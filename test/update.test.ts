import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSelf, Updater, type UpdaterOptions, type InstalledPlugin } from "../src/update.ts";
import { checked, runCommand } from "../src/service/commands.ts";
import { sourceHash, validateStage } from "../src/service/releases.ts";
import { type Release } from "../src/service/state.ts";
import { until } from "./helpers.ts";
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "broadcast-update-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) => checked(runCommand, ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], cwd);
async function release(cwd: string, version: string) {
  mkdirSync(join(cwd, "src/service"), { recursive: true });
  writeFileSync(join(cwd, "src/service/entry.ts"), 'console.log(JSON.stringify(process.argv[2] === "assets" ? [] : {protocol:1,schema:9,version:JSON.parse(await Bun.file("package.json").text()).version}));');
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(cwd, "herdr-plugin.toml"), `id = "herdr-broadcast"\nversion = "${version}"\n`);
  await git(cwd, "add", "-A"); await git(cwd, "commit", "-qm", version); return git(cwd, "rev-parse", "HEAD");
}
async function fixture() {
  const origin = join(dir, "origin.git"), root = join(dir, "root"), dev = join(dir, "dev"), runtime = join(dir, "runtime"), stateDir = join(dir, "state");
  await git(dir, "init", "-q", "--bare", "-b", "main", origin); await git(dir, "clone", "-q", origin, dev);
  const first = await release(dev, "0.3.0"); await git(dev, "push", "-qu", "origin", "main"); await git(dir, "clone", "-q", origin, root);
  cpSync(root, runtime, { recursive: true });
  const current: Release = { directory: runtime, sourceRoot: root, revision: first, sourceRevision: first, sourceHash: sourceHash(root), hash: sourceHash(runtime), protocol: 1, schema: 9, version: "0.3.0" };
  const next = await release(dev, "0.3.1"); await git(dev, "tag", "-a", "v0.3.1", "-m", "release"); await git(dev, "push", "-q", "--tags"); await git(dev, "push", "-q");
  const activated: Release[] = [], calls: string[][] = [], order: string[] = [];
  const options: UpdaterOptions = { stateDir, current, publish() {}, validate: async () => { order.push("validate"); },
    plugins: async () => [{ plugin_id: "herdr-broadcast", plugin_root: root, version: "0.3.0", source: { kind: "local" } }],
    run: async (argv, opts) => {
      calls.push(argv);
      if (argv[1] === "plugin" && argv[2] === "link") { order.push("link"); return { code: 0, stdout: "", stderr: "" }; }
      if (!["git", process.execPath].includes(argv[0]!)) throw new Error(`Unexpected external command: ${argv[0]}`);
      return runCommand(argv, opts);
    },
    activate: async candidate => { order.push("activate"); activated.push(candidate); },
  };
  return { root, dev, origin, stateDir, first, next, current, activated, options, calls, order };
}
function github(f: Awaited<ReturnType<typeof fixture>>, requestedRef: string | null = "main") {
  let installed = false, nativeUpdates = 0;
  let releaseData: unknown = { tag_name: "v0.3.1", draft: false, prerelease: false, published_at: "2026-10-30T00:00:00Z" };
  const installs: string[][] = [];
  const options: UpdaterOptions = { ...f.options,
    fetch: async url => String(url).endsWith("/releases/latest") ? releaseData === null ? new Response(null, { status: 404 }) : Response.json(releaseData) : Response.json({ id: 1 }),
    plugins: async () => [{ plugin_id: "test.herdr-broadcast", plugin_root: installed ? f.dev : f.root, version: installed ? "0.3.1" : "0.3.0",
      source: { kind: "github", owner: "test", repo: "broadcast", requested_ref: installed ? f.next : requestedRef, resolved_commit: installed ? f.next : f.first } }],
    run: async (argv, opts) => {
      if (argv[1] === "plugin" && ["update", "install"].includes(argv[2]!)) { installs.push(argv); nativeUpdates++; installed = true; return { code: 0, stdout: "", stderr: "" }; }
      return f.options.run!(argv.map(a => a === "https://github.com/test/broadcast.git" ? f.origin : a), opts);
    },
  };
  return { options, installed: () => installed, nativeUpdates: () => nativeUpdates, installs, setRelease: (value: unknown) => { releaseData = value; } };
}

test("local checks use the checkout only, even when its upstream has a newer version", async () => {
  const f = await fixture(), u = new Updater(f.options);
  expect(await u.check()).toMatchObject({ kind: "local", available: false, latest_revision: null, blocked_reason: null });
  writeFileSync(join(f.root, "src/local.ts"), "local edits");
  expect(await u.check()).toMatchObject({ available: false, blocked_reason: null });
  expect(f.calls.some(a => a.includes("fetch") || a.includes("ls-remote"))).toBe(false);
});
test("local apply validates, relinks and switches a snapshot, preserving dirty source and Git refs", async () => {
  const f = await fixture(); writeFileSync(join(f.root, "src/new.ts"), "export const local = true;");
  writeFileSync(join(f.root, "herdr-plugin.toml"), 'id = "herdr-broadcast"\nversion = "0.3.0-dev"\n');
  const refs = await git(f.root, "show-ref"), hash = sourceHash(f.root), u = new Updater(f.options);
  const accepted = await u.applyLocal(); expect(accepted.operation_id).toBeTruthy();
  await u.wait(); expect(u.status.phase).toBe("restarting"); expect(f.order).toEqual(["validate", "link", "activate"]);
  const next = f.activated[0]!;
  expect(next.directory).not.toBe(f.root); expect(next.revision).toBe(f.first);
  expect(readFileSync(join(next.directory, "src/new.ts"), "utf8")).toContain("local = true");
  expect(await git(f.root, "show-ref")).toBe(refs); expect(sourceHash(f.root)).toBe(hash);
  const after = new Updater({ ...f.options, current: next });
  expect(await after.describe()).toMatchObject({ kind: "local", current_revision: f.first });
});
test("local installation refuses upstream downloads and directs the user to apply", async () => {
  const f = await fixture(), u = new Updater(f.options); await u.install(); await u.wait();
  expect(u.status.error).toContain("bun src/main.ts web-apply"); expect(f.activated).toHaveLength(0);
  expect(f.calls.some(a => a.includes("fetch") || a.includes("update"))).toBe(false);
});
test("GitHub installations reject the local apply operation", async () => {
  const f = await fixture(), g = github(f), u = new Updater(g.options); await u.applyLocal(); await u.wait();
  expect(u.status.error).toContain("更新并重启"); expect(f.activated).toHaveLength(0); expect(g.nativeUpdates()).toBe(0); expect(f.order).toEqual([]);
});
for (const failure of ["dependencies", "typecheck", "resources"]) test(`${failure} failure persists without relinking or switching, and can retry`, async () => {
  const f = await fixture(), u = new Updater({ ...f.options, validate: async () => { throw new Error(failure); } });
  await u.applyLocal(); await u.wait(); expect(u.status).toMatchObject({ phase: "error", outcome: "failed", current_revision: f.first });
  expect(f.order).toEqual([]);
  const retry = new Updater(f.options); expect(retry.status.error).toBe(failure);
  await retry.applyLocal(); await retry.wait(); expect(f.activated).toHaveLength(1);
  expect(await git(f.root, "rev-parse", "HEAD")).toBe(f.first);
});
test("local source changes during validation abort before relinking or activation", async () => {
  const f = await fixture(), u = new Updater({ ...f.options, validate: async () => { writeFileSync(join(f.root, "src/local.ts"), "changed"); } });
  await u.applyLocal(); await u.wait(); expect(u.status.error).toContain("本地源码发生变化"); expect(f.order).toEqual([]);
});
test("relink failure keeps the current runtime", async () => {
  const f = await fixture(), u = new Updater({ ...f.options, run: async (a, o) => a[2] === "link" ? { code: 1, stdout: "", stderr: "link failed" } : f.options.run!(a, o) });
  await u.applyLocal(); await u.wait(); expect(u.status.error).toContain("link failed"); expect(f.activated).toEqual([]);
});
test("a source change during preparation prevents re-linking a GitHub installation as local", async () => {
  const f = await fixture(); let changed = false;
  const u = new Updater({ ...f.options, plugins: async () => [{ plugin_id: "herdr-broadcast", plugin_root: f.root, source: { kind: changed ? "github" : "local" } }], validate: async () => { changed = true; } });
  await u.applyLocal(); await u.wait(); expect(u.status.error).toContain("来源发生变化"); expect(f.order).toEqual([]);
});
test("duplicate apply/restart requests share one operation", async () => {
  const f = await fixture(); let resolve!: () => void; const gate = new Promise<void>(r => { resolve = r; });
  const u = new Updater({ ...f.options, validate: () => gate });
  const first = (await u.applyLocal()).operation_id, second = (await u.restart()).operation_id;
  expect(second).toBe(first); resolve(); await u.wait(); expect(f.activated).toHaveLength(1);
});
test("restart ignores dirty or missing source and never prepares, relinks or downloads", async () => {
  const f = await fixture(); writeFileSync(join(f.root, "src/local.ts"), "changed");
  const u = new Updater({ ...f.options, plugins: async () => { throw new Error("source unavailable"); } });
  rmSync(f.root, { recursive: true }); await u.restart(); await u.wait();
  expect(f.activated).toEqual([f.current]); expect(f.order).toEqual(["activate"]); expect(f.calls).toEqual([]);
});
test("refresh discards old development hints while preserving a failed operation", async () => {
  const f = await fixture(); mkdirSync(f.stateDir);
  writeFileSync(join(f.stateDir, "update.json"), JSON.stringify({ kind: "git", mode: "development", source_changed: true, available: true, latest_revision: f.next,
    phase: "error", action: "apply", operation_id: "saved-operation", outcome: "failed", error: "saved failure" }));
  const u = new Updater(f.options), status = await u.describe();
  expect(status).toMatchObject({ kind: "local", available: false, latest_revision: null, phase: "error", outcome: "failed", error: "saved failure", operation_id: "saved-operation" });
  expect(status).not.toHaveProperty("mode"); expect(status).not.toHaveProperty("source_changed");
  const saved = JSON.parse(readFileSync(join(f.stateDir, "update.json"), "utf8"));
  expect(saved).not.toHaveProperty("mode"); expect(saved).not.toHaveProperty("source_changed");
});
test("manual local apply works without a Git repository", async () => {
  const f = await fixture(); rmSync(join(f.root, ".git"), { recursive: true });
  const u = new Updater(f.options); expect(await u.describe()).toMatchObject({ kind: "local", available: false });
  await u.applyLocal(); await u.wait(); expect(f.activated).toHaveLength(1);
});
test("scheduled checks do not inspect or load local source or request upstream updates", async () => {
  const f = await fixture(); let descriptions = 0; const phases: string[] = [];
  const u = new Updater({ ...f.options, timing: { firstCheckMs: 10, everyMs: 30 },
    plugins: async () => { descriptions++; return f.options.plugins!(); }, publish: s => phases.push(s.phase),
    run: async () => { throw new Error("Local status must not run any command"); } });
  u.start();
  try {
    await until(() => u.status.kind === "local");
    rmSync(f.root, { recursive: true }); // Even unavailable source cannot disturb the confirmed service.
    const before = descriptions; await until(() => descriptions >= before + 2);
    expect(u.status.phase).toBe("idle"); expect(phases).not.toContain("checking"); expect(f.activated).toEqual([]);
  } finally { u.stop(); }
});
for (const file of ["herdr-plugin.toml", "untracked.txt"]) test(`GitHub dirty source (${file}) still blocks installation`, async () => {
  const f = await fixture(); writeFileSync(join(f.root, file), "local work"); const u = new Updater(github(f).options);
  expect((await u.check()).blocked_reason).toContain("未提交"); await u.install(); await u.wait(); expect(f.activated).toHaveLength(0);
});
test("diverged GitHub histories still refuse automatic installation", async () => {
  const f = await fixture(); const revision = await release(f.root, "0.4.0-local");
  const u = new Updater({ ...github(f).options, current: { ...f.current, revision } }); expect((await u.check()).blocked_reason).toContain("分叉");
});
test("clean installation HEAD differing from its registered commit blocks replacement", async () => {
  const f = await fixture(); await release(f.root, "0.3.0-local");
  expect(await git(f.root, "status", "--porcelain")).toBe("");
  const g = github(f), u = new Updater(g.options);
  expect((await u.check()).blocked_reason).not.toBeNull();
  await u.install(); await u.wait();
  expect(g.nativeUpdates()).toBe(0); expect(f.activated).toEqual([]);
});
for (const ref of [null, "main", "refs/heads/main", "v0.3.0", "abcdef0123456789"]) test(`GitHub installation ${ref ?? "default"} follows published releases and installs the exact commit`, async () => {
  const f = await fixture(), g = github(f, ref), u = new Updater(g.options), refs = await git(f.root, "show-ref");
  expect(await u.check()).toMatchObject({ kind: "github", available: true, latest_revision: f.next, latest_tag: "v0.3.1" });
  await u.install(); await u.wait(); expect(g.nativeUpdates()).toBe(1); expect(f.activated[0]!.revision).toBe(f.next);
  expect(g.installs[0]!.slice(1)).toEqual(["plugin", "install", "test/broadcast", "--ref", f.next, "--yes"]);
  expect(await git(f.root, "show-ref")).toBe(refs); expect(f.order).not.toContain("link");
});
test("unreleased commits are never offered or installed", async () => {
  const f = await fixture(), g = github(f); g.setRelease(null);
  const u = new Updater(g.options);
  expect(await u.check()).toMatchObject({ available: false, latest_revision: null, latest_version: null, latest_tag: null, blocked_reason: "尚无正式 Release", phase: "idle" });
  await u.install(); await u.wait(); expect(g.nativeUpdates()).toBe(0); expect(f.activated).toEqual([]);
});
test("a branch beyond a release is not the update target", async () => {
  const f = await fixture(), g = github(f); await release(f.dev, "0.4.0"); await git(f.dev, "push", "-q");
  expect(await new Updater(g.options).check()).toMatchObject({ latest_revision: f.next, latest_version: "0.3.1" });
});
for (const version of ["0.3.1", "0.4.0"]) test(`published release does not replace same or newer runtime version ${version}`, async () => {
  const f = await fixture(), g = github(f), u = new Updater({ ...g.options, current: { ...f.current, version } });
  expect((await u.check()).available).toBe(false);
  await u.install(); await u.wait(); expect(g.nativeUpdates()).toBe(0);
});
for (const patch of [{ draft: true }, { prerelease: true }, { published_at: null }, { tag_name: "v0.4.0-rc.1" }]) test(`invalid stable release is refused: ${JSON.stringify(patch)}`, async () => {
  const f = await fixture(), g = github(f); g.setRelease({ tag_name: "v0.3.1", draft: false, prerelease: false, published_at: "2026-10-30T00:00:00Z", ...patch });
  const u = new Updater(g.options); expect(await u.check()).toMatchObject({ phase: "error", available: false });
  await u.install(); await u.wait(); expect(g.nativeUpdates()).toBe(0);
});
test("release tag must match package and plugin versions", async () => {
  const f = await fixture(); await git(f.dev, "tag", "v0.4.0"); await git(f.dev, "push", "-q", "--tags");
  const g = github(f); g.setRelease({ tag_name: "v0.4.0", draft: false, prerelease: false, published_at: "2026-10-30T00:00:00Z" });
  const u = new Updater(g.options); expect((await u.check()).error).toContain("版本不一致");
  await u.install(); await u.wait(); expect(g.nativeUpdates()).toBe(0);
});
test("installation rejects a different actual commit even if it descends from the release", async () => {
  const f = await fixture(), g = github(f), advanced = await release(f.dev, "0.4.0"); await git(f.dev, "push", "-q");
  const u = new Updater({ ...g.options, plugins: async () => (await g.options.plugins!()).map(p => g.installed() ? { ...p, source: { ...p.source, resolved_commit: advanced } } : p) });
  await u.install(); await u.wait(); expect(u.status.error).toContain("提交不一致"); expect(f.activated).toEqual([]);
});
test("a failed release check clears stale update availability", async () => {
  const f = await fixture(), g = github(f); let fail = false;
  const u = new Updater({ ...g.options, fetch: (url, init) => fail ? Promise.resolve(new Response(null, { status: 503 })) : g.options.fetch!(url, init) });
  expect((await u.check()).available).toBe(true); fail = true;
  expect(await u.check()).toMatchObject({ phase: "error", available: false, latest_revision: null });
});
test("Herdr's shallow installed checkout still permits a newer release", async () => {
  const f = await fixture(); rmSync(f.root, { recursive: true });
  await git(dir, "init", "-q", f.root);
  await git(f.root, "fetch", "--depth", "1", f.origin, f.first);
  await git(f.root, "checkout", "--detach", "FETCH_HEAD");
  expect(await git(f.root, "rev-parse", "--is-shallow-repository")).toBe("true");
  expect(await new Updater(github(f).options).check()).toMatchObject({ available: true, blocked_reason: null });
});
test("launcher-owned legacy branch status is cleared when describing the GitHub source", async () => {
  const { UpdateJournal } = await import("../src/service/update-state.ts");
  const f = await fixture(), g = github(f), journal = new UpdateJournal(f.stateDir);
  journal.commit({ kind: "github", available: true, latest_revision: f.next, latest_version: "0.3.1", checked_at: 123 });
  const u = new Updater({ ...g.options, persist: async (patch, guard) => journal.commit(patch, guard) });
  u.status = journal.status; // Managers receive the launcher's persisted status on activation.
  expect(await u.describe()).toMatchObject({ available: false, latest_revision: null, latest_tag: null, checked_at: null });
  expect(journal.status.available).toBe(false);
});
test("GitHub records newer than the runtime remain retryable after validation failure", async () => {
  const f = await fixture(), g = github(f); let fail = true;
  const options = { ...g.options, validate: async () => { if (fail) throw new Error("candidate validation failed"); } };
  const first = new Updater(options); await first.install(); await first.wait();
  expect(first.status.outcome).toBe("failed"); expect(first.status.current_revision).toBe(f.first); expect(g.installed()).toBe(true);
  fail = false; const retry = new Updater(options); expect((await retry.check()).available).toBe(true);
  await retry.install(); await retry.wait(); expect(retry.status.error).toBeNull(); expect(f.activated[0]!.revision).toBe(f.next); expect(g.nativeUpdates()).toBe(2);
});
test("later checks keep a failed operation visible after reconnect", async () => {
  const f = await fixture(), u = new Updater({ ...f.options, validate: async () => { throw new Error("saved failure"); } });
  await u.applyLocal(); await u.wait(); await u.check(); expect(u.status).toMatchObject({ phase: "error", outcome: "failed", error: "saved failure" });
  expect(new Updater(f.options).status.error).toBe("saved failure");
});
test("finds both installed and linked plugin identities", () => {
  const plugin: InstalledPlugin = { plugin_id: "qivyn.herdr-broadcast", plugin_root: "/tmp/plugin" };
  expect(findSelf([plugin], "herdr-broadcast")).toBe(plugin);
});
for (const failure of ["dependencies", "typecheck", "resources"]) test(`stage validator rejects ${failure} before activation`, async () => {
  const steps: string[] = [], calls: string[][] = [];
  const run: import("../src/service/commands.ts").Run = async argv => {
    calls.push(argv);
    if ((failure === "dependencies" && argv.includes("install")) || (failure === "typecheck" && argv.includes("typecheck"))) return { code: 1, stdout: "", stderr: failure };
    return { code: 0, stdout: argv.includes("assets") ? "[]" : "", stderr: "" };
  };
  await expect(validateStage(dir, run, s => steps.push(s))).rejects.toThrow();
  expect(calls[0]).toEqual([process.execPath, "install", "--frozen-lockfile"]); expect(steps.at(-1)).toBe(failure);
});
test("validation refreshes generated browser assets from staged dependencies", async () => {
  for (const f of ["package.json", "bun.lock", "tsconfig.json", "herdr-plugin.toml", "src/web/page.html", "src/web/page.js", "src/web/terminal.js", "src/web/icon.svg", "src/web/vendor/terminal.js"]) {
    mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), "old");
  }
  const asset = join(dir, "dependency.js"); writeFileSync(asset, "new dependency");
  await validateStage(dir, async argv => {
    if (argv.includes("assets")) { expect(existsSync(join(dir, "src/web/vendor/terminal.js"))).toBe(false); return { code: 0, stdout: JSON.stringify([{ name: "terminal.js", path: asset }]), stderr: "" }; }
    return { code: 0, stdout: "", stderr: "" };
  });
  expect(readFileSync(join(dir, "src/web/vendor/terminal.js"), "utf8")).toBe("new dependency");
});

function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

test("restart interrupting a release check preserves the previous known update", async () => {
  const f = await fixture(), g = github(f), entered = gate(); let hold = false;
  const u = new Updater({ ...g.options, fetch: async (url, init) => {
    if (hold) {
      entered.resolve();
      await new Promise<void>(resolve => init!.signal!.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("cancelled request");
    }
    return g.options.fetch!(url, init);
  } });
  expect((await u.check()).available).toBe(true); hold = true;
  const checking = u.check(); await entered.promise;
  await u.restart(); await checking; await u.wait();
  expect(u.status).toMatchObject({ available: true, latest_revision: f.next, latest_tag: "v0.3.1" });
  expect(f.activated).toEqual([f.current]);
});

test("cancel waits for plugin discovery, ignores its late result and leaves restart usable", async () => {
  const f = await fixture(), entered = gate(), finish = gate(); let signal: AbortSignal | undefined;
  const u = new Updater({ ...f.options, plugins: async s => { signal = s; entered.resolve(); await finish.promise; return f.options.plugins!(); } });
  const checking = u.check(); await entered.promise;
  expect(u.preparing).toBe(false); expect(u.lifecycle).toBe("checking");
  let cancelled = false; const cancellation = u.cancel().then(() => { cancelled = true; });
  await Bun.sleep(10); expect(signal?.aborted).toBe(true); expect(cancelled).toBe(false);
  finish.resolve(); await Promise.all([checking, cancellation]);
  expect(u.status.kind).toBe("unmanaged"); expect(u.status.phase).toBe("idle");
  await u.restart(); await u.wait(); expect(f.activated).toEqual([f.current]); expect(u.status.error).toBeNull();
});

test("cancel includes background descriptions and resumed timers still run", async () => {
  const f = await fixture(), entered = gate(), finish = gate(); let calls = 0;
  const u = new Updater({ ...f.options, timing: { firstCheckMs: 10, everyMs: 20 }, plugins: async () => {
    calls++; if (calls === 1) { entered.resolve(); await finish.promise; } return f.options.plugins!();
  } });
  u.start(); await entered.promise;
  let done = false; const cancellation = u.cancel().then(() => { done = true; });
  await Bun.sleep(10); expect(done).toBe(false); finish.resolve(); await cancellation;
  expect(u.status.kind).toBe("unmanaged");
  u.start(); try { await until(() => calls >= 3); expect(u.status.kind).toBe("local"); } finally { await u.cancel(); }
});

for (const action of ["restart", "install"] as const) test(`${action} interrupts a check and duplicate requests share the accepted operation`, async () => {
  const f = await fixture(), entered = gate(); let calls = 0;
  const u = new Updater({ ...f.options, plugins: async signal => {
    if (++calls === 1) { entered.resolve(); await new Promise<void>(r => signal!.addEventListener("abort", () => r(), { once: true })); }
    return f.options.plugins!();
  } });
  const checking = u.check(); await entered.promise;
  const [first, second] = await Promise.all([u[action](), u[action]()]);
  await checking; await u.wait(); expect(first.operation_id).toBeTruthy(); expect(second.operation_id).toBe(first.operation_id);
  expect(u.status.error ?? "").not.toContain("正在检查");
  expect(f.activated.length).toBe(action === "restart" ? 1 : 0); // Local install still rejects by policy, after cancelling the check.
});

test("cancellation during operation acceptance waits for persistence and never activates", async () => {
  const { UpdateJournal } = await import("../src/service/update-state.ts");
  const f = await fixture(), journal = new UpdateJournal(f.stateDir), entered = gate(), finish = gate();
  const u = new Updater({ ...f.options, persist: async (patch, expected) => {
    if (patch.phase === "updating") { entered.resolve(); await finish.promise; }
    return journal.commit(patch, expected);
  } });
  const starting = u.restart(); await entered.promise;
  let done = false; const cancellation = u.cancel().then(() => { done = true; });
  await Bun.sleep(10); expect(done).toBe(false); finish.resolve();
  await Promise.allSettled([starting, cancellation]); expect(done).toBe(true); expect(f.activated).toEqual([]);
  expect(u.status.outcome).toBe("failed");
  await u.restart(); await u.wait(); expect(f.activated).toEqual([f.current]);
});

test("a failed drain leaves the updater available for another restart", async () => {
  const f = await fixture(); let attempts = 0;
  const u = new Updater({ ...f.options, activate: async next => { if (++attempts === 1) throw new Error("drain timed out"); f.activated.push(next); } });
  await u.restart(); await u.wait(); expect(u.status.outcome).toBe("failed");
  await u.cancel(); await u.restart(); await u.wait(); expect(f.activated).toEqual([f.current]); expect(u.status.error).toBeNull();
});

test("restart cancels a background description without querying unavailable source again", async () => {
  const f = await fixture(), entered = gate(); let queries = 0;
  const u = new Updater({ ...f.options, plugins: async signal => {
    queries++; entered.resolve();
    await new Promise<void>(r => signal!.addEventListener("abort", () => r(), { once: true }));
    throw new Error("source unavailable");
  } });
  u.start(); await entered.promise;
  try {
    await u.restart(); await u.wait();
    expect(queries).toBe(1); expect(f.activated).toEqual([f.current]); expect(u.status.error).toBeNull();
  } finally { await u.cancel(); }
});
