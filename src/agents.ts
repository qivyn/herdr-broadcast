/** What new agents can be, and where they can start. */
import { LOCAL } from "./herdr.ts";

/** The agent kinds `herdr agent start --kind` knows. */
export const AGENT_KINDS = ["claude", "codex", "pi", "opencode", "gemini", "cursor", "copilot", "droid", "amp", "omp", "kimi", "qwen", "grok", "devin", "cline", "kiro", "kilo", "hermes", "agy", "mastracode", "qodercli", "letta", "maki", "muse"];

/** Capabilities offered by the default picker; other running kinds remain accessible. */
export const AGENTS = [
  { kind: "claude", name: "Claude Code", cli: "claude", integration: "claude", configSuffix: "/hooks/herdr-agent-state.sh", resume: ["--resume"], picker: ["--resume"], paths: false, guide: "https://code.claude.com/docs/en/setup" },
  { kind: "codex", name: "Codex", cli: "codex", integration: "codex", configSuffix: "/herdr-agent-state.sh", resume: ["resume"], picker: ["resume"], paths: false, guide: "https://developers.openai.com/codex/cli/" },
  { kind: "pi", name: "Pi", cli: "pi", integration: "pi", configSuffix: "/extensions/herdr-agent-state.ts", resume: ["--session"], picker: ["--resume"], paths: true, guide: "https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent" },
  { kind: "omp", name: "OMP", cli: "omp", integration: "omp", configSuffix: "/extensions/herdr-omp-agent-state.ts", resume: ["--resume="], picker: [], paths: true, guide: "https://github.com/can1357/oh-my-pi" },
  { kind: "opencode", name: "OpenCode", cli: "opencode", integration: "opencode", configSuffix: "/plugins/herdr-agent-state.js", resume: ["--session"], picker: [], paths: false, guide: "https://opencode.ai/docs/" },
  { kind: "kimi", name: "Kimi", cli: "kimi", integration: "kimi", configSuffix: "/hooks/herdr-agent-state.sh", resume: ["--session"], picker: [], paths: false, guide: "https://moonshotai.github.io/kimi-cli/en/" },
  { kind: "agy", name: "Antigravity", cli: "agy", integration: "antigravity-cli", configSuffix: "/hooks/herdr-agent-state.sh", resume: ["--conversation"], picker: [], paths: false, guide: "https://herdr.dev/docs/integrations/#antigravity-cli" },
  { kind: "grok", name: "Grok", cli: "grok", integration: "grok", configSuffix: "/hooks/herdr-agent-state.sh", resume: ["--resume"], picker: [], paths: false, guide: "https://herdr.dev/docs/integrations/#grok-cli" },
  { kind: "qwen", name: "Qwen", cli: "qwen", integration: "qwen", configSuffix: "/hooks/herdr-agent-session.sh", resume: ["--resume"], picker: [], paths: false, guide: "https://qwenlm.github.io/qwen-code-docs/" },
] as const;
export const DEFAULT_AGENT_KINDS = AGENTS.map(a => a.kind);
export const agentCapability = (kind: string | null) => AGENTS.find(a => a.kind === kind);

/** Values are argv, never shell code; reject option-like IDs and control characters. */
export function nativeResumeArgs(kind: string | null, type: string | null, value: string | null): string[] | null {
  const agent = agentCapability(kind);
  if (!agent || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return null;
  if (type === "path") {
    if (!agent.paths || !value.startsWith("/") || !value.endsWith(".jsonl")) return null;
  } else if (type !== "id" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)) return null;
  const args: string[] = [...agent.resume];
  if (args.at(-1)!.endsWith("=")) args[args.length - 1] += value;
  else args.push(value);
  return args;
}

/** Remote folders must be absolute or start with ~ (Herdr resolves them on that machine). */
export function validCwd(machineId: string, cwd: string): string | null {
  const trimmed = cwd.trim();
  if (trimmed === "") return "请填写目录";
  if (machineId !== LOCAL && !(trimmed.startsWith("/") || trimmed === "~" || trimmed.startsWith("~/"))) return "远程机器的目录必须是绝对路径或以 ~ 开头";
  return null;
}
