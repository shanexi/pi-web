"use client";

// D3: sandbox-side directory browser for the cwd picker. The "select a
// directory" flow lost its host-machine semantics on Cloudflare (D0 hid it);
// this revives it against the per-user E2B sandbox: GET /api/dirs?path= lists
// subdirectories, POST /api/dirs creates one, and the selected path becomes
// the cwd for new sessions. When no sandbox exists yet the backend answers
// with the {sandbox:null} marker and this renders the 「工作区未初始化」 empty
// state with an explicit 「初始化工作区」 button (POST /api/workspace/init) —
// browsing never implicitly spins up a VM.

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-base";

interface DirEntry {
  name: string;
  path: string;
}

interface DirsResponse {
  sandbox?: string | null;
  path?: string;
  dirs?: DirEntry[];
  error?: string;
}

interface Props {
  /** Directory to open first (falls back to /workspace). */
  initialPath?: string | null;
  /** Called with the chosen absolute sandbox path. */
  onSelect: (path: string) => void;
}

function parentOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

export function SandboxDirPicker({ initialPath, onSelect }: Props) {
  const [path, setPath] = useState<string>(initialPath || "/workspace");
  const [dirs, setDirs] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uninitialized, setUninitialized] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (dirPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/dirs?path=${encodeURIComponent(dirPath)}`);
      const data = (await res.json().catch(() => ({}))) as DirsResponse;
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        setDirs([]);
        return;
      }
      if (data.sandbox === null) {
        setUninitialized(true);
        setDirs([]);
        return;
      }
      setUninitialized(false);
      setDirs(data.dirs ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDirs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(path);
  }, [path, load]);

  const handleInit = useCallback(async () => {
    if (initializing) return;
    setInitializing(true);
    setError(null);
    try {
      const res = await apiFetch("/api/workspace/init", { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      await res.json().catch(() => ({}));
      await load(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInitializing(false);
    }
  }, [initializing, load, path]);

  const handleMakeDir = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name || busy || name.includes("/")) return;
    setBusy(true);
    setError(null);
    try {
      const target = `${path === "/" ? "" : path}/${name}`;
      const res = await apiFetch("/api/dirs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: target }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setNewFolderOpen(false);
      setNewFolderName("");
      setPath(target); // descend into the new project directory
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, newFolderName, path]);

  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 7,
    width: "100%",
    padding: "6px 10px",
    background: "none",
    border: "none",
    color: "var(--text-muted)",
    cursor: "pointer",
    textAlign: "left",
    fontSize: 11,
    fontFamily: "var(--font-mono)",
  };

  if (uninitialized) {
    return (
      <div style={{ padding: "10px", borderTop: "1px solid var(--border)" }}>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8, textAlign: "center" }}>
          工作区未初始化
        </div>
        <button
          onClick={() => void handleInit()}
          disabled={initializing}
          style={{
            width: "100%",
            padding: "6px 0",
            background: "var(--accent)",
            border: "none",
            borderRadius: 5,
            color: "#fff",
            fontSize: 11,
            fontWeight: 600,
            cursor: initializing ? "not-allowed" : "pointer",
            opacity: initializing ? 0.65 : 1,
          }}
        >
          {initializing ? "初始化中…" : "初始化工作区"}
        </button>
        {error && (
          <div style={{ marginTop: 6, color: "#dc2626", fontSize: 11, overflowWrap: "anywhere" }}>{error}</div>
        )}
      </div>
    );
  }

  return (
    <div style={{ borderTop: "1px solid var(--border)" }}>
      {/* Current path + up */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderBottom: "1px solid var(--border)" }}>
        <button
          onClick={() => setPath(parentOf(path))}
          disabled={path === "/"}
          title="Up one directory"
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 20, height: 20, padding: 0,
            background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 4,
            color: path === "/" ? "var(--text-dim)" : "var(--text-muted)",
            cursor: path === "/" ? "not-allowed" : "pointer", flexShrink: 0,
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="2 6.5 5 3.5 8 6.5" />
          </svg>
        </button>
        <span
          title={path}
          style={{
            flex: 1, fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl", textAlign: "left",
          }}
        >
          {path}
        </span>
      </div>

      {/* Subdirectories */}
      <div style={{ maxHeight: 160, overflowY: "auto" }}>
        {loading && <div style={{ padding: "6px 10px", fontSize: 11, color: "var(--text-dim)" }}>Loading…</div>}
        {!loading && dirs.map((d) => (
          <button key={d.path} onClick={() => setPath(d.path)} style={rowStyle} title={d.path}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
            </svg>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</span>
          </button>
        ))}
        {!loading && dirs.length === 0 && !error && (
          <div style={{ padding: "6px 10px", fontSize: 11, color: "var(--text-dim)" }}>No subdirectories</div>
        )}
        {error && (
          <div style={{ padding: "6px 10px", fontSize: 11, color: "#dc2626", overflowWrap: "anywhere" }}>{error}</div>
        )}
      </div>

      {/* Actions */}
      <div style={{ padding: "6px 8px", borderTop: "1px solid var(--border)" }}>
        {newFolderOpen ? (
          <div>
            <input
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleMakeDir();
                }
                if (e.key === "Escape") {
                  setNewFolderOpen(false);
                  setNewFolderName("");
                }
              }}
              placeholder="new-folder-name"
              autoFocus
              style={{
                width: "100%", fontSize: 11, fontFamily: "var(--font-mono)", padding: "5px 8px",
                border: "1px solid var(--accent)", borderRadius: 5, outline: "none",
                background: "var(--bg)", color: "var(--text)", boxSizing: "border-box",
              }}
            />
            <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
              <button
                onClick={() => void handleMakeDir()}
                disabled={busy || !newFolderName.trim() || newFolderName.includes("/")}
                style={{
                  flex: 1, padding: "4px 0", background: "var(--accent)", border: "none", borderRadius: 5,
                  color: "#fff", fontSize: 11, fontWeight: 600,
                  cursor: busy || !newFolderName.trim() ? "not-allowed" : "pointer",
                  opacity: busy || !newFolderName.trim() ? 0.65 : 1,
                }}
              >
                {busy ? "Creating…" : "Create"}
              </button>
              <button
                onClick={() => { setNewFolderOpen(false); setNewFolderName(""); }}
                style={{
                  flex: 1, padding: "4px 0", background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 5, color: "var(--text-muted)", fontSize: 11, cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 5 }}>
            <button
              onClick={() => onSelect(path)}
              style={{
                flex: 1, padding: "4px 0", background: "var(--accent)", border: "none", borderRadius: 5,
                color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer",
              }}
              title={`Use ${path} as the new-session working directory`}
            >
              Select this directory
            </button>
            <button
              onClick={() => setNewFolderOpen(true)}
              style={{
                flex: 1, padding: "4px 0", background: "var(--bg-hover)", border: "1px solid var(--border)",
                borderRadius: 5, color: "var(--text-muted)", fontSize: 11, cursor: "pointer",
              }}
            >
              New folder…
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
