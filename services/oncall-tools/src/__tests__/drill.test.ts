import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// POST /drill/break|reset (a Lots alert source's drill button) and the Slack commands that share their
// logic. GitHub (commitImageChange) and ArgoCD (requestArgoCdRefresh) are stubbed; FileDriftedError and the
// rest of github.ts are real. Each test imports the routes fresh, so config.ts reads the env it sets.

const { commitImageChange, requestArgoCdRefresh, postThreadMessage, endCall } = vi.hoisted(() => ({
  commitImageChange: vi.fn(),
  requestArgoCdRefresh: vi.fn(),
  postThreadMessage: vi.fn(),
  endCall: vi.fn(),
}));

vi.mock("../github.js", async (importActual) => ({ ...(await importActual<typeof import("../github.js")>()), commitImageChange }));
vi.mock("../argocd.js", () => ({ requestArgoCdRefresh }));
vi.mock("../slack.js", async (importActual) => ({ ...(await importActual<typeof import("../slack.js")>()), postThreadMessage, endCall }));

const DRILL_TOKEN = "drill-test-token";
const GOOD = "registry.rosenvall.se/carnufex/oncall-demo-api:1.0.0";
const BAD = "registry.rosenvall.se/carnufex/oncall-demo-api:1.1.0";

function commit(sha: string, message = "m") {
  return { sha, short_sha: sha.slice(0, 7), url: `https://github.example.test/commit/${sha}`, message };
}

async function drillApp(token: string | undefined) {
  if (token === undefined) delete process.env.DRILL_API_TOKEN;
  else process.env.DRILL_API_TOKEN = token;
  vi.resetModules();
  const { drillRoute } = await import("../routes/drill.js");
  return drillRoute;
}

type App = { request: (path: string, init: RequestInit) => Response | Promise<Response> };

function post(app: App, path: string, bearer?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearer !== undefined) headers.Authorization = `Bearer ${bearer}`;
  return app.request(path, { method: "POST", headers, body: JSON.stringify({ source: "homelab-alertmanager" }) });
}

beforeEach(() => {
  commitImageChange.mockReset();
  requestArgoCdRefresh.mockReset().mockResolvedValue({ ok: true });
  postThreadMessage.mockReset().mockResolvedValue(undefined);
  endCall.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.DRILL_API_TOKEN;
});

describe("POST /drill/*: the feature switch and the bearer", () => {
  it("answers 404 when DRILL_API_TOKEN is not set", async () => {
    const app = await drillApp(undefined);
    expect((await post(app, "/break", DRILL_TOKEN)).status).toBe(404);
    expect((await post(app, "/reset", DRILL_TOKEN)).status).toBe(404);
    expect(commitImageChange).not.toHaveBeenCalled();
  });

  it("answers 404 when DRILL_API_TOKEN is the placeholder unset", async () => {
    const app = await drillApp("unset");
    expect((await post(app, "/break", "unset")).status).toBe(404);
    expect(commitImageChange).not.toHaveBeenCalled();
  });

  it("answers 401 for a wrong or missing bearer, and commits nothing", async () => {
    const app = await drillApp(DRILL_TOKEN);
    expect((await post(app, "/break", "wrong-token")).status).toBe(401);
    expect((await post(app, "/reset", `${DRILL_TOKEN}x`)).status).toBe(401);
    expect((await post(app, "/break")).status).toBe(401);
    // The tool token is not a way in.
    const tool = await app.request("/break", { method: "POST", headers: { "X-Oncall-Token": "test-token" } });
    expect(tool.status).toBe(401);
    expect(commitImageChange).not.toHaveBeenCalled();
  });
});

describe("POST /drill/break", () => {
  it("commits the bad tag, says it was triggered from Lots, and refreshes ArgoCD", async () => {
    commitImageChange.mockResolvedValue(commit("abc1234def"));
    const app = await drillApp(DRILL_TOKEN);
    const res = await post(app, "/break", DRILL_TOKEN);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("demo-api 1.1.0 is committed (abc1234); ArgoCD is rolling it out.");
    expect(commitImageChange).toHaveBeenCalledWith(
      expect.objectContaining({ fromImage: GOOD, toImage: BAD, message: "feat(oncall-demo): deploy demo-api 1.1.0\n\nDrill triggered from Lots." }),
    );
    expect(requestArgoCdRefresh).toHaveBeenCalledTimes(1);
  });

  it("answers 200 and commits nothing when demo-api is already on the bad tag", async () => {
    const { FileDriftedError } = await import("../github.js");
    commitImageChange.mockRejectedValue(new FileDriftedError(BAD));
    const app = await drillApp(DRILL_TOKEN);
    const res = await post(app, "/break", DRILL_TOKEN);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("demo-api is already on 1.1.0.");
    expect(requestArgoCdRefresh).not.toHaveBeenCalled();
  });

  it("answers 502 file_drifted when the file names some other tag", async () => {
    const { FileDriftedError } = await import("../github.js");
    commitImageChange.mockRejectedValue(new FileDriftedError("registry.rosenvall.se/carnufex/oncall-demo-api:2.0.0"));
    const app = await drillApp(DRILL_TOKEN);
    const res = await post(app, "/break", DRILL_TOKEN);
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("demo-api is on 2.0.0, not 1.0.0; the drill expects a clean starting point (file_drifted).");
  });

  it("answers 502 without GitHub's words or the token when the commit fails", async () => {
    commitImageChange.mockRejectedValue(new Error("HttpError: Bad credentials ghp_secretvalue"));
    const app = await drillApp(DRILL_TOKEN);
    const res = await post(app, "/break", DRILL_TOKEN);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("commit_failed");
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("Bad credentials");
    expect(text).not.toContain(DRILL_TOKEN);
  });
});

describe("POST /drill/reset", () => {
  it("commits the good tag, says it was triggered from Lots, and resolves open incidents", async () => {
    commitImageChange.mockResolvedValue(commit("def5678abc"));
    const app = await drillApp(DRILL_TOKEN);
    const store = await import("../store.js");
    store.__resetStoreForTests();
    const incident = store.createIncident({ service: "demo-api", namespace: "oncall-demo", alert: { reason: "CrashLoopBackOff" } as never });

    const res = await post(app, "/reset", DRILL_TOKEN);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`demo-api is back on 1.0.0 (def5678). Resolved: ${incident.id}.`);
    expect(commitImageChange).toHaveBeenCalledWith(
      expect.objectContaining({ fromImage: BAD, toImage: GOOD, message: "revert(oncall-demo): reset demo-api to 1.0.0\n\nReset triggered from Lots." }),
    );
    expect(requestArgoCdRefresh).toHaveBeenCalledTimes(1);
    expect(store.getIncident(incident.id)?.status).toBe("resolved");
    expect(postThreadMessage).toHaveBeenCalledWith(expect.objectContaining({ id: incident.id }), expect.stringContaining("Reset from Lots"));
  });

  it("answers 200 when demo-api is already on the good tag", async () => {
    const { FileDriftedError } = await import("../github.js");
    commitImageChange.mockRejectedValue(new FileDriftedError(GOOD));
    const app = await drillApp(DRILL_TOKEN);
    (await import("../store.js")).__resetStoreForTests();
    const res = await post(app, "/reset", DRILL_TOKEN);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("demo-api is already on 1.0.0.");
  });

  it("answers 502 when GitHub is disabled", async () => {
    commitImageChange.mockRejectedValue(new Error("github_disabled"));
    const app = await drillApp(DRILL_TOKEN);
    const res = await post(app, "/reset", DRILL_TOKEN);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("GITHUB_TOKEN not set");
  });
});

describe("POST /slack/commands: /oncall drill and reset behave as before", () => {
  const signingSecret = "test-signing-secret";
  const fetchMock = vi.fn();

  async function slackApp() {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_SIGNING_SECRET = signingSecret;
    process.env.SLACK_CHANNEL_ID = "C0TEST";
    vi.resetModules();
    const { slackRoute } = await import("../routes/slack.js");
    return slackRoute;
  }

  function command(app: App, text: string) {
    const rawBody = new URLSearchParams({
      command: "/oncall",
      text,
      user_name: "alice",
      user_id: "U0ALICE",
      response_url: "https://hooks.slack.example.test/r",
    }).toString();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
    return app.request("/commands", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Slack-Request-Timestamp": timestamp, "X-Slack-Signature": signature },
      body: rawBody,
    });
  }

  function followUp(): string {
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    return (JSON.parse(String(init.body)) as { text: string }).text;
  }

  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_CHANNEL_ID;
  });

  it("/oncall drill commits from Slack by the user and posts the same follow-up", async () => {
    commitImageChange.mockResolvedValue(commit("abc1234def"));
    const app = await slackApp();
    const res = await command(app, "drill");
    expect(await res.json()).toEqual({ response_type: "ephemeral", text: "Starting the drill: deploying demo-api 1.1.0 …" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(commitImageChange).toHaveBeenCalledWith(
      expect.objectContaining({
        fromImage: GOOD,
        toImage: BAD,
        message: "feat(oncall-demo): deploy demo-api 1.1.0\n\nDrill triggered from Slack by alice.",
        authorName: "Release Bot",
      }),
    );
    expect(followUp()).toBe("Deployed demo-api 1.1.0 (abc1234). Watching for the crash…");
  });

  it("/oncall drill on a drifted file posts the same refusal", async () => {
    const { FileDriftedError } = await import("../github.js");
    commitImageChange.mockRejectedValue(new FileDriftedError(BAD));
    const app = await slackApp();
    await command(app, "drill");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(followUp()).toBe("demo-api is not currently at 1.0.0; the drill expects a clean starting point. Run `/oncall status` to check.");
  });

  it("/oncall reset commits from Slack and posts the same follow-up", async () => {
    commitImageChange.mockResolvedValue(commit("def5678abc"));
    const app = await slackApp();
    (await import("../store.js")).__resetStoreForTests();
    const res = await command(app, "reset");
    expect(await res.json()).toEqual({ response_type: "ephemeral", text: "Resetting demo-api to a known-good state…" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(commitImageChange).toHaveBeenCalledWith(
      expect.objectContaining({ fromImage: BAD, toImage: GOOD, message: "revert(oncall-demo): reset demo-api to 1.0.0\n\nReset triggered from Slack." }),
    );
    expect(followUp()).toBe("Reset complete. No open incidents to resolve.");
  });
});
