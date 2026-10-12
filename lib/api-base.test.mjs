import assert from "node:assert/strict";
import test from "node:test";

process.env.NEXT_PUBLIC_AGENT_BASE_URL = " https://agent.example.test/ ";
const { apiEvents, apiFetch, apiUrl, loginUrl } = await import("./api-base.ts");

test("cloud URLs normalize the backend origin and preserve existing absolute media URLs", () => {
  assert.equal(apiUrl("/api/models"), "https://agent.example.test/api/models");
  assert.equal(apiUrl("api/sessions"), "https://agent.example.test/api/sessions");
  assert.equal(apiUrl("https://media.example.test/image.png"), "https://media.example.test/image.png");
  assert.equal(apiUrl(apiUrl("/api/sessions/a/image")), "https://agent.example.test/api/sessions/a/image");
});

test("API requests retain caller options and include the authentication cookie", async () => {
  const originalFetch = globalThis.fetch;
  let observed;
  const response = new Response('{"models":[]}', { status: 200 });
  globalThis.fetch = async (...args) => { observed = args; return response; };
  try {
    const headers = { "Content-Type": "application/json" };
    const controller = new AbortController();
    assert.equal(await apiFetch("/api/agent/new", { method: "POST", headers, body: "{}", signal: controller.signal, credentials: "omit" }), response);
    assert.equal(observed[0], "https://agent.example.test/api/agent/new");
    assert.deepEqual(observed[1], { method: "POST", headers, body: "{}", signal: controller.signal, credentials: "include" });
  } finally { globalThis.fetch = originalFetch; }
});

test("parallel unauthenticated requests make one Feishu login navigation with a safe return URL", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const navigations = [];
  const returnTo = "https://ui.example.test/?session=a&cwd=%2Fworkspace";
  globalThis.window = { location: { get href() { return returnTo; }, set href(value) { navigations.push(value); } } };
  globalThis.fetch = async () => new Response(null, { status: 401 });
  try {
    const results = await Promise.all([apiFetch("/api/auth/me"), apiFetch("/api/sessions")]);
    assert.deepEqual(results.map((response) => response.status), [401, 401]);
    assert.deepEqual(navigations, [loginUrl(returnTo)]);
    assert.equal(new URL(navigations[0]).searchParams.get("return"), returnTo);
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow; }
});

test("agent and file SSE connections use the cloud origin and credentials", () => {
  const originalEventSource = globalThis.EventSource;
  globalThis.EventSource = class { constructor(url, options) { this.url = url; this.options = options; } };
  try {
    const events = apiEvents("/api/agent/session-1/events");
    assert.equal(events.url, "https://agent.example.test/api/agent/session-1/events");
    assert.deepEqual(events.options, { withCredentials: true });
    assert.equal(apiEvents(apiUrl("/api/files/workspace/test?type=watch")).url, "https://agent.example.test/api/files/workspace/test?type=watch");
  } finally { globalThis.EventSource = originalEventSource; }
});
