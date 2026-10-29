import { spawn } from "node:child_process";
export interface Ran { code: number; stdout: string; stderr: string }
export type Run = (argv: string[], opts: { cwd?: string; timeoutMs: number; signal?: AbortSignal }) => Promise<Ran>;
/** Bounded, noninteractive subprocesses. Only the updater's own command group is signalled. */
export const runCommand: Run = (argv, opts) => new Promise(resolve => {
  if (opts.signal?.aborted) { resolve({ code: 1, stdout: "", stderr: "Update cancelled" }); return; }
  const child = spawn(argv[0]!, argv.slice(1), { cwd: opts.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "development", GIT_TERMINAL_PROMPT: "0" } });
  let stdout = "", stderr = "", failed = false;
  let kill: ReturnType<typeof setTimeout> | undefined;
  const signal = (s: NodeJS.Signals) => { try { process.kill(-child.pid!, s); } catch { child.kill(s); } };
  const abort = (reason: string) => {
    if (failed) return; failed = true; stderr = reason; signal("SIGTERM");
    kill = setTimeout(() => signal("SIGKILL"), 2000);
  };
  const timer = setTimeout(() => abort(`${argv[0]} timed out`), opts.timeoutMs);
  const cancelled = () => abort("Update cancelled");
  opts.signal?.addEventListener("abort", cancelled, { once: true });
  child.stdout.on("data", x => { stdout += x; if (stdout.length > 2_000_000) abort("Command output too large"); });
  child.stderr.on("data", x => { if (!failed) stderr = (stderr + x).slice(-8000); });
  const finish = (code: number) => { clearTimeout(timer); clearTimeout(kill); opts.signal?.removeEventListener("abort", cancelled); if (failed) signal("SIGKILL"); resolve({ code: failed ? 1 : code, stdout, stderr }); };
  child.on("error", e => { stderr = e.message; finish(1); });
  child.on("close", code => finish(code ?? 1));
});
export async function checked(run: Run, argv: string[], cwd?: string, timeoutMs = 30_000): Promise<string> {
  const result = await run(argv, { cwd, timeoutMs });
  if (result.code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")}: ${result.stderr.trim().slice(-1000) || `exit ${result.code}`}`);
  return result.stdout.trim();
}
