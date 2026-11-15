import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

/** Constant-time comparison of the `X-Oncall-Token` header against TOOL_API_TOKEN (SPEC 2.2). */
export function verifyToolToken(headerValue: string | undefined | null): boolean {
  if (!headerValue) return false;
  const expected = Buffer.from(config.toolApiToken, "utf8");
  const actual = Buffer.from(headerValue, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/**
 * Constant-time check of an `Authorization: Bearer <token>` header against `expected`. Both sides
 * are hashed first, so neither the comparison nor an early length check leaks the token's length.
 */
export function verifyBearer(headerValue: string | undefined | null, expected: string): boolean {
  if (!headerValue) return false;
  const m = headerValue.match(/^Bearer[ ]+(\S+)[ ]*$/i);
  if (!m) return false;
  const a = createHash("sha256").update(m[1]!, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
