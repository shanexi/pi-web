// E1: client-side session export.
//
// The chosen approach (per 阶段E任务 E1): the frontend already has the full
// message history, so generate an HTML transcript in the browser and trigger a
// download — NO new Worker route. We re-read the session through the existing,
// owner-checked GET /api/sessions/:id (B2) so the export always reflects the
// persisted sql mirror (works even after DO eviction), then render it to a
// self-contained HTML blob.

import { apiFetch } from "./api-base";
import type { AgentMessage, ImageContent, SessionContext, SessionInfo } from "./types";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function imageSrc(block: ImageContent): string | null {
  const src = block.source;
  if (src.type === "url" && src.url) return src.url;
  if (src.type === "base64" && src.data) return `data:${src.media_type ?? "image/png"};base64,${src.data}`;
  return null;
}

/** Render one message's content array (or string) into escaped HTML fragments. */
function renderContent(content: unknown): string {
  if (typeof content === "string") {
    return content ? `<div class="text">${escapeHtml(content)}</div>` : "";
  }
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as {
      type?: string;
      text?: string;
      thinking?: string;
      toolName?: string;
      input?: unknown;
    };
    switch (block.type) {
      case "text":
        if (block.text) parts.push(`<div class="text">${escapeHtml(block.text)}</div>`);
        break;
      case "thinking":
        if (block.thinking) parts.push(`<div class="thinking">${escapeHtml(block.thinking)}</div>`);
        break;
      case "toolCall":
        parts.push(
          `<div class="tool-call"><span class="tool-name">${escapeHtml(
            block.toolName ?? "tool",
          )}</span><pre>${escapeHtml(JSON.stringify(block.input ?? {}, null, 2))}</pre></div>`,
        );
        break;
      case "image": {
        const src = imageSrc(raw as ImageContent);
        parts.push(src ? `<img class="img" src="${escapeHtml(src)}" alt="image" />` : `<div class="text">[image]</div>`);
        break;
      }
      default:
        break;
    }
  }
  return parts.join("\n");
}

const ROLE_LABELS: Record<string, string> = {
  user: "User",
  assistant: "Assistant",
  toolResult: "Tool Result",
  custom: "Note",
};

function renderMessage(msg: AgentMessage): string {
  const role = (msg as { role: string }).role;
  const label = ROLE_LABELS[role] ?? role;
  const body = renderContent((msg as { content?: unknown }).content);
  if (!body) return "";
  return `<section class="msg role-${escapeHtml(role)}">
  <header class="role">${escapeHtml(label)}</header>
  <div class="body">${body}</div>
</section>`;
}

/** Build a self-contained HTML transcript document. */
export function buildSessionHtml(name: string, session: SessionInfo, messages: AgentMessage[]): string {
  const rows = messages.map(renderMessage).filter(Boolean).join("\n");
  const meta = [
    session.cwd ? `cwd: ${session.cwd}` : "",
    session.created ? `created: ${session.created}` : "",
    `${messages.length} messages`,
  ]
    .filter(Boolean)
    .join(" · ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(name)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.55;
    max-width: 820px; margin: 0 auto; padding: 32px 20px 80px; color: #1a1a1a; background: #fff; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .meta { color: #777; font-size: 13px; margin-bottom: 28px; }
  .msg { border: 1px solid #e5e5e5; border-radius: 10px; padding: 12px 16px; margin: 14px 0; }
  .role { font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em;
    color: #888; margin-bottom: 8px; }
  .role-user { background: #f6f8ff; }
  .role-assistant { background: #fafafa; }
  .role-toolResult { background: #f4fbf4; }
  .text { white-space: pre-wrap; word-break: break-word; }
  .thinking { white-space: pre-wrap; color: #999; font-style: italic; border-left: 2px solid #ddd; padding-left: 10px; margin: 6px 0; }
  .tool-call { margin: 6px 0; font-size: 13px; }
  .tool-name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; color: #6b46c1; }
  .tool-call pre, .body pre { background: #f3f3f3; padding: 8px 10px; border-radius: 6px; overflow-x: auto; font-size: 12px; }
  .img { max-width: 100%; border-radius: 6px; margin: 6px 0; }
  @media (prefers-color-scheme: dark) {
    body { color: #e5e5e5; background: #1a1a1a; }
    .msg { border-color: #333; }
    .role-user { background: #1c2333; }
    .role-assistant { background: #202020; }
    .role-toolResult { background: #16241a; }
    .tool-call pre, .body pre { background: #262626; }
    .thinking { border-left-color: #444; }
  }
</style>
</head>
<body>
<h1>${escapeHtml(name)}</h1>
<div class="meta">${escapeHtml(meta)}</div>
${rows || '<p class="meta">No messages.</p>'}
</body>
</html>`;
}

/** Sanitize a session name into a safe download filename stem. */
function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^\w.\- ]+/g, "_").trim().replace(/\s+/g, "-");
  return cleaned.slice(0, 80) || "session";
}

/**
 * Fetch the session history and trigger a browser download of the HTML
 * transcript. Reuses the existing owner-checked GET /api/sessions/:id — no
 * server export route needed. Throws on a non-ok response so the caller can
 * surface the failure.
 */
export async function downloadSessionExport(session: SessionInfo): Promise<void> {
  const res = await apiFetch(`/api/sessions/${encodeURIComponent(session.id)}`);
  if (!res.ok) throw new Error(`export failed: HTTP ${res.status}`);
  const data = (await res.json()) as { info?: { name?: string }; context?: SessionContext };
  const messages = data.context?.messages ?? [];
  const name = data.info?.name || session.name || session.id.slice(0, 12);
  const html = buildSessionHtml(name, session, messages);

  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${sanitizeFilename(name)}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a tick so the navigation to the blob has begun.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
