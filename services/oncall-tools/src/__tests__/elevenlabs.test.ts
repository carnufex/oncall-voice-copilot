import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyElevenLabsSignature } from "../elevenlabs.js";

const secret = "test-webhook-secret";

function sign(t: string, rawBody: string, key = secret): string {
  const signedPayload = `${t}.${rawBody}`;
  const v0 = createHmac("sha256", key).update(signedPayload).digest("hex");
  return `t=${t},v0=${v0}`;
}

describe("verifyElevenLabsSignature", () => {
  it("accepts a correctly signed payload within the 30 minute window", () => {
    const now = 1700000000;
    const t = String(now - 60);
    const rawBody = JSON.stringify({ type: "post_call_transcription", data: { conversation_id: "conv_1" } });
    const header = sign(t, rawBody);

    expect(verifyElevenLabsSignature({ secret, header, rawBody, now })).toBe(true);
  });

  it("rejects a signature made with the wrong secret", () => {
    const now = 1700000000;
    const t = String(now);
    const rawBody = "{}";
    const header = sign(t, rawBody, "other-secret");

    expect(verifyElevenLabsSignature({ secret, header, rawBody, now })).toBe(false);
  });

  it("rejects a tampered body", () => {
    const now = 1700000000;
    const t = String(now);
    const header = sign(t, '{"a":1}');

    expect(verifyElevenLabsSignature({ secret, header, rawBody: '{"a":2}', now })).toBe(false);
  });

  it("rejects a timestamp older than 30 minutes", () => {
    const now = 1700000000;
    const t = String(now - 30 * 60 - 1);
    const rawBody = "{}";
    const header = sign(t, rawBody);

    expect(verifyElevenLabsSignature({ secret, header, rawBody, now })).toBe(false);
  });

  it("rejects a malformed header", () => {
    expect(verifyElevenLabsSignature({ secret, header: "not-a-valid-header", rawBody: "{}", now: 1700000000 })).toBe(false);
  });
});
