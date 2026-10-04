import type { RequestHandler } from "express";
import { hashOpaqueToken } from "./auth-crypto";
import {
  AuthStoreNotConfiguredError,
  AuthStoreUnavailableError,
  findSession,
  type AccountUser,
} from "./auth-store";

export const sessionCookieName = "database_pilot_session";

declare global {
  namespace Express {
    interface Request {
      accountUser?: AccountUser;
    }
  }
}

export const requireAccount: RequestHandler = async (req, res, next) => {
  const token = req.cookies?.[sessionCookieName];
  if (typeof token !== "string" || token.length < 32) {
    res.status(401).json({ error: "Sign in is required." });
    return;
  }

  try {
    const user = await findSession(hashOpaqueToken(token));
    if (!user) {
      res.status(401).json({ error: "Sign in is required." });
      return;
    }
    req.accountUser = user;
    next();
  } catch (error) {
    if (
      error instanceof AuthStoreNotConfiguredError ||
      error instanceof AuthStoreUnavailableError
    ) {
      res.status(503).json({
        error: "Account storage is unavailable. Configure the Railway auth database.",
      });
      return;
    }
    req.log.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "Could not validate account session",
    );
    res.status(500).json({ error: "The account session could not be checked." });
  }
};

