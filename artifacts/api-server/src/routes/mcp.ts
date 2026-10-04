import { createHash, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Router, type IRouter, type RequestHandler } from "express";
import { createDatabasePilotServer } from "../lib/mcp-server";

const router: IRouter = Router();

const authenticate: RequestHandler = (req, res, next) => {
  const expected = process.env["MCP_AUTH_TOKEN"];
  if (!expected || expected.length < 32) {
    res.status(503).json({
      error:
        "MCP server is locked until MCP_AUTH_TOKEN is set to at least 32 characters in Replit Secrets.",
    });
    return;
  }

  const authorization = req.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const supplied = bearer ?? req.get("x-mcp-token") ?? "";
  const expectedDigest = createHash("sha256").update(expected).digest();
  const suppliedDigest = createHash("sha256").update(supplied).digest();

  if (!supplied || !timingSafeEqual(expectedDigest, suppliedDigest)) {
    res.status(401).json({ error: "A valid MCP bearer token is required." });
    return;
  }
  next();
};

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

router.all("/mcp", authenticate, checkOrigin, async (req, res): Promise<void> => {
  const server = createDatabasePilotServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  let closed = false;
  const closeServer = (): void => {
    if (closed) return;
    closed = true;
    void server.close().catch((error: unknown) => {
      req.log.warn({ err: error }, "Could not close MCP request server cleanly");
    });
  };

  transport.onerror = (error) => {
    req.log.error({ err: error }, "MCP transport error");
  };
  res.on("finish", closeServer);
  res.on("close", closeServer);

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    req.log.error({ err: error }, "MCP request failed");
    if (!res.headersSent) {
      res.status(500).json({ error: "The MCP request could not be completed." });
    } else if (!res.writableEnded) {
      res.end();
    }
    closeServer();
  }
});

export default router;