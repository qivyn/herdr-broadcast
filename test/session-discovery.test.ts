import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanSessionHistory, discoveryCommand, type SessionQuery } from "../src/session-discovery.ts";

let root: string;
const id = "01234567-1234-4567-89ab-0123456789ab";
const sentAt = Date.parse("2026-10-26T12:00:00Z");
const prompt = "Find the original conversation\n你好";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "bc-discovery-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function query(agent = "pi"): SessionQuery { return { agent, cwd: root, prompt, sentAt, store: root }; }
function write(path: string, rows: unknown[]) { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, rows.map(x => JSON.stringify(x)).join("\n") + "\n"); }
function pi(path: string, text = prompt, at = sentAt, cwd = root) {
  write(path, [{ type: "session", id, cwd }, { type: "message", timestamp: new Date(at).toISOString(), message: { role: "user", content: [{ type: "text", text }] } }]);
}

test("Pi lookup requires matching machine-local directory, exact prompt and send time", async () => {
  const file = join(root, "project", "original.jsonl");
  pi(file);
  pi(join(root, "project", "later.jsonl"), prompt, sentAt + 60000);
  pi(join(root, "other", "other.jsonl"), prompt, sentAt, join(root, "other"));
  pi(join(root, "project", "different.jsonl"), "a different request");
  const result = await scanSessionHistory(query());
  expect(result.status).toBe("found");
  expect(result.session?.kind).toBe("path");
  expect(result.session?.value).toEndWith("/project/original.jsonl");
  expect(await scanSessionHistory({ ...query(), prompt: "missing" })).toEqual({ status: "none" });
});

test("parallel identical broadcasts and forked copies never pick a winner by recency", async () => {
  pi(join(root, "project", "one.jsonl"));
  pi(join(root, "project", "two.jsonl"), prompt, sentAt + 1);
  expect(await scanSessionHistory(query())).toEqual({ status: "ambiguous" });
});

test("incomplete or oversized transcripts prevent a false uniqueness claim", async () => {
  pi(join(root, "project", "one.jsonl"));
  writeFileSync(join(root, "project", "incomplete.jsonl"), '{"type":"session",');
  expect(await scanSessionHistory(query())).toEqual({ status: "unavailable" });
  writeFileSync(join(root, "project", "incomplete.jsonl"), "x".repeat(4 * 1024 * 1024 + 1));
  expect(await scanSessionHistory(query())).toEqual({ status: "unavailable" });
});

test("Claude lookup ignores tool results and subagent history", async () => {
  const msg = { role: "user", content: [{ type: "text", text: prompt }] };
  write(join(root, "projects", "project", id + ".jsonl"), [
    { type: "user", sessionId: id, cwd: root, timestamp: new Date(sentAt).toISOString(), message: msg },
    { type: "assistant", message: { content: "ignore" } },
  ]);
  write(join(root, "projects", "project", "subagent.jsonl"), [
    { type: "user", isSidechain: true, sessionId: id, cwd: root, timestamp: new Date(sentAt).toISOString(), message: msg },
  ]);
  expect(await scanSessionHistory(query("claude"))).toEqual({ status: "found", session: { kind: "id", value: id } });
});

test("Codex lookup uses session metadata and the timestamped user response item", async () => {
  write(join(root, "sessions", "2026", "10", "26", "rollout.jsonl"), [
    { type: "session_meta", payload: { id, cwd: root } },
    { type: "response_item", timestamp: new Date(sentAt).toISOString(), payload: { role: "user", content: [{ type: "input_text", text: prompt }] } },
  ]);
  expect(await scanSessionHistory(query("codex"))).toEqual({ status: "found", session: { kind: "id", value: id } });
});

for (const agent of ["codex", "claude", "pi"]) test(`${agent} verifies a reported session without reading unrelated oversized or incomplete history`, async () => {
  const dir = agent === "codex" ? join(root, "sessions", "2026", "10", "26")
    : agent === "claude" ? join(root, "projects", "project") : join(root, "project");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "unrelated.jsonl"), "x".repeat(6 * 1024 * 1024));
  const file = join(dir, agent === "codex" ? `rollout-2026-10-26T12-00-00-${id}.jsonl` : `${id}.jsonl`);
  if (agent === "pi") pi(file);
  else if (agent === "claude") write(file, [{ type: "user", sessionId: id, cwd: root, timestamp: new Date(sentAt).toISOString(), message: { role: "user", content: prompt } }]);
  else write(file, [{ type: "session_meta", payload: { id, cwd: root } }, { type: "response_item", timestamp: new Date(sentAt).toISOString(), payload: { role: "user", content: prompt } }]);
  const expected = { kind: agent === "pi" ? "path" as const : "id" as const, value: agent === "pi" ? file : id };
  expect(await scanSessionHistory({ ...query(agent), expected })).toMatchObject({ status: "found", session: expected });
  // A known-ID proof must never fall back to some other matching conversation.
  expect((await scanSessionHistory({ ...query(agent), expected, prompt: "other input" })).status).toBe("none");
  expect((await scanSessionHistory({ ...query(agent), expected, cwd: join(root, "other") })).status).not.toBe("found");
  expect((await scanSessionHistory({ ...query(agent), expected, sentAt: sentAt + 60000 })).status).toBe("none");
});

test("reported Codex identity validates metadata, retries partial records and keeps candidate read limits", async () => {
  const file = join(root, "sessions", "2026", "10", "26", `rollout-${id}.jsonl`);
  const expected = { kind: "id" as const, value: id }, q = { ...query("codex"), expected };
  const meta = { type: "session_meta", payload: { id, cwd: root } };
  const input = { type: "response_item", timestamp: new Date(sentAt).toISOString(), payload: { role: "user", content: prompt } };
  write(file, [{ ...meta, payload: { ...meta.payload, id: "11234567-1234-4567-89ab-0123456789ab" } }, input]);
  expect(await scanSessionHistory(q)).toMatchObject({ status: "unavailable", reason: "identity_mismatch" });
  write(file, [meta]); appendFileSync(file, JSON.stringify(input).slice(0, 20));
  expect(await scanSessionHistory(q)).toMatchObject({ status: "unavailable", reason: "incomplete" });
  appendFileSync(file, JSON.stringify(input).slice(20) + "\n");
  expect(await scanSessionHistory(q)).toMatchObject({ status: "found", session: expected });
  appendFileSync(file, "x".repeat(6 * 1024 * 1024));
  expect((await scanSessionHistory(q)).status).toBe("found"); // output after the proven input is irrelevant
  write(file, [meta, { type: "response_item", payload: { output: "x".repeat(6 * 1024 * 1024) } }, input]);
  expect(await scanSessionHistory(q)).toMatchObject({ status: "unavailable", reason: "read_limit" });
  expect(await scanSessionHistory({ ...q, expected: { kind: "id", value: "../../escape" } })).toMatchObject({ status: "unavailable", reason: "invalid_identity" });
});

test("known Claude ID is independent of the number and matching text of other conversations", async () => {
  const dir = join(root, "projects", "fixture"); mkdirSync(dir, { recursive: true });
  for (let n = 0; n < 2001; n++) writeFileSync(join(dir, `other-${n}.jsonl`), "not a transcript");
  const row = { type: "user", sessionId: id, cwd: root, timestamp: new Date(sentAt).toISOString(), message: { role: "user", content: prompt } };
  write(join(dir, id + ".jsonl"), [row]);
  const other = "11234567-1234-4567-89ab-0123456789ab";
  write(join(dir, other + ".jsonl"), [{ ...row, sessionId: other }]);
  const expected = { kind: "id" as const, value: id };
  expect(await scanSessionHistory({ ...query("claude"), expected })).toMatchObject({ status: "found", session: expected });
});

test("SSH history lookup uses the requested profile and keeps user prompts out of its command", () => {
  const command = discoveryCommand({ id: "remote", enabled: true, target: "ssh://user@host:2222", label: "Remote", session: "work" });
  expect(command).toContain("user@host");
  expect(command).toContain("2222");
  expect(command).toContain("BatchMode=yes");
  expect(command).toContain("StrictHostKeyChecking=yes");
  expect(command.at(-1)).toStartWith('exec "${SHELL:-/bin/sh}" -lc ' );
  expect(command.join(" ")).not.toContain(prompt);
});
