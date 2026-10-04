import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import {
  CreateTokenBody,
  CreateTokenResponse,
  ListTokensResponse,
  RevokeTokenParams,
} from "@workspace/api-zod";
import { createApiToken, hashOpaqueToken } from "../lib/auth-crypto";
import { requireAccount } from "../lib/auth-middleware";
import {
  createToken,
  listTokens,
  revokeToken,
} from "../lib/auth-store";

const router: IRouter = Router();

router.get("/tokens", requireAccount, async (req, res): Promise<void> => {
  try {
    res.json(ListTokensResponse.parse(await listTokens(req.accountUser!.id)));
  } catch (error) {
    req.log.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "Could not list MCP tokens",
    );
    res.status(500).json({ error: "MCP tokens could not be loaded." });
  }
});

router.post("/tokens", requireAccount, async (req, res): Promise<void> => {
  const parsed = CreateTokenBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Choose a saved connection and enter a token label." });
    return;
  }
  const label = parsed.data.label.trim();
  if (!label) {
    res.status(400).json({ error: "Enter a label for this token." });
    return;
  }

  try {
    const token = createApiToken();
    const tokenInfo = await createToken(
      req.accountUser!.id,
      randomUUID(),
      parsed.data.connectionId,
      label,
      hashOpaqueToken(token),
      token.slice(0, 11),
    );
    if (!tokenInfo) {
      res.status(404).json({ error: "Database connection not found." });
      return;
    }
    res.status(201).json(
      CreateTokenResponse.parse({ token, tokenInfo }),
    );
  } catch (error) {
    req.log.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "Could not create MCP token",
    );
    res.status(500).json({ error: "MCP token could not be created." });
  }
});

router.delete("/tokens/:tokenId", requireAccount, async (req, res): Promise<void> => {
  const parsed = RevokeTokenParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "The token ID is invalid." });
    return;
  }
  try {
    const revoked = await revokeToken(req.accountUser!.id, parsed.data.tokenId);
    if (!revoked) {
      res.status(404).json({ error: "MCP token not found." });
      return;
    }
    res.sendStatus(204);
  } catch (error) {
    req.log.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "Could not revoke MCP token",
    );
    res.status(500).json({ error: "MCP token could not be revoked." });
  }
});

export default router;