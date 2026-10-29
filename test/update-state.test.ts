import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateJournal, updateGuard } from "../src/service/update-state.ts";

test("single writer preserves metadata and rejects stale operation, phase and outcome patches", () => {
  const dir = mkdtempSync(join(tmpdir(), "broadcast-journal-")), journal = new UpdateJournal(dir);
  try {
    const checking = journal.commit({ phase: "checking", checked_at: 100 });
    const running = journal.commit({ phase: "updating", operation_id: "one", outcome: "running", step: "download" }, updateGuard(checking));
    expect(() => journal.commit({ phase: "idle", checked_at: 200 }, updateGuard(checking))).toThrow("过期");
    const draining = journal.commit({ phase: "restarting", step: "drain" }, updateGuard(running));
    expect(() => journal.commit({ step: "dependencies" }, updateGuard(running))).toThrow("过期");
    journal.commit({ phase: "idle", outcome: "succeeded", step: null, checked_at: 300 });
    expect(() => journal.commit({ outcome: "running", phase: "restarting" }, updateGuard(draining))).toThrow("过期");
    const done = journal.status;
    expect(() => journal.commit({ phase: "restarting", outcome: "running" }, updateGuard(done))).toThrow("阶段");
    journal.commit({ source_version: "new" }, updateGuard(done));
    const saved = JSON.parse(readFileSync(join(dir, "update.json"), "utf8"));
    expect(saved).toMatchObject({ operation_id: "one", outcome: "succeeded", checked_at: 300, source_version: "new" });
    journal.commit({ phase: "updating", operation_id: "two", outcome: "running" }, updateGuard(journal.status));
    expect(() => journal.commit({ error: "old failure" }, updateGuard(done))).toThrow("过期");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
