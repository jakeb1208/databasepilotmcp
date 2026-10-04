# Database Pilot MCP

Database Pilot is a server-side Model Context Protocol (MCP) service for AI
agents. An agent starts with a natural-language question, retrieves only the
matching table definitions, runs a bounded read-only query, and answers from
the returned rows.

Schema retrieval uses a local in-memory TF-IDF index with lightweight concept
expansion. It needs no paid embedding API or hosted vector database. The MCP
server does not include an LLM: the agent that connects to it uses its existing
model to turn the question and retrieved schema into a query.

## MCP endpoint

The Streamable HTTP endpoint is:

```text
/api/mcp
```

The service is stateless over HTTP. MCP clients send
`Authorization: Bearer <MCP_AUTH_TOKEN>` on each request.

## Configure a database

Set these through Replit Secrets or the environment used to run the service.
Never put database credentials in source code or chat.

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Driver connection URL or SQLite file path. Store URLs containing credentials as a secret. |
| `DATABASE_TYPE` | No | `postgres`, `mysql`, `sqlite`, or `sqlserver`. Usually inferred from the URL scheme. CockroachDB uses the PostgreSQL driver. |
| `MCP_AUTH_TOKEN` | Yes | A private bearer token of at least 32 characters protecting the MCP endpoint. |
| `MCP_ALLOWED_ORIGINS` | No | Comma-separated browser origins allowed to call MCP. Server-to-server requests without an `Origin` header are accepted. By default, browser requests must be same-origin. |
| `DATABASE_QUERY_TIMEOUT_MS` | No | Query timeout in milliseconds for supported drivers; defaults to 10,000. |

Supported database URL schemes:

- PostgreSQL: `postgres://` or `postgresql://`
- CockroachDB: `cockroach://` or `cockroachdb://`, or set `DATABASE_TYPE=postgres`
- MySQL: `mysql://`
- MariaDB: `mariadb://`
- SQLite: `sqlite:./path/to/database.sqlite`, `sqlite:///absolute/path/to/database.sqlite`, or `file:./path/to/database.sqlite`
- SQL Server: `mssql://` or `sqlserver://`; alternatively set `DATABASE_TYPE=sqlserver` and provide a SQL Server connection string

SQLite opens an existing database file in read-only mode. It does not create a
missing database file.

## Agent tools

- `ask_database` — retrieves the most relevant schema for a natural-language question and tells the agent to query and answer from the results.
- `database_overview` — returns the engine, schema names, and up to 50 table names.
- `search_schema` — searches the local schema index.
- `describe_table` — returns one table's columns and key relationships.
- `run_readonly_query` — runs one bounded `SELECT` or read-only CTE, with a maximum of 200 returned rows.
- `refresh_schema_index` — refreshes metadata after schema changes.

The query tool rejects writes, multiple statements, locking reads, and selected
side-effect functions. It also uses read-only transactions or a read-only
SQLite connection where supported. Use a database login that has only the
minimum read permissions required; SQL Server credentials in particular must
be read-only because SQL Server does not offer the same per-transaction
read-only enforcement.

For PostgreSQL, use `$1`, `$2`, ... placeholders. For MySQL, SQLite, and SQL
Server, use `?` placeholders. Pass the matching values in `parameters`.

## Run and check

```sh
pnpm --filter @workspace/api-server run dev
```

The health check is `/api/healthz`. The MCP endpoint is `/api/mcp`.