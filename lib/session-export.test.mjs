import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
process.env.NEXT_PUBLIC_AGENT_BASE_URL = "https://agent.example.test";
const { loadSessionExport, buildSessionHtml } = await createJiti(import.meta.url).import("./session-export.ts");
const session = { id: "session-1", name: "Old title", cwd: "/workspace", created: "2026-01-01T00:00:00Z" };
const message = (i) => ({ role: "user", content: `message-${i}`, timestamp: i });
const context = (from, to, hasMore) => ({ messages: Array.from({ length: to - from + 1 }, (_, i) => message(from + i)), entryIds: Array.from({ length: to - from + 1 }, (_, i) => `e${from + i}`), oldestEntryId: `e${from}`, hasMore, turnsBefore: 0, thinkingLevel: "off", model: null });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

test("full-history export reads beyond the last 50 messages and keeps the initial branch", async () => {
  const requests = [];
  const responses = [
    { info: { name: "Saved title" }, leafId: "branch-tip", context: context(76, 125, true) },
    { context: context(26, 76, true) }, // An overlapping boundary must appear once.
    { context: context(1, 25, false) },
  ];
  const result = await loadSessionExport(session, async (url) => {
    requests.push(String(url));
    assert.ok(responses.length, "only the required pages should be fetched");
    return json(responses.shift());
  });
  assert.equal(result.name, "Saved title");
  assert.deepEqual(result.messages.map((item) => item.content), Array.from({ length: 125 }, (_, i) => `message-${i + 1}`));
  assert.equal(requests.length, 3);
  assert.equal(requests[0], "/api/sessions/session-1");
  assert.deepEqual(requests.slice(1).map((url) => {
    const parsed = new URL(url, "https://example.test");
    return [parsed.pathname, parsed.searchParams.get("before"), parsed.searchParams.get("leafId")];
  }), [["/api/sessions/session-1/context", "e76", "branch-tip"], ["/api/sessions/session-1/context", "e26", "branch-tip"]]);
  const html = buildSessionHtml(result.name, session, result.messages);
  assert.ok(html.indexOf("message-1</div>") < html.indexOf("message-125</div>"));
  assert.match(html, /125 messages/);
});

test("an inaccessible older page fails export instead of silently downloading a partial history", async () => {
  let requests = 0;
  await assert.rejects(loadSessionExport(session, async () => ++requests === 1
    ? json({ context: context(51, 100, true) })
    : json({ error: "forbidden" }, 403)), /HTTP 403/);
  assert.equal(requests, 2);
});

test("a repeated history cursor is rejected without an infinite request loop", async () => {
  let requests = 0;
  await assert.rejects(loadSessionExport(session, async () => {
    requests++;
    return json({ context: context(51, 100, true) });
  }), /cursor did not advance/);
  assert.equal(requests, 2);
});

test("exported media resolves cloud URLs, supports native images and escapes user text", () => {
  const html = buildSessionHtml("<script>title</script>", session, [
    { role: "user", content: [{ type: "text", text: "<b>hello</b>" }, { type: "image", source: { type: "url", url: "/api/sessions/session-1/entries/e1/tool-result-image?blockIndex=1" } }] },
    { role: "toolResult", content: [{ type: "image", data: "dGVzdA==", mimeType: "image/png" }] },
  ]);
  assert.match(html, /https:\/\/agent\.example\.test\/api\/sessions\/session-1\/entries\/e1\/tool-result-image\?blockIndex=1/);
  assert.match(html, /data:image\/png;base64,dGVzdA==/);
  assert.match(html, /&lt;b&gt;hello&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<script>title/);
});
