/**
 * The parts of Herdr's API objects this plugin reads (socket API protocol 22). Every field the
 * plugin does not need is left out; optional fields may be missing on older servers.
 */

export type AgentStatus = "idle" | "done" | "working" | "blocked" | "unknown" | (string & {});

export interface AgentSessionInfo {
  agent: string;
  /** "id" (e.g. a Claude session id) or "path" (a transcript file) */
  kind: string;
  source: string;
  value: string;
}

export interface AgentInfo {
  agent?: string | null;
  display_agent?: string | null;
  name?: string | null;
  agent_session?: AgentSessionInfo | null;
  agent_status: AgentStatus;
  interactive_ready?: boolean;
  /** listed while `agent start` is still waiting: the command may already have failed in the pane */
  launch_pending?: boolean;
  /** the state_change_seq of the last completed idle transition */
  completion_seq?: number | null;
  state_change_seq?: number;
  cwd?: string | null;
  foreground_cwd?: string | null;
  focused: boolean;
  pane_id: string;
  tab_id: string;
  terminal_id: string;
  terminal_title_stripped?: string | null;
  workspace_id: string;
}

export interface PaneInfo {
  pane_id: string;
  tab_id: string;
  terminal_id: string;
  workspace_id: string;
  cwd?: string | null;
  agent?: string | null;
  agent_status: AgentStatus;
}

export interface TabInfo {
  tab_id: string;
  workspace_id: string;
  label: string;
}

export interface WorkspaceInfo {
  workspace_id: string;
  label: string;
  active_tab_id: string;
  worktree?: { checkout_path: string; is_linked_worktree: boolean } | null;
}
