---
name: Database Pilot data ownership
description: Product scope for customer database drivers and Railway's role in Database Pilot.
---

Database Pilot must preserve PostgreSQL/CockroachDB, MySQL/MariaDB, SQLite, and SQL Server customer connections. Railway PostgreSQL is only for Database Pilot account and authentication data; it must not replace users' databases.

**Why:** The user explicitly required keeping all database types while using Railway for user authentication.

**How to apply:** When changing persistence, auth, or connection setup, keep the auth store separate from each user's selected database and retain all supported customer drivers.