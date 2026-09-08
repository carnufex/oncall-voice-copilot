import { CustomObjectsApi, Observable, type RequestContext, type ResponseContext } from "@kubernetes/client-node";
import { getKubeConfig } from "./k8s.js";
import { config } from "./config.js";
import { logger } from "./log.js";

let customObjectsApi: CustomObjectsApi | undefined;
function getCustomObjectsApi(): CustomObjectsApi {
  if (!customObjectsApi) customObjectsApi = getKubeConfig().makeApiClient(CustomObjectsApi);
  return customObjectsApi;
}

/**
 * The generated CustomObjectsApi client defaults PATCH requests to
 * `application/json-patch+json` (see @kubernetes/client-node ObjectSerializer.getPreferredMediaType).
 * We need `application/merge-patch+json` for a simple annotation merge patch, so this middleware
 * rewrites the Content-Type header on the way out.
 */
const mergePatchContentType = {
  pre(context: RequestContext): Observable<RequestContext> {
    context.setHeaderParam("Content-Type", "application/merge-patch+json");
    return new Observable(Promise.resolve(context));
  },
  post(context: ResponseContext): Observable<ResponseContext> {
    return new Observable(Promise.resolve(context));
  },
};

/**
 * Requests an ArgoCD refresh by merge-patching the Application's
 * `argocd.argoproj.io/refresh` annotation to "normal" (SPEC 2.4 step 3).
 * Failure here is non-fatal: the caller reports it as a slower sync, not an error.
 */
export async function requestArgoCdRefresh(): Promise<{ ok: true } | { ok: false; error: unknown }> {
  try {
    await getCustomObjectsApi().patchNamespacedCustomObject(
      {
        group: "argoproj.io",
        version: "v1alpha1",
        namespace: config.argocdNamespace,
        plural: "applications",
        name: config.argocdAppName,
        body: { metadata: { annotations: { "argocd.argoproj.io/refresh": "normal" } } },
      },
      { middleware: [mergePatchContentType], middlewareMergeStrategy: "append" },
    );
    return { ok: true };
  } catch (err) {
    logger.warn({ err }, "ArgoCD refresh patch failed");
    return { ok: false, error: err };
  }
}
