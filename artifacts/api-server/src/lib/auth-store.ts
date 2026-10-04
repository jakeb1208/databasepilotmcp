import pg from "pg";
import type { DatabaseKind } from "./database/types";

const { Pool } = pg;

export interface AccountUser {
  id: string;
  email: string;
  createdAt: string;
}

export interface DatabaseConnection {
  id: string;
  name: string;
  databaseType: DatabaseKind;
  createdAt: string;
  lastTestedAt: string | null;
}

export interface ApiToken {
  id: string;
  connectionId: string;
  connectionName: string;
  label: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface McpTokenIdentity {
  id: string;
  userId: string;
  connectionId: string;
  databaseType: DatabaseKind;
  encryptedConnection: string;
}

interface DbRow extends Record<string, unknown> {}

export class AuthStoreNotConfiguredError extends Error {
  constructor() {
    super("AUTH_DATABASE_URL is not configured.");
    this.name = "AuthStoreNotConfiguredError";
  }
}

export class AuthStoreUnavailableError extends Error {
  constructor() {
    super("The authentication database is not available.");
    this.name = "AuthStoreUnavailableError";
  }
}

export class AccountEmailConflictError extends Error {
  constructor() {
    super("An account with that email already exists.");
    this.name = "AccountEmailConflictError";
  }
}

export class AccountLimitReachedError extends Error {
  constructor() {
    super("This account has reached its connection or token limit.");
    this.name = "AccountLimitReachedError";
  }
}

const schemaSql = `
  CREATE TABLE IF NOT EXISTS database_pilot_users (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS database_pilot_users_email_ci
    ON database_pilot_users (lower(email));

  CREATE TABLE IF NOT EXISTS database_pilot_sessions (
    token_hash CHAR(64) PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES database_pilot_users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS database_pilot_sessions_user
    ON database_pilot_sessions (user_id);
  CREATE INDEX IF NOT EXISTS database_pilot_sessions_expiry
    ON database_pilot_sessions (expires_at);

  CREATE TABLE IF NOT EXISTS database_pilot_connections (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES database_pilot_users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    database_type TEXT NOT NULL CHECK (database_type IN ('postgres', 'mysql', 'sqlite', 'sqlserver')),
    encrypted_connection TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_tested_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS database_pilot_connections_user
    ON database_pilot_connections (user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS database_pilot_tokens (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES database_pilot_users(id) ON DELETE CASCADE,
    connection_id UUID NOT NULL REFERENCES database_pilot_connections(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS database_pilot_tokens_user
    ON database_pilot_tokens (user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS database_pilot_tokens_connection
    ON database_pilot_tokens (connection_id);
`;

let poolPromise: Promise<pg.Pool> | undefined;

async function getPool(): Promise<pg.Pool> {
  const connectionString = process.env["AUTH_DATABASE_URL"];
  if (!connectionString) throw new AuthStoreNotConfiguredError();
  if (poolPromise) return poolPromise;

  const candidate = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: "database-pilot-auth",
  });
  const pending = candidate
    .query(schemaSql)
    .then(() => candidate)
    .catch(async () => {
      await candidate.end().catch(() => undefined);
      throw new AuthStoreUnavailableError();
    });
  poolPromise = pending;
  try {
    return await pending;
  } catch (error) {
    if (poolPromise === pending) poolPromise = undefined;
    throw error;
  }
}

function asString(row: DbRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Invalid database row field: ${key}`);
  return value;
}

function asDate(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date in authentication database.");
  return date.toISOString();
}

function nullableDate(value: unknown): string | null {
  return value == null ? null : asDate(value);
}

function toUser(row: DbRow): AccountUser {
  return {
    id: asString(row, "id"),
    email: asString(row, "email"),
    createdAt: asDate(row["created_at"]),
  };
}

function toConnection(row: DbRow): DatabaseConnection {
  return {
    id: asString(row, "id"),
    name: asString(row, "name"),
    databaseType: asString(row, "database_type") as DatabaseKind,
    createdAt: asDate(row["created_at"]),
    lastTestedAt: nullableDate(row["last_tested_at"]),
  };
}

function toToken(row: DbRow): ApiToken {
  return {
    id: asString(row, "id"),
    connectionId: asString(row, "connection_id"),
    connectionName: asString(row, "connection_name"),
    label: asString(row, "label"),
    tokenPrefix: asString(row, "token_prefix"),
    createdAt: asDate(row["created_at"]),
    lastUsedAt: nullableDate(row["last_used_at"]),
    revokedAt: nullableDate(row["revoked_at"]),
  };
}

export async function createAccount(
  id: string,
  email: string,
  passwordHash: string,
  sessionHash: string,
  sessionExpiresAt: Date,
): Promise<AccountUser> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<DbRow>(
      `INSERT INTO database_pilot_users (id, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, created_at`,
      [id, email, passwordHash],
    );
    const user = result.rows[0];
    if (!user) throw new Error("Account creation returned no user.");
    await client.query(
      `INSERT INTO database_pilot_sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, $3)`,
      [sessionHash, id, sessionExpiresAt],
    );
    await client.query("COMMIT");
    return toUser(user);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505"
    ) {
      throw new AccountEmailConflictError();
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function findUserByEmail(email: string): Promise<
  | (AccountUser & { passwordHash: string })
  | null
> {
  const pool = await getPool();
  const result = await pool.query<DbRow>(
    `SELECT id, email, password_hash, created_at
     FROM database_pilot_users WHERE lower(email) = lower($1)`,
    [email],
  );
  const row = result.rows[0];
  return row
    ? { ...toUser(row), passwordHash: asString(row, "password_hash") }
    : null;
}

export async function createSession(
  userId: string,
  sessionHash: string,
  expiresAt: Date,
): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO database_pilot_sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, $3)`,
    [sessionHash, userId, expiresAt],
  );
}

export async function findSession(sessionHash: string): Promise<AccountUser | null> {
  const pool = await getPool();
  const result = await pool.query<DbRow>(
    `SELECT u.id, u.email, u.created_at
     FROM database_pilot_sessions s
     JOIN database_pilot_users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sessionHash],
  );
  return result.rows[0] ? toUser(result.rows[0]) : null;
}

export async function deleteSession(sessionHash: string): Promise<void> {
  const pool = await getPool();
  await pool.query(
    "DELETE FROM database_pilot_sessions WHERE token_hash = $1",
    [sessionHash],
  );
}

export async function listConnections(userId: string): Promise<DatabaseConnection[]> {
  const pool = await getPool();
  const result = await pool.query<DbRow>(
    `SELECT id, name, database_type, created_at, last_tested_at
     FROM database_pilot_connections
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows.map(toConnection);
}

export async function createConnection(
  userId: string,
  id: string,
  name: string,
  databaseType: DatabaseKind,
  encryptedConnection: string,
): Promise<DatabaseConnection> {
  const pool = await getPool();
  const result = await pool.query<DbRow>(
    `INSERT INTO database_pilot_connections
       (id, user_id, name, database_type, encrypted_connection)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, database_type, created_at, last_tested_at`,
    [id, userId, name, databaseType, encryptedConnection],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Connection creation returned no connection.");
  return toConnection(row);
}

export async function deleteConnection(
  userId: string,
  connectionId: string,
): Promise<boolean> {
  const pool = await getPool();
  const result = await pool.query(
    `DELETE FROM database_pilot_connections
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [connectionId, userId],
  );
  return result.rowCount === 1;
}

export async function listTokens(userId: string): Promise<ApiToken[]> {
  const pool = await getPool();
  const result = await pool.query<DbRow>(
    `SELECT t.id, t.connection_id, c.name AS connection_name, t.label,
            t.token_prefix, t.created_at, t.last_used_at, t.revoked_at
     FROM database_pilot_tokens t
     JOIN database_pilot_connections c ON c.id = t.connection_id
     WHERE t.user_id = $1
     ORDER BY t.created_at DESC`,
    [userId],
  );
  return result.rows.map(toToken);
}

export async function createToken(
  userId: string,
  id: string,
  connectionId: string,
  label: string,
  tokenHash: string,
  tokenPrefix: string,
): Promise<ApiToken | null> {
  const pool = await getPool();
  const result = await pool.query<DbRow>(
    `WITH inserted AS (
       INSERT INTO database_pilot_tokens
         (id, user_id, connection_id, label, token_hash, token_prefix)
       SELECT $1, $2, c.id, $4, $5, $6
       FROM database_pilot_connections c
       WHERE c.id = $3 AND c.user_id = $2
       RETURNING id, user_id, connection_id, label, token_prefix,
                 created_at, last_used_at, revoked_at
     )
     SELECT i.id, i.connection_id, c.name AS connection_name, i.label,
            i.token_prefix, i.created_at, i.last_used_at, i.revoked_at
     FROM inserted i
     JOIN database_pilot_connections c ON c.id = i.connection_id`,
    [id, userId, connectionId, label, tokenHash, tokenPrefix],
  );
  return result.rows[0] ? toToken(result.rows[0]) : null;
}

export async function revokeToken(userId: string, tokenId: string): Promise<boolean> {
  const pool = await getPool();
  const result = await pool.query(
    `UPDATE database_pilot_tokens
     SET revoked_at = COALESCE(revoked_at, now())
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [tokenId, userId],
  );
  return result.rowCount === 1;
}

export async function findMcpToken(
  tokenHash: string,
): Promise<McpTokenIdentity | null> {
  const pool = await getPool();
  const result = await pool.query<DbRow>(
    `SELECT t.id, t.user_id, c.id AS connection_id, c.database_type,
            c.encrypted_connection
     FROM database_pilot_tokens t
     JOIN database_pilot_connections c
       ON c.id = t.connection_id AND c.user_id = t.user_id
     WHERE t.token_hash = $1 AND t.revoked_at IS NULL`,
    [tokenHash],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: asString(row, "id"),
    userId: asString(row, "user_id"),
    connectionId: asString(row, "connection_id"),
    databaseType: asString(row, "database_type") as DatabaseKind,
    encryptedConnection: asString(row, "encrypted_connection"),
  };
}

export async function touchMcpToken(tokenId: string): Promise<boolean> {
  const pool = await getPool();
  const result = await pool.query(
    `UPDATE database_pilot_tokens SET last_used_at = now()
     WHERE id = $1 AND revoked_at IS NULL`,
    [tokenId],
  );
  return result.rowCount === 1;
}

export async function getDashboardCounts(userId: string): Promise<{
  connectionsCount: number;
  activeTokensCount: number;
  revokedTokensCount: number;
}> {
  const pool = await getPool();
  const result = await pool.query<DbRow>(
    `SELECT
       (SELECT count(*)::int FROM database_pilot_connections WHERE user_id = $1) AS connections_count,
       (SELECT count(*)::int FROM database_pilot_tokens WHERE user_id = $1 AND revoked_at IS NULL) AS active_tokens_count,
       (SELECT count(*)::int FROM database_pilot_tokens WHERE user_id = $1 AND revoked_at IS NOT NULL) AS revoked_tokens_count`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Could not read account summary.");
  return {
    connectionsCount: Number(row["connections_count"]),
    activeTokensCount: Number(row["active_tokens_count"]),
    revokedTokensCount: Number(row["revoked_tokens_count"]),
  };
}

export async function getRecentConnections(userId: string): Promise<DatabaseConnection[]> {
  const pool = await getPool();
  const result = await pool.query<DbRow>(
    `SELECT id, name, database_type, created_at, last_tested_at
     FROM database_pilot_connections
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 5`,
    [userId],
  );
  return result.rows.map(toConnection);
}

export async function getRecentTokens(userId: string): Promise<ApiToken[]> {
  const pool = await getPool();
  const result = await pool.query<DbRow>(
    `SELECT t.id, t.connection_id, c.name AS connection_name, t.label,
            t.token_prefix, t.created_at, t.last_used_at, t.revoked_at
     FROM database_pilot_tokens t
     JOIN database_pilot_connections c ON c.id = t.connection_id
     WHERE t.user_id = $1
     ORDER BY t.created_at DESC
     LIMIT 5`,
    [userId],
  );
  return result.rows.map(toToken);
}