import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./normalize.ts");
}

function assistant(content) {
  return { role: "assistant", provider: "test", model: "test-model", content };
}

test("recovers toolName from the pi `name` field (loaded-session shape)", async () => {
  const { normalizeToolCalls } = await loadSubject();
  // pi's session format serializes tool calls with `name`/`arguments`; the
  // backend returns them verbatim, so a loaded session carries this shape.
  const msg = assistant([
    { type: "toolCall", id: "call-1", name: "Agent", arguments: { task: "x" } },
  ]);
  const out = normalizeToolCalls(msg);
  const block = out.content[0];
  assert.equal(block.toolName, "Agent");
  assert.equal(block.toolCallId, "call-1");
  assert.deepEqual(block.input, { task: "x" });
});

test("a toolCall block with NEITHER toolName nor name degrades to '' (no undefined → no crash)", async () => {
  const { normalizeToolCalls } = await loadSubject();
  const msg = assistant([{ type: "toolCall", toolCallId: "c", input: {} }]);
  const out = normalizeToolCalls(msg);
  assert.equal(out.content[0].toolName, "");
});

test("is idempotent and lossless on a well-formed toolName block", async () => {
  const { normalizeToolCalls } = await loadSubject();
  const msg = assistant([{ type: "toolCall", toolCallId: "c1", toolName: "bash", input: { command: "ls" } }]);
  const once = normalizeToolCalls(msg);
  const twice = normalizeToolCalls(once);
  assert.deepEqual(once.content[0], { type: "toolCall", toolCallId: "c1", toolName: "bash", input: { command: "ls" } });
  assert.deepEqual(twice.content[0], once.content[0]);
});

test("leaves non-toolCall blocks (text/thinking) untouched", async () => {
  const { normalizeToolCalls } = await loadSubject();
  const msg = assistant([
    { type: "text", text: "hi" },
    { type: "thinking", thinking: "hmm" },
  ]);
  const out = normalizeToolCalls(msg);
  assert.deepEqual(out.content[0], { type: "text", text: "hi" });
  assert.deepEqual(out.content[1], { type: "thinking", thinking: "hmm" });
});

test("passes non-assistant messages through unchanged", async () => {
  const { normalizeToolCalls } = await loadSubject();
  const user = { role: "user", content: "hello" };
  assert.equal(normalizeToolCalls(user), user);
});
