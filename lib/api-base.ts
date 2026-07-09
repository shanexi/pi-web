// Base-URL resolution for all client-side API calls.
//
// On Cloudflare Workers the UI (Worker A, this app) and the agent backend
// (Worker B, /api/agent/* + /api/sessions/* + Session DO) are two separate
// Workers. Every client-side call to "/api/..." must therefore be routed
// through apiUrl() so it can be redirected to the backend Worker origin.
//
// NEXT_PUBLIC_AGENT_BASE_URL is inlined at build time by Next.js:
//   - empty / unset  -> same-origin relative path (single-Worker or local dev)
//   - an origin URL  -> cross-origin absolute URL (two-Worker topology,
//                       requires CORS on the backend Worker, incl. SSE ACAO)

const RAW_BASE = process.env.NEXT_PUBLIC_AGENT_BASE_URL ?? "";
// Normalize: trim whitespace and strip any trailing slashes so that
// `${base}${path}` never produces "//api/...".
const BASE = RAW_BASE.trim().replace(/\/+$/, "");

/**
 * Resolve an API path ("/api/...") against the configured agent backend.
 * With no base configured the path is returned unchanged (same-origin).
 */
export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (!BASE) return normalizedPath;
  return `${BASE}${normalizedPath}`;
}

/**
 * Synthetic working directory used when the UI runs on Cloudflare Workers,
 * where no local filesystem / directory picker exists. The backend Worker
 * treats it as an opaque label for the in-memory session cwd.
 */
export const CF_CWD = process.env.NEXT_PUBLIC_CF_CWD || "/workspace";

/** Backend login URL that bounces back to `returnTo` after Feishu OAuth. */
export function loginUrl(returnTo: string): string {
  return apiUrl(`/api/auth/feishu/login?return=${encodeURIComponent(returnTo)}`);
}

// One navigation is enough when several parallel calls 401 together.
let redirectingToLogin = false;

/**
 * D2a: authenticated fetch for ALL backend API calls. The backend Worker sits
 * on another origin behind a login gate keyed by the `pi_session` cookie, so
 * every call must send credentials; a 401 means "not logged in" and bounces
 * the browser through the backend's Feishu login, returning to the current
 * URL afterwards. (EventSource can't intercept 401s — AppShell's mount-time
 * /api/auth/me probe via this wrapper is what reliably opens the login door.)
 *
 * Always use this instead of `fetch(apiUrl(...))`.
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(apiUrl(path), { ...init, credentials: "include" });
  if (res.status === 401 && typeof window !== "undefined" && !redirectingToLogin) {
    redirectingToLogin = true;
    window.location.href = loginUrl(window.location.href);
  }
  return res;
}
