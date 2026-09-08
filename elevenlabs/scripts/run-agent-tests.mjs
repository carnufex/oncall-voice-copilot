#!/usr/bin/env node
// Runs every test attached to the project's agents and prints a table. Exit code 1 on any failure,
// so it can gate a push (see package.json "test:agents"). Needs ELEVENLABS_API_KEY.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const key = process.env.ELEVENLABS_API_KEY;
if (!key) {
  console.error("ELEVENLABS_API_KEY is not set");
  process.exit(2);
}
const H = { "xi-api-key": key, "content-type": "application/json" };
const API = "https://api.elevenlabs.io/v1/convai";
const here = dirname(fileURLToPath(import.meta.url));
const registry = JSON.parse(readFileSync(join(here, "..", "agents.json"), "utf8"));

async function api(path, init) {
  const res = await fetch(API + path, { headers: H, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const rows = [];

for (const agent of registry.agents) {
  const cfg = await api(`/agents/${agent.id}`);
  const attached = cfg.platform_settings?.testing?.attached_tests ?? [];
  if (attached.length === 0) {
    rows.push([cfg.name, "(no tests attached)", "-", ""]);
    continue;
  }
  const inv = await api(`/agents/${agent.id}/run-tests`, { method: "POST", body: JSON.stringify({ tests: attached.map((t) => ({ test_id: t.test_id })) }) });
  const started = Date.now();
  let runs = [];
  while (Date.now() - started < 10 * 60 * 1000) {
    await sleep(5000);
    const status = await api(`/test-invocations/${inv.id}`);
    runs = status.test_runs ?? [];
    if (runs.length && runs.every((t) => ["passed", "failed", "error"].includes(t.status))) break;
  }
  for (const t of runs) {
    if (t.status !== "passed") failures++;
    const reason = t.status === "passed" ? "" : (t.condition_result?.rationale?.summary ?? t.condition_result?.rationale?.messages?.[0] ?? "").slice(0, 80);
    rows.push([cfg.name, t.test_name ?? t.test_id, t.status, reason]);
  }
}

const widths = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => String(r[i]).length), 6));
const line = (r) => r.map((c, i) => String(c).padEnd(widths[i])).join("  ");
console.log(line(["AGENT", "TEST", "STATUS", "NOTE"]));
console.log(widths.map((w) => "-".repeat(w)).join("  "));
for (const r of rows) console.log(line(r));
console.log(`\n${rows.length} tests, ${failures} failed`);
process.exit(failures ? 1 : 0);
