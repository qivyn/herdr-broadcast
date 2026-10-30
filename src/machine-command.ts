/** Commands in the same local/SSH user environment as the agent integrations. */
import { LOCAL, machineList, type RawResult } from "./herdr.ts";
import { parseTarget } from "./web/ssh.ts";
import { spawn } from "node:child_process";

export const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function sshCommand(target: string, script: string): string[] {
  const t = parseTarget(target);
  return ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8",
    ...(t.port ? ["-p", String(t.port)] : []), "--", t.user ? `${t.user}@${t.host}` : t.host,
    `exec "\${SHELL:-/bin/sh}" -lc ${shellQuote(`exec sh -c ${shellQuote(script)}`)}`];
}
export async function machineCommand(machine: string, script: string, signal?: AbortSignal, timeoutMs = 30_000): Promise<RawResult> {
  if (signal?.aborted) throw new Error("操作已取消，请重新检查实际状态");
  let argv = ["/bin/sh", "-c", script];
  if (machine !== LOCAL) {
    const profile = (await machineList()).find(m => m.id === machine && m.enabled);
    if (!profile) throw new Error("原机器不存在或已停用");
    argv = sshCommand(profile.target, script);
  }
  if (signal?.aborted) throw new Error("操作已取消，请重新检查实际状态");
  const proc = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], detached: true });
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    try { if (proc.pid) process.kill(-proc.pid, "SIGTERM"); } catch { /* already exited */ }
    killTimer ??= setTimeout(() => { try { if (proc.pid) process.kill(-proc.pid, "SIGKILL"); } catch {} }, 300);
  };
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  try {
    let stdout = "", stderr = "";
    const collect = (chunk: Buffer, error: boolean) => {
      if (error) stderr += chunk.toString(); else stdout += chunk.toString();
      if (stdout.length + stderr.length > 256_000) { timedOut = true; abort(); }
    };
    proc.stdout!.on("data", chunk => collect(chunk, false)); proc.stderr!.on("data", chunk => collect(chunk, true));
    const code = await new Promise<number>((resolve, reject) => { proc.once("error", reject); proc.once("close", code => resolve(code ?? -1)); });
    if (signal?.aborted || timedOut) throw new Error("操作已取消或超时，请重新检查实际状态；不会自动重试");
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", abort); }
}
