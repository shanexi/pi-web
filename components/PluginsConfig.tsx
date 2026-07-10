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
} from "@/lib/api-types";

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
 * NOT iterate a hardcoded grid). v1 only ever surfaces `modelSteering`.
 */
const CAPABILITY_PLAIN: Record<string, string> = {
  modelSteering: "change system prompt / inject messages",
  promptDrive: "act as you (drive the agent)",
  toolInput: "rewrite tool inputs",
  transcript: "read your full transcript",
};

function capabilityPlain(cap: string): string {
  return CAPABILITY_PLAIN[cap] ?? cap;
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
 * The "+ Add extension" body: paste (or file-fill) a pre-bundled ESM module,
 * POST it, then — on 200 — show the server-derived manifest and the declared
 * capabilities to grant. Self-contained: it owns the install/grant POSTs and
 * reports every successful write up to the parent via onChanged (id + module),
 * so the parent can cache the bundle, reload the list, and mark dirty.
 */
function AddBundlePanel({
  onCancel,
  onChanged,
}: {
  onCancel: () => void;
  onChanged: (id: string, module: string, result: InstallExtensionResponse) => void;
}) {
  const [module, setModule] = useState("");
  const [id, setId] = useState("");
  const [description, setDescription] = useState("");
  const [version, setVersion] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [result, setResult] = useState<InstallExtensionResponse | null>(null);

  const post = useCallback(
    async (capabilities: ExtensionCapability[]): Promise<InstallExtensionResponse | null> => {
      setInstalling(true);
      setInstallError(null);
      try {
        const req: InstallExtensionRequest = {
          module,
          id: id.trim(),
          description: description.trim() || undefined,
          version: version.trim() || undefined,
          capabilities,
        };
        const res = await apiFetch("/api/plugins", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req),
        });
        const d = (await res.json()) as InstallExtensionResponse & { error?: string };
        // Server error body is always { error: string } (400 factory dry-run
        // original text / 409 built-in collision / 413 caps). Surface it verbatim.
        if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
        setResult(d);
        onChanged(req.id, module, d);
        return d;
      } catch (err) {
        setInstallError(errText(err));
        return null;
      } finally {
        setInstalling(false);
      }
    },
    [module, id, description, version, onChanged],
  );

  const install = useCallback(() => {
    if (!module.trim()) {
      setInstallError("Paste or choose a bundle module first.");
      return;
    }
    if (!id.trim()) {
      setInstallError("An extension id is required (lowercase, e.g. my-ext).");
      return;
    }
    // Install with no grants; capabilities are granted in the result step below.
    void post([]);
  }, [module, id, post]);

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

  const toggleGrant = useCallback(
    (cap: ExtensionCapability, shouldGrant: boolean) => {
      if (!result) return;
      const current = result.grantedCapabilities ?? [];
      const next = shouldGrant
        ? Array.from(new Set([...current, cap]))
        : current.filter((c) => c !== cap);
      void post(next);
    },
    [result, post],
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
      {result ? (
        // ── Install result: server-derived manifest + declared caps to grant ──
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: GREEN }}>
            Installed{" "}
            <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{result.id}</span>
          </div>

          <ManifestSummary manifest={result.manifest} />

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
              Capabilities this extension declared
            </div>
            {(result.declaredCapabilities ?? []).length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                None — it runs fully sandboxed (no ability to steer the agent).
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
            Stored per-user; runs isolated in a Dynamic Worker — no network, no secrets.
          </div>

          {installError && (
            <div style={{ fontSize: 12, color: RED, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {installError}
            </div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={install}
              disabled={installing}
              style={primaryBtnStyle(installing)}
            >
              {installing ? "Installing…" : "Install"}
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
      const bundle = bundleCacheRef.current.get(ext.id);
      if (!bundle) {
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
        const req: InstallExtensionRequest = {
          module: bundle,
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
        const d = (await res.json()) as InstallExtensionResponse & { error?: string };
        if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
        patchExtension(ext.id, { grantedCapabilities: d.grantedCapabilities ?? nextCaps });
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
    (id: string, module: string) => {
      bundleCacheRef.current.set(id, module);
      setDirty(true);
      setActionError(null);
      setActionMessage(`Installed ${id}.`);
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
          </div>
          {ext.description ? (
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {ext.description}
            </div>
          ) : null}

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
              (v1: [] or ["modelSteering"]); never a hardcoded grid. */}
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
