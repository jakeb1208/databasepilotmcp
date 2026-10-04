import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { DatabaseKind } from "./types";

export class ConnectionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionInputError";
  }
}

export class ConnectionServerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionServerConfigurationError";
  }
}

const protocolsByKind: Record<DatabaseKind, string[]> = {
  postgres: ["postgres", "postgresql", "cockroach", "cockroachdb"],
  mysql: ["mysql", "mariadb"],
  sqlite: ["sqlite", "file"],
  sqlserver: ["mssql", "sqlserver"],
};

function connectionProtocol(value: string): string | null {
  return /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase() ?? null;
}

function sqlitePath(value: string): string {
  if (value.startsWith("sqlite:")) {
    return decodeURIComponent(value.slice("sqlite:".length).replace(/^\/\//, ""));
  }
  if (value.startsWith("file:")) {
    return decodeURIComponent(value.slice("file:".length));
  }
  return value;
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function prepareConnectionString(
  kind: DatabaseKind,
  rawValue: string,
): Promise<string> {
  const value = rawValue.trim();
  if (!value) throw new ConnectionInputError("Enter a database connection string.");

  const protocol = connectionProtocol(value);
  if (protocol && !protocolsByKind[kind].includes(protocol)) {
    throw new ConnectionInputError(
      "The selected database type does not match the connection string.",
    );
  }

  if (kind === "postgres" && !protocolsByKind.postgres.includes(protocol ?? "")) {
    throw new ConnectionInputError("Use a PostgreSQL or CockroachDB connection URL.");
  }
  if (kind === "mysql" && !protocolsByKind.mysql.includes(protocol ?? "")) {
    throw new ConnectionInputError("Use a MySQL or MariaDB connection URL.");
  }
  if (kind === "sqlserver" && !protocol && !/(?:server|data source)\s*=/i.test(value)) {
    throw new ConnectionInputError(
      "Use an mssql:// URL or a SQL Server connection string with a server field.",
    );
  }
  if (kind !== "sqlite") return value;

  const configuredRoot = process.env["SQLITE_DATABASE_ROOT"];
  if (!configuredRoot) {
    throw new ConnectionServerConfigurationError(
      "SQLite support requires SQLITE_DATABASE_ROOT to point to a mounted directory.",
    );
  }

  let root: string;
  try {
    root = await realpath(configuredRoot);
  } catch {
    throw new ConnectionServerConfigurationError(
      "The configured SQLite database directory is not available.",
    );
  }

  let resolvedFile: string;
  try {
    const requestedPath = sqlitePath(value);
    const candidate = path.isAbsolute(requestedPath)
      ? requestedPath
      : path.resolve(root, requestedPath);
    resolvedFile = await realpath(candidate);
    const details = await stat(resolvedFile);
    if (!details.isFile()) throw new Error("Not a file.");
  } catch {
    throw new ConnectionInputError(
      "The SQLite database file must exist inside the configured SQLite directory.",
    );
  }

  if (!isInsideRoot(root, resolvedFile)) {
    throw new ConnectionInputError(
      "SQLite database files must be inside the configured SQLite directory.",
    );
  }
  return `sqlite:${resolvedFile}`;
}