/** Pi treats a missing --session path as a new session, so check it before restoring. */
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { LOCAL, machineList, type MachineProfile } from "./herdr.ts";
import { parseTarget } from "./web/ssh.ts";

export function sessionFileCheckCommand(profile: MachineProfile, path: string): string[] {
  const target = parseTarget(profile.target);
  const quoted = `'${path.replace(/'/g, `'\\''`)}'`;
  return ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8",
    ...(target.port ? ["-p", String(target.port)] : []), "--", target.user ? `${target.user}@${target.host}` : target.host,
    `test -f ${quoted} && test -r ${quoted} && test -s ${quoted}`];
}

export async function sessionFileReadable(machine: string, path: string): Promise<boolean> {
  if (machine === LOCAL) {
    try { await access(path, constants.R_OK); const info = await stat(path); return info.isFile() && info.size > 0; }
    catch { return false; }
  }
  const profile = (await machineList()).find((m) => m.id === machine && m.enabled);
  if (!profile) throw new Error("原机器不存在或已停用");
  const proc = Bun.spawn(sessionFileCheckCommand(profile, path), { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 15_000);
  try {
    const [code] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code === 0) return true;
    if (code === 1) return false;
    throw new Error("无法检查原机器上的会话文件，请检查 SSH 连接后再试");
  } finally { clearTimeout(timer); }
}
