import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  formatSchemaName,
  summarizeSchema,
  validateMaxRows,
  validateQueryParameters,
} from "./database/drivers";
import type { DatabaseAdapter, QueryResult, QueryValue } from "./database/types";
import {
  findRelationshipPath,
  getAllTables,
  getTableSchema,
  refreshSchemaIndex,
  searchSchema,
} from "./schema-index";

const queryParameterSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

function jsonToolResult(value: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function errorToolResult(error: unknown): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  const message =
    error instanceof Error ? error.message : "The database operation failed.";
  const sanitized = message.replace(
    /((?:postgres(?:ql)?|mysql|mariadb|mssql|sqlserver):\/\/)[^\s@]+@/gi,
    "$1[credentials-redacted]@",
  );
  return {
    content: [{ type: "text", text: sanitized }],
    isError: true,
  };
}

function capQueryResult(result: QueryResult): QueryResult {
  const maxColumns = 40;
  const maxCharacters = 96_000;
  const columns = result.columns.slice(0, maxColumns);
  const rows: Record<string, unknown>[] = [];
  let characters = 0;
  let responseTruncated = columns.length < result.columns.length;

  for (const row of result.rows) {
    const boundedRow = Object.fromEntries(columns.map((column) => [column, row[column]]));
    const size = JSON.stringify(boundedRow).length;
    if (characters + size > maxCharacters) {
      responseTruncated = true;
      break;
    }
    characters += size;
    rows.push(boundedRow);
  }

  if (rows.length < result.rows.length) responseTruncated = true;
  return {
    columns,
    rows,
    rowCount: rows.length,
    truncated: result.truncated || responseTruncated,
  };
}

export interface DatabasePilotContext {
  connectionId: string;
  getAdapter: () => Promise<DatabaseAdapter>;
}

function quoteIdentifier(kind: DatabaseAdapter["kind"], identifier: string): string {
  if (kind === "mysql") return `\`${identifier.replaceAll("`", "``")}\``;
  if (kind === "sqlserver") return `[${identifier.replaceAll("]", "]]")}]`;
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function createDatabasePilotServer(context: DatabasePilotContext): McpServer {
  const server = new McpServer({
    name: "database-pilot",
    version: "1.0.0",
  });
  const readOnlyAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  server.registerTool(
    "ask_database",
    {
      title: "Ask the database",
      description:
        "Start here when a user asks a natural-language question about the database. Retrieves only the most relevant table schemas from the local schema index. Then write a SELECT query using that context, call run_readonly_query, and answer from its rows. This tool does not send data to an AI service.",
      inputSchema: {
        question: z.string().min(4).max(2_000).describe("The user's database question."),
        tableLimit: z.number().int().min(1).max(8).optional(),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ question, tableLimit }) => {
      try {
        const database = await context.getAdapter();
        const result = await searchSchema(
          context.connectionId,
          database,
          question,
          tableLimit ?? 5,
        );
        return jsonToolResult({
          question,
          matchingTables: result.matches,
          matchingTableCount: result.matches.length,
          totalIndexedTables: result.tableCount,
          indexBuiltAt: result.indexBuiltAt,
          nextStep:
            "Use the matching schemas to write one parameterized SELECT query, call run_readonly_query, and answer the user's question from the returned rows. If no schema matches, inspect database_overview or describe_table.",
        });
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );

  server.registerTool(
    "list_tables",
    {
      title: "List database tables",
      description:
        "Lists table names and column counts, optionally filtered by schema or name. Use this for direct inventory questions before describing a specific table.",
      inputSchema: {
        schema: z.string().min(1).max(128).optional(),
        nameContains: z.string().min(1).max(128).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ schema, nameContains, limit }) => {
      try {
        const database = await context.getAdapter();
        const tables = await getAllTables(context.connectionId, database);
        const filtered = tables.filter(
          (table) =>
            (!schema || table.schema.toLowerCase() === schema.toLowerCase()) &&
            (!nameContains ||
              table.name.toLowerCase().includes(nameContains.toLowerCase())),
        );
        const maximum = limit ?? 100;
        return jsonToolResult({
          tableCount: filtered.length,
          tables: filtered.slice(0, maximum).map((table) => ({
            name: formatSchemaName(table),
            schema: table.schema,
            table: table.name,
            columnCount: table.columns.length,
          })),
          truncated: filtered.length > maximum,
        });
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );

  server.registerTool(
    "database_overview",
    {
      title: "Database overview",
      description:
        "Returns the database engine, table count, schema names, and up to 50 table names. It does not return column definitions or row data; use ask_database or search_schema for focused retrieval.",
      inputSchema: {},
      annotations: readOnlyAnnotations,
    },
    async () => {
      try {
        const database = await context.getAdapter();
        const tables = await getAllTables(context.connectionId, database);
        return jsonToolResult(summarizeSchema(database.kind, tables));
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );

  server.registerTool(
    "search_schema",
    {
      title: "Search database schema",
      description:
        "Searches the local, in-memory TF-IDF schema index with lightweight concept expansion. Returns only the best-matching tables and their columns, keys, and relationships.",
      inputSchema: {
        query: z.string().min(2).max(2_000).describe("Table, field, or business concept to find."),
        limit: z.number().int().min(1).max(8).optional(),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ query, limit }) => {
      try {
        const database = await context.getAdapter();
        return jsonToolResult(
          await searchSchema(context.connectionId, database, query, limit ?? 5),
        );
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );

  server.registerTool(
    "describe_table",
    {
      title: "Describe a database table",
      description:
        "Returns the column types and primary/foreign-key relationships for one table. Use its schema-qualified name from database_overview when duplicate table names exist.",
      inputSchema: {
        table: z.string().min(1).max(256).describe("Table name, preferably schema-qualified."),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ table }) => {
      try {
        const database = await context.getAdapter();
        const result = await getTableSchema(context.connectionId, database, table);
        if (result) return jsonToolResult(result);
        const allTables = await getAllTables(context.connectionId, database);
        const matches = allTables.filter((candidate) => candidate.name === table);
        if (matches.length === 1) {
          const match = await getTableSchema(
            context.connectionId,
            database,
            formatSchemaName(matches[0]!),
          );
          if (match) return jsonToolResult(match);
        }
        if (matches.length > 1) {
          return jsonToolResult({
            error: "This table name exists in more than one schema.",
            matchingTables: matches.map(formatSchemaName),
          });
        }
        return jsonToolResult({
          error: `Table "${table}" was not found in the current schema index.`,
        });
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );

  server.registerTool(
    "find_table_relationships",
    {
      title: "Find a relationship path between tables",
      description:
        "Finds the shortest path of declared foreign keys between two tables. Use it when an agent needs to determine how to join related tables.",
      inputSchema: {
        fromTable: z.string().min(1).max(256),
        toTable: z.string().min(1).max(256),
        maxDepth: z.number().int().min(1).max(6).optional(),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ fromTable, toTable, maxDepth }) => {
      try {
        const database = await context.getAdapter();
        return jsonToolResult(
          await findRelationshipPath(
            context.connectionId,
            database,
            fromTable,
            toTable,
            maxDepth ?? 4,
          ),
        );
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );

  server.registerTool(
    "sample_table_rows",
    {
      title: "Sample rows from a table",
      description:
        "Returns a small, bounded sample from one table to help identify real value formats. This returns database data to the connected MCP client; use only for tables the user asked about. The database connection itself must use read-only permissions.",
      inputSchema: {
        table: z.string().min(1).max(256),
        maxRows: z.number().int().min(1).max(20).optional(),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ table, maxRows }) => {
      try {
        const database = await context.getAdapter();
        const tables = await getAllTables(context.connectionId, database);
        const qualified = tables.filter(
          (candidate) =>
            formatSchemaName(candidate).toLowerCase() === table.toLowerCase(),
        );
        const unqualified = tables.filter(
          (candidate) => candidate.name.toLowerCase() === table.toLowerCase(),
        );
        const matches = qualified.length > 0 ? qualified : unqualified;
        if (matches.length !== 1) {
          return jsonToolResult({
            error:
              matches.length > 1
                ? "This table name exists in more than one schema."
                : `Table "${table}" was not found in the current schema index.`,
            matchingTables: matches.map(formatSchemaName),
          });
        }
        const selected = matches[0]!;
        const tableName = [selected.schema, selected.name]
          .map((identifier) => quoteIdentifier(database.kind, identifier))
          .join(".");
        const limit = maxRows ?? 5;
        const result = await database.query(
          `SELECT * FROM ${tableName}`,
          [],
          validateMaxRows(limit),
        );
        const bounded = capQueryResult(result);
        return jsonToolResult({
          table: formatSchemaName(selected),
          databaseType: database.kind,
          ...bounded,
          ...(bounded.truncated
            ? { note: "The sample was capped. Request only the columns and rows needed." }
            : {}),
        });
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );

  server.registerTool(
    "run_readonly_query",
    {
      title: "Run a read-only query",
      description:
        "Executes one read-only SELECT query or read-only CTE with positional parameters and a hard result cap. Use ? placeholders for MySQL, SQLite, and SQL Server; use $1, $2, ... for PostgreSQL. Never include credentials or secrets in SQL. The connected database account should also be read-only.",
      inputSchema: {
        sql: z.string().min(1).max(50_000).describe("A single SELECT statement."),
        parameters: z.array(queryParameterSchema).max(100).optional(),
        maxRows: z.number().int().min(1).max(200).optional(),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ sql: query, parameters, maxRows }) => {
      try {
        const database = await context.getAdapter();
        const validatedParameters = validateQueryParameters(
          (parameters ?? []) as QueryValue[],
        );
        const result = await database.query(
          query,
          validatedParameters,
          validateMaxRows(maxRows),
        );
        const bounded = capQueryResult(result);
        return jsonToolResult({
          databaseType: database.kind,
          ...bounded,
          ...(bounded.truncated
            ? {
                note:
                  "The result rows, columns, or content were capped to keep the agent response bounded. Select only the fields and rows needed.",
              }
            : {}),
        });
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );

  server.registerTool(
    "refresh_schema_index",
    {
      title: "Refresh schema index",
      description:
        "Reloads database table and column metadata and rebuilds the in-memory retrieval index. Use after database schema changes.",
      inputSchema: {},
      annotations: readOnlyAnnotations,
    },
    async () => {
      try {
        const database = await context.getAdapter();
        return jsonToolResult(
          await refreshSchemaIndex(context.connectionId, database),
        );
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );

  return server;
}