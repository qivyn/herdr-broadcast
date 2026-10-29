/** What new agents can be, and where they can start. */
import { LOCAL } from "./herdr.ts";

/** The agent kinds `herdr agent start --kind` knows. */
export const AGENT_KINDS = ["claude", "codex", "pi", "opencode", "gemini", "cursor", "copilot", "droid", "amp", "omp", "kimi", "qwen", "grok", "devin", "cline", "kiro", "kilo", "hermes", "agy", "mastracode", "qodercli", "letta", "maki", "muse"];

/** Remote folders must be absolute or start with ~ (Herdr resolves them on that machine). */
export function validCwd(machineId: string, cwd: string): string | null {
  const trimmed = cwd.trim();
  if (trimmed === "") return "请填写目录";
  if (machineId !== LOCAL && !(trimmed.startsWith("/") || trimmed === "~" || trimmed.startsWith("~/"))) return "远程机器的目录必须是绝对路径或以 ~ 开头";
  return null;
}
