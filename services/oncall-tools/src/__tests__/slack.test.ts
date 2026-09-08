import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySlackSignature } from "../slack.js";

const signingSecret = "test-signing-secret";

function sign(timestamp: string, rawBody: string, secret = signingSecret): string {
  const base = `v0:${timestamp}:${rawBody}`;
  return `v0=${createHmac("sha256", secret).update(base).digest("hex")}`;
}

describe("verifySlackSignature", () => {
  it("accepts a correctly signed request within the time window", () => {
    const now = 1700000000;
    const timestamp = String(now - 5);
    const rawBody = "command=%2Foncall&text=drill";
    const signature = sign(timestamp, rawBody);

    expect(verifySlackSignature({ signingSecret, timestamp, rawBody, signature, now })).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const now = 1700000000;
    const timestamp = String(now);
    const rawBody = "command=%2Foncall&text=drill";
    const signature = sign(timestamp, rawBody, "wrong-secret");

    expect(verifySlackSignature({ signingSecret, timestamp, rawBody, signature, now })).toBe(false);
  });

  it("rejects a tampered body", () => {
    const now = 1700000000;
    const timestamp = String(now);
    const signature = sign(timestamp, "command=%2Foncall&text=drill", signingSecret);

    expect(verifySlackSignature({ signingSecret, timestamp, rawBody: "command=%2Foncall&text=reset", signature, now })).toBe(false);
  });

  it("rejects a timestamp older than the 5 minute tolerance", () => {
    const now = 1700000000;
    const timestamp = String(now - 301);
    const rawBody = "command=%2Foncall&text=drill";
    const signature = sign(timestamp, rawBody);

    expect(verifySlackSignature({ signingSecret, timestamp, rawBody, signature, now })).toBe(false);
  });

  it("accepts a timestamp exactly at the tolerance boundary", () => {
    const now = 1700000000;
    const timestamp = String(now - 300);
    const rawBody = "command=%2Foncall&text=drill";
    const signature = sign(timestamp, rawBody);

    expect(verifySlackSignature({ signingSecret, timestamp, rawBody, signature, now })).toBe(true);
  });
});
