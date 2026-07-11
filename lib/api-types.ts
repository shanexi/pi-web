export interface SkillSearchResult {
  package: string;
  installs: string;
  url: string;
}

// E8c/E8e: the install-time grantable capabilities (backend `DwCapability`,
// §7). `modelSteering` is derivable from before_agent_start/input; E8e-s3 adds
// `exec` (the sandbox-only pi.exec capability, DECLARED via the bundle's
// `export const capabilities` — declaring it forces transport=sandbox). The UI
// still renders whatever the API declares — it does NOT hardcode this set —
// so this union is a type aid, not a grid the panel iterates.
export type ExtensionCapability = "promptDrive" | "modelSteering" | "toolInput" | "transcript" | "exec";

// E7 → E8c: the GET /api/plugins row. E7's {id, description, enabled} stay for
// backward compat and are all a BUILT-IN row ever carries; the E8c fields are
// third-party-only (absent on built-ins). `source` is optional-tolerant: a row
// with no `source` is treated as "builtin" (forward/rollback safety).
export interface ExtensionInfo {
  /** Stable id (the PATCH toggle keys on this; mono-rendered for third-party). */
  id: string;
  /** One-line description surfaced in the panel. */
  description: string;
  /** Whether the current user has this extension enabled (default true). */
  enabled: boolean;
  /** "builtin" (compile-time, audited) vs "thirdparty" (user-uploaded). Absent → treat as "builtin". */
  source?: "builtin" | "thirdparty";
  /**
   * Third-party only: where the bundle RUNS, chosen at install (E8e).
   *  - "dw": an isolated per-owner Dynamic Worker — no network, no secrets;
   *    capability grants are ENFORCED (the bridge is a real isolation boundary).
   *  - "sandbox": the owner's OWN E2B sandbox (node) — has your files, network,
   *    and shell. Runs only when the bundle needs node/exec. NOT intra-sandbox
   *    isolated: capability grants here are a CONSENT/declaration signal for
   *    well-behaved extensions, not an isolation boundary. Install only code you
   *    trust. Absent/legacy → "dw".
   */
  transport?: "dw" | "sandbox";
  /** Third-party only: author-supplied version string (may be absent). */
  version?: string;
  /** Third-party only: the tool names the bundle registers (dry-run derived). */
  toolNames?: string[];
  /** Third-party only: the whitelisted events the bundle subscribes to (dry-run derived). */
  events?: string[];
  /** Third-party only: capabilities the install-time dry-run DECLARED (v1: [] or ["modelSteering"]). */
  declaredCapabilities?: ExtensionCapability[];
  /** Third-party only: the subset of declared capabilities the user has GRANTED. */
  grantedCapabilities?: ExtensionCapability[];
  /**
   * Third-party only (E8e-install-ux): the originating Source string
   * (`npm:…`/`git:…`/path) if the bundle was resolved from one — absent for a
   * pasted bundle. Lets a row-level capability change re-resolve without a
   * re-upload.
   */
  installSource?: string;
  /** Third-party only, optional: a load/dry-run error if the backend surfaces one on the row (not populated by v1 GET; tolerated if present). */
  loadError?: string;
}

export interface ExtensionsResponse {
  extensions: ExtensionInfo[];
}

// E8c: the server-DERIVED manifest echoed back by a successful install POST
// (§5 — the install-time dry-run is the single source of truth; the author
// never hand-writes this). All arrays are byte/count capped server-side.
export interface ExtensionBundleToolManifest {
  name: string;
  label?: string;
  description?: string;
  /** Plain JSON-Schema object (TypeBox serializes to exactly this). */
  parameters?: Record<string, unknown>;
}

export interface ExtensionBundleCommandManifest {
  name: string;
  description?: string;
}

export interface ExtensionBundleManifest {
  tools?: ExtensionBundleToolManifest[];
  commands?: ExtensionBundleCommandManifest[];
  events?: string[];
  /** event → number of handlers registered for it. */
  handlerCounts?: Record<string, number>;
  /** Capabilities the extension DECLARES it wants (granting is separate). */
  capabilities?: ExtensionCapability[];
}

// E8c → E8e-install-ux: POST /api/plugins request body. Provide EITHER `module`
// (the pre-bundled, self-contained ESM primitive — paste/dev) OR `source` (an
// `npm:<name[@version]>` / `git:<https url>` / path string the owner sandbox
// resolves + esbuild-bundles, §14.1 — always forced to transport=sandbox). `id`
// is REQUIRED in paste mode (400 "id is required"); in source mode it MAY be
// omitted and is derived from the package name. `capabilities` is the subset of
// the declared set the user chooses to grant (must be ⊆ declared or the route 400s).
export interface InstallExtensionRequest {
  /** Paste primitive: the pre-bundled, self-contained ESM. Provide this OR `source`. */
  module?: string;
  /** E8e-install-ux: `npm:`/`git:`/path Source; resolved + bundled server-side. Provide this OR `module`. */
  source?: string;
  /** Required in paste mode; optional (derived from the package name) in source mode. */
  id?: string;
  description?: string;
  version?: string;
  capabilities?: ExtensionCapability[];
}

// E8c: POST /api/plugins 200 response — success + the id, the server-derived
// manifest, and the declared/granted capability split (all authoritative).
export interface InstallExtensionResponse {
  success: true;
  id: string;
  /** Where the install-time dry-run chose to run it (see ExtensionInfo.transport). */
  transport: "dw" | "sandbox";
  manifest: ExtensionBundleManifest;
  declaredCapabilities: ExtensionCapability[];
  grantedCapabilities: ExtensionCapability[];
}
