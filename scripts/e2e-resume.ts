/** Real Pi restore/picker contract; isolated Herdr/Pi state, no model requests or user panes. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/db.ts";
import { Engine } from "../src/engine.ts";
import { Conversations, continuationInfo, continuationKey } from "../src/continuation.ts";
import { herdrResult, runHerdr } from "../src/herdr.ts";

const root = realpathSync(mkdtempSync("/tmp/bc-resume-"));
const binary = Bun.which("herdr");
if (!binary || !Bun.which("pi")) throw new Error("Install Herdr and Pi first");
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(HERDR|PI|OMO|SENPI)_/.test(k) && !/(API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(k))),
  XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"),
  HERDR_BIN_PATH: binary, HERDR_BROADCAST_SESSION: "resume-test", SHELL: "/bin/sh",
  PI_CODING_AGENT_DIR: join(root, "pi"), PI_OFFLINE: "1", PI_TELEMETRY: "0",
};
for (const k of Object.keys(process.env)) if (/^(HERDR|PI|OMO|SENPI)_/.test(k)) delete process.env[k];
Object.assign(process.env, env);
mkdirSync(join(root, "config", "herdr"), { recursive: true });
writeFileSync(join(root, "config", "herdr", "config.toml"), 'onboarding = false\n[shell]\ndefault_shell = "/bin/sh"\n');
const session = "01234567-1234-4567-89ab-0123456789ab";
const dir = join(root, "pi", "sessions", `--${root.slice(1).replaceAll("/", "-")}--`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(root, "pi", "settings.json"), JSON.stringify({ packages: [], quietStartup: true }));
const file = join(dir, `2026-10-26T12-00-00-000Z_${session}.jsonl`);
const marker = "RESTORE_SAVED_HISTORY_ONLY";
writeFileSync(file, [
  { type: "session", version: 3, id: session, timestamp: "2026-10-26T12:00:00.000Z", cwd: root },
  { type: "message", id: "11111111", parentId: null, timestamp: "2026-10-26T12:00:00.000Z", message: { role: "user", content: [{ type: "text", text: marker }], timestamp: 1793016000000 } },
  { type: "message", id: "22222222", parentId: "11111111", timestamp: "2026-10-26T12:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "Saved response; no request needed." }], api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1793016001000 } },
].map(x => JSON.stringify(x)).join("\n") + "\n");
const daemon = Bun.spawn([binary, "--session", "resume-test", "server"], { env, stdout: Bun.file(join(root, "server.log")), stderr: Bun.file(join(root, "server.log")) });
const store = new Store(join(root, "broadcast.sqlite"));
const engine = new Engine(store, () => {});
const conversations = new Conversations(store, engine, () => {});
async function screen(pane: string) {
  return (await runHerdr(["pane", "read", pane, "--source", "visible", "--format", "text"])).stdout;
}
async function waitScreen(pane: string, match: (s: string) => boolean) {
  let text = "";
  for (let i = 0; i < 80; i++) { text = await screen(pane); if (match(text)) return text; await Bun.sleep(250); }
  throw new Error(`Unexpected terminal: ${text}`);
}
try {
  for (let i = 0; ; i++) {
    try { await herdrResult(["api", "snapshot"]); break; }
    catch (e) { if (i > 80) throw e; await Bun.sleep(100); }
  }
  await engine.refreshMachines();
  const id = store.createBroadcast({ title: "restore test", prompt: "NEVER SEND THIS", executions: [{ machine_id: "local", machine_label: "Local", target_kind: "existing", agent_kind: "pi", cwd: root, pane_id: "closed", terminal_id: "closed" }] });
  const e = store.executions(id)[0]!;
  store.update(e.id, { state: "completed" });
  const saved = store.execution(e.id)!;
  const result = await conversations.continue(saved, true);
  console.log(JSON.stringify({ phase: "picker", result }));
  const binding = store.continuation(continuationKey(saved))!;
  assert.ok(binding, JSON.stringify(result));
  const text = await waitScreen(binding.pane_id, s => s.includes(marker));
  assert.match(text, /session|会话/i);
  // Choose the only fixture session, without typing or submitting any new prompt.
  await herdrResult(["pane", "send-keys", binding.pane_id, "Enter"]);
  await waitScreen(binding.pane_id, s => s.includes("Saved response; no request needed."));
  await herdrResult(["workspace", "close", binding.workspace_id]);
  store.db.query("UPDATE broadcast_rounds SET prompt = ? WHERE broadcast_id = ?").run(marker, id);
  store.update(saved.id, { sent_at: Date.parse("2026-10-26T12:00:00.000Z") });
  const legacy = store.execution(saved.id)!;
  const restored = await conversations.continue(legacy, true);
  const exact = store.execution(saved.id)!;
  assert.equal(exact.session_value, file);
  const live = store.continuation(continuationKey(exact))!;
  await waitScreen(live.pane_id, s => s.includes("Saved response; no request needed."));
  assert.equal(store.execution(e.id)!.state, "completed");
  assert.ok(["opened", "resumed"].includes(restored.mode), JSON.stringify(restored));
  assert.equal(continuationInfo(store, engine, exact).terminal_state, "live");
  console.log(JSON.stringify({ result: "passed", picker: result.mode, exact: restored.mode, checks: ["real Pi picker", "select saved session", "automatic history discovery", "close and reopen same history", "no broadcast resend"] }));
} finally {
  await conversations.settle(); engine.stop(); await engine.settle(); store.close();
  await runHerdr(["server", "stop"]).catch(() => undefined);
  daemon.kill(); await daemon.exited;
  rmSync(root, { recursive: true, force: true });
}
