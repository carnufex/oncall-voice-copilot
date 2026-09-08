import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

/** Constant-time comparison of the `X-Oncall-Token` header against TOOL_API_TOKEN (SPEC 2.2). */
export function verifyToolToken(headerValue: string | undefined | null): boolean {
  if (!headerValue) return false;
  const expected = Buffer.from(config.toolApiToken, "utf8");
  const actual = Buffer.from(headerValue, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
