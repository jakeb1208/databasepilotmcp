Human written README - Jake Bergeron:

Database pilot is an mcp server that it multi user. It is read only. Database connections are made at https://workspaceapi-server-production-811c.up.railway.app/. The MCP endpoint is https://workspaceapi-server-production-811c.up.railway.app/api/mcp

Database pilot gives an AI agent scoped, read-only access to a selected database without exposing its saved credentials, and the Agent can answer developers' database questions regarding public info.

First test: connected Supabase Postegre SQL to Database Pilot through https://workspaceapi-server-production-811c.up.railway.app/. Obtained token, MCP URL, and instructions to connect to agent.

I connected it to Replit, and it proved successful, giving me information about the public database tables and content for another project of mine.

This was my first try at an MCP server, and I developed it in about 3-3.5 hours with Replit free.

Here's what the AI wrote for the README for more details about the project:

Database Pilot
Database Pilot is a multi-user, read-only MCP service. Each account saves its own database connections and creates bearer tokens scoped to one connection. The web console is served at /; the stateless Streamable HTTP MCP endpoint is /api/mcp.

Schema search uses a local in-memory TF-IDF index; the MCP service does not send schema or query data to an AI service. The connected MCP client uses its own model to choose tools and interpret results.

Railway setup
Provision a Railway PostgreSQL service for Database Pilot's account, session, connection-metadata, and token records. This database is separate from every customer database entered in the console. Set the following as Railway service variables:

Variable	Required	Description
AUTH_DATABASE_URL	Yes	Railway PostgreSQL connection URL used only for Database Pilot accounts, sessions, encrypted connection records, and token hashes.
DB_CREDENTIALS_ENCRYPTION_KEY	Yes	Base64 encoding of exactly 32 random bytes used for AES-256-GCM encryption of saved customer connection strings. Generate with openssl rand -base64 32; keep a durable backup because losing it makes saved connections unrecoverable.
SQLITE_DATABASE_ROOT	For SQLite	Directory on a Railway volume containing SQLite files. SQLite paths are restricted to existing files inside this directory; the browser does not upload files.
MCP_ALLOWED_ORIGINS	No	Comma-separated additional browser origins permitted to send MCP requests. Same-origin requests are allowed by default; server-to-server requests without an Origin header are accepted.
DATABASE_QUERY_TIMEOUT_MS	No	Query timeout in milliseconds; defaults to 10,000.
The API creates its prefixed account tables and indexes with additive CREATE TABLE/INDEX IF NOT EXISTS statements when the Railway database is first used. Existing customer databases are never migrated or replaced.

Do not set a shared DATABASE_URL or MCP_AUTH_TOKEN for customer access. Each user enters their own connection in the console, which tests it before saving the encrypted credentials. The service stores only a hash of each MCP token and returns the plaintext token once at creation.

Accounts and connections
Accounts use email and a password of at least 12 characters. Passwords are hashed with scrypt; browser sessions are opaque, stored as hashes, and expire after 14 days. Email verification and password recovery are not configured in this version.

Connection types:

PostgreSQL and CockroachDB (PostgreSQL driver)
MySQL and MariaDB (MySQL driver)
SQLite (existing file under SQLITE_DATABASE_ROOT, opened read-only)
SQL Server (URL or connection string)
Customer databases must be reachable from the Railway service. Use dedicated database credentials with only the read permissions required, and restrict database network access to trusted egress where possible. A hosted connection service is a database proxy: do not enter a connection that you are not authorized to expose to the MCP client.

Agent tools
ask_database — retrieve the most relevant schema for a natural-language question.
database_overview — return database engine, schema names, and sample table names.
list_tables — list tables with optional schema/name filtering.
search_schema — retrieve table schemas matching a business concept or field.
describe_table — return columns and key relationships for one table.
find_table_relationships — find a shortest declared foreign-key path between tables.
sample_table_rows — return a bounded sample of up to 20 rows from one table.
run_readonly_query — run one bounded SELECT or read-only CTE, up to 200 rows.
refresh_schema_index — refresh cached metadata after schema changes.
Read-only query validation rejects writes, multiple statements, locking reads, and selected side-effect functions. PostgreSQL, MySQL, and SQLite use read-only transactions or files where supported. SQL Server connections must use a read-only database account because SQL Server does not provide the same per-transaction read-only enforcement. sample_table_rows returns actual database values to the connected MCP client; use it only when the user asks for examples.

For PostgreSQL use $1, $2, ... placeholders. For MySQL, SQLite, and SQL Server use ? placeholders. Pass values through the tool's parameters.

Connect an MCP client
Create a token in the console and configure a client that supports custom bearer headers with:

URL: https://<your-railway-domain>/api/mcp
Authorization: Bearer <token-shown-once>
Some MCP clients require OAuth discovery and will not accept a custom bearer token. OAuth authorization is not implemented in this version.

Run locally
The web preview is at / and the API preview is at /api. Account and connection operations require AUTH_DATABASE_URL and DB_CREDENTIALS_ENCRYPTION_KEY; no database connection values are required at build time.

pnpm --filter @workspace/database-pilot-console run dev
pnpm --filter @workspace/api-server run dev
Health check: /api/healthz.
