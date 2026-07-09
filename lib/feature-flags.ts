// Compile-time feature flags for the Cloudflare Workers fork.
//
// LOCAL_PANELS gates the "local machine" feature panels inherited from
// upstream pi-web: the Models/Skills/Plugins config dialogs and the
// FileExplorer / FileViewer file panel. Their backing routes
// (/api/config/*, /api/skills*, /api/plugins*, /api/files*, /api/file-index,
// /api/auth/login/:provider) do not exist on the agent Worker, and two of the
// panels open EventSources that would retry forever against it
// (ModelsConfig's OAuth-login SSE, FileViewer's file-watch SSE).
//
// The components themselves are intentionally kept in the tree (only their
// entry points are gated) so they keep type-checking and can be revived:
// task D3 flips this flag (or splits it per-panel) to bring back
// FileExplorer/FileViewer backed by the session sandbox filesystem.
// Models/Skills/Plugins stay hidden even then.
//
// The explicit `: boolean` annotation stops TypeScript from narrowing the
// gated JSX into `never`-land, so the hidden branches stay fully checked.
export const LOCAL_PANELS: boolean = false;
