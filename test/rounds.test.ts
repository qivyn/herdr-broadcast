import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.ts";

const target = { machine_id: "local", machine_label: "Local", target_kind: "existing" as const,
  pane_id: "w1:p1", terminal_id: "term_1", session_kind: "id", session_value: "session-1" };

test("v7 migration leaves legacy empty send timestamps unknown, while old workers invalidate new unsent evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "broadcast-v7-")), path = join(dir, "db.sqlite");
  let store = new Store(path);
  try {
    const id = store.createBroadcast({ title: "legacy", prompt: "maybe delivered", executions: [
      { ...target, target_kind: "new", session_kind: null, session_value: null }, target,
    ] });
    const [pending, completed] = store.executions(id);
    store.update(pending!.id, { state: "sending", owner_pid: 2147483647 });
    store.update(completed!.id, { state: "completed", sent_at: 100, finished_at: 200 });
    const saved = store.executions(id).map(({ input_attempted, ...e }) => e);
    store.saveContinuation({ key: "legacy-binding", pane_id: "w2:p1", terminal_id: "t2", workspace_id: "w2", workspace_label: "Restore", tab_id: "tab2", status: "launched", error: null });
    store.db.exec("DROP TRIGGER executions_input_attempt; ALTER TABLE executions DROP COLUMN input_attempted; ALTER TABLE executions DROP COLUMN interrupt_requested_at; PRAGMA user_version = 7;");
    store.close(); store = new Store(path);
    expect(store.db.query("PRAGMA user_version").get()).toEqual({ user_version: 9 });
    expect(store.executions(id)).toEqual(saved.map(e => ({ ...e, input_attempted: null, interrupt_requested_at: null })));
    expect(store.continuation("legacy-binding")!.terminal_id).toBe("t2");
    const next = store.createRound(id, "new task", [{ ...target, target_kind: "new", session_kind: null, session_value: null }]);
    const fresh = store.executions(id).find(e => e.round_id === next.id)!;
    expect(fresh.input_attempted).toBe(0);
    // A v7 worker does not know the new column; the database still records its claim atomically.
    store.db.query("UPDATE executions SET state = 'sending', owner_pid = 2147483647 WHERE id = ?").run(fresh.id);
    expect(store.execution(fresh.id)!.input_attempted).toBe(1);
    const claimed = store.createRound(id, "atomic claim", [target]);
    const claiming = store.executions(id).find(e => e.round_id === claimed.id)!;
    expect(store.claim(claiming.id, ["submitting"], "sending")).toBe(true);
    expect(store.claim(claiming.id, ["submitting"], "sending")).toBe(false);
    expect(store.execution(claiming.id)!.input_attempted).toBe(1);
    store.update(claiming.id, { state: "sent" });
    expect(store.recoverAbandoned(() => false)).toBe(2);
    expect(store.execution(pending!.id)).toMatchObject({ state: "uncertain", input_attempted: null, seq_before: null, sent_at: null });
    expect(store.execution(fresh.id)).toMatchObject({ state: "uncertain", input_attempted: 1, seq_before: null, sent_at: null });
    store.close(); store = new Store(path);
    expect(store.execution(fresh.id)!.input_attempted).toBe(1);
    expect(store.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("v5 migration preserves IDs, results and session bindings, and survives reopening", () => {
  const dir = mkdtempSync(join(tmpdir(), "broadcast-rounds-"));
  const file = join(dir, "db.sqlite");
  let store: Store | undefined;
  try {
    // Build a complete legacy database by removing the round schema from a saved fixture.
    store = new Store(file);
    const id = store.createBroadcast({ title: "old", prompt: "original instruction", executions: [target] });
    const e = store.executions(id)[0]!;
    store.update(e.id, { state: "completed", sent_at: 100, finished_at: 200 });
    const { round_id: _, ...saved } = store.execution(e.id)!;
    store.saveContinuation({ key: "binding", pane_id: "w2:p1", terminal_id: "term_2", workspace_id: "w2", workspace_label: "Restore", tab_id: "t2", status: "launched", error: null });
    store.close(); store = undefined;
    const old = new Database(file);
    old.exec("DROP INDEX executions_round; ALTER TABLE executions DROP COLUMN round_id; DROP TABLE broadcast_rounds; PRAGMA user_version = 5;");
    old.close();

    store = new Store(file);
    const rounds = store.rounds(id);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ number: 1, prompt: "original instruction", total: 1, counts: { completed: 1 } });
    expect(store.execution(e.id)).toEqual({ ...saved, round_id: rounds[0]!.id });
    expect(store.continuation("binding")?.terminal_id).toBe("term_2");
    const next = store.createRound(id, "next instruction", [target]);
    expect(next.number).toBe(2);
    store.close(); store = new Store(file);
    expect(store.rounds(id)).toHaveLength(2);
    expect(store.listBroadcasts()).toHaveLength(1);
    expect(store.listBroadcasts()[0]).toMatchObject({ round_count: 2, counts: { completed: 1, submitting: 1 } });
    expect(store.executions(id)[1]).toMatchObject({ session_value: "session-1", round_id: next.id });
    expect(store.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    store.deleteBroadcast(id);
    expect(store.rounds(id)).toEqual([]);
    expect(store.executions(id)).toEqual([]);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("concurrent writers append unique rounds and a failed round rolls back all of its participants", async () => {
  const dir = mkdtempSync(join(tmpdir(), "broadcast-round-writers-"));
  const file = join(dir, "db.sqlite");
  const store = new Store(file);
  try {
    const id = store.createBroadcast({ title: "one", prompt: "first", executions: [target] });
    const script = `import { Store } from ${JSON.stringify(new URL("../src/db.ts", import.meta.url).pathname)};
      const store = new Store(process.argv[1]);
      for (let i = 0; i < 4; i++) store.createRound(Number(process.argv[2]), process.argv[3] + i, [${JSON.stringify(target)}]);
      store.close();`;
    const writers = ["a", "b", "c"].map(prefix => Bun.spawn([process.execPath, "-e", script, file, String(id), prefix], { stdout: "pipe", stderr: "pipe" }));
    for (const child of writers) {
      const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(error).toBe(""); expect(code).toBe(0);
    }
    const rounds = store.rounds(id);
    expect(rounds.map(r => r.number)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    expect(new Set(rounds.map(r => r.prompt)).size).toBe(13);
    expect(() => store.createRound(id, "must roll back", [target, { ...target, machine_id: null as any }])).toThrow();
    expect(store.rounds(id)).toHaveLength(13);
    expect(store.executions(id)).toHaveLength(13);
    expect(store.listBroadcasts()).toHaveLength(1);
    expect(store.createRound(id, "after failure", [target]).number).toBe(14);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("v6 migration adds retry deduplication without changing existing rounds or conversation bindings", () => {
  const dir = mkdtempSync(join(tmpdir(), "broadcast-v6-")), path = join(dir, "db.sqlite");
  let store = new Store(path);
  try {
    const id = store.createBroadcast({ title: "existing", prompt: "instruction", executions: [target] });
    const e = store.executions(id)[0]!; store.update(e.id, { state: "lost", error: "original error" });
    const saved = store.execution(e.id)!;
    store.saveContinuation({ key: "saved", pane_id: "w2:p1", terminal_id: "term2", workspace_id: "w2", tab_id: "t2", workspace_label: "Restored", status: "uncertain", error: "waiting" });
    store.db.exec("DROP TABLE execution_retries; PRAGMA user_version = 6;"); store.close(); store = new Store(path);
    expect(store.execution(e.id)).toEqual(saved); expect(store.rounds(id)).toHaveLength(1);
    expect(store.continuation("saved")!.status).toBe("uncertain");
    const round = store.createRetryRound(saved, target);
    expect(round.number).toBe(2); expect(store.createRetryRound(saved, target).id).toBe(round.id);
    expect(store.rounds(id)).toHaveLength(2);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
