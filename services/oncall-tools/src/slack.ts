import { createHmac, timingSafeEqual } from "node:crypto";
import { WebClient } from "@slack/web-api";
import { config, isSlackEnabled, warnOnce } from "./config.js";
import { logger } from "./log.js";
import type { Incident } from "./types.js";

const SLACK_TIMESTAMP_TOLERANCE_SECONDS = 300;

let lastDrillUserId: string | undefined;
/** Remembers who ran the last /oncall drill so the Slack call card can be attributed to them. */
export function setLastDrillUserId(userId: string | undefined): void {
  if (userId) lastDrillUserId = userId;
}
export function getLastDrillUserId(): string | undefined {
  return lastDrillUserId;
}

export function verifySlackSignature(params: {
  signingSecret: string;
  timestamp: string;
  rawBody: string;
  signature: string;
  now?: number;
}): boolean {
  const { signingSecret, timestamp, rawBody, signature, now = Date.now() / 1000 } = params;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now - ts) > SLACK_TIMESTAMP_TOLERANCE_SECONDS) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;

  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signature, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

let client: WebClient | undefined;
function getClient(): WebClient | undefined {
  if (!isSlackEnabled()) {
    warnOnce("slack-disabled", "Slack integration disabled: SLACK_BOT_TOKEN/SLACK_SIGNING_SECRET/SLACK_CHANNEL_ID not set", logger);
    return undefined;
  }
  if (!client) client = new WebClient(config.slackBotToken);
  return client;
}

export async function postAlert(incident: Incident): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    const openedAt = new Date(incident.opened_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: config.localTimezone });
    const result = await c.chat.postMessage({
      channel: config.slackChannelId!,
      text: `CrashLoopBackOff: ${incident.service} (${incident.namespace})`,
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: `:rotating_light: CrashLoopBackOff: ${incident.service} (${incident.namespace})` },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Service:*\n${incident.service}` },
            { type: "mrkdwn", text: `*Namespace:*\n${incident.namespace}` },
            { type: "mrkdwn", text: `*Pod:*\n${incident.alert.pod ?? "unknown"}` },
            { type: "mrkdwn", text: `*Restarts:*\n${incident.alert.restarts ?? "unknown"}` },
            { type: "mrkdwn", text: `*Since:*\n${openedAt}` },
          ],
        },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `Incident ${incident.id}` }],
        },
      ],
    });
    if (!result.ts) return;
    incident.slack = { channel: config.slackChannelId!, thread_ts: result.ts };

    await postCall(incident);
  } catch (err) {
    logger.warn({ err }, "Failed to post Slack alert");
  }
}

async function postCall(incident: Incident): Promise<void> {
  const c = getClient();
  if (!c || !incident.slack) return;
  const joinUrl = `${config.publicBaseUrl}/call/${incident.id}`;
  try {
    // calls.add with a bot token requires created_by (a Slack user id): the engineer who ran
    // the last /oncall drill, or SLACK_CALL_CREATED_BY as a fallback.
    const createdBy = getLastDrillUserId() ?? config.slackCallCreatedBy;
    if (!createdBy) throw new Error("no created_by user id available for calls.add");
    const call = await c.calls.add({
      external_unique_id: incident.id,
      join_url: joinUrl,
      title: `On-call copilot: ${incident.service} ${incident.alert.reason}`,
      external_display_id: incident.id,
      created_by: createdBy,
    } as Parameters<WebClient["calls"]["add"]>[0]);
    const callId = (call as { call?: { id?: string } }).call?.id;
    if (callId) {
      incident.slack.call_id = callId;
      await c.chat.postMessage({
        channel: incident.slack.channel,
        thread_ts: incident.slack.thread_ts,
        text: "Join the on-call copilot call",
        blocks: [{ type: "call", call_id: callId }],
      } as unknown as Parameters<WebClient["chat"]["postMessage"]>[0]);
    } else {
      throw new Error("calls.add returned no call id");
    }
  } catch (err) {
    logger.warn({ err }, "calls.add failed, falling back to a link button");
    await c.chat.postMessage({
      channel: incident.slack.channel,
      thread_ts: incident.slack.thread_ts,
      text: "Join the on-call copilot call",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "Join the on-call copilot call" },
          accessory: { type: "button", text: { type: "plain_text", text: "Join call" }, url: joinUrl },
        },
      ],
    });
  }
}

export async function postThreadMessage(incident: Incident, text: string): Promise<void> {
  const c = getClient();
  if (!c || !incident.slack) return;
  try {
    await c.chat.postMessage({ channel: incident.slack.channel, thread_ts: incident.slack.thread_ts, text });
  } catch (err) {
    logger.warn({ err }, "Failed to post Slack thread message");
  }
}

export async function endCall(incident: Incident): Promise<void> {
  const c = getClient();
  if (!c || !incident.slack?.call_id) return;
  try {
    await c.calls.end({ id: incident.slack.call_id });
  } catch (err) {
    logger.warn({ err }, "Failed to end Slack call");
  }
}

export function getSlackClientOrUndefined(): WebClient | undefined {
  return getClient();
}
