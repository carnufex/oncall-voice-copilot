import { createHmac, timingSafeEqual } from "node:crypto";
import { config, isElevenLabsEnabled, warnOnce } from "./config.js";
import { logger } from "./log.js";

const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 30 * 60;

/**
 * Verifies the `ElevenLabs-Signature` header on the post-call webhook.
 * Format: "t=<unix_seconds>,v0=<hex hmac-sha256 of `${t}.${rawBody}`>".
 * See docs/SPEC.md section 2.2 and 2.8.
 */
export function verifyElevenLabsSignature(params: {
  secret: string;
  header: string;
  rawBody: string;
  now?: number;
}): boolean {
  const { secret, header, rawBody, now = Date.now() / 1000 } = params;

  const parts = Object.fromEntries(
    header
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const idx = p.indexOf("=");
        return [p.slice(0, idx), p.slice(idx + 1)];
      }),
  );
  const t = parts["t"];
  const v0 = parts["v0"];
  if (!t || !v0) return false;

  const ts = Number(t);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now - ts) > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) return false;

  const signedPayload = `${t}.${rawBody}`;
  const expected = createHmac("sha256", secret).update(signedPayload).digest("hex");

  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(v0, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

export type ConversationTokenResult = {
  conversation_token: string;
  conversation_id?: string;
};

/**
 * Mints a WebRTC conversation token via
 * GET https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=<id>
 * (verified against the installed @elevenlabs/react 1.15.2 / @elevenlabs/client 1.25.0 typings
 * and the ElevenLabs API reference: response is `{ token, conversation_id }`; we rename `token`
 * to `conversation_token` for our own /api response contract, see docs/SPEC.md section 2.7).
 */
export async function mintConversationToken(): Promise<ConversationTokenResult | undefined> {
  if (!isElevenLabsEnabled()) {
    warnOnce(
      "elevenlabs-disabled",
      "ElevenLabs integration disabled: ELEVENLABS_API_KEY/ELEVENLABS_AGENT_ID not set",
      logger,
    );
    return undefined;
  }
  const url = new URL("https://api.elevenlabs.io/v1/convai/conversation/token");
  url.searchParams.set("agent_id", config.elevenlabsAgentId!);

  const res = await fetch(url, {
    method: "GET",
    headers: { "xi-api-key": config.elevenlabsApiKey! },
  });
  if (!res.ok) {
    logger.warn({ status: res.status, body: await res.text().catch(() => "") }, "ElevenLabs token request failed");
    return undefined;
  }
  const body = (await res.json()) as { token?: string; conversation_id?: string };
  if (!body.token) {
    logger.warn({ body }, "ElevenLabs token response missing token field");
    return undefined;
  }
  return { conversation_token: body.token, conversation_id: body.conversation_id };
}
