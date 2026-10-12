import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { listSessionFamilies } = await createJiti(import.meta.url).import("./session-family.ts");

function session(id, modified, relation) {
  return { path: `/tmp/${id}.jsonl`, id, cwd: "/tmp", created: modified, modified,
    messageCount: 1, firstMessage: id, ...(relation ? { relation } : {}) };
}

test("ordinary conversations and forks remain independent rows ordered by their own updates", () => {
  const origin = session("origin", "2026-01-03T00:00:00Z");
  const fork = session("fork", "2026-01-02T00:00:00Z", { kind: "fork", originSessionId: "origin" });
  const other = session("other", "2026-01-01T00:00:00Z");
  const rows = listSessionFamilies([other, fork, origin]);
  assert.deepEqual(rows.map((row) => row.root.id), ["origin", "fork", "other"]);
  assert.equal(rows[1].root.relation.originSessionId, "origin");
  assert.equal(rows[1].latestModified, fork.modified);
});

test("refreshing a catalog row does not produce a duplicate conversation", () => {
  const before = session("same", "2026-01-01T00:00:00Z");
  const after = session("same", "2026-01-02T00:00:00Z");
  assert.deepEqual(listSessionFamilies([before, after]).map((row) => row.root), [after]);
});
