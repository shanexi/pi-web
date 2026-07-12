"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { apiFetch } from "@/lib/api-base";

// Per-owner E2B sandbox status + pause/resume, shown in the top bar next to the
// account identity (the sandbox is account-scoped: one shared VM across all of
// the owner's sessions and directories).
//
// Poll GET /api/workspace/state for the precise lifecycle (cold/running/paused —
// an e2b getInfo probe, which does NOT resume a paused VM). Click opens a popover
// with the state + one action:
//  - running → Pause (freeze fs+memory, save cost; next tool call auto-resumes).
//  - paused/cold → Wake (pre-warm now so the next command skips cold-resume).
// Pause is GUARDED server-side: if any of the owner's sessions is running the
// backend returns 409 (never kills running work) and we surface that inline.

type SandboxState = "loading" | "cold" | "running" | "paused" | "error";

const POLL_MS = 25_000;

const DOT: Record<SandboxState, string> = {
  loading: "var(--text-dim)",
  cold: "var(--text-dim)",
  running: "#4ade80",
  paused: "#f59e0b",
  error: "#ef4444",
};

const LABEL: Record<SandboxState, string> = {
  loading: "sandbox…",
  cold: "no sandbox",
  running: "sandbox running",
  paused: "sandbox paused",
  error: "sandbox ?",
};

const STATE_TEXT: Record<SandboxState, string> = {
  loading: "读取中…",
  cold: "无 sandbox",
  running: "运行中",
  paused: "已暂停",
  error: "状态未知",
};

const HELP: Record<SandboxState, string> = {
  loading: "",
  cold: "还没有 sandbox — 下次操作会新建一个。",
  running: "暂停会冻结文件系统 + 内存并省资源;下次操作自动恢复(同一个 sandbox)。",
  paused: "已冻结,状态完整保留;下次操作会自动恢复。",
  error: "读取沙箱状态失败。",
};

function Dot({ color, size = 7 }: { color: string; size?: number }) {
  return (
    <span
      style={{ width: size, height: size, borderRadius: "50%", background: color, flexShrink: 0, transition: "background 0.3s" }}
    />
  );
}

export function SandboxStatusChip({ style }: { style?: CSSProperties }) {
  const [state, setState] = useState<SandboxState>("loading");
  const [open, setOpen] = useState(false);
  const [acting, setActing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const aliveRef = useRef(true);
  const rootRef = useRef<HTMLDivElement>(null);

  const probe = useCallback(async () => {
    try {
      const res = await apiFetch("/api/workspace/state");
      if (!aliveRef.current) return;
      if (!res.ok) {
        setState("error");
        return;
      }
      const data = (await res.json()) as { state?: string };
      const s = data.state;
      setState(s === "running" || s === "paused" || s === "cold" ? s : "error");
    } catch {
      if (aliveRef.current) setState("error");
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      await probe();
      if (aliveRef.current && !document.hidden) timer = setTimeout(loop, POLL_MS);
    };
    const kick = () => {
      if (!document.hidden) loop();
    };
    loop();
    window.addEventListener("focus", kick);
    document.addEventListener("visibilitychange", kick);
    return () => {
      aliveRef.current = false;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", kick);
      document.removeEventListener("visibilitychange", kick);
    };
  }, [probe]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pause = async () => {
    setActing(true);
    setNotice(null);
    try {
      const res = await apiFetch("/api/workspace/pause", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { runningSessionIds?: string[] };
      if (res.status === 409) {
        const n = Array.isArray(data.runningSessionIds) ? data.runningSessionIds.length : 0;
        setNotice(`${n} 个会话正在运行,先等它们结束再暂停。`);
      } else if (res.ok) {
        setState("paused");
      } else {
        setNotice("暂停失败,请重试。");
      }
    } catch {
      setNotice("暂停失败,请重试。");
    } finally {
      setActing(false);
    }
  };

  const wake = async () => {
    setActing(true);
    setNotice(null);
    try {
      const res = await apiFetch("/api/workspace/resume", { method: "POST" });
      if (res.ok) setState("running");
      else setNotice("恢复失败,请重试。");
    } catch {
      setNotice("恢复失败,请重试。");
    } finally {
      setActing(false);
    }
  };

  const actionBtn: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    width: "100%",
    height: 30,
    background: "var(--bg-hover)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: acting ? "var(--text-dim)" : "var(--text)",
    cursor: acting ? "default" : "pointer",
    fontSize: 12,
    fontWeight: 500,
  };

  return (
    <div ref={rootRef} style={{ position: "relative", display: "flex", alignItems: "center", ...style }}>
      <button
        type="button"
        onClick={() => {
          setNotice(null);
          setOpen((o) => !o);
          if (!open) probe();
        }}
        title={`Sandbox: ${STATE_TEXT[state]}`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: "100%",
          padding: "0 12px",
          background: "none",
          border: "none",
          cursor: "pointer",
          fontSize: 11,
          color: "var(--text-muted)",
          whiteSpace: "nowrap",
        }}
      >
        <Dot color={DOT[state]} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{LABEL[state]}</span>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 200,
            width: 244,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 6px 20px rgba(0,0,0,0.12)",
            padding: 10,
            fontSize: 12,
            color: "var(--text)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 7, fontWeight: 600, marginBottom: 6 }}>
            <Dot color={DOT[state]} size={8} />
            <span>Sandbox · {STATE_TEXT[state]}</span>
          </div>
          {HELP[state] && (
            <div style={{ color: "var(--text-muted)", lineHeight: 1.5, marginBottom: 10 }}>{HELP[state]}</div>
          )}

          {state === "running" && (
            <button type="button" onClick={pause} disabled={acting} style={actionBtn}>
              {acting ? "暂停中…" : "暂停 · 省资源"}
            </button>
          )}
          {(state === "paused" || state === "cold") && (
            <button type="button" onClick={wake} disabled={acting} style={actionBtn}>
              {acting ? "唤醒中…" : state === "cold" ? "新建并唤醒" : "唤醒 · 预热"}
            </button>
          )}

          {notice && (
            <div style={{ marginTop: 9, color: "#ef4444", lineHeight: 1.5 }}>{notice}</div>
          )}
        </div>
      )}
    </div>
  );
}
