"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import { apiFetch } from "@/lib/api-base";
import { useIsMobile } from "@/hooks/useIsMobile";
import { THIRDPARTY_EXTENSIONS } from "@/lib/feature-flags";
import type {
  ExtensionCapability,
  ExtensionInfo,
  ExtensionsResponse,
  InstallExtensionRequest,
  InstallExtensionResponse,
  PackageInstallExtension,
  PackageInstallResponse,
} from "@/lib/api-types";
import { isPackageInstallResponse } from "@/lib/api-types";

/**
 * E7 → E8c: Plugins panel.
 *
 * E7 base (unchanged, always present): an ENABLE/DISABLE toggler for the agent
 * Worker's compile-time BUILT-IN extensions (GET/PATCH /api/plugins via
 * apiFetch). The built-ins are audited pi-cf source, so the only per-user knob
 * is on/off, applied to a live session on /reload.
 *
 * E8c layer (gated on THIRDPARTY_EXTENSIONS): a "THIRD-PARTY" section on top of
 * the built-in list — install a user-uploaded pi extension bundle (POST
 * /api/plugins → server-side dry-run derives the manifest), grant the
 * capabilities that dry-run DECLARED (v1: at most `modelSteering`), toggle it,
 * or remove it (two-step confirm). Each third-party extension runs isolated in
 * a per-owner Dynamic Worker (no network, no secrets).
 *
 * With THIRDPARTY_EXTENSIONS=false the panel renders EXACTLY the E7 built-in
 * -only UI (regression-safe rollback): flat list, no groups, no install.
 *
 * All third-party-supplied text (id, description, version, tool/command/event
 * names, server error text) is rendered as JSX text / escaped attribute values
 * — never as raw HTML. All network calls go through apiFetch.
 */

const RED = "#f87171";
const GREEN = "#4ade80";

/**
 * Plain-words gloss for a granted capability — "what power does this give the
 * extension over your session". Unknown capabilities fall through to the raw
 * id so the UI stays data-driven (it renders whatever the API declares; it does
 * NOT iterate a hardcoded grid). The API surfaces `modelSteering` (steering
 * events) and, for sandbox-transport extensions, `exec` (E8e-s3 pi.exec).
 */
const CAPABILITY_PLAIN: Record<string, string> = {
  modelSteering: "change system prompt / inject messages",
  promptDrive: "act as you (drive the agent)",
  toolInput: "rewrite tool inputs",
  transcript: "read your full transcript",
  exec: "run shell commands in your sandbox (which has your files + network)",
};

function capabilityPlain(cap: string): string {
  return CAPABILITY_PLAIN[cap] ?? cap;
}

/**
 * The honest trust framing for where a third-party extension RUNS. `dw` is a
 * real isolation boundary (no network/secrets, capabilities enforced); `sandbox`
 * is the owner's own domain (files + network + shell) and is NOT intra-sandbox
 * isolated — capability grants there are consent, not enforcement, so install
 * only code you trust. This is why we never show a blanket "isolated" claim.
 */
function transportTrust(transport?: "dw" | "sandbox"): { label: string; note: string; warn: boolean } {
  if (transport === "sandbox") {
    return {
      label: "Runs in your sandbox",
      note: "Full access to your workspace files, network, and shell — install only code you trust. Capability grants below are a consent signal, not a hard sandbox.",
      warn: true,
    };
  }
  return {
    label: "Isolated Dynamic Worker",
    note: "No network, no secrets; capability grants are enforced by the isolation boundary.",
    warn: false,
  };
}

function TransportBadge({ transport }: { transport?: "dw" | "sandbox" }) {
  const t = transportTrust(transport);
  return (
    <div
      style={{
        fontSize: 11,
        lineHeight: 1.5,
        padding: "6px 8px",
        borderRadius: 6,
        border: `1px solid ${t.warn ? RED : "var(--border)"}`,
        background: t.warn ? "rgba(248,113,113,0.08)" : "var(--bg)",
        color: "var(--text-muted)",
      }}
    >
      <span style={{ fontWeight: 700, color: t.warn ? RED : "var(--text)" }}>{t.label}</span>
      {" — "}
      {t.note}
    </div>
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function Toggle({
  enabled,
  loading,
  onToggle,
}: {
  enabled: boolean;
  loading: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={loading}
      title={enabled ? "Enabled — click to disable" : "Disabled — click to enable"}
      aria-label={enabled ? "Disable extension" : "Enable extension"}
      aria-pressed={enabled}
      style={{
        flexShrink: 0,
        width: 40,
        height: 22,
        borderRadius: 11,
        border: "none",
        padding: 0,
        cursor: loading ? "wait" : "pointer",
        background: enabled ? "var(--accent)" : "var(--border)",
        position: "relative",
        transition: "background 0.18s",
        outline: "none",
        opacity: loading ? 0.65 : 1,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: enabled ? 21 : 3,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "var(--bg)",
          boxShadow: "0 1px 4px rgba(0,0,0,0.22)",
          transition: "left 0.18s cubic-bezier(.4,0,.2,1)",
        }}
      />
    </button>
  );
}

/** Group heading ("BUILT-IN" / "THIRD-PARTY"). */
function GroupHeader({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: 0.8,
        color: "var(--text-dim)",
        textTransform: "uppercase",
        margin: "4px 2px",
      }}
    >
      {children}
    </div>
  );
}

/** Small outlined chip (version / tool name / event name). Text is escaped by React. */
function Chip({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: 10.5,
        lineHeight: 1.4,
        padding: "1px 6px",
        borderRadius: 5,
        border: "1px solid var(--border)",
        color: "var(--text-muted)",
        background: "var(--bg)",
        fontFamily: mono ? "var(--font-mono)" : undefined,
        maxWidth: "100%",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        verticalAlign: "middle",
      }}
    >
      {children}
    </span>
  );
}

/** Segmented-control tab for the install mode toggle (Source / Paste). */
function ModeTab({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      style={{
        fontSize: 12,
        fontWeight: 600,
        padding: "5px 12px",
        borderRadius: 6,
        cursor: disabled ? "not-allowed" : "pointer",
        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
        background: active ? "var(--accent)" : "transparent",
        color: active ? "#fff" : "var(--text-muted)",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}

/** A tiny spinning ring for the "resolving in your sandbox" state. */
function Spinner() {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 12,
        height: 12,
        borderRadius: "50%",
        border: "2px solid var(--border)",
        borderTopColor: "var(--accent)",
        animation: "pi-spin 0.7s linear infinite",
      }}
    >
      <style>{"@keyframes pi-spin { to { transform: rotate(360deg); } }"}</style>
    </span>
  );
}

/**
 * One capability badge = a grant TOGGLE. Granted → filled pill "✓ <plain>"
 * (click to revoke); ungranted → outlined "Grant: <plain>" (click to grant).
 * The label always spells the power in plain words.
 */
function CapabilityBadge({
  cap,
  granted,
  busy,
  onToggle,
}: {
  cap: ExtensionCapability;
  granted: boolean;
  busy: boolean;
  onToggle: (shouldGrant: boolean) => void;
}) {
  const plain = capabilityPlain(cap);
  return (
    <button
      type="button"
      onClick={() => onToggle(!granted)}
      disabled={busy}
      title={
        granted
          ? `Granted: this extension can ${plain}. Click to revoke.`
          : `Not granted. Click to let this extension ${plain}.`
      }
      aria-pressed={granted}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 11,
        lineHeight: 1.4,
        padding: "2px 8px",
        borderRadius: 6,
        cursor: busy ? "wait" : "pointer",
        border: granted ? "1px solid var(--accent)" : "1px dashed var(--border)",
        background: granted ? "var(--accent)" : "transparent",
        color: granted ? "#fff" : "var(--text-muted)",
        opacity: busy ? 0.6 : 1,
        maxWidth: "100%",
      }}
    >
      <span aria-hidden style={{ fontWeight: 700 }}>{granted ? "✓" : "＋"}</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {granted ? plain : `Grant: ${plain}`}
      </span>
    </button>
  );
}

/**
 * The "+ Add extension" body. Two modes (upstream pi.dev/packages parity):
 *  - "From source" (default): type an `npm:`/`git:`/path Source string — the
 *    owner sandbox resolves it as a full pi PACKAGE (E8e-PACKAGE, §14): ALL its
 *    EXTENSIONS + SKILLS install in one go (prompts DEFERRED → 0; themes N/A on
 *    headless pi-cf). Always sandbox transport. `id` is optional (derived from
 *    the package name). On 200 shows the upstream-style counts line + each
 *    installed extension row (transport badge + grantable capabilities) + a note
 *    that skills appear in the Skills panel after /reload.
 *  - "Paste bundle" (the primitive): paste (or file-fill) a pre-bundled ESM
 *    module — DW-first, sandbox-fallback. `id` required. On 200 shows the
 *    server-derived manifest + the declared capabilities to grant.
 * Self-contained: it owns the install/grant POSTs and reports every successful
 * write up to the parent via onChanged (the installed ids + their bundle|null),
 * so the parent can cache a pasted bundle, reload the list, mark dirty.
 */
function AddBundlePanel({
  onCancel,
  onChanged,
}: {
  onCancel: () => void;
  onChanged: (installed: Array<{ id: string; module: string | null }>) => void;
}) {
  const [mode, setMode] = useState<"source" | "paste">("source");
  const [source, setSource] = useState("");
  const [module, setModule] = useState("");
  const [id, setId] = useState("");
  const [description, setDescription] = useState("");
  const [version, setVersion] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [result, setResult] = useState<InstallExtensionResponse | PackageInstallResponse | null>(null);

  const post = useCallback(
    async (
      capabilities: ExtensionCapability[],
      // A source per-extension re-grant pins ONE extension id (the whole package
      // re-resolves, but only this extension takes the new grant server-side).
      targetId?: string,
    ): Promise<InstallExtensionResponse | PackageInstallResponse | null> => {
      setInstalling(true);
      setInstallError(null);
      try {
        const trimmedId = id.trim();
        // Source mode POSTs {source, id?} (id derived server-side when omitted;
        // a re-grant pins targetId); paste mode POSTs {module, id}. Never both.
        const req: InstallExtensionRequest =
          mode === "source"
            ? {
                source: source.trim(),
                id: targetId ?? (trimmedId || undefined),
                description: description.trim() || undefined,
                version: version.trim() || undefined,
                capabilities,
              }
            : {
                module,
                id: trimmedId,
                description: description.trim() || undefined,
                version: version.trim() || undefined,
                capabilities,
              };
        const res = await apiFetch("/api/plugins", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req),
        });
        const d = (await res.json()) as (InstallExtensionResponse | PackageInstallResponse) & { error?: string };
        // Server error body is always { error: string } (400 parse/resolve/factory
        // original text / 409 built-in collision / 413 caps). Surface it verbatim.
        if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
        setResult(d);
        // The server owns a source bundle (never returned) → cache null; a pasted
        // bundle is cached so a later row-level re-grant needs no re-upload.
        if (isPackageInstallResponse(d)) {
          onChanged(d.extensions.map((e) => ({ id: e.id, module: null })));
        } else {
          onChanged([{ id: d.id, module }]);
        }
        return d;
      } catch (err) {
        setInstallError(errText(err));
        return null;
      } finally {
        setInstalling(false);
      }
    },
    [mode, source, module, id, description, version, onChanged],
  );

  const install = useCallback(() => {
    if (mode === "source") {
      if (!source.trim()) {
        setInstallError("Enter a source (e.g. npm:@scope/package).");
        return;
      }
    } else {
      if (!module.trim()) {
        setInstallError("Paste or choose a bundle module first.");
        return;
      }
      if (!id.trim()) {
        setInstallError("An extension id is required (lowercase, e.g. my-ext).");
        return;
      }
    }
    // Install with no grants; capabilities are granted in the result step below.
    void post([]);
  }, [mode, source, module, id, post]);

  const onFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      try {
        const text = await file.text();
        setModule(text);
        if (!id.trim()) {
          const base = file.name
            .replace(/\.[^.]+$/, "")
            .toLowerCase()
            .replace(/[^a-z0-9_-]/g, "-")
            .replace(/^-+/, "")
            .slice(0, 64);
          if (base) setId(base);
        }
      } catch (err) {
        setInstallError(errText(err));
      }
    },
    [id],
  );

  // Paste result: toggle a capability on the single installed extension.
  const toggleGrant = useCallback(
    (cap: ExtensionCapability, shouldGrant: boolean) => {
      if (!result || isPackageInstallResponse(result)) return;
      const current = result.grantedCapabilities ?? [];
      const next = shouldGrant
        ? Array.from(new Set([...current, cap]))
        : current.filter((c) => c !== cap);
      void post(next);
    },
    [result, post],
  );

  // Package result: toggle a capability on ONE installed extension. The whole
  // Source re-resolves, but only `ext.id` takes the new grant server-side (its
  // siblings keep theirs); we pin it via targetId.
  const toggleExtGrant = useCallback(
    (ext: PackageInstallExtension, cap: ExtensionCapability, shouldGrant: boolean) => {
      const current = ext.grantedCapabilities ?? [];
      const next = shouldGrant
        ? Array.from(new Set([...current, cap]))
        : current.filter((c) => c !== cap);
      void post(next, ext.id);
    },
    [post],
  );

  const inputStyle: React.CSSProperties = {
    width: "100%",
    fontSize: 12,
    padding: "6px 8px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "var(--bg)",
    color: "var(--text)",
    outline: "none",
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 14,
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--bg-panel)",
      }}
    >
      {result && isPackageInstallResponse(result) ? (
        // ── Source PACKAGE result: counts line + each installed extension row ──
        <PackageResultView
          result={result}
          installing={installing}
          installError={installError}
          onToggleGrant={toggleExtGrant}
          onDone={onCancel}
        />
      ) : result ? (
        // ── Paste result: server-derived manifest + declared caps to grant ──
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: GREEN }}>
            Installed{" "}
            <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{result.id}</span>
          </div>

          <ManifestSummary manifest={result.manifest} />

          <TransportBadge transport={result.transport} />

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
              Capabilities this extension declared
            </div>
            {(result.declaredCapabilities ?? []).length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                {result.transport === "sandbox"
                  ? "None declared — but a sandbox extension still runs with full access to your sandbox (above)."
                  : "None — it runs fully isolated with no ability to steer the agent."}
              </div>
            ) : (
              <>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {(result.declaredCapabilities ?? []).map((cap) => (
                    <CapabilityBadge
                      key={cap}
                      cap={cap}
                      granted={(result.grantedCapabilities ?? []).includes(cap)}
                      busy={installing}
                      onToggle={(shouldGrant) => toggleGrant(cap, shouldGrant)}
                    />
                  ))}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
                  Granting lets this extension act in your session with the stated power.
                </div>
              </>
            )}
          </div>

          {installError && (
            <div style={{ fontSize: 12, color: RED, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {installError}
            </div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={onCancel} style={primaryBtnStyle(false)}>
              Done
            </button>
          </div>
        </div>
      ) : (
        // ── Install form ────────────────────────────────────────────────────
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Mode toggle: Source (default, upstream parity) vs Paste bundle (primitive). */}
          <div style={{ display: "flex", gap: 6 }}>
            <ModeTab active={mode === "source"} onClick={() => setMode("source")} disabled={installing}>
              From source
            </ModeTab>
            <ModeTab active={mode === "paste"} onClick={() => setMode("paste")} disabled={installing}>
              Paste bundle
            </ModeTab>
          </div>

          {mode === "source" ? (
            // ── Source mode: npm:/git:/path → resolved + bundled in your sandbox ──
            <>
              <input
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="npm:@scope/package"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
              />
              <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 }}>
                Examples:{" "}
                <Chip mono>npm:@scope/pi-plugin</Chip> <Chip mono>npm:my-pi-ext@1.2.0</Chip>{" "}
                <Chip mono>git:https://github.com/user/repo</Chip>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                  placeholder="id (optional — derived from the package name)"
                  spellCheck={false}
                  autoCapitalize="off"
                  style={{ ...inputStyle, flex: "2 1 180px", fontFamily: "var(--font-mono)" }}
                />
                <input
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  placeholder="version (optional)"
                  spellCheck={false}
                  style={{ ...inputStyle, flex: "1 1 90px" }}
                />
              </div>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="description (optional)"
                style={inputStyle}
              />
              <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
                Source extensions are resolved and bundled inside your own sandbox, so they always
                run there (with your files, network, and shell) — install shows the exact tools,
                events, and capabilities before you grant anything.
              </div>
            </>
          ) : (
            // ── Paste mode: the pre-bundled ESM primitive (local/dev) ────────────
            <>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                  placeholder="id (required, e.g. protected-paths)"
                  spellCheck={false}
                  autoCapitalize="off"
                  style={{ ...inputStyle, flex: "2 1 180px", fontFamily: "var(--font-mono)" }}
                />
                <input
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  placeholder="version (optional)"
                  spellCheck={false}
                  style={{ ...inputStyle, flex: "1 1 90px" }}
                />
              </div>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="description (optional)"
                style={inputStyle}
              />
              <textarea
                value={module}
                onChange={(e) => setModule(e.target.value)}
                placeholder="Paste the pre-bundled ESM module here (or choose a file below)…"
                spellCheck={false}
                style={{
                  ...inputStyle,
                  minHeight: 120,
                  resize: "vertical",
                  fontFamily: "var(--font-mono)",
                  lineHeight: 1.45,
                  whiteSpace: "pre",
                  overflowWrap: "normal",
                }}
              />
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <input
                  type="file"
                  accept=".js,.mjs,.txt,text/javascript,application/javascript"
                  onChange={(e) => void onFile(e.target.files?.[0])}
                  style={{ fontSize: 11, color: "var(--text-muted)", maxWidth: "100%" }}
                />
              </div>
              <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
                Stored per-user. Most pasted bundles run in an isolated Dynamic Worker (no network,
                no secrets). Bundles that need node/shell run in your own sandbox (with your files +
                network) instead — install shows which, and asks before granting anything.
              </div>
            </>
          )}

          {installError && (
            <div style={{ fontSize: 12, color: RED, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {installError}
            </div>
          )}

          {installing && mode === "source" && (
            <div style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 8 }}>
              <Spinner />
              Resolving &amp; bundling in your sandbox…
            </div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={install}
              disabled={installing}
              style={primaryBtnStyle(installing)}
            >
              {installing ? (mode === "source" ? "Resolving…" : "Installing…") : "Install"}
            </button>
            <button type="button" onClick={onCancel} disabled={installing} style={ghostBtnStyle}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Server-derived manifest summary (tools / commands / events). All names escaped. */
function ManifestSummary({ manifest }: { manifest: InstallExtensionResponse["manifest"] }) {
  const tools = manifest.tools ?? [];
  const commands = manifest.commands ?? [];
  const events = manifest.events ?? [];
  const row = (label: string, items: string[]) =>
    items.length > 0 ? (
      <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>{label}</span>
        {items.map((it, i) => (
          <Chip key={`${label}-${i}-${it}`} mono>
            {it}
          </Chip>
        ))}
      </div>
    ) : null;
  if (tools.length === 0 && commands.length === 0 && events.length === 0) {
    return (
      <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
        No tools, commands, or events registered.
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {row(
        "tools",
        tools.map((t) => t.name),
      )}
      {row(
        "commands",
        commands.map((c) => c.name),
      )}
      {row("events", events)}
    </div>
  );
}

/**
 * The Source PACKAGE install result (E8e-PACKAGE): an upstream-style per-type
 * counts line ("N ext · M skills · 0 prompts · — themes (N/A on headless)"),
 * then each installed extension as a row (transport badge + server-derived
 * manifest + grantable declared capabilities), any per-extension failures, and a
 * note that skills land in the Skills panel after a /reload. All package-supplied
 * text (ids, names, error text) is rendered as escaped JSX.
 */
function PackageResultView({
  result,
  installing,
  installError,
  onToggleGrant,
  onDone,
}: {
  result: PackageInstallResponse;
  installing: boolean;
  installError: string | null;
  onToggleGrant: (ext: PackageInstallExtension, cap: ExtensionCapability, shouldGrant: boolean) => void;
  onDone: () => void;
}) {
  const extCount = result.extensions.length;
  const skillCount = result.installedSkills.count;
  const countsLine = `${extCount} ext · ${skillCount} skills · ${result.promptsCount} prompts · — themes (N/A on headless)`;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: GREEN }}>
        Installed{" "}
        <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>
          {result.packageName ?? result.source}
        </span>
      </div>

      {/* Upstream-style per-type counts line. */}
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-mono)" }}>
        {countsLine}
      </div>

      {/* Each installed extension: badge + manifest + grantable capabilities. */}
      {extCount === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          No extensions in this package — skills only.
        </div>
      ) : (
        result.extensions.map((ext) => {
          const declared = ext.declaredCapabilities ?? [];
          const granted = ext.grantedCapabilities ?? [];
          return (
            <div
              key={ext.id}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: "10px 12px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--bg)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span
                  style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}
                >
                  {ext.id}
                </span>
                {ext.version ? <Chip>v{ext.version}</Chip> : null}
              </div>
              <ManifestSummary manifest={ext.manifest} />
              <TransportBadge transport={ext.transport} />
              {declared.length === 0 ? (
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {ext.transport === "sandbox"
                    ? "No capabilities declared — but a sandbox extension still runs with full access to your sandbox (above)."
                    : "No capabilities declared — runs fully isolated."}
                </div>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {declared.map((cap) => (
                    <CapabilityBadge
                      key={`${ext.id}-${cap}`}
                      cap={cap}
                      granted={granted.includes(cap)}
                      busy={installing}
                      onToggle={(shouldGrant) => onToggleGrant(ext, cap, shouldGrant)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}

      {/* Per-extension failures (a bad extension fails only itself). */}
      {result.failures && result.failures.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Extensions that failed to install</div>
          {result.failures.map((f) => (
            <div key={f.id} style={{ fontSize: 12, color: RED, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              <span style={{ fontFamily: "var(--font-mono)" }}>{f.id}</span>: {f.error}
            </div>
          ))}
        </div>
      )}

      {/* Skills note — they land in the Skills panel after a /reload. */}
      {skillCount > 0 && (
        <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
          {skillCount} skill{skillCount === 1 ? "" : "s"} installed
          {result.installedSkills.names.length > 0 ? ` (${result.installedSkills.names.join(", ")})` : ""} — they appear in
          the Skills panel after you /reload the session.
        </div>
      )}

      {installError && (
        <div style={{ fontSize: 12, color: RED, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {installError}
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={onDone} style={primaryBtnStyle(false)}>
          Done
        </button>
      </div>
    </div>
  );
}

function primaryBtnStyle(busy: boolean): React.CSSProperties {
  return {
    padding: "6px 14px",
    background: "var(--accent)",
    border: "1px solid var(--accent)",
    borderRadius: 6,
    color: "#fff",
    cursor: busy ? "not-allowed" : "pointer",
    fontSize: 13,
    opacity: busy ? 0.6 : 1,
  };
}

const ghostBtnStyle: React.CSSProperties = {
  padding: "6px 14px",
  background: "none",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 13,
};

export function PluginsConfig({
  sessionId,
  onClose,
  onReloaded,
}: {
  sessionId: string | null;
  onClose: () => void;
  onReloaded?: () => void;
}) {
  const isMobile = useIsMobile();
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const [granting, setGranting] = useState<Set<string>>(new Set()); // key = `${id}:${cap}`
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  // id → module for extensions installed THIS session, so a row-level grant can
  // re-POST (the only backend path to change a grant needs the bundle, which
  // GET does not return). Lost on modal close → graceful degrade for old rows.
  const bundleCacheRef = useRef<Map<string, string>>(new Map());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/plugins");
      const next = (await res.json()) as ExtensionsResponse & { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setExtensions(next.extensions ?? []);
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patchExtension = useCallback((id: string, patch: Partial<ExtensionInfo>) => {
    setExtensions((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }, []);

  const toggle = useCallback(async (ext: ExtensionInfo) => {
    const next = !ext.enabled;
    setToggling((s) => new Set(s).add(ext.id));
    setActionError(null);
    try {
      const res = await apiFetch("/api/plugins", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: ext.id, enabled: next }),
      });
      const d = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      setExtensions((prev) => prev.map((e) => (e.id === ext.id ? { ...e, enabled: next } : e)));
      setDirty(true);
    } catch (err) {
      setActionError(errText(err));
    } finally {
      setToggling((s) => {
        const n = new Set(s);
        n.delete(ext.id);
        return n;
      });
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    setRemoving((s) => new Set(s).add(id));
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await apiFetch("/api/plugins", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const d = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      setExtensions((prev) => prev.filter((e) => e.id !== id));
      bundleCacheRef.current.delete(id);
      setConfirmRemove(null);
      setDirty(true);
      setActionMessage(`Removed ${id}.`);
    } catch (err) {
      setActionError(errText(err));
    } finally {
      setRemoving((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  }, []);

  const setCapability = useCallback(
    async (ext: ExtensionInfo, cap: ExtensionCapability, shouldGrant: boolean) => {
      // A grant change re-POSTs. Prefer a cached PASTED bundle; else re-resolve
      // from the stored Source (source installs never return their bundle). Only
      // an old paste row with neither is unactionable → ask for a re-upload.
      const bundle = bundleCacheRef.current.get(ext.id);
      if (!bundle && !ext.installSource) {
        setActionError(
          `To change capabilities for “${ext.id}”, re-add its bundle via “+ Add extension”. ` +
            `(The stored bundle isn't returned by the API, so a grant needs a re-upload.)`,
        );
        return;
      }
      const key = `${ext.id}:${cap}`;
      setGranting((s) => new Set(s).add(key));
      setActionError(null);
      setActionMessage(null);
      const current = ext.grantedCapabilities ?? [];
      const nextCaps = shouldGrant
        ? Array.from(new Set([...current, cap]))
        : current.filter((c) => c !== cap);
      try {
        const req: InstallExtensionRequest = bundle
          ? {
              module: bundle,
              id: ext.id,
              description: ext.description || undefined,
              version: ext.version || undefined,
              capabilities: nextCaps,
            }
          : {
              // Re-resolve from Source (owner sandbox); id pins the same row.
              source: ext.installSource,
              id: ext.id,
              description: ext.description || undefined,
              version: ext.version || undefined,
              capabilities: nextCaps,
            };
        const res = await apiFetch("/api/plugins", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req),
        });
        const d = (await res.json()) as (InstallExtensionResponse | PackageInstallResponse) & { error?: string };
        if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
        // A cached PASTE re-POST returns the single-extension shape; a SOURCE
        // re-resolve returns the PACKAGE shape (re-resolves the whole package, but
        // only this id took the new grant) — read the matching extension's grant.
        const grantedFromResp = isPackageInstallResponse(d)
          ? d.extensions.find((e) => e.id === ext.id)?.grantedCapabilities ?? nextCaps
          : d.grantedCapabilities ?? nextCaps;
        patchExtension(ext.id, { grantedCapabilities: grantedFromResp });
        setDirty(true);
        setActionMessage(
          shouldGrant
            ? `Granted “${capabilityPlain(cap)}” to ${ext.id}.`
            : `Revoked “${capabilityPlain(cap)}” from ${ext.id}.`,
        );
      } catch (err) {
        setActionError(errText(err));
      } finally {
        setGranting((s) => {
          const n = new Set(s);
          n.delete(key);
          return n;
        });
      }
    },
    [patchExtension],
  );

  const onInstalled = useCallback(
    (installed: Array<{ id: string; module: string | null }>) => {
      // A pasted bundle is cached so a later row-level re-grant needs no re-upload;
      // a source install has no client-side bundle (the server resolved it) → the
      // reloaded row's installSource drives re-grants instead. A PACKAGE install
      // reports every extension it created.
      for (const { id, module } of installed) if (module) bundleCacheRef.current.set(id, module);
      setDirty(true);
      setActionError(null);
      const ids = installed.map((x) => x.id);
      if (ids.length > 0) setActionMessage(`Installed ${ids.join(", ")}.`);
      void load();
    },
    [load],
  );

  const reloadSession = useCallback(async () => {
    if (!sessionId) return;
    setReloading(true);
    setActionError(null);
    try {
      await sendAgentCommand(sessionId, { type: "reload" });
      setDirty(false);
      onReloaded?.();
    } catch (err) {
      setActionError(errText(err));
    } finally {
      setReloading(false);
    }
  }, [onReloaded, sessionId]);

  const busy = toggling.size > 0 || removing.size > 0 || granting.size > 0 || reloading;
  const showThirdParty = THIRDPARTY_EXTENSIONS;

  // Tolerate an absent `source` (treat as built-in). When the third-party layer
  // is OFF, only built-ins are surfaced — the exact E7 rollback surface.
  const builtins = extensions.filter((e) => e.source !== "thirdparty");
  const thirdparty = showThirdParty ? extensions.filter((e) => e.source === "thirdparty") : [];

  const renderBuiltinRow = (ext: ExtensionInfo) => (
    <div
      key={ext.id}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "12px 14px",
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--bg-panel)",
      }}
    >
      <span
        style={{
          flexShrink: 0,
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: ext.enabled ? "var(--accent)" : "var(--border)",
          boxShadow: ext.enabled ? "0 0 4px var(--accent)" : "none",
        }}
      />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: ext.enabled ? "var(--text)" : "var(--text-dim)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {ext.id}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, lineHeight: 1.5 }}>
          {ext.description}
        </div>
      </div>
      <Toggle enabled={ext.enabled} loading={toggling.has(ext.id)} onToggle={() => void toggle(ext)} />
    </div>
  );

  const renderThirdPartyRow = (ext: ExtensionInfo) => {
    const declared = ext.declaredCapabilities ?? [];
    const granted = ext.grantedCapabilities ?? [];
    const hasError = !!ext.loadError;
    const dotColor = hasError ? RED : ext.enabled ? "var(--accent)" : "var(--border)";
    return (
      <div
        key={ext.id}
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 14,
          padding: "12px 14px",
          border: `1px solid ${hasError ? RED : "var(--border)"}`,
          borderRadius: 8,
          background: "var(--bg-panel)",
        }}
      >
        <span
          style={{
            flexShrink: 0,
            width: 8,
            height: 8,
            marginTop: 6,
            borderRadius: "50%",
            background: dotColor,
            boxShadow: hasError
              ? `0 0 4px ${RED}`
              : ext.enabled
                ? "0 0 4px var(--accent)"
                : "none",
          }}
        />
        <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: ext.enabled ? "var(--text)" : "var(--text-dim)",
                fontFamily: "var(--font-mono)",
                wordBreak: "break-all",
              }}
            >
              {ext.id}
            </span>
            {ext.version ? <Chip>v{ext.version}</Chip> : null}
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 0.4,
                textTransform: "uppercase",
                padding: "1px 6px",
                borderRadius: 5,
                border: `1px solid ${ext.transport === "sandbox" ? RED : "var(--border)"}`,
                color: ext.transport === "sandbox" ? RED : "var(--text-dim)",
              }}
              title={transportTrust(ext.transport).note}
            >
              {ext.transport === "sandbox" ? "sandbox" : "worker"}
            </span>
          </div>
          {ext.description ? (
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {ext.description}
            </div>
          ) : null}

          {ext.transport === "sandbox" && <TransportBadge transport="sandbox" />}

          {hasError && (
            <div style={{ fontSize: 12, color: RED, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {ext.loadError}
            </div>
          )}

          {ext.toolNames && ext.toolNames.length > 0 && (
            <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>tools</span>
              {ext.toolNames.map((t, i) => (
                <Chip key={`${ext.id}-tool-${i}-${t}`} mono>
                  {t}
                </Chip>
              ))}
            </div>
          )}

          {/* Capability badges — data-driven: exactly what the API DECLARED
              (e.g. [], ["modelSteering"], or ["exec"]); never a hardcoded grid. */}
          {declared.length > 0 && (
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              {declared.map((cap) => (
                <CapabilityBadge
                  key={`${ext.id}-cap-${cap}`}
                  cap={cap}
                  granted={granted.includes(cap)}
                  busy={granting.has(`${ext.id}:${cap}`)}
                  onToggle={(shouldGrant) => void setCapability(ext, cap, shouldGrant)}
                />
              ))}
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
          <Toggle
            enabled={ext.enabled}
            loading={toggling.has(ext.id)}
            onToggle={() => void toggle(ext)}
          />
          {confirmRemove === ext.id ? (
            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                onClick={() => void remove(ext.id)}
                disabled={removing.has(ext.id)}
                title="Confirm removal"
                style={{
                  fontSize: 11,
                  padding: "3px 8px",
                  borderRadius: 5,
                  border: `1px solid ${RED}`,
                  background: RED,
                  color: "#fff",
                  cursor: removing.has(ext.id) ? "wait" : "pointer",
                }}
              >
                {removing.has(ext.id) ? "Removing…" : "Confirm"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmRemove(null)}
                disabled={removing.has(ext.id)}
                style={{
                  fontSize: 11,
                  padding: "3px 8px",
                  borderRadius: 5,
                  border: "1px solid var(--border)",
                  background: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmRemove(ext.id)}
              title="Remove this third-party extension"
              style={{
                fontSize: 11,
                padding: "3px 8px",
                borderRadius: 5,
                border: `1px solid ${RED}`,
                background: "none",
                color: RED,
                cursor: "pointer",
              }}
            >
              Remove
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: isMobile ? "calc(100vw - 16px)" : 640,
          maxWidth: "calc(100vw - 16px)",
          height: isMobile ? "calc(100dvh - 16px)" : "70vh",
          maxHeight: "calc(100dvh - 16px)",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 18px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>Extensions</span>
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
              {showThirdParty ? "Built-in + third-party" : "Built-in · enable / disable"}
            </span>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 20,
              lineHeight: 1,
              padding: "2px 6px",
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: 18 }}>
          {loading ? (
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading…</div>
          ) : error ? (
            <div style={{ fontSize: 13, color: RED }}>{error}</div>
          ) : !showThirdParty ? (
            // ── E7 rollback surface: flat built-in list, no groups, no install ──
            builtins.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
                No built-in extensions available.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {builtins.map(renderBuiltinRow)}
              </div>
            )
          ) : (
            // ── E8c grouped surface: BUILT-IN + THIRD-PARTY ─────────────────────
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <GroupHeader>Built-in</GroupHeader>
                {builtins.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                    No built-in extensions available.
                  </div>
                ) : (
                  builtins.map(renderBuiltinRow)
                )}
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <GroupHeader>Third-party</GroupHeader>
                {addOpen ? (
                  <AddBundlePanel onCancel={() => setAddOpen(false)} onChanged={onInstalled} />
                ) : (
                  <button
                    type="button"
                    onClick={() => setAddOpen(true)}
                    style={{
                      alignSelf: "flex-start",
                      fontSize: 12,
                      padding: "6px 12px",
                      borderRadius: 6,
                      border: "1px dashed var(--border)",
                      background: "none",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                    }}
                  >
                    + Add extension
                  </button>
                )}
                {thirdparty.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                    No third-party extensions installed.
                  </div>
                ) : (
                  thirdparty.map(renderThirdPartyRow)
                )}
              </div>
            </div>
          )}

          {actionMessage && (
            <div style={{ fontSize: 12, color: GREEN, marginTop: 12, whiteSpace: "pre-wrap" }}>
              {actionMessage}
            </div>
          )}
          {actionError && (
            <div
              style={{
                fontSize: 12,
                color: RED,
                marginTop: 12,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {actionError}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "10px 18px",
            borderTop: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <div style={{ minWidth: 0, flex: 1, fontSize: 11, color: "var(--text-dim)" }}>
            {dirty
              ? sessionId
                ? "Reload the session to apply changes."
                : "Open a session, then /reload to apply changes."
              : "Changes apply on the next session reload."}
          </div>
          {dirty && sessionId && (
            <button
              onClick={() => void reloadSession()}
              disabled={busy}
              style={{
                padding: "6px 14px",
                background: "var(--accent)",
                border: "1px solid var(--accent)",
                borderRadius: 6,
                color: "#fff",
                cursor: busy ? "not-allowed" : "pointer",
                fontSize: 13,
                opacity: busy ? 0.6 : 1,
              }}
            >
              {reloading ? "Reloading…" : "Reload session"}
            </button>
          )}
          <button
            onClick={onClose}
            style={{
              padding: "6px 14px",
              background: "none",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
