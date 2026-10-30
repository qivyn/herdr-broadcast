import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS, nativeResumeArgs } from "../src/agents.ts";
import { AgentEnvironments, inspectEnvironment, integrationStatus, type EnvironmentRunner } from "../src/agent-environment.ts";
import { machineCommand, sshCommand } from "../src/machine-command.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const journal = () => { const d = mkdtempSync(join(tmpdir(), "bc-environment-")); dirs.push(d); return join(d, "operations.json"); };
function fixture() {
  const installed = new Set<string>(); const calls: { machine: string; script: string }[] = [];
  const missing = new Set<string>(); let reject = "";
  const run: EnvironmentRunner = async (machine, script, signal) => {
    calls.push({ machine, script });
    if (signal?.aborted) throw new Error("cancelled");
    if (script.includes("integration status")) return { code: 0, stderr: "", stdout: AGENTS.map(a => `${a.integration}: ${installed.has(a.integration) ? "current (v10)" : "not installed"} (/custom/${a.kind}${a.configSuffix})`).join("\n") };
    if (script.includes("integration install")) {
      const a = AGENTS.find(a => script.endsWith(`'${a.integration}'`))!;
      if (a.integration === reject) return { code: 1, stdout: "", stderr: "failure" };
      installed.add(a.integration); return { code: 0, stdout: "installed", stderr: "" };
    }
    const a = AGENTS.find(a => script.includes(`command -v '${a.cli}'`))!;
    return { code: 0, stderr: "", stdout: `${missing.has(a.kind) ? "" : `/usr/bin/${a.cli}\n1.2.3\n`}__BC_VERSION_CODE__0\n__BC_CONFIG__yes` };
  };
  return { run, calls, installed, missing, fail(name: string) { reject = name; } };
}
test("nine native recovery adapters preserve arguments and reject invalid IDs/paths", () => {
  const expected = [["--resume", "abc-12"], ["resume", "abc-12"], ["--session", "abc-12"], ["--resume=abc-12"], ["--session", "abc-12"], ["--session", "abc-12"], ["--conversation", "abc-12"], ["--resume", "abc-12"], ["--resume", "abc-12"]];
  expect(AGENTS.map(a => nativeResumeArgs(a.kind, "id", "abc-12"))).toEqual(expected);
  expect(nativeResumeArgs("omp", "path", "/a b/old.jsonl")).toEqual(["--resume=/a b/old.jsonl"]);
  expect(nativeResumeArgs("opencode", "id", "ses_001")).toEqual(["--session", "ses_001"]);
  for (const a of AGENTS) for (const value of ["--last", "a\nb", "$(bad)", ""]) expect(nativeResumeArgs(a.kind, "id", value)).toBeNull();
  expect(nativeResumeArgs("pi", "path", "relative.jsonl")).toBeNull();
  expect(nativeResumeArgs("claude", "path", "/a.jsonl")).toBeNull();
});
test("environment separates CLI/config/integration, preserves custom directories and maps agy correctly", async () => {
  const f = fixture(); f.installed.add("pi"); f.missing.add("codex");
  const state = await inspectEnvironment("remote", f.run);
  expect(state.agents).toHaveLength(9);
  expect(state.agents.find(a => a.kind === "pi")).toMatchObject({ ready: true, configDir: "/custom/pi", configReady: true });
  expect(state.agents.find(a => a.kind === "codex")).toMatchObject({ ready: false, cli: null });
  expect(state.agents.find(a => a.kind === "agy")?.integration).toBe("antigravity-cli");
  expect(f.calls.every(c => c.machine === "remote" && !c.script.includes("--machine"))).toBe(true);
  expect(integrationStatus("pi: outdated (v1) (/a b/extensions/herdr-agent-state.ts)", "pi")).toEqual({ state: "outdated", path: "/a b/extensions/herdr-agent-state.ts" });
  expect(integrationStatus("unrecognized", "pi").state).toBe("unknown");
});
test("installation reuses current integrations, coalesces requests and records partial failure independently", async () => {
  const f = fixture(); f.installed.add("pi"); f.fail("codex");
  const manager = new AgentEnvironments(journal(), () => {}, f.run);
  const first = manager.start("remote", ["pi", "codex", "antigravity-cli"], "user@shared-host");
  expect(manager.start("remote", ["pi", "codex"], "user@shared-host").id).toBe(first.id);
  expect(manager.start("another-session", ["pi"], "user@shared-host").id).toBe(first.id);
  expect(() => manager.start("remote", ["grok"], "user@shared-host")).toThrow();
  await manager.settle();
  expect(first.state).toBe("failed");
  expect(first.items.map(i => i.state)).toEqual(["ready", "failed", "ready"]);
  expect(f.calls.filter(c => c.script.includes("integration install")).map(c => c.script.split("install ")[1])).toEqual(["'codex'", "'antigravity-cli'"]);
  expect(() => manager.start("local", ["$(bad)"])).toThrow();
});
test("cancellation stops remaining items; startup marks interrupted work without replay", async () => {
  const f = fixture(), file = journal();
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const manager = new AgentEnvironments(file, () => {}, async (...args) => { await wait; return f.run(...args); });
  const op = manager.start("local", ["pi", "codex"]); manager.cancel(op.id); release();
  await manager.settle();
  expect(op.state).toBe("cancelled");
  expect(f.calls.some(c => c.script.includes("integration install"))).toBe(false);
  const saved = JSON.parse(readFileSync(file, "utf8")); saved[0].state = "running"; saved[0].items[0].state = "installing"; writeFileSync(file, JSON.stringify(saved));
  const recovered = new AgentEnvironments(file, () => {}, f.run);
  expect(recovered.get(op.id)?.state).toBe("interrupted");
  expect(recovered.snapshots.size).toBe(0);
});
test("SSH commands retain saved target/port and quote remote scripts as one command", () => {
  const argv = sshCommand("ssh://alice@host:2201", "test -d '/a b' && echo '$HOME'");
  expect(argv).toContain("2201"); expect(argv).toContain("alice@host");
  expect(argv.at(-1)).toContain("${SHELL:-/bin/sh}");
  expect(argv.at(-1)).toContain("exec sh -c");
  expect(() => sshCommand("-oProxyCommand=bad", "true")).toThrow();
});

test("cancelling a real local command terminates its child process group", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const command = machineCommand("local", "sleep 30", controller.signal);
  setTimeout(() => controller.abort(), 50);
  await expect(command).rejects.toThrow("取消");
  expect(Date.now() - started).toBeLessThan(2000);
});

test("uninitialized configuration, broken CLI dependencies and incompatible Kimi are actionable prerequisites", async () => {
  const f = fixture();
  const state = await inspectEnvironment("local", async (...args) => {
    const result = await f.run(...args);
    if (args[1].includes("command -v 'pi'")) result.stdout = result.stdout.replace("__BC_CONFIG__yes", "__BC_CONFIG__");
    if (args[1].includes("command -v 'codex'")) result.stdout = result.stdout.replace("__BC_VERSION_CODE__0", "__BC_VERSION_CODE__1");
    if (args[1].includes("command -v 'kimi'")) result.stdout = result.stdout.replace("1.2.3", "0.13.0");
    return result;
  });
  expect(state.agents.find(a => a.kind === "pi")).toMatchObject({ ready: false, configReady: false });
  expect(state.agents.find(a => a.kind === "codex")).toMatchObject({ ready: false, cliReady: false });
  expect(state.agents.find(a => a.kind === "kimi")?.reason).toContain("0.14.0");
});
