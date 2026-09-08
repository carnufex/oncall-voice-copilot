// demo-api: the "victim" service for the on-call voice copilot demo.
// Version 1.0.0 is healthy. Version 1.1.0 introduces a feature-flag client that
// requires FEATURE_FLAGS_URL and refuses to start without it. That is the
// realistic, boring root cause the agent has to find in the logs.
const http = require("node:http");

const version = process.env.APP_VERSION || "0.0.0";
const startedAt = Date.now();

console.log(`demo-api ${version} starting`);

if (version.startsWith("1.1") && !process.env.FEATURE_FLAGS_URL) {
  console.error(
    "FATAL: startup config check failed: FEATURE_FLAGS_URL is not set (required since 1.1.0 for the feature-flag client)"
  );
  setTimeout(() => process.exit(1), 500);
} else {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/healthz") {
      res.end(JSON.stringify({ ok: true, version }));
      return;
    }
    res.end(
      JSON.stringify({
        service: "demo-api",
        version,
        uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
      })
    );
  });
  server.listen(8080, () => console.log(`demo-api ${version} listening on :8080`));
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
