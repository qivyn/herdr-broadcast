#!/usr/bin/env bun
/** Real Codex CLI + Herdr, isolated homes and offline provider. No user sessions or model requests. */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isolatedHerdr } from "./e2e-environment.ts";
import { Store, type Execution } from "../src/db.ts";
import { Engine } from "../src/engine.ts";
import { Conversations, continuationKey } from "../src/continuation.ts";
import { agentGet, paneRead, paneSendKeys, paneSendText, runHerdr, herdrResult } from "../src/herdr.ts";
import { startWebServer } from "../src/web/server.ts";
import { shellQuote } from "../src/machine-command.ts";

const previewRequested = process.argv.includes("--preview") || process.env.CODEX_E2E_PREVIEW === "1";
const codex = Bun.which("codex");
if (!codex) throw new Error("Install Codex CLI with --no-daemon support for this E2E");
for (const key of Object.keys(process.env)) if (/^CODEX_|(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key)) delete process.env[key];
const env = await isolatedHerdr("codex-recovery");
const root = env.root, work = join(root, "work"), home = join(root, "codex");
mkdirSync(work); mkdirSync(home);
// A real installation has unrelated historical tool output. It must not block a live ID proof.
const oldDir = join(home, "sessions", "2026", "09", "29"); mkdirSync(oldDir, { recursive: true });
writeFileSync(join(oldDir, "rollout-2026-09-29T00-00-00-01234567-1234-4567-89ab-0123456789ab.jsonl"), [
  { type: "session_meta", payload: { id: "01234567-1234-4567-89ab-0123456789ab", cwd: work } },
  { type: "response_item", payload: { type: "custom_tool_call_output", output: "x".repeat(6 * 1024 * 1024) } },
].map(x => JSON.stringify(x)).join("\n") + "\n");
process.env.CODEX_HOME = home; process.env.BROADCAST_CODEX_OFFLINE_KEY = "offline-fixture";
// Restart the isolated server so every PTY inherits only this temporary Codex environment.
await runHerdr(["server", "stop"]);
const server = Bun.spawn([process.env.HERDR_BIN_PATH!, "--session", process.env.HERDR_BROADCAST_SESSION!, "server"], { env: process.env, stdout: Bun.file(join(root, "codex-server.log")), stderr: Bun.file(join(root, "codex-server.log")) });
writeFileSync(join(home, "config.toml"), `model_provider = "offline"\nmodel = "offline"\n[model_providers.offline]\nname = "Offline fixture"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nenv_key = "BROADCAST_CODEX_OFFLINE_KEY"\n[features]\nhooks = true\n[projects.${JSON.stringify(work)}]\ntrust_level = "trusted"\n`);
const store = new Store(join(root, "broadcast.sqlite"));
const engine = new Engine(store, () => {}, { startupConfirmMs: 60_000 });
const conversations = new Conversations(store, engine, () => {}, undefined, async () => ({ status: "none" }));
let preview: ReturnType<typeof startWebServer> | undefined;
const trace = join(root, "codex-trace.jsonl"), hooklog = join(root, "hooks.jsonl");
const log = (type: string, value: unknown) => appendFileSync(trace, JSON.stringify({ at: Date.now(), type, value }) + "\n");
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
async function wait<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, timeout = 25_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (ok(value)) return value; await Bun.sleep(200); }
  throw new Error("Timed out: " + what);
}
const current = (e: Execution) => store.execution(e.id)!;
async function screen(pane: string) { return paneRead("local", pane, 60, "visible"); }
async function dismissUpdate(pane: string) { const s = await screen(pane); if (/Update available/.test(s) && /[123][.)].*(?:Skip|Update|Ignore)/i.test(s) && (await agentGet("local", pane)).agent_status === "blocked") await paneSendKeys("local", pane, ["esc"]); }
function newBroadcast(prompt: string) {
  const id = store.createBroadcast({ title: "Codex isolated test", prompt, executions: [{ machine_id: "local", machine_label: "Local", target_kind: "new", agent_kind: "codex", cwd: work, slot: 1 }] });
  const e = store.executions(id)[0]!; engine.submit(store.rounds(id)[0]!.id); return e;
}
async function submitted(e: Execution) {
  return wait(async () => { const now = current(e); if (now.pane_id) await dismissUpdate(now.pane_id); log("execution", now); return now; }, e => e.state === "sent" || e.state === "failed" || e.state === "uncertain", "submission");
}
async function ordinary(e: Execution, text: string) {
  const target = await conversations.target(current(e)); assert(target?.mode === "reconnect", "target must be confirmed");
  const round = store.createRound(e.broadcast_id, text, [{ ...target.execution, target_kind: "existing", continuation_source: continuationKey(current(e)), parent_execution_id: e.id }]);
  const child = store.executions(e.broadcast_id).find(x => x.round_id === round.id)!; engine.submit(round.id); return child;
}
async function abortWork(pane: string) { await paneSendKeys("local", pane, ["esc"]); await Bun.sleep(400); }
try {
  await wait(async () => (await runHerdr(["api", "snapshot"])).code, c => c === 0, "isolated server");
  const install = await runHerdr(["integration", "install", "codex"]); assert(install.code === 0, install.stderr);
  const hook = join(home, "herdr-agent-state.sh"); copyFileSync(hook, hook + ".original");
  const collector = join(root, "hook.ts");
  // Delay real hook forwarding past agent.prompt's receipt, deterministically exercising late identity.
  writeFileSync(collector, `import {appendFileSync} from 'node:fs';const input=await Bun.stdin.text();appendFileSync(${JSON.stringify(hooklog)},JSON.stringify({at:Date.now(),input:JSON.parse(input),pane:process.env.HERDR_PANE_ID})+'\\n');await Bun.sleep(1200);const p=Bun.spawn(['bash',${JSON.stringify(hook + ".original")},...process.argv.slice(2)],{stdin:new Blob([input]),stdout:'inherit',stderr:'inherit'});process.exit(await p.exited);`);
  writeFileSync(hook, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(collector)} "$@"\n`);
  await engine.refreshMachines();
  const first = newBroadcast("/status");
  await wait(async () => current(first), e => !!e.pane_id, "new pane");
  const firstPane = current(first).pane_id!;
  await wait(async () => { await dismissUpdate(firstPane); return screen(firstPane); }, s => /Hooks need review/.test(s), "hooks trust UI");
  await wait(async () => engine.canCancelStartup(first.id), Boolean, "startup wait");
  assert(current(first).input_attempted === 0, "must not paste into trust UI");
  log("trust-before", await screen(firstPane));
  // Explicit test operator trusts only the temporary fixture hook.
  await paneSendKeys("local", firstPane, ["enter"]);
  await wait(() => screen(firstPane), s => /Lifecycle hooks/.test(s), "hooks manager");
  await paneSendText("local", firstPane, "t"); await Bun.sleep(300);
  assert(current(first).input_attempted === 0, "trusted hooks manager is still not a composer");
  await paneSendKeys("local", firstPane, ["esc"]);
  assert((await submitted(first)).state === "sent", "first /status must submit after trust");
  await wait(() => screen(firstPane), s => /Session:/.test(s), "first /status actually executed");
  assert(!current(first).session_value, "/status alone must not invent identity");
  await conversations.confirmSession(current(first), current(first).terminal_id);
  const next = await ordinary(first, "codex-isolated-first-" + crypto.randomUUID());
  assert((await submitted(next)).state === "sent", "ordinary follow-up sent");
  await wait(async () => current(next), e => !!e.session_value, "late native identity", 25_000);
  assert(current(first).session_value === current(next).session_value, "explicit no-ID confirmation must acquire selected identity");
  const firstId = current(first).session_value!;
  await abortWork(firstPane);
  const second = newBroadcast("codex-isolated-second-" + crypto.randomUUID());
  assert((await submitted(second)).state === "sent", "second broadcast sent");
  await wait(async () => current(second), e => !!e.session_value, "second native identity");
  const secondPane = current(second).pane_id!;
  assert(current(second).session_value !== firstId, "two terminals must have distinct native sessions");
  assert((await agentGet("local", firstPane)).agent_session?.value === firstId, "second hook must not overwrite first pane");
  await abortWork(secondPane);
  await herdrResult(["pane", "close", firstPane]);
  await herdrResult(["pane", "close", secondPane]);
  // A legacy unknown record explicitly selects the second fixture history.
  const unknownId = store.createBroadcast({ title: "Legacy selection", prompt: "never replay this", executions: [{ machine_id: "local", machine_label: "Local", target_kind: "existing", agent_kind: "codex", cwd: work }] });
  const unknown = store.executions(unknownId)[0]!; store.update(unknown.id, { state: "sent", input_attempted: 1, sent_at: 1 });
  const opened = await conversations.continue(current(unknown), true); assert(opened.mode === "choose", "explicit picker launched");
  const picker = store.continuation(continuationKey(unknown))!;
  const pickerScreen = await wait(async () => { await dismissUpdate(picker.pane_id); return screen(picker.pane_id); }, s => /Resume|session/i.test(s), "history picker"); log("picker", pickerScreen);
  await paneSendKeys("local", picker.pane_id, ["enter"]);
  await wait(async () => agentGet("local", picker.pane_id), a => a.interactive_ready === true, "selected conversation ready");
  await conversations.confirmSession(current(unknown), picker.terminal_id);
  const resumed = await ordinary(unknown, "codex-isolated-resume-" + crypto.randomUUID());
  assert((await submitted(resumed)).state === "sent", "selected session follow-up sent");
  await wait(async () => current(unknown), e => !!e.session_value, "selected session saved");
  assert(current(unknown).session_value === current(second).session_value, "picker must bind the selected latest fixture, not first terminal");
  await abortWork(picker.pane_id); await herdrResult(["pane", "close", picker.pane_id]);
  const hookCount = readFileSync(hooklog, "utf8").trim().split("\n").length;
  const restored = await conversations.continue(current(unknown)); log("restore-result", restored);
  const direct = store.continuation(continuationKey(current(unknown)))!;
  await wait(async () => { await dismissUpdate(direct.pane_id); return agentGet("local", direct.pane_id); }, a => a.interactive_ready === true, "direct restore startup");
  if (restored.mode === "inspect") await conversations.confirmSession(current(unknown), direct.terminal_id);
  const directScreen = await screen(direct.pane_id); log("direct", directScreen);
  assert(!/Resume a previous session/.test(directScreen), "saved ID must skip history picker");
  assert(directScreen.includes(store.getRound(resumed.round_id)!.prompt), "direct restore must show selected original history");
  await Bun.sleep(500);
  assert(readFileSync(hooklog, "utf8").trim().split("\n").length === hookCount, "restore must not send an ordinary task");
  const hooks = readFileSync(hooklog, "utf8").trim().split("\n").map(l => JSON.parse(l));
  assert(hooks.some(h => h.pane === firstPane && h.input.session_id === firstId), "first hook target");
  assert(hooks.some(h => h.pane === secondPane && h.input.session_id === current(second).session_value), "second hook target");
  assert(hooks.some(h => h.pane === picker.pane_id && h.input.source === "resume"), "resumed hook target");
  const messages: string[] = [];
  for await (const file of new Bun.Glob("sessions/**/*.jsonl").scan({ cwd: home, absolute: true })) {
    for (const line of readFileSync(file, "utf8").trim().split("\n")) {
      const item = JSON.parse(line);
      if (item.type === "response_item" && item.payload?.role === "user") messages.push((item.payload.content ?? []).map((c: { text?: string }) => c.text || "").join(""));
    }
  }
  for (const e of [next, second, resumed]) assert(messages.filter(text => text === store.getRound(e.round_id)!.prompt).length === 1, "each ordinary submission must occur exactly once in native history");
  assert(!messages.includes("never replay this"), "restoration must not replay history");
  console.log("[e2e] Codex trust wait, delayed identity, independent terminals, selected session and exact restore passed");
  if (previewRequested) {
    const pending = newBroadcast("/status"); assert((await submitted(pending)).state === "sent", "preview unbound fixture sent");
    preview = startWebServer(store, { host: "127.0.0.1", port: 0, token: null, hosts: [] });
    await preview.engine.refreshMachines(); await preview.engine.refresh("local");
    console.log("[preview] " + preview.url);
    await new Promise<void>(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  }
} catch (error) {
  for (const e of store.db.query<Execution, []>("SELECT * FROM executions").all()) if (e.pane_id) log("failure-screen", { id: e.id, screen: await screen(e.pane_id).catch(String) });
  for await (const file of new Bun.Glob("sessions/**/*.jsonl").scan({ cwd: home, absolute: true })) log("fixture-transcript", readFileSync(file, "utf8"));
  log("fixture-agents", await runHerdr(["agent", "list"]));
  console.error(error); process.exitCode = 1;
} finally {
  await preview?.stop(); engine.stop(); await conversations.settle(); await engine.settle();
  const evidence = process.env.E2E_LOG_DIR ? resolve(process.env.E2E_LOG_DIR) : null;
  store.close();
  if (evidence) { mkdirSync(evidence, { recursive: true }); for (const name of ["codex-trace.jsonl", "hooks.jsonl", "broadcast.sqlite"]) if (existsSync(join(root, name))) copyFileSync(join(root, name), join(evidence, name)); }
  try { await env.close(); } finally { server.kill(); await server.exited; }
}
