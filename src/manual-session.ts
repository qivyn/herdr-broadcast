/** User-confirmed terminals: a process lifetime, never a fabricated native session ID. */
import { randomUUID } from "node:crypto";
import type { Continuation, Store } from "./db.ts";
import type { PaneInfo } from "./herdr-types.ts";
import { herdrResult, paneList } from "./herdr.ts";
import { machineCommand, shellQuote } from "./machine-command.ts";

const lifetime = randomUUID();
export interface ProcessIdentity { pid: number; started: string; name: string }
export interface ManualProcess { lifetime: string; token: string; processes: ProcessIdentity[]; agent_process?: "codex" }
export const manualBindingKey = (machine: string, terminal: string) => `manual:${JSON.stringify([machine, terminal])}`;
const latest = new Map<string, ProcessIdentity[] | null>();
const invalidated = new Set<string>();

/** Native start identity, including subsecond resolution on macOS (ps lstart is insufficient). */
export function processStartScript(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("进程 ID 无效");
  const script = `import sys, ctypes as c\nfrom pathlib import Path\npid=${pid}\nif sys.platform == 'linux':\n s=Path('/proc/%d/stat'%pid).read_text().rsplit(')',1)[1].split()\n print(Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+s[19])\nelif sys.platform == 'darwin':\n class BSD(c.Structure):\n  _fields_=[('prefix',c.c_uint32*12),('comm',c.c_char*16),('name',c.c_char*32),('suffix',c.c_uint32*6),('sec',c.c_uint64),('usec',c.c_uint64)]\n info=BSD()\n lib=c.CDLL('/usr/lib/libproc.dylib')\n if lib.proc_pidinfo(pid,3,0,c.byref(info),c.sizeof(info))!=c.sizeof(info) or info.sec==0: raise RuntimeError('process unavailable')\n print(str(info.sec)+':'+str(info.usec))\nelse: raise RuntimeError('unsupported platform')`;
  return `python3 -c ${shellQuote(script)}`;
}
export function sameProcess(a: ProcessIdentity[], b: ProcessIdentity[]): boolean {
  return a.length > 0 && a.length === b.length && a.every((p, i) => p.pid === b[i]?.pid && p.started === b[i]?.started && p.name === b[i]?.name);
}
interface ProcessInfo { pane_id: string; shell_pid: number | null; foreground_processes: { pid: number; name: string }[] }
export async function terminalProcesses(machine: string, pane: string, terminal: string, agentProcess?: "codex"): Promise<ProcessIdentity[]> {
  const panes = await paneList(machine);
  if (!panes.some(p => p.pane_id === pane && p.terminal_id === terminal)) throw new Error("终端已变化，请重新绑定");
  const { process_info: info } = await herdrResult<{ process_info: ProcessInfo }>(["pane", "process-info", "--pane", pane], { machine });
  // Herdr includes transient descendants (git, hook runners). For known Codex, pin the CLI itself.
  const selected = (snapshot: ProcessInfo) => snapshot?.foreground_processes?.filter(p => p.pid !== snapshot.shell_pid
    && !/^(?:-|\/.*\/)?(?:ba|z|fi|da|k|c|tc)?sh$/.test(p.name)
    && (!agentProcess || /(?:^|\/)codex$/.test(p.name))) ?? [];
  const processes = selected(info);
  if (info?.pane_id !== pane || !processes.length) throw new Error("终端中没有可核实的前台 agent；请先启动 agent 并选择原会话");
  const identities = await Promise.all(processes.map(async p => {
    const result = await machineCommand(machine, processStartScript(p.pid));
    const started = result.stdout.trim();
    if (result.code !== 0 || !started || started.length > 200 || started.includes("\n")) throw new Error("无法核实进程启动时间，请检查机器环境后重新绑定");
    return { pid: p.pid, name: p.name, started };
  }));
  const after = await herdrResult<{ process_info: ProcessInfo }>(["pane", "process-info", "--pane", pane], { machine });
  const stable = agentProcess
    ? after.process_info?.pane_id === info.pane_id && after.process_info?.shell_pid === info.shell_pid
      && JSON.stringify(selected(after.process_info)) === JSON.stringify(processes)
    : JSON.stringify(after.process_info) === JSON.stringify(info);
  if (!stable || !(await paneList(machine)).some(p => p.pane_id === pane && p.terminal_id === terminal)) throw new Error("绑定期间进程或终端变化，请重新确认");
  return identities.sort((a, b) => a.pid - b.pid);
}
export function manualValid(machine: string, binding: Continuation): boolean {
  const current = latest.get(manualBindingKey(machine, binding.terminal_id));
  return binding.manual_process?.lifetime === lifetime && !invalidated.has(binding.manual_process.token)
    && !!current && sameProcess(binding.manual_process.processes, current);
}
export async function refreshManual(machine: string, binding: Continuation): Promise<boolean> {
  const key = manualBindingKey(machine, binding.terminal_id);
  if (binding.manual_process?.lifetime !== lifetime) { latest.set(key, null); return false; }
  try { latest.set(key, await terminalProcesses(machine, binding.pane_id, binding.terminal_id, binding.manual_process.agent_process)); }
  catch { latest.set(key, null); }
  const valid = manualValid(machine, binding);
  if (!valid && binding.manual_process) invalidated.add(binding.manual_process.token);
  return valid;
}
export async function confirmManual(store: Store, machine: string, pane: PaneInfo, key: string, label: string, agentProcess?: "codex"): Promise<Continuation> {
  const processes = await terminalProcesses(machine, pane.pane_id, pane.terminal_id, agentProcess);
  const binding: Continuation = { ...pane, key, workspace_label: label, status: "uncertain", error: null,
    manual_process: { lifetime, token: randomUUID(), processes, ...(agentProcess ? { agent_process: agentProcess } : {}) }, manual_required: true, identity_source: "manual" };
  // Old versions see uncertain + an unrecognized custom agent and cannot silently grant input.
  store.saveContinuation(binding);
  latest.set(manualBindingKey(machine, pane.terminal_id), processes);
  return binding;
}
