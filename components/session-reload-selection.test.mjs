import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const sidebarSource = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const shellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
function callback(source, matches) {
  const file = ts.createSourceFile("component.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === "useEffect" && node.arguments[0] && matches(node.arguments[0].getText(file))) found = node.arguments[0].getText(file);
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(found, "the component's startup callback exists");
  return found;
}
const restore = callback(sidebarSource, (text) => text.includes("restoredRef.current") && text.includes("initialSessionId") && text.includes("allSessions"));
const persist = callback(shellSource, (text) => text.includes("setTabOpenSession") && text.includes("setTabOpenNewSession"));
const selectStart = shellSource.indexOf("const handleSelectSession = useCallback");
const selectEnd = shellSource.indexOf("\n  const handleNewSession", selectStart);
const select = shellSource.slice(selectStart, selectEnd);
const saved = { id: "saved-chat", cwd: "/workspace", projectKey: "/workspace", messageCount: 8, firstMessage: "E2E_OK" };

function harness(overrides = {}) {
  const selections = [], tabs = [], urls = [], notices = [];
  const state = { selectedSession: null, newSessionCwd: "/workspace", selectedCwd: "/workspace", sessionKey: 0, initialSessionRestored: false,
    allSessions: [saved], loading: false, error: null, initialSessionId: saved.id, initialSessionLinked: true, skipInitialProjectSelection: false,
    restoredRef: { current: false }, activeNewSessionDraftKeyRef: { current: null }, activeProjectKeyRef: { current: "/workspace" }, suppressCwdBumpRef: { current: false },
    branchLeafChangeFnRef: { current: null }, activeCwd: "/workspace", isMobile: false, ...overrides };
  const context = vm.createContext({ ...state, URLSearchParams,
    window: { location: { search: `?session=${state.initialSessionId}` } },
    router: { replace: (url) => urls.push(url) }, useCallback: (fn) => fn,
    invalidateWorkspaceRestore() {}, changeFileWorkspace() {}, rekeyDraft() {}, parkedNewSessionDraftKey: (cwd) => cwd,
    workspaceKeyOf: (session) => session.projectKey ?? session.cwd,
    getRecentProjects: (sessions) => sessions.length ? [{ root: sessions[0].cwd }] : [],
    t: (key) => key, showToast: (message) => notices.push(message),
    setLastOpenSession() {}, setTabOpenSession: (id) => tabs.push({ kind: "session", id }), setTabOpenNewSession: (cwd) => tabs.push({ kind: "new", cwd }),
  });
  for (const setter of new Set([...select.matchAll(/\bset[A-Z]\w*(?=\()/g)].map((match) => match[0]))) {
    const key = setter[3].toLowerCase() + setter.slice(4);
    context[setter] = (value) => { context[key] = typeof value === "function" ? value(context[key]) : value; };
  }
  context.setSelectedCwd = (cwd) => { context.selectedCwd = cwd; };
  context.onInitialRestoreDone = () => { context.initialSessionRestored = true; };
  vm.runInContext(stripTypeScriptTypes(`${select}\nglobalThis.select = handleSelectSession;`), context);
  context.onSelectSession = (session, isRestore) => { selections.push(session.id); context.select(session, isRestore); };
  const run = (fn) => vm.runInContext(stripTypeScriptTypes(`(${fn})()`), context);
  return { context, selections, tabs, urls, notices, restore: () => run(restore), persist: () => run(persist) };
}

test("reloading ?session restores the saved chat despite the initial /workspace composer", () => {
  const h = harness();
  h.persist();
  assert.deepEqual(h.tabs, [], "default cwd must not overwrite tab memory while the URL session is pending");
  h.restore();
  assert.equal(h.context.selectedSession.id, saved.id);
  assert.equal(h.context.selectedSession.messageCount, 8);
  assert.equal(h.context.newSessionCwd, null);
  assert.equal(h.context.sessionKey, 1, "the chat remounts with the saved session");
  assert.equal(h.context.initialSessionRestored, true);
  h.persist();
  assert.deepEqual(h.tabs, [{ kind: "session", id: saved.id }]);
  assert.deepEqual(h.urls, [], "the existing session URL does not trigger a Suspense remount");
  h.restore();
  assert.deepEqual(h.selections, [saved.id], "catalog hydration does not select the session again");
});

test("startup waits for a successful catalog read before consuming the requested session", () => {
  const h = harness({ loading: true, allSessions: [] });
  h.restore();
  assert.equal(h.context.restoredRef.current, false);
  h.context.loading = false;
  h.context.error = "temporary fetch failure";
  h.restore();
  assert.equal(h.context.restoredRef.current, false);
  h.context.error = null;
  h.context.allSessions = [saved];
  h.restore();
  assert.deepEqual(h.selections, [saved.id]);
});

test("a missing linked session resolves even when the catalog is empty", () => {
  const h = harness({ allSessions: [] });
  h.restore();
  assert.equal(h.context.initialSessionRestored, true);
  assert.equal(h.context.selectedSession, null);
  assert.deepEqual(h.notices, ["sidebar.sessionNotFound"]);
});

test("explicit cwd navigation retains a fresh composer instead of adopting a URL session", () => {
  const h = harness({ skipInitialProjectSelection: true });
  h.restore();
  assert.deepEqual(h.selections, []);
  assert.equal(h.context.newSessionCwd, "/workspace");
});
