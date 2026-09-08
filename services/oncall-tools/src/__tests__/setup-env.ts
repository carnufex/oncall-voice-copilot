// Ensures src/config.ts's required env vars are present before any test module imports it.
process.env.PUBLIC_BASE_URL ??= "https://oncall.example.test";
process.env.TOOL_API_TOKEN ??= "test-token";
