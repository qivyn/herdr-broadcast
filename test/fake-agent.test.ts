import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { shellQuote } from "../src/machine-command.ts";

test("offline Agent reports do not change its foreground process group and still record exact receipts", async () => {
  const root = mkdtempSync(join(tmpdir(), "bc-fake-agent-"));
  const reportLog = join(root, "reports.jsonl"), reporter = join(root, "report.ts"), bin = join(root, "herdr");
  writeFileSync(reporter, `import { appendFileSync } from "node:fs";
const ps = Bun.spawn(["ps", "-o", "pgid=", "-p", String(process.pid)], { stdout: "pipe" });
const group = Number((await new Response(ps.stdout).text()).trim());
if (await ps.exited !== 0 || !group) process.exit(1);
const args = process.argv.slice(2);
appendFileSync(process.env.REPORT_LOG!, JSON.stringify({ group, state: args[args.indexOf("--state") + 1] }) + "\\n");
`);
  writeFileSync(bin, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(reporter)} "$@"\n`);
  chmodSync(bin, 0o755);
  const reports = () => existsSync(reportLog) ? readFileSync(reportLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { group: number; state: string }) : [];
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../scripts/fake-agent.ts"), "fakebot", "0"], {
    env: { ...process.env, HERDR_PANE_ID: "fixture-pane", HERDR_BIN_PATH: bin, REPORT_LOG: reportLog, BROADCAST_E2E_RECEIPTS_DIR: root },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const output = new Response(child.stdout).text(), errors = new Response(child.stderr).text();
  try {
    const deadline = Date.now() + 5000;
    while (reports().length === 0) {
      if (child.exitCode !== null || Date.now() >= deadline) throw new Error("offline Agent did not report ready");
      await Bun.sleep(10);
    }
    const ps = Bun.spawn(["ps", "-o", "pgid=", "-p", String(child.pid)], { stdout: "pipe" });
    const group = Number((await new Response(ps.stdout).text()).trim());
    expect(await ps.exited).toBe(0); expect(group).toBeGreaterThan(0);
    child.stdin.write("one offline instruction"); child.stdin.end();
    expect(await child.exited).toBe(0); expect(await errors).toBe("");
    expect(await output).toContain("received: one offline instruction");
    const log = reports();
    expect(log.map(report => report.state)).toEqual(["idle", "working", "idle"]);
    expect(log.every(report => report.group !== group)).toBe(true);
    expect(readFileSync(join(root, "fixture-pane.jsonl"), "utf8")).toBe('"one offline instruction"\n');
    expect(readFileSync(join(root, "fixture-pane.done.jsonl"), "utf8")).toBe('"one offline instruction"\n');
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited; await Promise.all([output, errors]);
    rmSync(root, { recursive: true, force: true });
  }
});
