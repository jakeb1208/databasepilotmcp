# Database Pilot MCP

Database Pilot is a server-side MCP service that helps AI agents answer natural-language questions about relational databases using locally indexed schemas and bounded read-only queries.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API and MCP server
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required secrets: `DATABASE_URL`, `MCP_AUTH_TOKEN`
- Optional env: `DATABASE_TYPE`, `MCP_ALLOWED_ORIGINS`, `DATABASE_QUERY_TIMEOUT_MS`
- MCP endpoint: `/api/mcp`; health check: `/api/healthz`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API and MCP transport: Express 5, Streamable HTTP
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Database Pilot drivers: PostgreSQL/CockroachDB, MySQL/MariaDB, SQLite, SQL Server

## Where things live

- `artifacts/api-server/src/lib/database/` — database adapters, schema metadata, and read-only query checks
- `artifacts/api-server/src/lib/schema-index.ts` — local schema retrieval index
- `artifacts/api-server/src/lib/mcp-server.ts` — MCP tools exposed to agent clients
- `artifacts/api-server/src/routes/mcp.ts` — authenticated Streamable HTTP endpoint
- `artifacts/api-server/README.md` — database setup and MCP client guidance

## Architecture decisions

- The MCP server does not call an LLM or hosted embedding service. The connected AI agent handles natural-language-to-SQL using retrieved schema, keeping server-side AI and vector-store costs out of the app.
- Schema retrieval is a local, in-memory sparse-vector index; it stores metadata, not database rows.
- The MCP endpoint fails closed until `MCP_AUTH_TOKEN` is configured. Configure database credentials as environment secrets and use a read-only database account.

## Product

- AI agents can retrieve relevant schema context, inspect tables, execute bounded read-only queries, and refresh the schema index.

## User preferences

- Keep the service free to run for all users; do not make paid LLM or hosted vector-store services a runtime requirement.

## Gotchas

- SQLite uses Node's built-in `node:sqlite` driver and requires an existing database file; it opens the file read-only.
- SQL Server must use a database login with read-only permissions because its transaction API does not enforce read-only mode.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
