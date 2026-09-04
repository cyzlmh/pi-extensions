import { register } from "node:module";
// Minimal harness: load the extension with a mock pi API and print injected headers.

const calls = [];
const pi = {
  on(event, handler) {
    calls.push({ event, handler });
  },
};

const { default: ext } = await import(
  "./extensions/index.ts"
);
ext(pi);

const beforeProviderHeaders = calls.find((c) => c.event === "before_provider_headers");
if (!beforeProviderHeaders) throw new Error("extension did not register before_provider_headers");

function run(provider, baseUrl) {
  const event = { headers: {} };
  const ctx = { model: { provider, baseUrl } };
  beforeProviderHeaders.handler(event, ctx);
  return event.headers;
}

console.log("=== zai-coding-cn (v4 endpoint, what this machine actually uses) ===");
console.log(run("zai-coding-cn", "https://open.bigmodel.cn/api/coding/paas/v4"));

console.log("\n=== custom provider on api.z.ai anthropic endpoint ===");
console.log(run("my-custom", "https://api.z.ai/api/anthropic"));

console.log("\n=== non-zhipu provider (must stay untouched) ===");
const untouched = run("deepseek", "https://api.deepseek.com/v1");
console.log("header count:", Object.keys(untouched).length, Object.keys(untouched));

console.log("\n=== two requests share session id but differ in query id ===");
const h1 = run("zai-coding", "https://api.z.ai/api/coding/paas/v4");
const h2 = run("zai-coding", "https://api.z.ai/api/coding/paas/v4");
console.log("same session:", h1["X-Session-Id"] === h2["X-Session-Id"]);
console.log("new query id:", h1["X-Query-Id"] !== h2["X-Query-Id"]);
