"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import { apiFetch, CF_CWD } from "@/lib/api-base";
import { useIsMobile } from "@/hooks/useIsMobile";
import { THIRDPARTY_EXTENSIONS } from "@/lib/feature-flags";
import type {
  ExtensionCapability,
  ExtensionInfo,
  ExtensionsResponse,
  InstallExtensionRequest,
  InstallExtensionResponse,
  PackageInstallResponse,
  PluginPackageInfo,
  PluginResourceInfo,
  PluginsListResponse,
} from "@/lib/api-types";
import { isPackageInstallResponse } from "@/lib/api-types";

/**
 * E7 → E8c → E8f: Plugins panel.
 *
 * E8f (this file, gated on THIRDPARTY_EXTENSIONS): an upstream-faithful
 * master-detail plugin manager over GET /api/plugins (PluginsListResponse).
 * Left list groups PACKAGES (installed source packages + synthesized
 * legacy/bundle packages) then BUILT-IN (compile-time extensions); right pane
 * shows a per-package detail (toggle / update / reload / remove, metadata
 * grid, resolved resources with per-extension capability grants) or an Add
 * Plugin panel (upstream layout + our "From source" / "Paste bundle" modes).
 * Every mutation re-GETs the list (our POSTs don't return full snapshots).
 *
 * With THIRDPARTY_EXTENSIONS=false the panel renders EXACTLY the E7 built-in
 * -only UI (regression-safe rollback): flat list, no groups, no install.
 *
 * All third-party-supplied text (ids, sources, descriptions, versions,
 * tool/command/event names, server error text) is rendered as JSX text /
 * escaped attribute values — never as raw HTML. All network calls go through
 * apiFetch.
 */

const RED = "#f87171";
const SKILLS_ROOT = "/workspace/.pi/skills";

/**
 * Plain-words gloss for a granted capability — "what power does this give the
 * extension over your session". Unknown capabilities fall through to the raw
 * id so the UI stays data-driven (it renders whatever the API declares; it
 * does NOT iterate a hardcoded grid).
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
 * real isolation boundary (no network/secrets, capabilities enforced);
 * `sandbox` is the owner's own domain (files + network + shell) and is NOT
 * intra-sandbox isolated — capability grants there are consent, not
 * enforcement, so install only code you trust.
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

function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function resourceSummary(pkg: PluginPackageInfo): string {
  if (pkg.disabled) return "Disabled";
  const parts = [
    pkg.counts.extensions ? `${pkg.counts.extensions} ext` : "",
    pkg.counts.skills ? `${pkg.counts.skills} skills` : "",
    pkg.counts.prompts ? `${pkg.counts.prompts} prompts` : "",
    pkg.counts.themes ? `${pkg.counts.themes} themes` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No resources";
}

function versionSummary(pkg: PluginPackageInfo): string {
  const parts = [];
  if (pkg.version) parts.push(`installed ${pkg.version}`);
  if (pkg.configuredVersion) parts.push(`configured ${pkg.configuredVersion}`);
  return parts.length ? parts.join(" · ") : "Unknown";
}

/** Upstream findInstalledPackage strategy, minus scope (single workspace). */
function findInstalledPackage(
  packages: PluginPackageInfo[],
  source: string,
): PluginPackageInfo | undefined {
  const trimmed = source.trim();
  const withoutNpmPrefix = trimmed.startsWith("npm:") ? trimmed.slice(4) : trimmed;
  return packages.find((pkg) => pkg.source === trimmed)
    ?? packages.find((pkg) => pkg.source === `npm:${withoutNpmPrefix}`)
    ?? packages.find((pkg) => pkg.source.endsWith(trimmed));
}

function statusColor(status: PluginPackageInfo["status"]): string {
  if (status === "loaded") return "var(--accent)";
  if (status === "installed") return "#f59e0b";
  if (status === "disabled") return "var(--text-dim)";
  return "#ef4444";
}

function buttonStyle(disabled?: boolean, danger?: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    background: danger ? "rgba(239,68,68,0.08)" : "none",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: danger ? "#ef4444" : "var(--text-muted)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 12,
    opacity: disabled ? 0.5 : 1,
  };
}

function Toggle({
  enabled,
  loading,
  onToggle,
  label,
}: {
  enabled: boolean;
  loading: boolean;
  onToggle: () => void;
  label?: string;
}) {
  const title = label ?? (enabled ? "Enabled — click to disable" : "Disabled — click to enable");
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={loading}
      title={title}
      aria-label={title}
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

/** Gray state chip ("disabled" / "pasted bundle" / "legacy"), upstream chip idiom. */
function StateChip({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 10,
        padding: "1px 5px",
        borderRadius: 3,
        flexShrink: 0,
        background: "rgba(120,120,120,0.12)",
        color: "var(--text-dim)",
      }}
    >
      {children}
    </span>
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

/** Segmented-control tab for the install mode toggle (From source / Paste bundle). */
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
 * One resolved EXTENSION inside a package detail: mono id + version chip +
 * transport mini-badge + row-level enable toggle, then the trust badge,
 * grantable declared capabilities (existing setCapability re-grant path),
 * manifest summary, and any load error.
 */
function ExtensionResourceCard({
  ext,
  toggling,
  granting,
  onToggle,
  onGrant,
}: {
  ext: ExtensionInfo;
  toggling: Set<string>;
  granting: Set<string>;
  onToggle: (ext: ExtensionInfo) => void;
  onGrant: (ext: ExtensionInfo, cap: ExtensionCapability, shouldGrant: boolean) => void;
}) {
  const declared = ext.declaredCapabilities ?? [];
  const granted = ext.grantedCapabilities ?? [];
  // While ANY grant for this extension is in flight, EVERY badge is disabled:
  // two concurrent grants would each compute nextCaps from the same stale
  // snapshot, so the last POST would silently drop the first grant.
  const grantBusy = Array.from(granting).some((k) => k.startsWith(`${ext.id}:`));
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "10px 12px",
        border: `1px solid ${ext.loadError ? RED : "var(--border)"}`,
        borderRadius: 6,
        background: "var(--bg)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span
          style={{
            fontSize: 12,
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
        <span style={{ flex: 1 }} />
        <Toggle
          enabled={ext.enabled}
          loading={toggling.has(ext.id)}
          onToggle={() => onToggle(ext)}
        />
      </div>

      {ext.description ? (
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
          {ext.description}
        </div>
      ) : null}

      <TransportBadge transport={ext.transport} />

      {/* Capability badges — data-driven: exactly what the API DECLARED. */}
      {declared.length > 0 && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {declared.map((cap) => (
            <CapabilityBadge
              key={`${ext.id}-cap-${cap}`}
              cap={cap}
              granted={granted.includes(cap)}
              busy={grantBusy}
              onToggle={(shouldGrant) => onGrant(ext, cap, shouldGrant)}
            />
          ))}
        </div>
      )}

      <ManifestSummary
        manifest={{ tools: (ext.toolNames ?? []).map((name) => ({ name })), events: ext.events }}
      />

      {ext.loadError && (
        <div style={{ fontSize: 12, color: RED, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {ext.loadError}
        </div>
      )}
    </div>
  );
}

/** One resolved SKILL row: mono name + dim path line + missing state. */
function SkillResourceRow({ res }: { res: PluginResourceInfo }) {
  const path = res.path ?? `${SKILLS_ROOT}/${res.name}`;
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: 12,
          color: "var(--text)",
          fontFamily: "var(--font-mono)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={path}
      >
        {res.name}
      </div>
      <div
        style={{
          fontSize: 10,
          color: "var(--text-dim)",
          fontFamily: "var(--font-mono)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          marginTop: 1,
        }}
        title={path}
      >
        {path}
      </div>
      {res.missing && (
        <div style={{ fontSize: 11, color: "#ef4444", marginTop: 1 }}>
          Not found — Update reinstalls
        </div>
      )}
    </div>
  );
}

/** Resolved-resource groups in fixed order (only non-empty groups render). */
function ResourceList({
  pkg,
  toggling,
  granting,
  onExtToggle,
  onGrant,
}: {
  pkg: PluginPackageInfo;
  toggling: Set<string>;
  granting: Set<string>;
  onExtToggle: (ext: ExtensionInfo) => void;
  onGrant: (ext: ExtensionInfo, cap: ExtensionCapability, shouldGrant: boolean) => void;
}) {
  const groups = ([
    ["extension", "Extensions"],
    ["skill", "Skills"],
    ["prompt", "Prompts"],
    ["theme", "Themes"],
  ] as const)
    .map(([kind, label]) => ({
      kind,
      label,
      resources: pkg.resources.filter((resource) => resource.kind === kind),
    }))
    .filter((group) => group.resources.length > 0);

  if (groups.length === 0) {
    return (
      <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
        {pkg.disabled ? "Package disabled" : "No resolved resources"}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {groups.map((group, groupIndex) => (
        <div
          key={group.kind}
          style={{
            borderTop: groupIndex === 0 ? "none" : "1px solid var(--border)",
            paddingTop: groupIndex === 0 ? 0 : 12,
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "var(--text-dim)",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            {group.label}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {group.resources.map((resource) =>
              resource.kind === "extension" && resource.extension ? (
                <ExtensionResourceCard
                  key={`ext:${resource.name}`}
                  ext={resource.extension}
                  toggling={toggling}
                  granting={granting}
                  onToggle={onExtToggle}
                  onGrant={onGrant}
                />
              ) : resource.kind === "skill" ? (
                <SkillResourceRow key={`skill:${resource.name}`} res={resource} />
              ) : (
                <div
                  key={`${resource.kind}:${resource.name}`}
                  style={{
                    fontSize: 12,
                    color: "var(--text)",
                    fontFamily: "var(--font-mono)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {resource.name}
                </div>
              ),
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The right-pane detail for an installed PACKAGE (or synthesized legacy/bundle package). */
function PackageDetail({
  pkg,
  sessionId,
  busyKey,
  actionError,
  actionMessage,
  toggling,
  granting,
  onPackageToggle,
  onUpdate,
  onRemove,
  onReloadSession,
  onExtToggle,
  onGrant,
}: {
  pkg: PluginPackageInfo;
  sessionId: string | null;
  busyKey: string | null;
  actionError: string | null;
  actionMessage: string | null;
  toggling: Set<string>;
  granting: Set<string>;
  onPackageToggle: (pkg: PluginPackageInfo) => void;
  onUpdate: (pkg: PluginPackageInfo) => void;
  onRemove: (pkg: PluginPackageInfo) => void;
  onReloadSession: () => void;
  onExtToggle: (ext: ExtensionInfo) => void;
  onGrant: (ext: ExtensionInfo, cap: ExtensionCapability, shouldGrant: boolean) => void;
}) {
  const key = pkg.key;
  const busy = busyKey?.endsWith(key) ?? false;
  const reloadBusy = busyKey === "reload";
  const hasExtensions =
    pkg.counts.extensions > 0 || pkg.resources.some((r) => r.kind === "extension");
  const hasSkills = pkg.resources.some((r) => r.kind === "skill");
  // No re-resolvable Source for a pasted bundle — Update can't re-POST it.
  const updateDisabled = pkg.installKind === "bundle";

  const storageLines =
    hasExtensions && hasSkills
      ? ["extensions → Durable Object (cloud)", `skills → ${SKILLS_ROOT}`]
      : hasExtensions
        ? ["Durable Object (cloud)"]
        : hasSkills
          ? [SKILLS_ROOT]
          : ["—"];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 680 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, minWidth: 0, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 180, flex: 1 }}>
          {hasExtensions && (
            <Toggle
              enabled={!pkg.disabled}
              loading={busy || reloadBusy}
              onToggle={() => onPackageToggle(pkg)}
              label={pkg.disabled ? "Enable package" : "Disable package"}
            />
          )}
          {pkg.disabled && <StateChip>disabled</StateChip>}
          {pkg.installKind === "bundle" && <StateChip>pasted bundle</StateChip>}
          {pkg.installKind === "legacy" && <StateChip>legacy</StateChip>}
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {pkg.source}
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={() => onUpdate(pkg)}
            disabled={busy || reloadBusy || updateDisabled}
            style={buttonStyle(busy || reloadBusy || updateDisabled)}
            title={
              updateDisabled
                ? "Pasted bundles have no source to re-resolve — paste the bundle again to update."
                : undefined
            }
          >
            {busyKey === `update:${key}` ? "Updating..." : "Update"}
          </button>
          <button
            onClick={onReloadSession}
            disabled={!sessionId || reloadBusy || busy}
            style={buttonStyle(!sessionId || reloadBusy || busy)}
            title={sessionId ? "Reload current session" : "Open a session to reload"}
          >
            {reloadBusy ? "Reloading..." : "Reload session"}
          </button>
          <button
            onClick={() => onRemove(pkg)}
            disabled={busy || reloadBusy}
            style={buttonStyle(busy || reloadBusy, true)}
          >
            {busyKey === `remove:${key}` ? "Removing..." : "Remove"}
          </button>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(96px, 130px) minmax(0, 1fr)",
          gap: "9px 14px",
          fontSize: 12,
          lineHeight: 1.45,
        }}
      >
        <div style={{ color: "var(--text-dim)" }}>Status</div>
        <div style={{ color: statusColor(pkg.status), textTransform: "capitalize" }}>{pkg.status}</div>
        <div style={{ color: "var(--text-dim)" }}>Version</div>
        <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{versionSummary(pkg)}</div>
        <div style={{ color: "var(--text-dim)" }}>Package</div>
        <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
          {pkg.packageName ?? "Unknown"}
        </div>
        <div style={{ color: "var(--text-dim)" }}>Resources</div>
        <div style={{ color: "var(--text-muted)" }}>{resourceSummary(pkg)}</div>
        <div style={{ color: "var(--text-dim)" }}>Storage</div>
        <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
          {storageLines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
        <div style={{ color: "var(--text-dim)" }}>Cwd</div>
        <div style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
          {shortenPath(CF_CWD)}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>
          Resolved Resources
        </div>
        <ResourceList
          pkg={pkg}
          toggling={toggling}
          granting={granting}
          onExtToggle={onExtToggle}
          onGrant={onGrant}
        />
      </div>

      {actionMessage && (
        <div style={{ fontSize: 12, color: "#16a34a" }}>
          {actionMessage}
        </div>
      )}
      {actionError && (
        <div style={{ fontSize: 12, color: "#ef4444", whiteSpace: "pre-wrap" }}>
          {actionError}
        </div>
      )}
    </div>
  );
}

/** Reduced detail for a compile-time BUILT-IN extension (not a package: no Update/Remove). */
function BuiltinDetail({
  ext,
  sessionId,
  busyKey,
  toggling,
  actionError,
  actionMessage,
  onToggle,
  onReloadSession,
}: {
  ext: ExtensionInfo;
  sessionId: string | null;
  busyKey: string | null;
  toggling: Set<string>;
  actionError: string | null;
  actionMessage: string | null;
  onToggle: (ext: ExtensionInfo) => void;
  onReloadSession: () => void;
}) {
  const reloadBusy = busyKey === "reload";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 680 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, minWidth: 0, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 180, flex: 1 }}>
          <Toggle
            enabled={ext.enabled}
            loading={toggling.has(ext.id)}
            onToggle={() => onToggle(ext)}
            label={ext.enabled ? "Disable extension" : "Enable extension"}
          />
          {!ext.enabled && <StateChip>disabled</StateChip>}
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {ext.id}
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={onReloadSession}
            disabled={!sessionId || reloadBusy}
            style={buttonStyle(!sessionId || reloadBusy)}
            title={sessionId ? "Reload current session" : "Open a session to reload"}
          >
            {reloadBusy ? "Reloading..." : "Reload session"}
          </button>
        </div>
      </div>

      {ext.description ? (
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
          {ext.description}
        </div>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(96px, 130px) minmax(0, 1fr)",
          gap: "9px 14px",
          fontSize: 12,
          lineHeight: 1.45,
        }}
      >
        <div style={{ color: "var(--text-dim)" }}>Status</div>
        <div
          style={{
            color: ext.enabled ? "var(--accent)" : "var(--text-dim)",
            textTransform: "capitalize",
          }}
        >
          {ext.enabled ? "loaded" : "disabled"}
        </div>
        <div style={{ color: "var(--text-dim)" }}>Package</div>
        <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          built-in (compile-time)
        </div>
        <div style={{ color: "var(--text-dim)" }}>Storage</div>
        <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          compiled into Worker
        </div>
      </div>

      {actionMessage && (
        <div style={{ fontSize: 12, color: "#16a34a" }}>
          {actionMessage}
        </div>
      )}
      {actionError && (
        <div style={{ fontSize: 12, color: "#ef4444", whiteSpace: "pre-wrap" }}>
          {actionError}
        </div>
      )}
    </div>
  );
}

/**
 * The Add Plugin panel: upstream layout (title, autofocused Source input,
 * Enter submits, clickable Examples, accent Install button) + our two modes
 * ("From source" resolves a full pi package in the owner sandbox; "Paste
 * bundle" keeps the pre-bundled-ESM primitive with id/version/description).
 */
function AddPluginPanel({
  source,
  busy,
  actionError,
  onSourceChange,
  onInstallSource,
  onInstallPaste,
  onError,
}: {
  source: string;
  busy: boolean;
  actionError: string | null;
  onSourceChange: (value: string) => void;
  onInstallSource: () => void;
  onInstallPaste: (req: { module: string; id: string; description?: string; version?: string }) => void;
  onError: (message: string) => void;
}) {
  const [mode, setMode] = useState<"source" | "paste">("source");
  const [module, setModule] = useState("");
  const [id, setId] = useState("");
  const [description, setDescription] = useState("");
  const [version, setVersion] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const examples = ["npm:@scope/pi-plugin", "npm:my-pi-ext@1.2.0", "git:https://github.com/user/repo"];

  useEffect(() => {
    if (mode === "source") inputRef.current?.focus();
  }, [mode]);

  const submit = useCallback(() => {
    if (mode === "source") {
      if (!source.trim()) {
        onError("Enter a source (e.g. npm:@scope/package).");
        return;
      }
      onInstallSource();
    } else {
      if (!module.trim()) {
        onError("Paste or choose a bundle module first.");
        return;
      }
      if (!id.trim()) {
        onError("An extension id is required (lowercase, e.g. my-ext).");
        return;
      }
      onInstallPaste({
        module,
        id: id.trim(),
        description: description.trim() || undefined,
        version: version.trim() || undefined,
      });
    }
  }, [mode, source, module, id, description, version, onError, onInstallSource, onInstallPaste]);

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
        onError(errText(err));
      }
    },
    [id, onError],
  );

  const inputStyle: React.CSSProperties = {
    width: "100%",
    fontSize: 12,
    padding: "6px 8px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "var(--bg-panel)",
    color: "var(--text)",
    outline: "none",
  };

  const installBtnDisabled = busy || (mode === "source" && !source.trim());

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 660, minHeight: "100%" }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
        Add Plugin
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        <ModeTab active={mode === "source"} onClick={() => setMode("source")} disabled={busy}>
          From source
        </ModeTab>
        <ModeTab active={mode === "paste"} onClick={() => setMode("paste")} disabled={busy}>
          Paste bundle
        </ModeTab>
      </div>

      {mode === "source" ? (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <label htmlFor="plugin-source" style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>
              Source
            </label>
            <input
              id="plugin-source"
              ref={inputRef}
              value={source}
              onChange={(e) => onSourceChange(e.target.value)}
              placeholder="npm:@scope/package"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              style={{
                width: "100%",
                height: 36,
                padding: "0 11px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--bg-panel)",
                color: "var(--text)",
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                outline: "none",
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && source.trim() && !busy) submit();
              }}
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={submit}
              disabled={installBtnDisabled}
              style={{
                ...buttonStyle(installBtnDisabled),
                background: "var(--accent)",
                color: "white",
                borderColor: "var(--accent)",
              }}
            >
              {busy ? "Installing..." : "Install"}
            </button>
            {busy && (
              <span style={{ fontSize: 12, color: "var(--text-muted)", display: "inline-flex", alignItems: "center", gap: 8 }}>
                <Spinner />
                Resolving &amp; bundling in your sandbox…
              </span>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>
              Examples
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {examples.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => onSourceChange(example)}
                  style={{
                    width: "100%",
                    minHeight: 30,
                    textAlign: "left",
                    padding: "6px 9px",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    background: "var(--bg-panel)",
                    color: "var(--text-dim)",
                    cursor: "pointer",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "var(--bg-panel)";
                    e.currentTarget.style.color = "var(--text-dim)";
                  }}
                >
                  {example}
                </button>
              ))}
            </div>
          </div>

          <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
            Source extensions are resolved and bundled inside your own sandbox, so they always
            run there (with your files, network, and shell) — install shows the exact tools,
            events, and capabilities before you grant anything.
          </div>
        </>
      ) : (
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
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={submit}
              disabled={busy}
              style={{
                ...buttonStyle(busy),
                background: "var(--accent)",
                color: "white",
                borderColor: "var(--accent)",
              }}
            >
              {busy ? "Installing..." : "Install"}
            </button>
          </div>
        </>
      )}

      {actionError && (
        <div style={{ fontSize: 12, color: "#ef4444", whiteSpace: "pre-wrap" }}>
          {actionError}
        </div>
      )}
    </div>
  );
}

const BUILTIN_KEY_PREFIX = "builtin:";

const EMPTY_TOTALS = { extensions: 0, skills: 0, prompts: 0, themes: 0 };

/** E8f master-detail panel (THIRDPARTY_EXTENSIONS=true). */
function PluginsConfigMasterDetail({
  sessionId,
  onClose,
  onReloaded,
}: {
  sessionId: string | null;
  onClose: () => void;
  onReloaded?: () => void;
}) {
  const isMobile = useIsMobile();
  const [data, setData] = useState<PluginsListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [installSource, setInstallSource] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [granting, setGranting] = useState<Set<string>>(new Set()); // key = `${id}:${cap}`
  // id → module for extensions pasted THIS session, so a row-level grant can
  // re-POST (the only backend path to change a grant needs the bundle, which
  // GET does not return). Lost on modal close → graceful degrade for old rows.
  const bundleCacheRef = useRef<Map<string, string>>(new Map());

  // After any successful SOURCE install/update, drop cached pasted bundles
  // whose ids the package now owns — a stale paste must never shadow a
  // source-installed row on a later re-grant.
  const pruneBundleCache = useCallback(
    (d: InstallExtensionResponse | PackageInstallResponse) => {
      if (isPackageInstallResponse(d)) {
        for (const e of d.extensions) bundleCacheRef.current.delete(e.id);
      }
    },
    [],
  );

  const packages = useMemo(() => data?.packages ?? [], [data?.packages]);
  const builtins = useMemo(
    () => (data?.extensions ?? []).filter((e) => e.source !== "thirdparty"),
    [data?.extensions],
  );
  const selectedPackage = packages.find((pkg) => pkg.key === selected) ?? null;
  const selectedBuiltin =
    selected?.startsWith(BUILTIN_KEY_PREFIX)
      ? builtins.find((e) => `${BUILTIN_KEY_PREFIX}${e.id}` === selected) ?? null
      : null;

  const load = useCallback(async (): Promise<PluginsListResponse | null> => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/plugins");
      const raw = (await res.json()) as Partial<PluginsListResponse> & { error?: string };
      if (!res.ok || raw.error) throw new Error(raw.error ?? `HTTP ${res.status}`);
      const next: PluginsListResponse = {
        extensions: raw.extensions ?? [],
        packages: raw.packages ?? [],
        totals: raw.totals ?? EMPTY_TOTALS,
        diagnostics: raw.diagnostics ?? [],
      };
      setData(next);
      // Empty package list auto-opens the Add panel; add mode is sticky.
      setAddMode((current) => next.packages.length === 0 || current);
      // Keep the current selection if it still exists; else first package,
      // else first builtin.
      setSelected((current) => {
        const builtinKeys = next.extensions
          .filter((e) => e.source !== "thirdparty")
          .map((e) => `${BUILTIN_KEY_PREFIX}${e.id}`);
        const keys = new Set<string>([...next.packages.map((p) => p.key), ...builtinKeys]);
        if (current && keys.has(current)) return current;
        return next.packages[0]?.key ?? builtinKeys[0] ?? null;
      });
      return next;
    } catch (err) {
      setError(errText(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Package-level enable/disable (PATCH { package, enabled }).
  const togglePackage = useCallback(
    async (pkg: PluginPackageInfo) => {
      const action = pkg.disabled ? "enable" : "disable";
      setBusyKey(`${action}:${pkg.key}`);
      setActionError(null);
      setActionMessage(null);
      try {
        const res = await apiFetch("/api/plugins", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ package: pkg.key, enabled: pkg.disabled }),
        });
        const d = (await res.json()) as { success?: boolean; error?: string };
        if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
        setDirty(true);
        await load();
        setActionMessage(action === "enable" ? "Package enabled." : "Package disabled.");
      } catch (err) {
        setActionError(errText(err));
      } finally {
        setBusyKey(null);
      }
    },
    [load],
  );

  // Update = re-POST the same source (server upsert keeps enabled/grants).
  const updatePackage = useCallback(
    async (pkg: PluginPackageInfo) => {
      setBusyKey(`update:${pkg.key}`);
      setActionError(null);
      setActionMessage(null);
      try {
        const res = await apiFetch("/api/plugins", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: pkg.key } satisfies InstallExtensionRequest),
        });
        const d = (await res.json()) as (InstallExtensionResponse | PackageInstallResponse) & {
          error?: string;
        };
        if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
        pruneBundleCache(d);
        setDirty(true);
        await load();
        setActionMessage("Package updated.");
      } catch (err) {
        setActionError(errText(err));
      } finally {
        setBusyKey(null);
      }
    },
    [load, pruneBundleCache],
  );

  // Remove the whole package (DELETE { package }). No confirmation (upstream).
  const removePackage = useCallback(
    async (pkg: PluginPackageInfo) => {
      setBusyKey(`remove:${pkg.key}`);
      setActionError(null);
      setActionMessage(null);
      try {
        const res = await apiFetch("/api/plugins", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ package: pkg.key }),
        });
        const d = (await res.json()) as { success?: boolean; error?: string };
        if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
        for (const r of pkg.resources) {
          if (r.kind === "extension") bundleCacheRef.current.delete(r.name);
        }
        setDirty(true);
        const next = await load();
        // Select the first remaining package; with none left, load() has
        // already flipped to add mode.
        if (next) setSelected(next.packages[0]?.key ?? null);
        setActionMessage("Package removed.");
      } catch (err) {
        setActionError(errText(err));
      } finally {
        setBusyKey(null);
      }
    },
    [load],
  );

  // Per-extension enable/disable (existing PATCH { id, enabled }) — used by
  // both the per-package extension cards and the built-in detail.
  const toggleExtension = useCallback(
    async (ext: ExtensionInfo) => {
      const next = !ext.enabled;
      setToggling((s) => new Set(s).add(ext.id));
      setActionError(null);
      setActionMessage(null);
      try {
        const res = await apiFetch("/api/plugins", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: ext.id, enabled: next }),
        });
        const d = (await res.json()) as { success?: boolean; error?: string };
        if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
        setDirty(true);
        await load();
      } catch (err) {
        setActionError(errText(err));
      } finally {
        setToggling((s) => {
          const n = new Set(s);
          n.delete(ext.id);
          return n;
        });
      }
    },
    [load],
  );

  const setCapability = useCallback(
    async (ext: ExtensionInfo, cap: ExtensionCapability, shouldGrant: boolean) => {
      // A grant change re-POSTs. A source-installed row ALWAYS re-resolves from
      // its stored Source — a cached paste with a colliding id would re-POST a
      // STALE module (and server-side clear the row's source, detaching it from
      // its package). Only rows WITHOUT a Source use the cached PASTED bundle;
      // an old paste row with neither is unactionable → ask for a re-upload.
      const bundle = ext.installSource ? undefined : bundleCacheRef.current.get(ext.id);
      if (!bundle && !ext.installSource) {
        setActionError(
          `To change capabilities for “${ext.id}”, re-add its bundle via “Add plugin”. ` +
            `(The stored bundle isn't returned by the API, so a grant needs a re-upload.)`,
        );
        return;
      }
      const gkey = `${ext.id}:${cap}`;
      setGranting((s) => new Set(s).add(gkey));
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
        const d = (await res.json()) as (InstallExtensionResponse | PackageInstallResponse) & {
          error?: string;
        };
        if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
        pruneBundleCache(d);
        setDirty(true);
        await load();
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
          n.delete(gkey);
          return n;
        });
      }
    },
    [load, pruneBundleCache],
  );

  const installFromSource = useCallback(async () => {
    const source = installSource.trim();
    if (!source) return;
    setBusyKey(`install:${source}`);
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await apiFetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source } satisfies InstallExtensionRequest),
      });
      const d = (await res.json()) as (InstallExtensionResponse | PackageInstallResponse) & {
        error?: string;
      };
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      pruneBundleCache(d);
      setDirty(true);
      const next = await load();
      if (next) {
        const installed = findInstalledPackage(next.packages, source);
        setSelected(installed ? installed.key : source);
      }
      setAddMode(false);
      setInstallSource("");
      setActionMessage("Package installed.");
    } catch (err) {
      setActionError(errText(err));
    } finally {
      setBusyKey(null);
    }
  }, [installSource, load, pruneBundleCache]);

  const installFromPaste = useCallback(
    async (req: { module: string; id: string; description?: string; version?: string }) => {
      setBusyKey(`install:bundle:${req.id}`);
      setActionError(null);
      setActionMessage(null);
      try {
        const body: InstallExtensionRequest = { ...req, capabilities: [] };
        const res = await apiFetch("/api/plugins", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const d = (await res.json()) as (InstallExtensionResponse | PackageInstallResponse) & {
          error?: string;
        };
        if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
        // A pasted bundle is cached so a later row-level re-grant needs no re-upload.
        bundleCacheRef.current.set(req.id, req.module);
        setDirty(true);
        await load();
        setSelected(`bundle:${req.id}`);
        setAddMode(false);
        setActionMessage("Package installed.");
      } catch (err) {
        setActionError(errText(err));
      } finally {
        setBusyKey(null);
      }
    },
    [load],
  );

  const reloadSession = useCallback(async () => {
    if (!sessionId) return;
    setBusyKey("reload");
    setActionError(null);
    setActionMessage(null);
    try {
      await sendAgentCommand(sessionId, { type: "reload" });
      setDirty(false);
      onReloaded?.();
      await load();
      setActionMessage("Session reloaded.");
    } catch (err) {
      setActionError(errText(err));
    } finally {
      setBusyKey(null);
    }
  }, [load, onReloaded, sessionId]);

  const addBusy = busyKey?.startsWith("install:") ?? false;

  const selectRow = useCallback((key: string) => {
    setSelected(key);
    setAddMode(false);
    setActionError(null);
    setActionMessage(null);
  }, []);

  const renderRow = (opts: {
    key: string;
    dotColor: string;
    line1: string;
    line2: string;
    line3?: string;
  }) => {
    const isSelected = !addMode && selected === opts.key;
    return (
      <div
        key={opts.key}
        onClick={() => selectRow(opts.key)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "8px 8px",
          borderRadius: 5,
          cursor: "pointer",
          background: isSelected ? "var(--bg-selected)" : "none",
        }}
        onMouseEnter={(e) => {
          if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(e) => {
          if (!isSelected) e.currentTarget.style.background = "none";
        }}
      >
        <span
          style={{
            flexShrink: 0,
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: opts.dotColor,
          }}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: isSelected ? 600 : 400,
              color: "var(--text)",
              fontFamily: "var(--font-mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {opts.line1}
          </div>
          <div
            style={{
              fontSize: 10,
              color: "var(--text-dim)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              marginTop: 2,
            }}
          >
            {opts.line2}
          </div>
          {opts.line3 && (
            <div
              style={{
                fontSize: 10,
                color: "var(--text-dim)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                marginTop: 2,
              }}
            >
              {opts.line3}
            </div>
          )}
        </div>
      </div>
    );
  };

  const groupHeaderStyle: React.CSSProperties = {
    padding: "4px 8px 3px",
    fontSize: 10,
    fontWeight: 600,
    color: "var(--text-dim)",
    textTransform: "uppercase",
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
          width: isMobile ? "calc(100vw - 16px)" : 860,
          maxWidth: "calc(100vw - 16px)",
          height: isMobile ? "calc(100dvh - 16px)" : "76vh",
          maxHeight: "calc(100dvh - 16px)",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 8,
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
            <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
              Plugins
            </span>
            <code
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {shortenPath(CF_CWD)}
            </code>
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

        {/* Body — master-detail */}
        <div style={{ flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row", overflow: "hidden" }}>
          <div
            style={{
              width: isMobile ? "100%" : 245,
              maxHeight: isMobile ? "40vh" : undefined,
              borderRight: isMobile ? "none" : "1px solid var(--border)",
              borderBottom: isMobile ? "1px solid var(--border)" : "none",
              display: "flex",
              flexDirection: "column",
              flexShrink: 0,
              background: "var(--bg-panel)",
            }}
          >
            <div style={{ flex: 1, overflowY: "auto", padding: "8px 6px" }}>
              {loading ? (
                <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-muted)" }}>
                  Loading...
                </div>
              ) : error ? (
                <div style={{ padding: "10px 8px", fontSize: 11, color: "#ef4444" }}>
                  {error}
                </div>
              ) : packages.length === 0 && builtins.length === 0 ? (
                <div style={{ padding: "10px 8px", fontSize: 11, color: "var(--text-dim)" }}>
                  No plugins configured
                </div>
              ) : (
                <>
                  {packages.length > 0 && (
                    <div style={{ marginBottom: 6 }}>
                      <div style={groupHeaderStyle}>Packages</div>
                      {packages.map((pkg) =>
                        renderRow({
                          key: pkg.key,
                          dotColor: statusColor(pkg.status),
                          line1: pkg.source,
                          line2: resourceSummary(pkg),
                          line3:
                            pkg.version || pkg.configuredVersion
                              ? versionSummary(pkg)
                              : undefined,
                        }),
                      )}
                    </div>
                  )}
                  {builtins.length > 0 && (
                    <div style={{ marginBottom: 6 }}>
                      <div style={groupHeaderStyle}>Built-in</div>
                      {builtins.map((ext) =>
                        renderRow({
                          key: `${BUILTIN_KEY_PREFIX}${ext.id}`,
                          dotColor: ext.enabled ? "var(--accent)" : "var(--text-dim)",
                          line1: ext.id,
                          line2: ext.enabled ? "1 ext" : "Disabled",
                        }),
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
            <div style={{ padding: "8px 6px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
              <button
                type="button"
                onClick={() => {
                  setAddMode(true);
                  setActionError(null);
                  setActionMessage(null);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 8px",
                  borderRadius: 5,
                  border: "none",
                  width: "100%",
                  cursor: "pointer",
                  background: addMode ? "var(--bg-selected)" : "none",
                  color: addMode ? "var(--accent)" : "var(--text-dim)",
                  fontSize: 12,
                }}
                onMouseEnter={(e) => {
                  if (!addMode) e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  if (!addMode) e.currentTarget.style.background = "none";
                }}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Add plugin
              </button>
            </div>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
            {addMode ? (
              <AddPluginPanel
                source={installSource}
                busy={addBusy}
                actionError={actionError}
                onSourceChange={setInstallSource}
                onInstallSource={() => void installFromSource()}
                onInstallPaste={(req) => void installFromPaste(req)}
                onError={setActionError}
              />
            ) : loading ? null : selectedPackage ? (
              <PackageDetail
                key={selectedPackage.key}
                pkg={selectedPackage}
                sessionId={sessionId}
                busyKey={busyKey}
                actionError={actionError}
                actionMessage={actionMessage}
                toggling={toggling}
                granting={granting}
                onPackageToggle={(pkg) => void togglePackage(pkg)}
                onUpdate={(pkg) => void updatePackage(pkg)}
                onRemove={(pkg) => void removePackage(pkg)}
                onReloadSession={() => void reloadSession()}
                onExtToggle={(ext) => void toggleExtension(ext)}
                onGrant={(ext, cap, shouldGrant) => void setCapability(ext, cap, shouldGrant)}
              />
            ) : selectedBuiltin ? (
              <BuiltinDetail
                key={`${BUILTIN_KEY_PREFIX}${selectedBuiltin.id}`}
                ext={selectedBuiltin}
                sessionId={sessionId}
                busyKey={busyKey}
                toggling={toggling}
                actionError={actionError}
                actionMessage={actionMessage}
                onToggle={(ext) => void toggleExtension(ext)}
                onReloadSession={() => void reloadSession()}
              />
            ) : (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-dim)",
                  fontSize: 13,
                }}
              >
                Select a package
              </div>
            )}
          </div>
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
          <div style={{ minWidth: 0, flex: 1, fontSize: 11, color: "var(--text-dim)", overflow: "hidden" }}>
            {data?.diagnostics.length ? (
              <span
                title={data.diagnostics
                  .map((d) => `${d.type}: ${d.source ? `${d.source}: ` : ""}${d.message}`)
                  .join("\n")}
                style={{ color: data.diagnostics.some((d) => d.type === "error") ? "#ef4444" : "#d97706" }}
              >
                {data.diagnostics.length} diagnostic{data.diagnostics.length === 1 ? "" : "s"}
              </span>
            ) : (
              <span>
                {data ? (
                  <>
                    {`${data.totals.extensions} ext · ${data.totals.skills} skills · ${data.totals.prompts} prompts · `}
                    <span title="themes are N/A on headless pi-cf">{data.totals.themes} themes</span>
                  </>
                ) : (
                  ""
                )}
              </span>
            )}
            {dirty && <span> · Reload the session to apply changes.</span>}
          </div>
          <button
            onClick={() => void load()}
            disabled={loading || busyKey !== null}
            style={buttonStyle(loading || busyKey !== null)}
          >
            Refresh
          </button>
          <button onClick={onClose} style={buttonStyle(false)}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * E7 rollback surface (THIRDPARTY_EXTENSIONS=false): the exact built-in-only
 * panel — flat list, no groups, no install.
 */
function PluginsConfigLegacy({
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
  const [actionError, setActionError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [reloading, setReloading] = useState(false);

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

  const busy = toggling.size > 0 || reloading;
  // Tolerate an absent `source` (treat as built-in) — the E7 surface only
  // ever shows built-ins.
  const builtins = extensions.filter((e) => e.source !== "thirdparty");

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
              Built-in · enable / disable
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
          ) : builtins.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
              No built-in extensions available.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {builtins.map((ext) => (
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
                  <Toggle
                    enabled={ext.enabled}
                    loading={toggling.has(ext.id)}
                    onToggle={() => void toggle(ext)}
                  />
                </div>
              ))}
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

export function PluginsConfig(props: {
  sessionId: string | null;
  onClose: () => void;
  onReloaded?: () => void;
}) {
  if (!THIRDPARTY_EXTENSIONS) return <PluginsConfigLegacy {...props} />;
  return <PluginsConfigMasterDetail {...props} />;
}
