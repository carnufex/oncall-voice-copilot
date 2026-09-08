import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetStoreForTests,
  createIncident,
  createPendingAction,
  revertPendingActionExecution,
  tryExecutePendingAction,
} from "../store.js";
import type { RollbackPlan } from "../types.js";

const plan: RollbackPlan = {
  deployment: "demo-api",
  namespace: "oncall-demo",
  from_image: "registry.rosenvall.se/carnufex/oncall-demo-api:1.1.0",
  to_image: "registry.rosenvall.se/carnufex/oncall-demo-api:1.0.0",
  file: "kubernetes/applications/oncall-demo/demo-api-deployment.yaml",
  branch: "master",
  summary: "Roll demo-api back from 1.1.0 to 1.0.0.",
};

beforeEach(() => {
  __resetStoreForTests();
});

describe("pending action TTL / one-shot logic", () => {
  it("executes successfully within the TTL window", () => {
    const incident = createIncident({ service: "demo-api", namespace: "oncall-demo", alert: { reason: "CrashLoopBackOff", message: "x" } });
    const action = createPendingAction(incident, plan, 120000);

    const result = tryExecutePendingAction(incident, action.action_id);
    expect(result).toEqual({ ok: true, action: expect.objectContaining({ action_id: action.action_id }) });
    expect(incident.pending_actions[action.action_id]?.executed_at).toBeDefined();
  });

  it("rejects an unknown action_id", () => {
    const incident = createIncident({ service: "demo-api", namespace: "oncall-demo", alert: { reason: "CrashLoopBackOff", message: "x" } });
    const result = tryExecutePendingAction(incident, "deadbeef0000");
    expect(result).toEqual({ ok: false, error: "action_not_found" });
  });

  it("is one-shot: a second execution of the same action fails", () => {
    const incident = createIncident({ service: "demo-api", namespace: "oncall-demo", alert: { reason: "CrashLoopBackOff", message: "x" } });
    const action = createPendingAction(incident, plan, 120000);

    expect(tryExecutePendingAction(incident, action.action_id).ok).toBe(true);
    const second = tryExecutePendingAction(incident, action.action_id);
    expect(second).toEqual({ ok: false, error: "action_already_executed" });
  });

  it("rejects an execution after the TTL has expired", () => {
    vi.useFakeTimers();
    try {
      const incident = createIncident({ service: "demo-api", namespace: "oncall-demo", alert: { reason: "CrashLoopBackOff", message: "x" } });
      const action = createPendingAction(incident, plan, 1000); // 1s TTL

      vi.advanceTimersByTime(1001);

      const result = tryExecutePendingAction(incident, action.action_id);
      expect(result).toEqual({ ok: false, error: "action_expired" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows a retry after revertPendingActionExecution (e.g. a failed side effect)", () => {
    const incident = createIncident({ service: "demo-api", namespace: "oncall-demo", alert: { reason: "CrashLoopBackOff", message: "x" } });
    const action = createPendingAction(incident, plan, 120000);

    expect(tryExecutePendingAction(incident, action.action_id).ok).toBe(true);
    revertPendingActionExecution(incident, action.action_id);
    expect(tryExecutePendingAction(incident, action.action_id).ok).toBe(true);
  });
});
