"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { apiFetch } from "@/lib/api-base";

// Compact per-workspace E2B sandbox status chip, shown on the sidebar cwd row.
//
// Two-state MVP driven by GET /api/workspace/status (a pure read — never touches
// E2B, cheap to poll): a sandbox is either provisioned for this owner ("active"
// — running OR idle-paused, both resume transparently on the next tool call) or
// not created yet / reset ("cold"). Running-vs-paused and explicit pause/wake
// are a later slice. The sandbox is owner-global (shared across every one of the
// owner's sessions), so this polls rather than binding to a single session.

type SandboxState = "loading" | "active" | "cold" | "error";

const POLL_MS = 15_000;

const META: Record<SandboxState, { dot: string; label: string; title: string }> = {
  loading: { dot: "var(--text-dim)", label: "sandbox…", title: "Checking sandbox status" },
  active: {
    dot: "#4ade80",
    label: "sandbox active",
    title: "A sandbox is provisioned for your workspace — it resumes automatically on the next command.",
  },
  cold: {
    dot: "var(--text-dim)",
    label: "no sandbox",
    title: "No sandbox yet — the next command starts one.",
  },
  error: { dot: "#ef4444", label: "sandbox ?", title: "Couldn't read sandbox status." },
};

export function SandboxStatusChip({ style }: { style?: CSSProperties }) {
  const [state, setState] = useState<SandboxState>("loading");
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const res = await apiFetch("/api/workspace/status");
        if (!aliveRef.current) return;
        if (!res.ok) {
          setState("error");
        } else {
          const data = (await res.json()) as { exists?: boolean };
          setState(data.exists ? "active" : "cold");
        }
      } catch {
        if (aliveRef.current) setState("error");
      }
      // Reschedule only while the tab is visible — a background tab needn't poll.
      if (aliveRef.current && !document.hidden) timer = setTimeout(poll, POLL_MS);
    };

    const kick = () => {
      if (!document.hidden) poll();
    };

    poll();
    window.addEventListener("focus", kick);
    document.addEventListener("visibilitychange", kick);
    return () => {
      aliveRef.current = false;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", kick);
      document.removeEventListener("visibilitychange", kick);
    };
  }, []);

  const meta = META[state];

  return (
    <div
      title={meta.title}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 4px 0",
        fontSize: 11,
        color: "var(--text-muted)",
        ...style,
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: meta.dot,
          flexShrink: 0,
          transition: "background 0.3s",
        }}
      />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{meta.label}</span>
    </div>
  );
}
