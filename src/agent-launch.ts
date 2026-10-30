import { machineCommand } from "./machine-command.ts";

/** Probe the machine that will run Codex; an unsupported flag must never launch a fallback session. */
export async function agentLaunchArgs(machine: string, kind: string, args: string[] = [], run = machineCommand): Promise<string[]> {
  if (kind !== "codex") return args;
  const result = await run(machine, 'exec "${SHELL:-/bin/sh}" -lc \'codex --help\'', undefined, 10_000);
  if (result.code !== 0 || !/(?:^|\s)--no-daemon(?:\s|$)/m.test(result.stdout)) {
    throw new Error("无法确认此机器的 Codex 支持 --no-daemon。请检查 CLI 安装与版本后重试；未启动会话。");
  }
  return ["--no-daemon", ...args];
}

/** Only visible modal chrome, never scrollback. Herdr 0.9.5 misreports these as idle. */
export function codexInputBlock(screen: string): string | null {
  const text = screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
  if (/^\s*Hooks need review\s*$/m.test(text) && /enter confirm.*esc skip/i.test(text)) return "请先在 Codex 中审核 hooks，并返回对话输入框";
  if (/^\s*Hooks\s*$/m.test(text) && /Lifecycle hooks from config|esc (?:close|back)|trust all/i.test(text)) return "请完成 hooks 审核并按 Esc 返回对话输入框";
  if (/^\s*(?:Resume a previous session|Resume session|Select a session)\s*$/mi.test(text) && /esc|enter/i.test(text)) return "请先选择原会话并返回对话输入框";
  // Hook detail/review panels vary by version; the navigation footer distinguishes them from chat text.
  if (/^\s*(?:SessionStart|Review hook|Hook details)\s*$/mi.test(text) && /(?:trust|untrust).*esc (?:back|close)/i.test(text)) return "请完成 hooks 审核并返回对话输入框";
  const footer = text.trimEnd().split("\n").slice(-3).join(" ");
  if (/(?:enter|\btrust\b).*esc (?:skip|close|back|cancel)/i.test(footer)) return "请先完成 Codex 当前的选择或确认并返回对话输入框";
  return null;
}
