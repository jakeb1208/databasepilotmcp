import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import type { DatabaseKind } from "./database/types";

export class CredentialEncryptionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialEncryptionConfigurationError";
  }
}

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      64,
      { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derivePassword(password, salt);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  const [algorithm, saltText, hashText] = encodedHash.split("$");
  if (algorithm !== "scrypt" || !saltText || !hashText) return false;
  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(hashText, "base64url");
    if (salt.length !== 16 || expected.length !== 64) return false;
    const actual = await derivePassword(password, salt);
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function createSessionToken(): string {
  return `dps_${randomBytes(32).toString("base64url")}`;
}

export function createApiToken(): string {
  return `dp_${randomBytes(32).toString("base64url")}`;
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function encryptionKey(): Buffer {
  const encoded = process.env["DB_CREDENTIALS_ENCRYPTION_KEY"]?.trim();
  if (!encoded) {
    throw new CredentialEncryptionConfigurationError(
      "DB_CREDENTIALS_ENCRYPTION_KEY is not configured.",
    );
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new CredentialEncryptionConfigurationError(
      "DB_CREDENTIALS_ENCRYPTION_KEY must encode exactly 32 bytes.",
    );
  }
  return key;
}

export function encryptConnectionString(connectionString: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(connectionString, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptConnectionString(payload: string): string {
  const [version, ivText, tagText, ciphertextText] = payload.split(".");
  if (version !== "v1" || !ivText || !tagText || ciphertextText === undefined) {
    throw new Error("Saved database credentials have an unsupported format.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivText, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function isDatabaseKind(value: unknown): value is DatabaseKind {
  return (
    value === "postgres" ||
    value === "mysql" ||
    value === "sqlite" ||
    value === "sqlserver"
  );
}
