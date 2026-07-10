"use client";

import { useCallback, useEffect, useState } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import { apiFetch } from "@/lib/api-base";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { ExtensionInfo, ExtensionsResponse } from "@/lib/api-types";

/**
 * E7: Plugins panel — an ENABLE/DISABLE toggler for the agent Worker's
 * compile-time built-in extensions. This replaces the upstream package manager
 * (install/remove/search/scope are gone): the built-ins are audited pi-cf
 * source, so the only per-user knob is on/off, persisted per owner and applied
 * to a live session on /reload. Data source: GET/PATCH /api/plugins via
 * apiFetch. Degrades gracefully to empty/error states.
 */
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
      setError(err instanceof Error ? err.message : String(err));
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
      setActionError(err instanceof Error ? err.message : String(err));
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
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setReloading(false);
    }
  }, [onReloaded, sessionId]);

  const busy = toggling.size > 0 || reloading;

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
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>Built-in · enable / disable</span>
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
            <div style={{ fontSize: 13, color: "#f87171" }}>{error}</div>
          ) : extensions.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--text-dim)" }}>No built-in extensions available.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {extensions.map((ext) => (
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
            <div style={{ fontSize: 12, color: "#f87171", marginTop: 12, whiteSpace: "pre-wrap" }}>
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
