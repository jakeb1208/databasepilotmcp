import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request, type RequestHandler, type Response } from "express";
import {
  GetSessionResponse,
  LoginAccountBody,
  LoginAccountResponse,
  RegisterAccountBody,
  RegisterAccountResponse,
} from "@workspace/api-zod";
import {
  createSessionToken,
  hashOpaqueToken,
  hashPassword,
  verifyPassword,
} from "../lib/auth-crypto";
import { sessionCookieName } from "../lib/auth-middleware";
import {
  AccountEmailConflictError,
  AuthStoreNotConfiguredError,
  AuthStoreUnavailableError,
  createAccount,
  createSession,
  deleteSession,
  findSession,
  findUserByEmail,
} from "../lib/auth-store";

const router: IRouter = Router();
const sessionDurationMs = 14 * 24 * 60 * 60 * 1_000;
const attemptsByIp = new Map<string, { count: number; resetAt: number }>();
const dummyPasswordHash = `scrypt$${Buffer.alloc(16).toString("base64url")}$${Buffer.alloc(64).toString("base64url")}`;

const authRateLimit: RequestHandler = (req, res, next) => {
  const now = Date.now();
  const key = req.ip || "unknown";
  const current = attemptsByIp.get(key);
  const bucket =
    !current || current.resetAt <= now
      ? { count: 0, resetAt: now + 15 * 60 * 1_000 }
      : current;
  bucket.count += 1;
  attemptsByIp.set(key, bucket);

  if (attemptsByIp.size > 5_000) {
    for (const [ip, attempt] of attemptsByIp) {
      if (attempt.resetAt <= now) attemptsByIp.delete(ip);
    }
  }
  if (bucket.count > 10) {
    res.status(429).json({ error: "Too many account attempts. Try again later." });
    return;
  }
  next();
};

function setSessionCookie(req: Request, res: Response, token: string): void {
  res.cookie(sessionCookieName, token, {
    httpOnly: true,
    secure: req.secure || process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    path: "/",
    maxAge: sessionDurationMs,
  });
}

function clearSessionCookie(req: Request, res: Response): void {
  res.clearCookie(sessionCookieName, {
    httpOnly: true,
    secure: req.secure || process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    path: "/",
  });
}

function handleAuthError(req: Request, res: Response, error: unknown): void {
  if (error instanceof AccountEmailConflictError) {
    res.status(409).json({ error: error.message });
    return;
  }
  if (error instanceof AuthStoreNotConfiguredError) {
    res.status(503).json({
      error: "Account storage is not configured. Set AUTH_DATABASE_URL to the Railway PostgreSQL service.",
    });
    return;
  }
  if (error instanceof AuthStoreUnavailableError) {
    res.status(503).json({
      error: "Account storage is unavailable. Check the Railway PostgreSQL connection.",
    });
    return;
  }
  req.log.error(
    { errorName: error instanceof Error ? error.name : "unknown" },
    "Account request failed",
  );
  res.status(500).json({ error: "The account request could not be completed." });
}

router.post("/auth/register", authRateLimit, async (req, res): Promise<void> => {
  const parsed = RegisterAccountBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a valid email and a password with at least 12 characters." });
    return;
  }

  try {
    const email = parsed.data.email.trim().toLowerCase();
    const sessionToken = createSessionToken();
    const user = await createAccount(
      randomUUID(),
      email,
      await hashPassword(parsed.data.password),
      hashOpaqueToken(sessionToken),
      new Date(Date.now() + sessionDurationMs),
    );
    setSessionCookie(req, res, sessionToken);
    res.status(201).json(
      RegisterAccountResponse.parse({ authenticated: true, user }),
    );
  } catch (error) {
    handleAuthError(req, res, error);
  }
});

router.post("/auth/login", authRateLimit, async (req, res): Promise<void> => {
  const parsed = LoginAccountBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a valid email and password." });
    return;
  }

  try {
    const email = parsed.data.email.trim().toLowerCase();
    const user = await findUserByEmail(email);
    const passwordMatches = await verifyPassword(
      parsed.data.password,
      user?.passwordHash ?? dummyPasswordHash,
    );
    if (!user || !passwordMatches) {
      res.status(401).json({ error: "Email or password is incorrect." });
      return;
    }

    const sessionToken = createSessionToken();
    await createSession(
      user.id,
      hashOpaqueToken(sessionToken),
      new Date(Date.now() + sessionDurationMs),
    );
    setSessionCookie(req, res, sessionToken);
    res.json(LoginAccountResponse.parse({
      authenticated: true,
      user: { id: user.id, email: user.email, createdAt: user.createdAt },
    }));
  } catch (error) {
    handleAuthError(req, res, error);
  }
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  const sessionToken = req.cookies?.[sessionCookieName];
  if (typeof sessionToken === "string") {
    try {
      await deleteSession(hashOpaqueToken(sessionToken));
    } catch (error) {
      if (!(error instanceof AuthStoreNotConfiguredError)) {
        req.log.warn(
          { errorName: error instanceof Error ? error.name : "unknown" },
          "Could not remove account session during logout",
        );
      }
    }
  }
  clearSessionCookie(req, res);
  res.sendStatus(204);
});

router.get("/auth/session", async (req, res): Promise<void> => {
  const sessionToken = req.cookies?.[sessionCookieName];
  if (typeof sessionToken !== "string" || sessionToken.length < 32) {
    res.json(GetSessionResponse.parse({ authenticated: false, user: null }));
    return;
  }

  try {
    const user = await findSession(hashOpaqueToken(sessionToken));
    if (!user) clearSessionCookie(req, res);
    res.json(
      GetSessionResponse.parse({
        authenticated: Boolean(user),
        user: user ?? null,
      }),
    );
  } catch (error) {
    handleAuthError(req, res, error);
  }
});

export default router;