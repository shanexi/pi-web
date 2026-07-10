// Compile-time feature flags for the Cloudflare Workers fork.
//
// LOCAL_PANELS gates the "local machine" config panels inherited from
// upstream pi-web: the Models/Plugins dialogs (and, pre-E3, Skills). Their
// backing routes (/api/config/*, /api/plugins*, /api/auth/login/:provider) do
// not exist on the agent Worker, and ModelsConfig opens an OAuth-login
// EventSource that would retry forever against it. These stay OFF (the
// "不做" list) — the components are kept in the tree so they type-check.
//
// FILE_PANELS (D3) revives the FILE side of what D0 hid — FileExplorer /
// FileViewer / the @ file-index / the cwd picker — now backed by the
// per-user E2B sandbox through the agent Worker's sandbox file routes
// (/api/files/*, /api/file-index, /api/dirs, /api/files ?type=watch SSE,
// /api/workspace/init). All calls go through apiFetch/apiUrl (D2a
// credentials + login-gate semantics).
//
// SKILLS_PANEL (E3) splits Skills OUT of LOCAL_PANELS: SkillsConfig is
// revived on its own flag, backed by the agent Worker's sandbox skills
// routes (GET/PATCH /api/skills, POST /api/skills/search, POST
// /api/skills/install — all via apiFetch).
//
// EXTENSIONS_PANEL (E7) splits Plugins OUT of LOCAL_PANELS: PluginsConfig is
// revived as an ENABLE/DISABLE toggler for the compile-time built-in
// extensions (NOT the upstream package manager — no install/remove/search),
// backed by the agent Worker's GET/PATCH /api/plugins routes via apiFetch.
// Models stays hidden under LOCAL_PANELS=false (no write backend on the agent
// Worker).
//
// THIRDPARTY_EXTENSIONS (E8c) layers the "THIRD-PARTY" section ON TOP of the E7
// built-in toggler inside the SAME PluginsConfig panel: install/remove a
// user-uploaded pi extension bundle (POST/DELETE /api/plugins), grant the
// capabilities the install-time dry-run declared (v1: at most `modelSteering`),
// and toggle it — each runs isolated in a per-owner Dynamic Worker (no network,
// no secrets). This is independent of EXTENSIONS_PANEL, which stays as-is: flip
// THIRDPARTY_EXTENSIONS back to false and the panel renders EXACTLY today's E7
// built-in-only UI (regression-safe rollback for a DW-host regression), the
// same分里程碑 pattern as E3 SKILLS_PANEL / E7 EXTENSIONS_PANEL. The fork can
// ship this ahead of the backend since false = zero behavior change.
//
// The explicit `: boolean` annotations stop TypeScript from narrowing the
// gated JSX into `never`-land, so hidden branches stay fully checked.
export const LOCAL_PANELS: boolean = false;
export const FILE_PANELS: boolean = true;
export const SKILLS_PANEL: boolean = true;
export const EXTENSIONS_PANEL: boolean = true;
export const THIRDPARTY_EXTENSIONS: boolean = true;
