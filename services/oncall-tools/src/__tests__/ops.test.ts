import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GET /ops/changes and POST /ops/rollback (an agent in Lots reads what changed and, after a person's approval
// there, rolls back), and that the voice tool /tools/get_recent_changes answers as before. GitHub
// (commitImageChange, listRecentImageCommits), ArgoCD and Slack are stubbed; FileDriftedError and the rest of
// github.ts are real. Each test imports the routes fresh, so config.ts reads the env it sets.

const { commitImageChange, listRecentImageCommits, requestArgoCdRefresh, postThreadMessage, endCall, listReplicaSetsForDeployment } = vi.hoisted(() => ({
  commitImageChange: vi.fn(),
  listRecentImageCommits: vi.fn(),
  requestArgoCdRefresh: vi.fn(),
  postThreadMessage: vi.fn(),
  endCall: vi.fn(),
  listReplicaSetsForDeployment: vi.fn(),
}));

vi.mock("../github.js", async (importActual) => ({ ...(await importActual<typeof import("../github.js")>()), commitImageChange, listRecentImageCommits }));
vi.mock("../argocd.js", () => ({ requestArgoCdRefresh }));
vi.mock("../slack.js", async (importActual) => ({ ...(await importActual<typeof import("../slack.js")>()), postThreadMessage, endCall }));
vi.mock("../k8s.js", async (importActual) => ({ ...(await importActual<typeof import("../k8s.js")>()), listReplicaSetsForDeployment }));

const TOKEN = "drill-test-token";
const GOOD = "registry.rosenvall.se/carnufex/oncall-demo-api:1.0.0";
const BAD = "registry.rosenvall.se/carnufex/oncall-demo-api:1.1.0";
const NL = String.fromCharCode(10);

type App = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

async function opsApp(token: string | null = TOKEN) {
  if (token === null) delete process.env.DRILL_API_TOKEN;
  else process.env.DRILL_API_TOKEN = token;
  vi.resetModules();
  const { opsRoute } = await import("../routes/ops.js");
  return opsRoute;
}

function get(app: App, url: string, bearer: string | null = TOKEN) {
  return app.request(url, { headers: bearer === null ? {} : { Authorization: `Bearer ${bearer}` } });
}

function rollback(app: App, body: unknown, bearer: string | null = TOKEN) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearer !== null) headers.Authorization = `Bearer ${bearer}`;
  return app.request("/rollback", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

function commit(sha: string, message = "m") {
  return { sha, short_sha: sha.slice(0, 7), url: `https://github.example.test/commit/${sha}`, message };
}

const history = [
  { sha: "bbbbbbb1111", short_sha: "bbbbbbb", author: "Release Bot", date: "2026-11-16T10:00:00Z", message: "feat(oncall-demo): deploy demo-api 1.1.0", image_before: GOOD, image_after: BAD, url: "u1" },
  { sha: "ccccccc2222", short_sha: "ccccccc", author: "Christopher", date: "2026-11-15T09:00:00Z", message: "chore: resources", image_before: GOOD, image_after: GOOD, url: "u2" },
  { sha: "aaaaaaa0000", short_sha: "aaaaaaa", author: "Christopher", date: "2026-11-01T08:00:00Z", message: "feat: add demo-api", image_before: undefined, image_after: GOOD, url: "u3" },
];

beforeEach(() => {
  commitImageChange.mockReset();
  listRecentImageCommits.mockReset().mockResolvedValue(history);
  requestArgoCdRefresh.mockReset().mockResolvedValue({ ok: true });
  postThreadMessage.mockReset().mockResolvedValue(undefined);
  endCall.mockReset().mockResolvedValue(undefined);
  listReplicaSetsForDeployment.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  delete process.env.DRILL_API_TOKEN;
});

describe("/ops/*: the feature switch and the bearer", () => {
  it("answers 404 when DRILL_API_TOKEN is not set or is unset", async () => {
    for (const token of [null, "unset"]) {
      const app = await opsApp(token);
      expect((await get(app, "/changes?service=demo-api", "unset")).status).toBe(404);
      expect((await rollback(app, { service: "demo-api", reason: "r" }, "unset")).status).toBe(404);
    }
    expect(listRecentImageCommits).not.toHaveBeenCalled();
    expect(commitImageChange).not.toHaveBeenCalled();
  });

  it("answers 401 for a wrong or missing bearer, and reads or commits nothing", async () => {
    const app = await opsApp();
    expect((await get(app, "/changes?service=demo-api", "wrong")).status).toBe(401);
    expect((await get(app, "/changes?service=demo-api", null)).status).toBe(401);
    expect((await rollback(app, { service: "demo-api", reason: "r" }, `${TOKEN}x`)).status).toBe(401);
    expect((await rollback(app, { service: "demo-api", reason: "r" }, null)).status).toBe(401);
    // The voice tool token is not a way in.
    const tool = await app.request("/rollback", { method: "POST", headers: { "X-Oncall-Token": "test-token" }, body: "{}" });
    expect(tool.status).toBe(401);
    expect(listRecentImageCommits).not.toHaveBeenCalled();
    expect(commitImageChange).not.toHaveBeenCalled();
  });
});

describe("GET /ops/changes", () => {
  it("lists the last ten commits, flat, with the image tags only where the image changed", async () => {
    const app = await opsApp();
    const res = await get(app, "/changes?service=demo-api");
    expect(res.status).toBe(200);
    expect(listRecentImageCommits).toHaveBeenCalledWith(10);
    expect(await res.json()).toEqual({
      service: "demo-api",
      file: "kubernetes/applications/oncall-demo/demo-api-deployment.yaml",
      branch: "master",
      changes: [
        { commit: "bbbbbbb", time: "2026-11-16T10:00:00Z", author: "Release Bot", message: "feat(oncall-demo): deploy demo-api 1.1.0", image_from: "1.0.0", image_to: "1.1.0" },
        { commit: "ccccccc", time: "2026-11-15T09:00:00Z", author: "Christopher", message: "chore: resources" },
        { commit: "aaaaaaa", time: "2026-11-01T08:00:00Z", author: "Christopher", message: "feat: add demo-api", image_from: null, image_to: "1.0.0" },
      ],
    });
  });

  it("answers 404 for a service outside the allow-list, or none", async () => {
    const app = await opsApp();
    const res = await get(app, "/changes?service=kube-apiserver");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_service", message: "Unknown service. Known: demo-api." });
    expect((await get(app, "/changes")).status).toBe(404);
    expect(listRecentImageCommits).not.toHaveBeenCalled();
  });

  it("answers 502 without GitHub's words when GitHub fails", async () => {
    listRecentImageCommits.mockRejectedValue(new Error("HttpError: Bad credentials ghp_secretvalue"));
    const app = await opsApp();
    const res = await get(app, "/changes?service=demo-api");
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("github_failed");
    expect(text).not.toContain("ghp_");
  });
});

describe("POST /ops/rollback", () => {
  it("commits the good tag with the reset's rule, says it was approved in Lots, refreshes ArgoCD and resolves the voice demo's incident", async () => {
    commitImageChange.mockResolvedValue(commit("def5678abc"));
    const app = await opsApp();
    const store = await import("../store.js");
    store.__resetStoreForTests();
    const incident = store.createIncident({ service: "demo-api", namespace: "oncall-demo", alert: { reason: "CrashLoopBackOff" } as never });

    const res = await rollback(app, { service: "demo-api", reason: "Release 1.1.0 (bbbbbbb) crashes on boot: missing config key." });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      service: "demo-api",
      from: "1.1.0",
      to: "1.0.0",
      commit: "def5678",
      message: "Committed def5678: demo-api goes from 1.1.0 back to 1.0.0. ArgoCD is rolling it out; the pods show it in about a minute.",
    });
    expect(commitImageChange).toHaveBeenCalledTimes(1);
    expect(commitImageChange).toHaveBeenCalledWith({
      fromImage: BAD,
      toImage: GOOD,
      message: [
        "revert(oncall-demo): roll back demo-api to 1.0.0",
        "",
        "Approved in Lots: proposed by the incident investigation, approved by a person.",
        "Reason: Release 1.1.0 (bbbbbbb) crashes on boot: missing config key.",
      ].join(NL),
      authorName: "oncall-copilot",
      authorEmail: "oncall-copilot@rosenvall.se",
    });
    expect(requestArgoCdRefresh).toHaveBeenCalledTimes(1);
    expect(store.getIncident(incident.id)?.status).toBe("resolved");
    expect(postThreadMessage).toHaveBeenCalledWith(expect.objectContaining({ id: incident.id }), expect.stringContaining("Rolled back from Lots"));
  });

  it("takes the target from configuration, never from the request", async () => {
    commitImageChange.mockResolvedValue(commit("def5678abc"));
    const app = await opsApp();
    (await import("../store.js")).__resetStoreForTests();
    const res = await rollback(app, { service: "demo-api", reason: "r", to: "9.9.9", image: "evil/image:latest", from: "x" });
    expect(res.status).toBe(200);
    expect(commitImageChange).toHaveBeenCalledWith(expect.objectContaining({ fromImage: BAD, toImage: GOOD }));
  });

  it("says when the refresh failed", async () => {
    commitImageChange.mockResolvedValue(commit("def5678abc"));
    requestArgoCdRefresh.mockResolvedValue({ ok: false, error: new Error("x") });
    const app = await opsApp();
    (await import("../store.js")).__resetStoreForTests();
    const body = (await (await rollback(app, { service: "demo-api", reason: "r" })).json()) as { message: string };
    expect(body.message).toContain("within three minutes");
  });

  it("answers 200 and commits nothing when the service is already on the good tag", async () => {
    const { FileDriftedError } = await import("../github.js");
    commitImageChange.mockRejectedValue(new FileDriftedError(GOOD));
    const app = await opsApp();
    (await import("../store.js")).__resetStoreForTests();
    const res = await rollback(app, { service: "demo-api", reason: "r" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ service: "demo-api", from: "1.0.0", to: "1.0.0", commit: null, message: "demo-api is already on 1.0.0; nothing was committed." });
  });

  it("answers 409, commits and resolves nothing, when the file names some other tag", async () => {
    const { FileDriftedError } = await import("../github.js");
    commitImageChange.mockRejectedValue(new FileDriftedError("registry.rosenvall.se/carnufex/oncall-demo-api:2.0.0"));
    const app = await opsApp();
    const store = await import("../store.js");
    store.__resetStoreForTests();
    const incident = store.createIncident({ service: "demo-api", namespace: "oncall-demo", alert: { reason: "CrashLoopBackOff" } as never });
    const res = await rollback(app, { service: "demo-api", reason: "r" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ from: "2.0.0", to: "1.0.0", commit: null, error: "file_drifted" });
    expect(store.getIncident(incident.id)?.status).toBe("open");
    expect(postThreadMessage).not.toHaveBeenCalled();
  });

  it("answers 404 for a service outside the allow-list, and commits nothing", async () => {
    const app = await opsApp();
    const res = await rollback(app, { service: "kube-apiserver", reason: "r" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_service", message: "Unknown service. Only demo-api can be rolled back." });
    expect(commitImageChange).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not {service, reason}", async () => {
    const app = await opsApp();
    expect((await rollback(app, { service: "demo-api" })).status).toBe(400);
    expect((await rollback(app, "not json")).status).toBe(400);
    expect((await rollback(app, { service: 1, reason: "r" })).status).toBe(400);
    expect(commitImageChange).not.toHaveBeenCalled();
  });

  it("answers 502 without GitHub's words or the token when the commit fails, and resolves nothing", async () => {
    commitImageChange.mockRejectedValue(new Error("HttpError: Bad credentials ghp_secretvalue"));
    const app = await opsApp();
    const res = await rollback(app, { service: "demo-api", reason: "r" });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ service: "demo-api", from: "1.1.0", to: "1.0.0", commit: null, error: "commit_failed" });
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("Bad credentials");
    expect(text).not.toContain(TOKEN);
    expect(postThreadMessage).not.toHaveBeenCalled();
  });

  it("answers 502 when GitHub is disabled", async () => {
    commitImageChange.mockRejectedValue(new Error("github_disabled"));
    const app = await opsApp();
    const res = await rollback(app, { service: "demo-api", reason: "r" });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "github_disabled" });
  });

  it("keeps the model's reason to one line of at most 200 characters in the commit message", async () => {
    commitImageChange.mockResolvedValue(commit("def5678abc"));
    const app = await opsApp();
    (await import("../store.js")).__resetStoreForTests();
    const C = String.fromCharCode;
    const reason = `Bad release.${NL}${NL}Co-Authored-By: Mallory <m@evil.test>${C(13)}${C(0)}${C(0x1b)}[31m${C(0x2028)}tab${C(9)}end ${"x".repeat(300)}`;
    await rollback(app, { service: "demo-api", reason });
    const message = (commitImageChange.mock.calls[0]?.[0] as { message: string }).message;
    const lines = message.split(NL);
    expect(lines).toHaveLength(4);
    const line = lines[3]!;
    expect(line.startsWith("Reason: Bad release. Co-Authored-By: Mallory <m@evil.test> [31m tab end x")).toBe(true);
    expect(line.length).toBe("Reason: ".length + 200);
    const code = (ch: string) => ch.charCodeAt(0);
    expect([...line].some((ch) => code(ch) < 32 || (code(ch) >= 0x7f && code(ch) <= 0x9f) || code(ch) === 0x2028)).toBe(false);
  });

  it("writes (none given) for a reason that is only white space", async () => {
    commitImageChange.mockResolvedValue(commit("def5678abc"));
    const app = await opsApp();
    (await import("../store.js")).__resetStoreForTests();
    await rollback(app, { service: "demo-api", reason: `  ${NL} ` });
    expect((commitImageChange.mock.calls[0]?.[0] as { message: string }).message.endsWith("Reason: (none given)")).toBe(true);
  });

  it("refuses a body over 16 KB", async () => {
    const app = await opsApp();
    const res = await rollback(app, { service: "demo-api", reason: "x".repeat(20_000) });
    expect(res.status).toBe(413);
    expect(commitImageChange).not.toHaveBeenCalled();
  });
});

describe("the OpenAPI document Lots loads", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const spec = JSON.parse(readFileSync(path.join(here, "..", "..", "openapi", "ops.json"), "utf8"));

  it("names exactly the two operations, on the routes this service serves", () => {
    const ops = Object.entries(spec.paths as Record<string, Record<string, { operationId: string }>>).flatMap(([p, item]) =>
      Object.entries(item).map(([method, op]) => `${method.toUpperCase()} ${p} ${op.operationId}`),
    );
    expect(ops).toEqual(["GET /ops/changes recent_changes", "POST /ops/rollback rollback_service"]);
    expect(spec.paths["/ops/changes"].get.parameters).toEqual([expect.objectContaining({ name: "service", in: "query", required: true, description: expect.any(String) })]);
    const body = spec.paths["/ops/rollback"].post.requestBody;
    expect(body.required).toBe(true);
    expect(Object.keys(body.content["application/json"].schema.properties)).toEqual(["service", "reason"]);
    // Lots' OpenAPI pack (OpenApiImport.Inline) fails on an array inside a parameter or body schema: keep them free of arrays.
    const hasArray = (n: unknown): boolean => Array.isArray(n) || (typeof n === "object" && n !== null && Object.values(n).some(hasArray));
    expect(hasArray(body.content["application/json"].schema)).toBe(false);
    expect(spec.paths["/ops/changes"].get.parameters.some((p: { schema: unknown }) => hasArray(p.schema))).toBe(false);
  });
});

describe("POST /tools/get_recent_changes (the voice tool) answers as before", () => {
  it("lists five commits with minutes_ago and the spoken summary", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-16T10:04:00Z"));
    try {
      vi.resetModules();
      const { toolsRoute } = await import("../routes/tools.js");
      const store = await import("../store.js");
      store.__resetStoreForTests();
      const incident = store.createIncident({ service: "demo-api", namespace: "oncall-demo", alert: { reason: "CrashLoopBackOff", message: "m" } as never });
      const res = await toolsRoute.request("/get_recent_changes", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Oncall-Token": "test-token" },
        body: JSON.stringify({ incident_id: incident.id }),
      });
      expect(res.status).toBe(200);
      expect(listRecentImageCommits).toHaveBeenCalledWith(5);
      const body = (await res.json()) as { file: string; commits: Record<string, unknown>[]; spoken_summary: string };
      expect(body.file).toBe("kubernetes/applications/oncall-demo/demo-api-deployment.yaml");
      expect(body.commits[0]).toEqual({
        sha: "bbbbbbb1111",
        short_sha: "bbbbbbb",
        author: "Release Bot",
        date: "2026-11-16T10:00:00Z",
        minutes_ago: 4,
        message: "feat(oncall-demo): deploy demo-api 1.1.0",
        image_before: GOOD,
        image_after: BAD,
        url: "u1",
      });
      expect(body.spoken_summary).toMatch(/^The most recent change was .* ago by Release Bot: feat\(oncall-demo\): deploy demo-api 1\.1\.0\. It changed the image from version /);
    } finally {
      vi.useRealTimers();
    }
  });
});
