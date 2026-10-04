export type DatabaseKind = "postgres" | "mysql" | "sqlite" | "sqlserver";

export type QueryValue = string | number | boolean | null;

export interface ColumnSchema {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  foreignKey?: {
    table: string;
    column: string;
  };
}

export interface TableSchema {
  schema: string;
  name: string;
  columns: ColumnSchema[];
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

export interface DatabaseAdapter {
  readonly kind: DatabaseKind;
  getSchema(): Promise<TableSchema[]>;
  query(sql: string, parameters: QueryValue[], maxRows: number): Promise<QueryResult>;
  close(): Promise<void>;
}