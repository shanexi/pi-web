import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
export type SubagentCodemode = "inherit" | "on" | "off";
export type SubagentMcp = "on" | "off";
export type SubagentScope = "builtin" | "global" | "workspace" | "project";
export type SubagentWritableScope = Extract<SubagentScope, "global" | "project">;

export interface SubagentProfile {
  name: string;
  displayName: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  extensionTools?: string[];
  /** Raw `ext:` deny selectors, resolved against the loaded extensions at spawn time. */
  disallowedExtensionTools?: string[];
  /** Omitted = SDK on-demand discovery; [] = explicitly no selected skills. */
  skills?: string[];
  /** Omitted = every enabled extension; [] = none. Names only, resolved like `ext:` selectors. */
  extensions?: string[];
  loadSkills: boolean;
  loadExtensions: boolean;
  /** Whether this profile enables Pi Web's codemode tool. Omitted profiles are disabled. */
  codemode?: SubagentCodemode;
  /** Whether its children connect the servers in `mcp.json`. Omitted profiles do not. */
  mcp?: SubagentMcp;
  model?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  inheritContext: boolean;
  runInBackground: boolean;
  promptMode: "replace" | "append";
  color?: string;
  isolation?: "worktree" | "off";
  persistSession?: boolean;
  enabled: boolean;
  scope: SubagentScope;
  filePath?: string;
}
