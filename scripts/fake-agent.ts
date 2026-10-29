/**
 * A stand-in coding agent for end-to-end checks: runs in the foreground of a herdr pane, reports
 * itself as idle, and for every line it receives reports working, "works" a moment, and reports
 * idle again, the way an agent integration would.
 *
 *   bun scripts/fake-agent.ts [name] [seconds-per-turn]
 *
 * The name must not be one Herdr supports itself (claude, codex, …): for those Herdr also checks
 * that the real program is the pane's foreground process.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const pane = process.env.HERDR_PANE_ID;
const bin = process.env.HERDR_BIN_PATH || "herdr";
const kind = process.argv[2] ?? "fakebot";
const turnMs = Number(process.argv[3] ?? "2") * 1000;
if (!pane) {
  console.error("fake-agent: not inside a herdr pane (HERDR_PANE_ID is unset)");
  process.exit(2);
}

let seq = 1;
async function report(state: string): Promise<void> {
  const proc = Bun.spawn([bin, "pane", "report-agent", pane!, "--source", "fake-agent", "--agent", kind, "--state", state, "--seq", String(seq++)], { stdout: "ignore", stderr: "inherit" });
  await proc.exited;
}

await report("idle");
console.log(`fake ${kind} ready in ${pane}`);
process.stdout.write("> ");
for await (const line of console) {
  if (process.env.BROADCAST_E2E_RECEIPTS_DIR) appendFileSync(join(process.env.BROADCAST_E2E_RECEIPTS_DIR, `${pane}.jsonl`), JSON.stringify(line) + "\n");
  console.log(`received: ${line}`);
  await report("working");
  await Bun.sleep(turnMs);
  console.log(`done: ${line}`);
  await report("idle");
  if (process.env.BROADCAST_E2E_RECEIPTS_DIR) appendFileSync(join(process.env.BROADCAST_E2E_RECEIPTS_DIR, `${pane}.done.jsonl`), JSON.stringify(line) + "\n");
  process.stdout.write("> ");
}
