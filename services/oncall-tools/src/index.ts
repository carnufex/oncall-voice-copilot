import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { config } from "./config.js";
import { logger } from "./log.js";
import { toolsRoute } from "./routes/tools.js";
import { slackRoute } from "./routes/slack.js";
import { apiRoute } from "./routes/api.js";
import { webhooksRoute } from "./routes/webhooks.js";
import { startDetector } from "./detector.js";
import { initStore } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.join(__dirname, "web");
const indexHtmlPath = path.join(webDist, "index.html");

initStore(config.incidentStorePath, logger);

const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true }));

app.route("/tools", toolsRoute);
app.route("/slack", slackRoute);
app.route("/api", apiRoute);
app.route("/webhooks", webhooksRoute);

app.use("/assets/*", serveStatic({ root: path.relative(process.cwd(), webDist) }));

app.get("/", (c) => {
  if (!existsSync(indexHtmlPath)) {
    return c.text("Call page not built yet: run `npm run build` (web/dist missing).", 503);
  }
  return c.html(readFileSync(indexHtmlPath, "utf8"));
});

app.get("/call/:id", (c) => {
  if (!existsSync(indexHtmlPath)) {
    return c.text("Call page not built yet: run `npm run build` (web/dist missing).", 503);
  }
  return c.html(readFileSync(indexHtmlPath, "utf8"));
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((err, c) => {
  logger.error({ err }, "unhandled error");
  return c.json({ error: "internal_error" }, 500);
});

const port = config.port;
serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port }, "oncall-tools listening");
});

try {
  startDetector();
} catch (err) {
  logger.error({ err }, "failed to start detector loop");
}
