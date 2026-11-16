import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { config } from "./config.js";
import { logger } from "./log.js";

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

/**
 * The guard of the routes Lots calls in the cluster (/drill/*, /ops/*): `Authorization: Bearer <DRILL_API_TOKEN>`.
 * Without DRILL_API_TOKEN (or "unset") they answer 404, the feature is off; a wrong or missing bearer is 401.
 * `label` names the route family in the log line.
 */
export function requireDrillBearer(label: string): MiddlewareHandler {
  return async (c, next) => {
    const expected = config.drillApiToken;
    if (!expected) return c.json({ error: "not_found" }, 404);
    if (!verifyBearer(c.req.header("Authorization"), expected)) {
      logger.warn({ path: c.req.path }, `${label}: refused, wrong or missing bearer`);
      return c.text("Unauthorized.", 401);
    }
    await next();
  };
}
