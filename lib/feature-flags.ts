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
// /api/skills/install — all via apiFetch). Models/Plugins stay hidden under
// LOCAL_PANELS=false (Models has no write backend; Plugins is E7).
//
// The explicit `: boolean` annotations stop TypeScript from narrowing the
// gated JSX into `never`-land, so hidden branches stay fully checked.
export const LOCAL_PANELS: boolean = false;
export const FILE_PANELS: boolean = true;
export const SKILLS_PANEL: boolean = true;
