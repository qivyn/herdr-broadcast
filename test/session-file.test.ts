import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sessionFileCheckCommand, sessionFileReadable } from "../src/session-file.ts";

test("Pi file preflight rejects missing, empty and directory targets", async () => {
  const root = mkdtempSync(join(tmpdir(), "bc-file-"));
  try {
    const file = join(root, "session.jsonl");
    expect(await sessionFileReadable("local", file)).toBe(false);
    writeFileSync(file, "");
    expect(await sessionFileReadable("local", file)).toBe(false);
    writeFileSync(file, '{"type":"session"}\n');
    expect(await sessionFileReadable("local", file)).toBe(true);
    expect(await sessionFileReadable("local", root)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("remote Pi preflight uses the saved SSH profile and quotes paths as data", () => {
  const command = sessionFileCheckCommand({ id: "remote", label: "Remote", enabled: true, target: "ssh://user@host:2222", session: "work" }, "/home/u/it's $(not-a-command).jsonl");
  expect(command).toContain("user@host");
  expect(command).toContain("2222");
  expect(command).toContain("StrictHostKeyChecking=yes");
  expect(command.at(-1)).toBe("test -f '/home/u/it'\\''s $(not-a-command).jsonl' && test -r '/home/u/it'\\''s $(not-a-command).jsonl' && test -s '/home/u/it'\\''s $(not-a-command).jsonl'");
});
