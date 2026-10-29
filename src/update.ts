/** Prepare immutable releases while the current service keeps working. Only its manager switches them. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { herdrBin, herdrJson } from "./herdr.ts";
import { checked, runCommand, type Run } from "./service/commands.ts";
import { readJSON, type Release } from "./service/state.ts";
import { describeRelease, snapshotSource, sourceHash, validateStage } from "./service/releases.ts";
import { emptyStatus, UpdateJournal, updateGuard, type UpdateGuard, type UpdateStatus } from "./service/update-state.ts";
export { emptyStatus, type UpdateStatus, type UpdatePhase } from "./service/update-state.ts";
export { runCommand, type Run, type Ran } from "./service/commands.ts";
export interface InstalledPlugin {
  plugin_id: string; plugin_root: string; version?: string;
  source?: { kind?: string; owner?: string; repo?: string; requested_ref?: string | null; subdir?: string | null; resolved_commit?: string };
  events?: unknown[]; actions?: { id?: string; action_id?: string }[];
}
export async function installedPlugins(signal?: AbortSignal): Promise<InstalledPlugin[]> {
  const list = await herdrJson<{ result?: { plugins?: InstalledPlugin[] } }>(["plugin", "list", "--json"], { timeoutMs: 10_000, signal });
  return list.result?.plugins ?? [];
}
export function findSelf(plugins: InstalledPlugin[], id = process.env.HERDR_PLUGIN_ID || "herdr-broadcast") {
  return plugins.find(p => p.plugin_id === id) ?? plugins.find(p => p.plugin_id === "herdr-broadcast" || p.plugin_id.endsWith(".herdr-broadcast")) ?? null;
}
export interface UpdateController {
  status: UpdateStatus;
  start(): void; stop(): void;
  describe(): Promise<UpdateStatus>; check(): Promise<UpdateStatus>; install(): Promise<UpdateStatus>; applyLocal(): Promise<UpdateStatus>; restart(): Promise<UpdateStatus>;
}
export interface UpdaterOptions {
  publish: (status: UpdateStatus) => void;
  stateDir?: string; current?: Release; sourceRoot?: string;
  activate?: (release: Release, status: UpdateStatus) => Promise<void>;
  plugins?: (signal?: AbortSignal) => Promise<InstalledPlugin[]>; run?: Run;
  persist?: (patch: Partial<UpdateStatus>, expected: UpdateGuard) => Promise<UpdateStatus>;
  validate?: (directory: string, run: Run, step: (s: string) => Promise<void>) => Promise<void>;
  timing?: { firstCheckMs?: number; everyMs?: number };
}
export class Updater implements UpdateController {
  status: UpdateStatus;
  private activity: "idle" | "checking" | "preparing" | "switching" = "idle";
  private cancelling: Promise<void> | null = null;
  private beginning: Promise<UpdateStatus> | null = null;
  private persist: NonNullable<UpdaterOptions["persist"]>;
  private job: Promise<void> = Promise.resolve();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private run: Run;
  private cache: string;
  private target: string | null = null;
  private origin = "";
  private sourceRevision: string | null = null;
  private checkedSourceHash = "";
  private describing: Promise<UpdateStatus> | null = null;
  private epoch = 0;
  private cancellation = new AbortController();
  constructor(private options: UpdaterOptions) {
    this.run = (argv, opts) => (options.run ?? runCommand)(argv, { ...opts, signal: this.cancellation.signal });
    this.cache = join(options.stateDir ?? ".", "update-cache.git");
    const saved = options.stateDir ? readJSON<UpdateStatus>(join(options.stateDir, "update.json")) : null;
    this.status = { ...emptyStatus(), ...saved, current_revision: options.current?.revision ?? null, current_version: options.current?.version ?? null };
    const journal = options.stateDir && !options.persist ? new UpdateJournal(options.stateDir) : null;
    if (journal) this.status = journal.commit({ current_revision: this.status.current_revision, current_version: this.status.current_version });
    this.persist = options.persist ?? (async (patch, expected) => journal ? journal.commit(patch, expected) : { ...this.status, ...patch });
    if (!options.activate) this.status.blocked_reason = "请通过 Herdr 的 Broadcast 网页动作启动受管服务";
  }
  private async patch(p: Partial<UpdateStatus>) {
    this.status = await this.persist(p, updateGuard(this.status));
    this.options.publish({ ...this.status });
  }
  private get busy() { return this.activity !== "idle"; }
  start(describeImmediately = true) {
    if (this.timers.length || this.cancelling) return;
    if (describeImmediately) void this.describe().catch(() => {});
    const checkInstalled = async () => { const signal = this.cancellation.signal; await this.describe(); if (!signal.aborted && this.status.kind === "github") await this.check(); };
    this.timers.push(setTimeout(() => void checkInstalled().catch(() => {}), this.options.timing?.firstCheckMs ?? 15_000));
    this.timers.push(setInterval(() => void checkInstalled().catch(() => {}), this.options.timing?.everyMs ?? 6 * 60 * 60_000));
  }
  stop() { this.timers.forEach(clearTimeout); this.timers = []; }
  cancel(): Promise<void> {
    this.epoch++;
    const beginning = this.beginning;
    if (!this.cancelling) {
      this.stop(); this.cancellation.abort();
      this.cancelling = (async () => {
        await Promise.allSettled([this.job, this.describing]);
        // Old checks and subprocesses must finish before any new operation gets a fresh signal.
        this.cancellation = new AbortController();
      })().finally(() => { this.cancelling = null; });
    }
    return this.cancelling.then(async () => {
      await beginning?.catch(() => {});
      await this.job.catch(() => {});
    });
  }
  get lifecycle() { return this.activity; }
  get preparing() { return this.activity === "preparing"; }
  async wait() { await this.beginning; await this.job; await this.describing; }
  private async self(): Promise<InstalledPlugin> {
    const signal = this.cancellation.signal;
    if (signal.aborted) throw new Error("更新已取消");
    const self = findSelf(await (this.options.plugins ?? installedPlugins)(signal));
    if (signal.aborted) throw new Error("更新已取消");
    if (!self) throw new Error("Herdr 的插件列表里没有找到 Broadcast");
    return self;
  }
  private async describePlugin(self: InstalledPlugin) {
    const github = self.source?.kind === "github";
    await this.patch({ kind: github ? "github" : self.source?.kind === "local" ? "local" : "unmanaged",
      root: self.plugin_root, source_revision: github ? self.source?.resolved_commit ?? null : null, source_version: github ? self.version ?? null : null,
      ...(!github ? { available: false, latest_revision: null, latest_version: null, blocked_reason: null } : {}) });
    return this.status;
  }
  async describe(): Promise<UpdateStatus> {
    if (this.busy || this.cancelling) return this.status;
    if (this.describing) return this.describing;
    this.describing = (async () => {
      const self = await this.self();
      if (this.busy || this.cancelling) return this.status;
      return this.describePlugin(self);
    })().finally(() => { this.describing = null; });
    return this.describing;
  }
  private async discover(): Promise<InstalledPlugin> {
    const self = await this.self(), root = self.plugin_root;
    await this.describePlugin(self);
    if (self.source?.kind !== "github") return self;
    this.sourceRevision = self.source.resolved_commit ?? null;
    this.checkedSourceHash = sourceHash(root);
    await this.patch({ blocked_reason: null });
    if (!this.sourceRevision) throw new Error("Herdr 没有记录安装提交");
    const dirty = await checked(this.run, ["git", "status", "--porcelain", "--untracked-files=all"], root);
    if (!self.source.owner || !self.source.repo) throw new Error("Herdr 没有记录 GitHub 来源");
    this.origin = `https://github.com/${self.source.owner}/${self.source.repo}.git`;
    const requested = self.source.requested_ref;
    let ref = requested || "HEAD";
    if (requested && !requested.startsWith("refs/heads/")) {
      const branch = await checked(this.run, ["git", "ls-remote", "--heads", this.origin, requested]);
      if (!branch) { await this.patch({ blocked_reason: "安装固定在 tag 或 commit；请通过 Herdr 显式更换版本", available: false }); return self; }
      ref = `refs/heads/${requested}`;
    }
    mkdirSync(this.options.stateDir!, { recursive: true });
    if (!existsSync(this.cache)) await checked(this.run, ["git", "init", "--bare", this.cache]);
    await checked(this.run, ["git", "fetch", "--no-tags", this.origin, ref], this.cache, 600_000);
    this.target = await checked(this.run, ["git", "rev-parse", "FETCH_HEAD"], this.cache);
    await checked(this.run, ["git", "fetch", "--no-tags", root, "HEAD"], this.cache, 60_000);
    const current = this.options.current?.revision ?? this.sourceRevision;
    const ancestor = async (a: string, b: string) => (await this.run(["git", "merge-base", "--is-ancestor", a, b], { cwd: this.cache, timeoutMs: 30_000 })).code === 0;
    let available = this.target !== current;
    let blocked: string | null = dirty ? "插件仓库有未提交的改动（包括未跟踪文件）：请先提交或移走" : null;
    if (available && await ancestor(this.target, current!)) available = false;
    else if (available && (!await ancestor(current!, this.target) || !await ancestor(this.sourceRevision, this.target))) blocked ??= "源码或运行版本与上游分叉，拒绝自动降级或覆盖";
    const manifest = await checked(this.run, ["git", "show", `${this.target}:${self.source?.subdir ? self.source.subdir + "/" : ""}herdr-plugin.toml`], this.cache).catch(() => "");
    if (this.cancellation.signal.aborted) throw new Error("更新已取消");
    if (/\[\[events\]\]|id\s*=\s*"worker"/.test(manifest)) blocked ??= "候选版本仍含旧 worker 或事件执行入口，不能自动切换";
    await this.patch({ latest_revision: this.target, latest_version: /version\s*=\s*"([^"]+)"/.exec(manifest)?.[1] ?? null, available, blocked_reason: blocked, checked_at: Date.now() });
    return self;
  }
  async check() {
    if (this.activity === "checking") { await this.job; return this.status; }
    if (this.busy || this.cancelling || !this.options.activate) return this.status;
    const failure = this.status.outcome === "failed" ? this.status.error : null;
    this.activity = "checking";
    this.job = (async () => {
      try {
        await this.describing;
        if (this.cancellation.signal.aborted) return;
        await this.patch({ phase: "checking", error: failure });
        await this.discover();
        await this.patch({ phase: failure ? "error" : "idle", error: failure });
      }
      catch (e) {
        await this.patch(this.cancellation.signal.aborted
          ? { phase: failure ? "error" : "idle", error: failure }
          : { phase: "error", error: String((e as Error).message), checked_at: Date.now() });
      }
    })().finally(() => { this.activity = "idle"; });
    await this.job;
    return this.status;
  }
  async install() { return this.begin("install"); }
  async applyLocal() { return this.begin("apply"); }
  async restart() { return this.begin("restart"); }
  private begin(action: "install" | "apply" | "restart"): Promise<UpdateStatus> {
    if (this.beginning) return this.beginning;
    const scheduled = this.timers.length > 0;
    // Cancel a read-only check before reserving this operation, so cancellation never waits on itself.
    const interrupted = this.activity === "checking" || (!this.busy && this.describing) ? this.cancel() : this.cancelling;
    const epoch = this.epoch;
    this.beginning = (async () => {
      await interrupted;
      if (epoch !== this.epoch) throw new Error("更新已取消");
      if (scheduled) this.start(false);
      return this.beginOperation(action, epoch);
    })().finally(() => { this.beginning = null; });
    return this.beginning;
  }
  private async beginOperation(action: "install" | "apply" | "restart", epoch: number): Promise<UpdateStatus> {
    if (this.busy) return this.status;
    if (!this.options.activate || !this.options.current || !this.options.stateDir) throw new Error("当前服务没有更新管理器");
    this.activity = "preparing";
    try {
      await this.describing;
      if (epoch !== this.epoch) throw new Error("更新已取消");
      await this.patch({ phase: "updating", action, step: action === "install" ? "download" : "resources", operation_id: randomUUID(), outcome: "running", error: null });
    } catch (e) { this.activity = "idle"; throw e; }
    this.job = (async () => {
      if (epoch !== this.epoch) throw new Error("更新已取消");
      await this.prepare(action);
    })().catch(async e => {
      await this.patch({ phase: "error", step: null, outcome: "failed", available: (action === "install" && this.status.kind === "github") || this.status.available, error: String(e.message ?? e) });
      this.activity = "idle";
    }).finally(() => { if (this.activity !== "switching") this.activity = "idle"; });
    return { ...this.status };
  }
  private async prepare(action: "install" | "apply" | "restart"): Promise<void> {
    let stage: string | undefined;
    try {
      let next: Release;
      if (action === "restart") {
        // Restart never reads, installs or applies the mutable source checkout.
        next = this.options.current!;
      } else if (action === "apply") {
        const self = await this.self();
        await this.describePlugin(self);
        if (self.source?.kind === "github") throw new Error("GitHub 安装请使用「更新并重启」，不能应用本地代码");
        next = await snapshotSource(self.plugin_root, this.options.stateDir!, this.run); stage = next.directory;
        await (this.options.validate ?? validateStage)(stage, this.run, step => this.patch({ step }));
        next = await describeRelease(stage, self.plugin_root, next.revision, next.sourceHash, next.sourceRevision, this.run);
        if (sourceHash(self.plugin_root) !== next.sourceHash) throw new Error("验证期间本地源码发生变化，请重试");
        const latest = await this.self();
        if (latest.source?.kind === "github" || latest.plugin_root !== self.plugin_root) throw new Error("准备期间插件来源发生变化，请重试");
        // Re-link only after validation; Herdr's actions/hooks match the source being applied.
        await this.patch({ step: "register" });
        await checked(this.run, [herdrBin(), "plugin", "link", self.plugin_root], undefined, 30_000);
        if (sourceHash(self.plugin_root) !== next.sourceHash) throw new Error("重新链接期间本地源码发生变化，请重试");
      } else {
        let self = await this.discover();
        if (self.source?.kind !== "github") throw new Error("本地链接请在源码目录手动运行 bun src/main.ts web-apply");
        if (this.status.blocked_reason) throw new Error(this.status.blocked_reason);
        if (!this.status.available) { await this.patch({ phase: "idle", step: null, outcome: "succeeded" }); return; }
        if (sourceHash(self.plugin_root) !== this.checkedSourceHash) throw new Error("准备期间源码发生变化，请重新检查");
        {
          const requested = self.source.requested_ref;
          const owner = self.source.owner, repo = self.source.repo;
          await checked(this.run, [herdrBin(), "plugin", "update", self.plugin_id, "--yes"], undefined, 600_000);
          self = await this.self();
          const actual = self.source?.resolved_commit;
          if (!actual || actual === this.options.current!.revision) throw new Error("Herdr 没有安装候选版本，请检查固定 ref");
          if (self.source?.kind !== "github" || self.source.requested_ref !== requested || self.source.owner !== owner || self.source.repo !== repo) throw new Error("准备期间插件安装来源发生变化");
          // The branch can advance while Herdr installs. Re-fetch its current target and verify
          // the commit Herdr actually registered, instead of trusting the earlier check.
          const candidate = this.target!;
          await this.discover();
          if (this.status.blocked_reason || (await this.run(["git", "merge-base", "--is-ancestor", candidate, actual], { cwd: this.cache, timeoutMs: 30_000 })).code !== 0
            || (await this.run(["git", "merge-base", "--is-ancestor", actual, this.target!], { cwd: this.cache, timeoutMs: 30_000 })).code !== 0) throw new Error("Herdr 登记的版本与目标分支不一致");
          next = await snapshotSource(self.plugin_root, this.options.stateDir!, this.run); stage = next.directory;
          next.revision = actual;
        }
        await (this.options.validate ?? validateStage)(stage!, this.run, step => this.patch({ step }));
        if (sourceHash(self.plugin_root) !== next.sourceHash) throw new Error("准备期间源码发生变化，请重新检查");
        const dirty = await checked(this.run, ["git", "status", "--porcelain", "--untracked-files=all"], self.plugin_root);
        if (dirty) throw new Error("准备期间出现未提交的改动，更新已取消");
        if (await checked(this.run, ["git", "rev-parse", "HEAD"], self.plugin_root) !== next.sourceRevision) throw new Error("准备期间源码提交发生变化");
        next = await describeRelease(stage!, self.plugin_root, next.revision, next.sourceHash, next.sourceRevision, this.run);
      }
      if (this.cancellation.signal.aborted) throw new Error("更新已取消");
      await this.patch({ phase: "restarting", step: "drain" });
      if (this.cancellation.signal.aborted) throw new Error("更新已取消");
      this.activity = "switching";
      await this.options.activate!(next, { ...this.status });
      stage = undefined; // manager owns the candidate until commit or rollback
    } finally { if (stage) rmSync(stage, { recursive: true, force: true }); }
  }
}
