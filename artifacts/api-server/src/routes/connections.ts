import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import {
  CreateConnectionBody,
  CreateConnectionResponse,
  DeleteConnectionParams,
  ListConnectionsResponse,
  TestConnectionBody,
  TestConnectionResponse,
} from "@workspace/api-zod";
import {
  CredentialEncryptionConfigurationError,
  encryptConnectionString,
} from "../lib/auth-crypto";
import { requireAccount } from "../lib/auth-middleware";
import {
  createConnection,
  deleteConnection,
  listConnections,
} from "../lib/auth-store";
import {
  ConnectionInputError,
  ConnectionServerConfigurationError,
  prepareConnectionString,
} from "../lib/database/connection-config";
import { createDatabaseAdapter } from "../lib/database/drivers";
import type { DatabaseKind } from "../lib/database/types";

const router: IRouter = Router();

async function testDatabase(
  databaseType: DatabaseKind,
  connectionString: string,
): Promise<{ success: true; databaseType: DatabaseKind; schemaCount: number; tableCount: number; message: string }> {
  const adapter = await createDatabaseAdapter(databaseType, connectionString);
  try {
    const tables = await adapter.getSchema();
    return {
      success: true,
      databaseType,
      schemaCount: new Set(tables.map((table) => table.schema)).size,
      tableCount: tables.length,
      message: "Connection successful.",
    };
  } finally {
    await adapter.close().catch(() => undefined);
  }
}

router.get("/connections", requireAccount, async (req, res): Promise<void> => {
  try {
    const connections = await listConnections(req.accountUser!.id);
    res.json(ListConnectionsResponse.parse(connections));
  } catch (error) {
    req.log.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "Could not list database connections",
    );
    res.status(500).json({ error: "Database connections could not be loaded." });
  }
});

router.post("/connections/test", requireAccount, async (req, res): Promise<void> => {
  const parsed = TestConnectionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Check the database type and connection string." });
    return;
  }

  try {
    const connectionString = await prepareConnectionString(
      parsed.data.databaseType,
      parsed.data.connectionString,
    );
    const result = await testDatabase(parsed.data.databaseType, connectionString);
    res.json(TestConnectionResponse.parse(result));
  } catch (error) {
    if (error instanceof ConnectionInputError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof ConnectionServerConfigurationError) {
      res.status(503).json({ error: error.message });
      return;
    }
    req.log.warn(
      { databaseType: parsed.data.databaseType },
      "Database connection test failed",
    );
    res.status(422).json({
      error: "Connection failed. Check the host, credentials, network access, and database permissions.",
    });
  }
});

router.post("/connections", requireAccount, async (req, res): Promise<void> => {
  const parsed = CreateConnectionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a name, database type, and valid connection string." });
    return;
  }
  const name = parsed.data.name.trim();
  if (!name) {
    res.status(400).json({ error: "Enter a name for this connection." });
    return;
  }

  try {
    const connectionString = await prepareConnectionString(
      parsed.data.databaseType,
      parsed.data.connectionString,
    );
    const encryptedConnection = encryptConnectionString(connectionString);
    const test = await testDatabase(parsed.data.databaseType, connectionString);
    if (!test.success) {
      res.status(422).json({ error: "The database connection test did not succeed." });
      return;
    }
    const connection = await createConnection(
      req.accountUser!.id,
      randomUUID(),
      name,
      parsed.data.databaseType,
      encryptedConnection,
    );
    res.status(201).json(CreateConnectionResponse.parse(connection));
  } catch (error) {
    if (error instanceof ConnectionInputError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (
      error instanceof ConnectionServerConfigurationError ||
      error instanceof CredentialEncryptionConfigurationError
    ) {
      res.status(503).json({ error: error.message });
      return;
    }
    req.log.warn(
      { databaseType: parsed.data.databaseType },
      "Database connection test or save failed",
    );
    res.status(422).json({
      error: "Connection failed. Check the host, credentials, network access, and database permissions.",
    });
  }
});

router.delete(
  "/connections/:connectionId",
  requireAccount,
  async (req, res): Promise<void> => {
    const parsed = DeleteConnectionParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: "The connection ID is invalid." });
      return;
    }
    try {
      const deleted = await deleteConnection(req.accountUser!.id, parsed.data.connectionId);
      if (!deleted) {
        res.status(404).json({ error: "Database connection not found." });
        return;
      }
      res.sendStatus(204);
    } catch (error) {
      req.log.error(
        { errorName: error instanceof Error ? error.name : "unknown" },
        "Could not delete database connection",
      );
      res.status(500).json({ error: "Database connection could not be deleted." });
    }
  },
);

export default router;