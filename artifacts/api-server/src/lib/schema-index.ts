import { formatSchema, formatSchemaName } from "./database/drivers";
import type { ColumnSchema, DatabaseAdapter, TableSchema } from "./database/types";

interface IndexedTable {
  table: TableSchema;
  text: string;
  vector: Map<string, number>;
}

interface SchemaIndex {
  builtAt: number;
  tables: IndexedTable[];
}

interface SchemaIndexCache {
  builtIndex?: SchemaIndex;
  buildInFlight?: Promise<SchemaIndex>;
  lastUsedAt: number;
}

export interface SchemaMatch {
  name: string;
  score: number;
  schema: string;
}

const indexTtlMs = 5 * 60 * 1_000;
const indexesByConnection = new Map<string, SchemaIndexCache>();

const conceptGroups = [
  ["customer", "client", "buyer", "account", "patron"],
  ["user", "member", "person", "profile", "contact"],
  ["order", "purchase", "sale", "transaction", "checkout"],
  ["product", "item", "sku", "inventory", "catalog"],
  ["payment", "charge", "invoice", "billing", "receipt"],
  ["revenue", "sales", "income", "amount", "total"],
  ["employee", "staff", "worker", "team", "agent"],
  ["created", "registered", "joined", "signup", "since"],
  ["email", "mail", "address", "contact"],
  ["refund", "return", "chargeback", "reversal"],
  ["location", "region", "country", "city", "address"],
  ["quantity", "count", "number", "units"],
  ["status", "state", "stage", "condition"],
  ["date", "time", "timestamp", "when"],
];

const concepts = new Map<string, string[]>();
for (const group of conceptGroups) {
  for (const term of group) concepts.set(term, group);
}

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
}

function expandTerms(tokens: string[]): Map<string, number> {
  const expanded = new Map<string, number>();
  for (const token of tokens) {
    expanded.set(token, Math.max(expanded.get(token) ?? 0, 1));
    for (const related of concepts.get(token) ?? []) {
      if (related !== token) {
        expanded.set(related, Math.max(expanded.get(related) ?? 0, 0.35));
      }
    }
  }
  return expanded;
}

function buildVector(text: string, documentFrequency: Map<string, number>, totalDocs: number): Map<string, number> {
  const terms = tokenize(text);
  const counts = new Map<string, number>();
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);

  const vector = new Map<string, number>();
  for (const [term, count] of expandTerms(terms)) {
    const tf = 1 + Math.log(Math.max(counts.get(term) ?? 1, 1));
    const idf = Math.log(1 + totalDocs / (1 + (documentFrequency.get(term) ?? 0)));
    vector.set(term, tf * idf * count);
  }
  const magnitude = Math.sqrt(
    [...vector.values()].reduce((sum, value) => sum + value * value, 0),
  );
  if (magnitude > 0) {
    for (const [term, value] of vector) vector.set(term, value / magnitude);
  }
  return vector;
}

function cosineSimilarity(
  left: Map<string, number>,
  right: Map<string, number>,
): number {
  let score = 0;
  for (const [term, weight] of left) score += weight * (right.get(term) ?? 0);
  return score;
}

function documentText(table: TableSchema): string {
  return [
    table.schema,
    table.name,
    ...table.columns.flatMap((column) => [
      column.name,
      column.type,
      column.primaryKey ? "primary key identifier id" : "",
      column.foreignKey
        ? `foreign key reference ${column.foreignKey.table} ${column.foreignKey.column}`
        : "",
    ]),
  ]
    .filter(Boolean)
    .join(" ");
}

function selectRelevantColumns(
  table: TableSchema,
  question: string,
  maximum = 80,
): ColumnSchema[] {
  if (table.columns.length <= maximum) return table.columns;
  const queryTerms = expandTerms(tokenize(question));
  const exactTerms = new Set(tokenize(question));
  const ranked = table.columns.map((column, index) => {
    const columnTerms = new Set(
      tokenize(
        [
          column.name,
          column.type,
          column.foreignKey?.table ?? "",
          column.foreignKey?.column ?? "",
        ].join(" "),
      ),
    );
    let score = column.primaryKey ? 0.5 : 0;
    if (column.foreignKey) score += 0.35;
    for (const [term, weight] of queryTerms) {
      if (columnTerms.has(term)) score += exactTerms.has(term) ? 2 : weight;
    }
    return { column, index, score };
  });

  const matched = ranked
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maximum);
  if (matched.length < maximum) {
    const selected = new Set(matched.map(({ index }) => index));
    for (const item of ranked) {
      if (matched.length >= maximum) break;
      if (!selected.has(item.index)) matched.push(item);
    }
  }
  return matched
    .sort((a, b) => a.index - b.index)
    .map(({ column }) => column);
}

async function buildIndex(database: DatabaseAdapter): Promise<SchemaIndex> {
  const tables = await database.getSchema();
  const texts = tables.map((table) => documentText(table));
  const documentFrequency = new Map<string, number>();
  for (const text of texts) {
    for (const term of new Set(tokenize(text))) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  return {
    builtAt: Date.now(),
    tables: tables.map((table, index) => ({
      table,
      text: texts[index]!,
      vector: buildVector(texts[index]!, documentFrequency, tables.length),
    })),
  };
}

function getCache(cacheKey: string): SchemaIndexCache {
  let entry = indexesByConnection.get(cacheKey);
  if (!entry) {
    entry = { lastUsedAt: Date.now() };
    indexesByConnection.set(cacheKey, entry);
  }
  entry.lastUsedAt = Date.now();
  if (indexesByConnection.size > 100) {
    const oldest = [...indexesByConnection.entries()]
      .filter(([key]) => key !== cacheKey)
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
    if (oldest) indexesByConnection.delete(oldest[0]);
  }
  return entry;
}

async function getIndex(
  cacheKey: string,
  database: DatabaseAdapter,
  forceRefresh = false,
): Promise<SchemaIndex> {
  const entry = getCache(cacheKey);
  if (
    !forceRefresh &&
    entry.builtIndex &&
    Date.now() - entry.builtIndex.builtAt < indexTtlMs
  ) {
    return entry.builtIndex;
  }
  if (entry.buildInFlight) return entry.buildInFlight;

  entry.buildInFlight = buildIndex(database)
    .then((index) => {
      entry.builtIndex = index;
      return index;
    })
    .finally(() => {
      entry.buildInFlight = undefined;
    });
  return entry.buildInFlight;
}

export async function searchSchema(
  cacheKey: string,
  database: DatabaseAdapter,
  question: string,
  limit = 5,
): Promise<{ matches: SchemaMatch[]; tableCount: number; indexBuiltAt: string }> {
  const queryVector = buildVector(question, new Map(), 1);
  const index = await getIndex(cacheKey, database);
  const matches = index.tables
    .map((document) => {
      const selectedColumns = selectRelevantColumns(document.table, question);
      return {
        name: formatSchemaName(document.table),
        score: cosineSimilarity(queryVector, document.vector),
        schema: formatSchema(
          document.table,
          selectedColumns,
          document.table.columns.length,
        ),
      };
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((match) => ({ ...match, score: Number(match.score.toFixed(4)) }));

  return {
    matches,
    tableCount: index.tables.length,
    indexBuiltAt: new Date(index.builtAt).toISOString(),
  };
}

export async function refreshSchemaIndex(
  cacheKey: string,
  database: DatabaseAdapter,
): Promise<{
  tableCount: number;
  indexBuiltAt: string;
}> {
  const index = await getIndex(cacheKey, database, true);
  return {
    tableCount: index.tables.length,
    indexBuiltAt: new Date(index.builtAt).toISOString(),
  };
}

export async function getAllTables(
  cacheKey: string,
  database: DatabaseAdapter,
): Promise<TableSchema[]> {
  const index = await getIndex(cacheKey, database);
  return index.tables.map(({ table }) => table);
}

export async function getTableSchema(
  cacheKey: string,
  database: DatabaseAdapter,
  name: string,
): Promise<SchemaMatch | null> {
  const index = await getIndex(cacheKey, database);
  const found = index.tables.find(
    ({ table }) => formatSchemaName(table).toLowerCase() === name.toLowerCase(),
  );
  if (!found) return null;
  return { name: formatSchemaName(found.table), score: 1, schema: formatSchema(found.table) };
}

function resolveTableName(
  tables: TableSchema[],
  input: string,
): { table?: TableSchema; matches: string[] } {
  const normalized = input.toLowerCase();
  const exact = tables.find(
    (table) => formatSchemaName(table).toLowerCase() === normalized,
  );
  if (exact) return { table: exact, matches: [formatSchemaName(exact)] };
  const unqualified = tables.filter((table) => table.name.toLowerCase() === normalized);
  if (unqualified.length === 1) {
    return { table: unqualified[0], matches: [formatSchemaName(unqualified[0]!)] };
  }
  return {
    matches: unqualified.map(formatSchemaName),
  };
}

export async function findRelationshipPath(
  cacheKey: string,
  database: DatabaseAdapter,
  fromName: string,
  toName: string,
  maxDepth: number,
): Promise<{
  found: boolean;
  fromTable: string;
  toTable: string;
  relationships: { fromTable: string; fromColumn: string; toTable: string; toColumn: string }[];
  matchingTables?: string[];
}> {
  const tables = await getAllTables(cacheKey, database);
  const from = resolveTableName(tables, fromName);
  const to = resolveTableName(tables, toName);
  if (!from.table || !to.table) {
    return {
      found: false,
      fromTable: fromName,
      toTable: toName,
      relationships: [],
      matchingTables: [...new Set([...from.matches, ...to.matches])],
    };
  }
  const fromKey = formatSchemaName(from.table);
  const toKey = formatSchemaName(to.table);
  if (fromKey === toKey) {
    return { found: true, fromTable: fromKey, toTable: toKey, relationships: [] };
  }

  const adjacency = new Map<
    string,
    { fromTable: string; fromColumn: string; toTable: string; toColumn: string }[]
  >();
  const addEdge = (
    edge: { fromTable: string; fromColumn: string; toTable: string; toColumn: string },
  ): void => {
    const edges = adjacency.get(edge.fromTable) ?? [];
    edges.push(edge);
    adjacency.set(edge.fromTable, edges);
  };

  for (const table of tables) {
    const tableName = formatSchemaName(table);
    for (const column of table.columns) {
      if (!column.foreignKey) continue;
      const reference = resolveTableName(tables, column.foreignKey.table);
      if (!reference.table) continue;
      const referencedName = formatSchemaName(reference.table);
      addEdge({
        fromTable: tableName,
        fromColumn: column.name,
        toTable: referencedName,
        toColumn: column.foreignKey.column,
      });
      addEdge({
        fromTable: referencedName,
        fromColumn: column.foreignKey.column,
        toTable: tableName,
        toColumn: column.name,
      });
    }
  }

  const queue: {
    table: string;
    path: { fromTable: string; fromColumn: string; toTable: string; toColumn: string }[];
  }[] = [{ table: fromKey, path: [] }];
  const visited = new Set([fromKey]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.path.length >= maxDepth) continue;
    for (const edge of adjacency.get(current.table) ?? []) {
      if (visited.has(edge.toTable)) continue;
      const path = [...current.path, edge];
      if (edge.toTable === toKey) {
        return {
          found: true,
          fromTable: fromKey,
          toTable: toKey,
          relationships: path,
        };
      }
      visited.add(edge.toTable);
      queue.push({ table: edge.toTable, path });
    }
  }
  return { found: false, fromTable: fromKey, toTable: toKey, relationships: [] };
}