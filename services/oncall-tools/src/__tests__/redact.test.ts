import { describe, expect, it } from "vitest";
import { redact, redactLines } from "../redact.js";

describe("redact", () => {
  it("redacts password= and token= style key-value pairs", () => {
    expect(redact("connect with password=hunter2 now")).toBe("connect with [REDACTED] now");
    expect(redact("auth token=abc.def.ghi here")).toBe("auth [REDACTED] here");
  });

  it("redacts Authorization: Bearer tokens", () => {
    expect(redact("Authorization: Bearer abc123XYZ-_")).toBe("Authorization: [REDACTED]");
  });

  it("redacts Slack bot/user tokens", () => {
    expect(redact("token is xoxb-123456-abcdef")).toBe("token is [REDACTED]");
    expect(redact("xoxp-111-222-333")).toBe("[REDACTED]");
  });

  it("redacts GitHub tokens (classic and fine-grained)", () => {
    expect(redact("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe("[REDACTED]");
    expect(redact("github_pat_abcDEF123_moreStuff")).toBe("[REDACTED]");
  });

  it("redacts AWS access key ids", () => {
    expect(redact("key AKIAABCDEFGHIJKLMNOP done")).toBe("key [REDACTED] done");
  });

  it("redacts JWT-like strings", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(redact(`bearer-less ${jwt} end`)).toBe("bearer-less [REDACTED] end");
  });

  it("redacts URL credentials", () => {
    expect(redact("postgres://user:pass@db.internal:5432/app")).toBe("postgres[REDACTED]db.internal:5432/app");
  });

  it("leaves ordinary text untouched", () => {
    const line = "demo-api 1.1.0 starting, listening on :8080";
    expect(redact(line)).toBe(line);
  });

  it("redactLines maps over an array preserving order and length", () => {
    const lines = ["hello world", "password=secret123", "goodbye"];
    expect(redactLines(lines)).toEqual(["hello world", "[REDACTED]", "goodbye"]);
  });
});
