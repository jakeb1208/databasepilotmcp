import { Router, type IRouter, type RequestHandler } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createDatabasePilotServer } from "../lib/mcp-server";
import {
  CredentialEncryptionConfigurationError,
  decryptConnectionString,
  hashOpaqueToken,
} from "../lib/auth-crypto";
import {
  AuthStoreNotConfiguredError,
  AuthStoreUnavailableError,
  findMcpToken,
  touchMcpToken,
  type McpTokenIdentity,
} from "../lib/auth-store";
import {
  ConnectionInputError,
  ConnectionServerConfigurationError,
  prepareConnectionString,
} from "../lib/database/connection-config";
import { createDatabaseAdapter } from "../lib/database/drivers";
import type { DatabaseAdapter } from "../lib/database/types";

const router: IRouter = Router();
const rateByToken = new Map<string, { count: number; resetAt: number }>();

const checkOrigin: RequestHandler = (req, res, next) => {
  const origin = req.get("origin");
  if (!origin) {
    next();
    return;
  }

  const configuredOrigins = (process.env["MCP_ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    res.status(403).json({ error: "The MCP request origin is invalid." });
    return;
  }

  const sameOrigin = originUrl.host === req.get("host");
  const explicitlyAllowed = configuredOrigins.includes(origin);
  if (!sameOrigin && !explicitlyAllowed) {
    res.status(403).json({
      error:
        "The MCP request origin is not allowed. Add it to MCP_ALLOWED_ORIGINS if this browser client is trusted.",
    });
    return;
  }
  next();
};

function isRateLimited(tokenId: string): boolean {
  const now = Date.now();
  const current = rateByToken.get(tokenId);
  const bucket =
    !current || current.resetAt <= now
      ? { count: 0, resetAt: now + 60_000 }
      : current;
  bucket.count += 1;
  rateByToken.set(tokenId, bucket);
  if (rateByToken.size > 5_000) {
    for (const [id, value] of rateByToken) {
      if (value.resetAt <= now) rateByToken.delete(id);
    }
  }
  return bucket.count > 120;
}

router.all("/mcp", checkOrigin, async (req, res): Promise<void> => {
  const authorization = req.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const supplied = bearer ?? req.get("x-mcp-token") ?? "";
  if (supplied.length < 32) {
    res.status(401).json({ error: "A valid Database Pilot bearer token is required." });
    return;
  }

  let identity: McpTokenIdentity | null;
  try {
    identity = await findMcpToken(hashOpaqueToken(supplied));
  } catch (error) {
    if (
      error instanceof AuthStoreNotConfiguredError ||
      error instanceof AuthStoreUnavailableError
    ) {
      res.status(503).json({ error: "MCP token storage is unavailable." });
      return;
    }
    req.log.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "Could not authenticate MCP request",
    );
    res.status(500).json({ error: "MCP authentication could not be completed." });
    return;
  }

  if (!identity) {
    res.status(401).json({ error: "A valid Database Pilot bearer token is required." });
    return;
  }
  const tokenIdentity = identity;
  if (isRateLimited(tokenIdentity.id)) {
    res.status(429).json({ error: "This MCP token is making too many requests." });
    return;
  }

  let connectionString: string;
  try {
    if (!(await touchMcpToken(tokenIdentity.id))) {
      res.status(401).json({ error: "A valid Database Pilot bearer token is required." });
      return;
    }
    connectionString = await prepareConnectionString(
      tokenIdentity.databaseType,
      decryptConnectionString(tokenIdentity.encryptedConnection),
    );
  } catch (error) {
    if (
      error instanceof AuthStoreNotConfiguredError ||
      error instanceof AuthStoreUnavailableError ||
      error instanceof CredentialEncryptionConfigurationError ||
      error instanceof ConnectionServerConfigurationError
    ) {
      res.status(503).json({ error: "The saved MCP connection is not available." });
      return;
    }
    if (error instanceof ConnectionInputError) {
      res.status(503).json({ error: "The saved database connection needs to be updated." });
      return;
    }
    req.log.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "Could not load MCP connection configuration",
    );
    res.status(500).json({ error: "The saved MCP connection could not be loaded." });
    return;
  }

  let adapterPromise: Promise<DatabaseAdapter> | undefined;
  const server = createDatabasePilotServer({
    connectionId: tokenIdentity.connectionId,
    getAdapter: () => {
      if (!adapterPromise) {
        adapterPromise = createDatabaseAdapter(tokenIdentity.databaseType, connectionString);
      }
      return adapterPromise;
    },
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  let closed = false;
  const closeResources = (): void => {
    if (closed) return;
    closed = true;
    void (async () => {
      await server.close().catch((error: unknown) => {
        req.log.warn(
          { errorName: error instanceof Error ? error.name : "unknown" },
          "Could not close MCP request server cleanly",
        );
      });
      if (adapterPromise) {
        try {
          const adapter = await adapterPromise;
          await adapter.close();
        } catch {
          // A pool that failed to open has no live resources to close.
        }
      }
    })();
  };

  transport.onerror = (error) => {
    req.log.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "MCP transport error",
    );
  };
  res.on("finish", closeResources);
  res.on("close", closeResources);

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    req.log.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "MCP request failed",
    );
    if (!res.headersSent) {
      res.status(500).json({ error: "The MCP request could not be completed." });
    } else if (!res.writableEnded) {
      res.end();
    }
    closeResources();
  }
});

export default router;