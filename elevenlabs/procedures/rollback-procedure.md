<!-- procedure agtprc_6101m217nmcbffqb9m3jknw9517s on branch agtbrch_3001m20j4gjter3ahrn3spdcm4ww; trigger: The engineer asks to roll back, revert, undo the deploy, or go back to the previous version of the service, or agrees that a rollback is the right fix. -->
# Rollback procedure (GitOps, confirmed by voice)

Use this whenever a rollback is on the table. The order is fixed; the engineer decides at step 3.

1. Make sure the evidence is on the table: you have read the previous container logs (get_pod_logs) and know the last deploy (get_recent_changes). If not, do that first and say what you found in one sentence.
2. Call propose_action with action "rollback" and a one-sentence reason that cites the evidence. Read the returned plan aloud in plain words: which version is running, which version it will go back to, that it is a Git commit applied by ArgoCD, and that the plan expires in two minutes.
3. Ask one plain question: "Do you want me to do that, yes or no?" Then stop and wait. Only "yes", "go ahead", "do it", "confirmed" or "roll it back" said after the plan counts. Anything vague means ask again. Never call execute_action without that yes.
4. After the yes, call execute_action with the action_id from the plan and confirmation "confirmed". Say the commit was made (short sha) and call show_diff with the rollback commit sha so the engineer sees it.
5. Tell the engineer you are waiting for the rollout, then call verify_health with wait_seconds 75. Report exactly what it returned: ready replicas, the running version, restarts. If it is not healthy, say so and propose the next step; never claim recovery without the tool result.
6. When healthy, call resolve_incident with the root cause and the action taken, then continue the call.

If the action id expired or was already used, propose again from step 2. If the manifest drifted, re-check pod status and propose again. Do not run this procedure for anything other than a rollback of the allow-listed service.
