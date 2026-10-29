import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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

test("SSH history lookup uses the requested profile and keeps user prompts out of its command", () => {
  const command = discoveryCommand({ id: "remote", enabled: true, target: "ssh://user@host:2222", label: "Remote", session: "work" });
  expect(command).toContain("user@host");
  expect(command).toContain("2222");
  expect(command).toContain("BatchMode=yes");
  expect(command).toContain("StrictHostKeyChecking=yes");
  expect(command.at(-1)).toStartWith("python3 -c '");
  expect(command.join(" ")).not.toContain(prompt);
});
