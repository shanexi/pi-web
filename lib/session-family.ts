import type { SessionInfo } from "./types";

export interface SessionFamily {
  root: SessionInfo;
  latestModified: string;
}

/** Each saved conversation, including a fork, is an independent sidebar row. */
export function listSessionFamilies(sessions: readonly SessionInfo[]): SessionFamily[] {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  return [...sessionsById.values()]
    .map((session) => ({ root: session, latestModified: session.modified }))
    .sort((a, b) => b.latestModified.localeCompare(a.latestModified));
}
