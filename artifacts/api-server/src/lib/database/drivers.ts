import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2/promise";
import sql from "mssql";
import pg from "pg";
import { DatabaseSync } from "node:sqlite";
import {
  assertReadOnlyQuery,
  capSqlServerRows,
  capSubqueryRows,
  replaceQuestionMarks,
} from "./sql-safety";
import type {
  ColumnSchema,
  DatabaseAdapter,
  DatabaseKind,
  QueryResult,
  QueryValue,
  TableSchema,
} from "./types";

type MetadataRow = Record<string, unknown>;

const queryTimeout = Number(process.env["DATABASE_QUERY_TIMEOUT_MS"] ?? 10_000);
if (!Number.isInteger(queryTimeout) || queryTimeout < 1_000 || queryTimeout > 120_000) {
  throw new Error("DATABASE_QUERY_TIMEOUT_MS must be an integer from 1000 to 120000.");
}

function getDatabaseKind(rawUrl: string, requested?: DatabaseKind): DatabaseKind {
  const protocol = rawUrl.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  let detected: DatabaseKind | undefined;
  if (protocol && ["postgres", "postgresql", "cockroach", "cockroachdb"].includes(protocol)) {
    detected = "postgres";
  } else if (protocol && ["mysql", "mariadb"].includes(protocol)) {
    detected = "mysql";
  } else if (protocol && ["sqlite", "file"].includes(protocol)) {
    detected = "sqlite";
  } else if (protocol && ["mssql", "sqlserver"].includes(protocol)) {
    detected = "sqlserver";
  }

  if (requested) {
    if (detected && detected !== requested) {
      throw new Error("The database type does not match the connection string.");
    }
    return requested;
  }
  if (detected) return detected;
  throw new Error("Could not determine the database type from the connection string.");
}

function getSqlitePath(rawUrl: string): string {
  if (rawUrl.startsWith("sqlite:")) {
    return decodeURIComponent(rawUrl.slice("sqlite:".length).replace(/^\/\//, ""));
  }
  if (rawUrl.startsWith("file:")) {
    return decodeURIComponent(rawUrl.slice("file:".length));
  }
  return rawUrl;
}

function normalizeRow(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[binary data: ${value.byteLength} bytes]`;
  if (value instanceof Uint8Array) return `[binary data: ${value.byteLength} bytes]`;
  if (typeof value === "string" && value.length > 2_048) {
    return `${value.slice(0, 2_048)}… [value truncated by Database Pilot]`;
  }
  if (Array.isArray(value)) return value.map(normalizeRow);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, normalizeRow(child)]),
    );
  }
  return value;
}

function normalizeRows(rows: MetadataRow[]): Record<string, unknown>[] {
  return rows.map((row) => normalizeRow(row) as Record<string, unknown>);
}

function getOrCreate(
  tables: Map<string, TableSchema>,
  schema: string,
  name: string,
): TableSchema {
  const key = `${schema}.${name}`;
  let table = tables.get(key);
  if (!table) {
    table = { schema, name, columns: [] };
    tables.set(key, table);
  }
  return table;
}

function addConstraint(
  tables: Map<string, TableSchema>,
  row: MetadataRow,
  type: "primary" | "foreign",
): void {
  const table = getOrCreate(
    tables,
    String(row["schema_name"] ?? ""),
    String(row["table_name"] ?? ""),
  );
  const column = table.columns.find(
    (candidate) => candidate.name === String(row["column_name"] ?? ""),
  );
  if (!column) return;
  if (type === "primary") column.primaryKey = true;
  else if (row["referenced_table_name"]) {
    column.foreignKey = {
      table: `${String(row["referenced_schema_name"] ?? "")}.${String(row["referenced_table_name"])}`,
      column: String(row["referenced_column_name"] ?? ""),
    };
  }
}

function orderSchema(tables: Map<string, TableSchema>): TableSchema[] {
  return [...tables.values()]
    .map((table) => ({
      ...table,
      columns: table.columns.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) =>
      `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`),
    );
}

async function createPostgresAdapter(connectionString: string): Promise<DatabaseAdapter> {
  const { Pool } = pg;
  const pool = new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 5_000,
    statement_timeout: queryTimeout,
  });

  const getSchema = async (): Promise<TableSchema[]> => {
    const tables = new Map<string, TableSchema>();
    const columns = await pool.query<MetadataRow>(
      `SELECT table_schema AS schema_name, table_name, column_name, data_type,
              is_nullable
       FROM information_schema.columns
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY table_schema, table_name, ordinal_position`,
    );
    for (const row of columns.rows) {
      const table = getOrCreate(
        tables,
        String(row["schema_name"]),
        String(row["table_name"]),
      );
      table.columns.push({
        name: String(row["column_name"]),
        type: String(row["data_type"]),
        nullable: row["is_nullable"] === "YES",
        primaryKey: false,
      });
    }

    const constraints = await pool.query<MetadataRow>(
      `SELECT tc.table_schema AS schema_name, tc.table_name, kcu.column_name,
              tc.constraint_type, kcu.position_in_unique_constraint,
              ccu.table_schema AS referenced_schema_name,
              ccu.table_name AS referenced_table_name,
              ccu.column_name AS referenced_column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_catalog = kcu.constraint_catalog
        AND tc.constraint_schema = kcu.constraint_schema
        AND tc.constraint_name = kcu.constraint_name
        AND tc.table_name = kcu.table_name
       LEFT JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_catalog = ccu.constraint_catalog
        AND tc.constraint_schema = ccu.constraint_schema
        AND tc.constraint_name = ccu.constraint_name
       WHERE tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')
         AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')`,
    );
    for (const row of constraints.rows) {
      addConstraint(
        tables,
        row,
        row["constraint_type"] === "PRIMARY KEY" ? "primary" : "foreign",
      );
    }
    return orderSchema(tables);
  };

  return {
    kind: "postgres",
    getSchema,
    async query(queryText, parameters, maxRows) {
      const safeSql = assertReadOnlyQuery(queryText);
      const client = await pool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        const result = await client.query(
          capSubqueryRows(safeSql, maxRows),
          parameters,
        );
        await client.query("COMMIT");
        const rows = normalizeRows(result.rows as MetadataRow[]);
        return {
          columns: result.fields.map((field) => field.name),
          rows: rows.slice(0, maxRows),
          rowCount: Math.min(rows.length, maxRows),
          truncated: rows.length > maxRows,
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function createMysqlAdapter(connectionString: string): Promise<DatabaseAdapter> {
  const pool = mysql.createPool({
    uri: connectionString,
    connectionLimit: 5,
    connectTimeout: 5_000,
    enableKeepAlive: true,
  });

  const getSchema = async (): Promise<TableSchema[]> => {
    const tables = new Map<string, TableSchema>();
    const [columnRows] = await pool.query<RowDataPacket[]>(
      `SELECT table_schema AS schema_name, table_name, column_name, data_type,
              is_nullable
       FROM information_schema.columns
       WHERE table_schema = DATABASE()
       ORDER BY table_schema, table_name, ordinal_position`,
    );
    for (const row of columnRows as MetadataRow[]) {
      const table = getOrCreate(
        tables,
        String(row["schema_name"]),
        String(row["table_name"]),
      );
      table.columns.push({
        name: String(row["column_name"]),
        type: String(row["data_type"]),
        nullable: row["is_nullable"] === "YES",
        primaryKey: false,
      });
    }

    const [constraintRows] = await pool.query<RowDataPacket[]>(
      `SELECT table_schema AS schema_name, table_name, column_name,
              constraint_name, referenced_table_schema AS referenced_schema_name,
              referenced_table_name, referenced_column_name
       FROM information_schema.key_column_usage
       WHERE table_schema = DATABASE()
         AND (constraint_name = 'PRIMARY' OR referenced_table_name IS NOT NULL)`,
    );
    for (const row of constraintRows as MetadataRow[]) {
      addConstraint(tables, row, row["constraint_name"] === "PRIMARY" ? "primary" : "foreign");
    }
    return orderSchema(tables);
  };

  return {
    kind: "mysql",
    getSchema,
    async query(queryText, parameters, maxRows) {
      const safeSql = assertReadOnlyQuery(queryText);
      const connection = await pool.getConnection();
      try {
        await connection.query("START TRANSACTION READ ONLY");
        const [rows, fields] = await connection.execute(
          {
            sql: capSubqueryRows(safeSql, maxRows),
            timeout: queryTimeout,
          },
          parameters,
        );
        await connection.commit();
        const normalized = normalizeRows(rows as MetadataRow[]);
        return {
          columns: (fields ?? []).map((field) => field.name),
          rows: normalized.slice(0, maxRows),
          rowCount: Math.min(normalized.length, maxRows),
          truncated: normalized.length > maxRows,
        };
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },
    close: () => pool.end(),
  };
}

function createSqliteAdapter(connectionString: string): DatabaseAdapter {
  const path = getSqlitePath(connectionString);
  if (!path) throw new Error("The SQLite connection must include a database file path.");
  const database = new DatabaseSync(path, { readOnly: true });

  const getSchema = async (): Promise<TableSchema[]> => {
    const tables = new Map<string, TableSchema>();
    const names = database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as MetadataRow[];

    for (const row of names) {
      const name = String(row["name"]);
      const escapedName = name.replaceAll('"', '""');
      const columns = database
        .prepare(`PRAGMA table_info("${escapedName}")`)
        .all() as MetadataRow[];
      const foreignKeys = database
        .prepare(`PRAGMA foreign_key_list("${escapedName}")`)
        .all() as MetadataRow[];
      const table: TableSchema = { schema: "main", name, columns: [] };
      for (const column of columns) {
        const foreignKey = foreignKeys.find(
          (key) => key["from"] === column["name"],
        );
        table.columns.push({
          name: String(column["name"]),
          type: String(column["type"] || "unknown"),
          nullable: Number(column["notnull"]) !== 1 && Number(column["pk"]) !== 1,
          primaryKey: Number(column["pk"]) > 0,
          ...(foreignKey
            ? {
                foreignKey: {
                  table: `main.${String(foreignKey["table"])}`,
                  column: String(foreignKey["to"] ?? ""),
                },
              }
            : {}),
        });
      }
      tables.set(`main.${name}`, table);
    }
    return orderSchema(tables);
  };

  return {
    kind: "sqlite",
    getSchema,
    async query(queryText, parameters, maxRows) {
      const safeSql = assertReadOnlyQuery(queryText);
      const statement = database.prepare(capSubqueryRows(safeSql, maxRows));
      const columns = statement.columns().map((column) => column.name);
      const sqliteParameters = parameters.map((value) =>
        typeof value === "boolean" ? Number(value) : value,
      );
      const rows = normalizeRows(statement.all(...sqliteParameters) as MetadataRow[]);
      return {
        columns,
        rows: rows.slice(0, maxRows),
        rowCount: Math.min(rows.length, maxRows),
        truncated: rows.length > maxRows,
      };
    },
    async close() {
      database.close();
    },
  };
}

function parseSqlServerConfig(connectionString: string): string | sql.config {
  if (!/^mssql:|^sqlserver:/i.test(connectionString)) {
    return connectionString;
  }

  const url = new URL(connectionString);
  const encrypt = url.searchParams.get("encrypt") !== "false";
  const trustServerCertificate =
    url.searchParams.get("trustServerCertificate") === "true";
  const port = url.port ? Number(url.port) : undefined;

  return {
    server: url.hostname,
    ...(port ? { port } : {}),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
    options: { encrypt, trustServerCertificate },
    connectionTimeout: 5_000,
    requestTimeout: queryTimeout,
    pool: { max: 5, min: 0, idleTimeoutMillis: 30_000 },
  };
}

async function createSqlServerAdapter(connectionString: string): Promise<DatabaseAdapter> {
  const pool = await new sql.ConnectionPool(parseSqlServerConfig(connectionString)).connect();

  const getSchema = async (): Promise<TableSchema[]> => {
    const tables = new Map<string, TableSchema>();
    const columns = await pool.request().query<MetadataRow>(
      `SELECT s.name AS schema_name, t.name AS table_name, c.name AS column_name,
              TYPE_NAME(c.user_type_id) AS data_type, c.is_nullable
       FROM sys.objects t
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       JOIN sys.columns c ON c.object_id = t.object_id
       WHERE t.type IN ('U', 'V') AND t.is_ms_shipped = 0
       ORDER BY s.name, t.name, c.column_id`,
    );
    for (const row of columns.recordset) {
      const table = getOrCreate(
        tables,
        String(row["schema_name"]),
        String(row["table_name"]),
      );
      table.columns.push({
        name: String(row["column_name"]),
        type: String(row["data_type"]),
        nullable: Boolean(row["is_nullable"]),
        primaryKey: false,
      });
    }

    const constraints = await pool.request().query<MetadataRow>(
      `SELECT s.name AS schema_name, t.name AS table_name, c.name AS column_name,
              i.name AS constraint_name, CAST(NULL AS NVARCHAR(128)) AS referenced_table_name,
              CAST(NULL AS NVARCHAR(128)) AS referenced_schema_name,
              CAST(NULL AS NVARCHAR(128)) AS referenced_column_name,
              CAST(1 AS bit) AS is_primary_key, CAST(0 AS bit) AS is_foreign_key
       FROM sys.tables t
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       JOIN sys.indexes i ON i.object_id = t.object_id AND i.is_primary_key = 1
       JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
       JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       UNION ALL
       SELECT s.name, t.name, c.name, fk.name, rt.name, rs.name, rc.name,
              CAST(0 AS bit) AS is_primary_key, CAST(1 AS bit) AS is_foreign_key
       FROM sys.foreign_key_columns fkc
       JOIN sys.foreign_keys fk ON fk.object_id = fkc.constraint_object_id
       JOIN sys.tables t ON t.object_id = fkc.parent_object_id
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       JOIN sys.columns c ON c.object_id = t.object_id AND c.column_id = fkc.parent_column_id
       JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
       JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
       JOIN sys.columns rc ON rc.object_id = rt.object_id AND rc.column_id = fkc.referenced_column_id`,
    );
    for (const row of constraints.recordset) {
      if (row["is_primary_key"]) addConstraint(tables, row, "primary");
      if (row["is_foreign_key"]) addConstraint(tables, row, "foreign");
    }
    return orderSchema(tables);
  };

  return {
    kind: "sqlserver",
    getSchema,
    async query(queryText, parameters, maxRows) {
      const safeSql = assertReadOnlyQuery(queryText);
      const query = capSqlServerRows(safeSql, maxRows);
      const transaction = new sql.Transaction(pool);
      await transaction.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
      try {
        const request = new sql.Request(transaction);
        for (const [index, parameter] of parameters.entries()) {
          request.input(`p${index + 1}`, parameter);
        }
        const result = await request.query(replaceQuestionMarks(query));
        await transaction.commit();
        const rows = normalizeRows(result.recordset as MetadataRow[]);
        return {
          columns: result.recordset.columns
            ? Object.keys(result.recordset.columns)
            : rows[0]
              ? Object.keys(rows[0])
              : [],
          rows: rows.slice(0, maxRows),
          rowCount: Math.min(rows.length, maxRows),
          truncated: rows.length > maxRows,
        };
      } catch (error) {
        await transaction.rollback().catch(() => undefined);
        throw error;
      }
    },
    close: () => pool.close(),
  };
}

export async function createDatabaseAdapter(
  requestedKind: DatabaseKind,
  connectionString: string,
): Promise<DatabaseAdapter> {
  const kind = getDatabaseKind(connectionString, requestedKind);
  switch (kind) {
    case "postgres":
      return createPostgresAdapter(connectionString);
    case "mysql":
      return createMysqlAdapter(connectionString);
    case "sqlite":
      return createSqliteAdapter(connectionString);
    case "sqlserver":
      return createSqlServerAdapter(connectionString);
  }
}

export function validateQueryParameters(value: unknown): QueryValue[] {
  if (!Array.isArray(value)) {
    throw new Error("parameters must be an array of strings, numbers, booleans, or null.");
  }
  if (value.length > 100) throw new Error("A maximum of 100 query parameters is allowed.");
  for (const item of value) {
    if (
      item !== null &&
      typeof item !== "string" &&
      typeof item !== "number" &&
      typeof item !== "boolean"
    ) {
      throw new Error("Query parameters must be strings, numbers, booleans, or null.");
    }
    if (typeof item === "number" && !Number.isFinite(item)) {
      throw new Error("Numeric query parameters must be finite.");
    }
  }
  return value as QueryValue[];
}

export function validateMaxRows(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new Error("maxRows must be an integer from 1 to 200.");
  }
  return value;
}

export function formatSchemaName(table: TableSchema): string {
  return `${table.schema}.${table.name}`;
}

export function formatSchema(
  table: TableSchema,
  selectedColumns: ColumnSchema[] = table.columns,
  totalColumnCount = table.columns.length,
): string {
  const columns = selectedColumns.slice(0, 80).map((column) => {
    const flags = [
      column.primaryKey ? "primary key" : "",
      column.foreignKey
        ? `references ${column.foreignKey.table}(${column.foreignKey.column})`
        : "",
      column.nullable ? "nullable" : "not null",
    ].filter(Boolean);
    return `  - ${column.name}: ${column.type} (${flags.join(", ")})`;
  });
  const omitted = Math.max(0, totalColumnCount - columns.length);
  if (omitted > 0) {
    columns.push(
      `  - ${omitted} additional columns omitted; use a narrower search or select only needed fields.`,
    );
  }
  return `Table ${formatSchemaName(table)}\n${columns.join("\n")}`;
}

export function summarizeSchema(
  kind: DatabaseKind,
  tables: TableSchema[],
): {
  databaseType: DatabaseKind;
  tableCount: number;
  schemaNames: string[];
  sampleTables: string[];
} {
  return {
    databaseType: kind,
    tableCount: tables.length,
    schemaNames: [...new Set(tables.map((table) => table.schema))].sort(),
    sampleTables: tables.slice(0, 50).map(formatSchemaName),
  };
}