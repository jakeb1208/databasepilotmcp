# Database Pilot

**Human-written README — Jake Bergeron**

Database Pilot is a multi-user MCP server with read-only database tools. It gives AI agents scoped access to a selected database so they can answer developers' questions about its schema and data without exposing saved connection credentials.

## Live app

- Dashboard: https://workspaceapi-server-production-811c.up.railway.app/
- MCP endpoint: https://workspaceapi-server-production-811c.up.railway.app/api/mcp

## First test

I connected a Supabase PostgreSQL database from another project to Database Pilot, created a token, and connected it to Replit as an MCP server. Replit Agent successfully returned table names from the database's `public` schema and sample records.

## Features

- Multi-user accounts with individually saved database connections
- Per-connection MCP tokens, shown once and revocable
- Encrypted saved connection strings
- Read-only tools for listing tables, searching and describing schemas, finding table relationships, sampling rows, and running bounded queries
- Support for PostgreSQL/CockroachDB, MySQL/MariaDB, SQLite, and SQL Server

## Quick demo

1. Create an account in the Database Pilot dashboard.
2. Add a database connection, test it, and save it.
3. Create a token scoped to that connection.
4. Add the MCP endpoint and an `Authorization: Bearer <token>` header in an MCP-compatible agent.
5. Ask the agent a question about the connected database.

Use database credentials with read-only permissions. The MCP tools are designed for read-only access; they do not provide database write operations.

## About

This was my first MCP server. I built it in about 3–3.5 hours with Replit Free.

For deployment variables and local development instructions, see the [API server README](artifacts/api-server/README.md).