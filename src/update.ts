/** Prepare immutable releases while the current service keeps working. Only its manager switches them. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { herdrBin, herdrJson } from "./herdr.ts";
import { latestRelease, type ReleaseFetch } from "./service/github-release.ts";
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
  fetch?: ReleaseFetch;
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
    // Saved branch-based results must not advertise an unpublished commit after migration.
    if (saved?.kind === "github" && saved.latest_tag === undefined) Object.assign(this.status, {
      available: false, latest_revision: null, latest_version: null, latest_tag: null, checked_at: null, blocked_reason: null,
    });
    const journal = options.stateDir && !options.persist ? new UpdateJournal(options.stateDir) : null;
    if (journal) this.status = journal.commit(this.status);
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
      ...(github && this.status.latest_tag === undefined ? { available: false, latest_revision: null, latest_version: null, latest_tag: null, checked_at: null, blocked_reason: null } : {}),
      ...(!github ? { available: false, latest_revision: null, latest_version: null, latest_tag: null, blocked_reason: null } : {}) });
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
    this.target = null;
    await this.patch({ available: false, latest_revision: null, latest_version: null, latest_tag: null });
    const release = await latestRelease(self.source.owner, self.source.repo, this.cancellation.signal, this.options.fetch);
    if (!release) {
      await this.patch({ blocked_reason: "尚无正式 Release", checked_at: Date.now() });
      return self;
    }
    mkdirSync(this.options.stateDir!, { recursive: true });
    if (!existsSync(this.cache)) await checked(this.run, ["git", "init", "--bare", this.cache]);
    await checked(this.run, ["git", "fetch", "--no-tags", this.origin, `refs/tags/${release.tag}`], this.cache, 600_000);
    this.target = await checked(this.run, ["git", "rev-parse", "FETCH_HEAD^{commit}"], this.cache);
    const head = await checked(this.run, ["git", "rev-parse", "HEAD"], root);
    const current = this.options.current?.revision ?? this.sourceRevision;
    const version = this.options.current?.version;
    let blocked: string | null = dirty ? "插件仓库有未提交的改动（包括未跟踪文件）：请先提交或移走" : null;
    if (head !== this.sourceRevision) blocked ??= "源码 HEAD 与 Herdr 登记的安装提交不一致，可能已分叉；拒绝覆盖本地提交";
    // Fetch missing known commits from the origin, never import shallow boundaries from Herdr's checkout.
    for (const revision of new Set([current, this.sourceRevision])) {
      if ((await this.run(["git", "cat-file", "-e", `${revision}^{commit}`], { cwd: this.cache, timeoutMs: 30_000 })).code !== 0) {
        const result = await this.run(["git", "fetch", "--no-tags", this.origin, revision!], { cwd: this.cache, timeoutMs: 60_000 });
        if (result.code !== 0) blocked ??= "源码或运行版本与正式 Release 分叉，无法验证提交关系";
      }
    }
    const ancestor = async (a: string, b: string) => {
      const result = await this.run(["git", "merge-base", "--is-ancestor", a, b], { cwd: this.cache, timeoutMs: 30_000 });
      if (result.code > 1) throw new Error("无法验证 Release 提交关系");
      return result.code === 0;
    };
    let available = false;
    if (!version || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) blocked ??= "无法确定运行版本，不能自动更新";
    else available = this.target !== current && Bun.semver.order(release.version, version) > 0;
    if (available && !blocked) {
      if (await ancestor(this.target, current!)) available = false;
      else if (!await ancestor(current!, this.target) || !await ancestor(this.sourceRevision, this.target)) blocked = "源码或运行版本与正式 Release 分叉，拒绝自动降级或覆盖";
    }
    const prefix = self.source.subdir ? self.source.subdir + "/" : "";
    const manifest = Bun.TOML.parse(await checked(this.run, ["git", "show", `${this.target}:${prefix}herdr-plugin.toml`], this.cache)) as { id?: string; version?: string; events?: unknown[]; actions?: { id?: string }[] };
    const pkg = JSON.parse(await checked(this.run, ["git", "show", `${this.target}:${prefix}package.json`], this.cache));
    if (manifest.version !== release.version || pkg.version !== release.version) throw new Error("Release tag、插件清单与 package.json 版本不一致");
    if (!manifest.id || ![manifest.id, `${self.source.owner}.${manifest.id}`].includes(self.plugin_id)) throw new Error("Release 插件身份与当前安装不一致");
    if (this.cancellation.signal.aborted) throw new Error("更新已取消");
    if (manifest.events?.length || manifest.actions?.some(a => a.id === "worker")) blocked ??= "候选版本仍含旧 worker 或事件执行入口，不能自动切换";
    await this.patch({ latest_revision: this.target, latest_version: release.version, latest_tag: release.tag, available, blocked_reason: blocked, checked_at: Date.now() });
    return self;
  }
  async check() {
    if (this.activity === "checking") { await this.job; return this.status; }
    if (this.busy || this.cancelling || !this.options.activate) return this.status;
    const failure = this.status.outcome === "failed" ? this.status.error : null;
    const previous = { available: this.status.available, latest_revision: this.status.latest_revision,
      latest_version: this.status.latest_version, latest_tag: this.status.latest_tag,
      blocked_reason: this.status.blocked_reason, checked_at: this.status.checked_at };
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
          ? { ...previous, phase: failure ? "error" : "idle", error: failure }
          : { phase: "error", available: false, latest_revision: null, latest_version: null, latest_tag: null, error: String((e as Error).message), checked_at: Date.now() });
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
      await this.patch({ phase: "error", step: null, outcome: "failed", error: String(e.message ?? e) });
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
          const source = self.source, candidate = this.target!, tag = this.status.latest_tag!;
          // Install the resolved commit: a moved tag or a newer release cannot change this operation's target.
          const repository = `${source.owner}/${source.repo}${source.subdir ? "/" + source.subdir : ""}`;
          const latest = await this.self();
          if (latest.plugin_id !== self.plugin_id || latest.plugin_root !== self.plugin_root || JSON.stringify(latest.source) !== JSON.stringify(source)
            || await checked(this.run, ["git", "rev-parse", "HEAD"], self.plugin_root) !== this.sourceRevision
            || sourceHash(self.plugin_root) !== this.checkedSourceHash
            || await checked(this.run, ["git", "status", "--porcelain", "--untracked-files=all"], self.plugin_root)) throw new Error("准备期间插件源码或安装来源发生变化");
          await checked(this.run, [herdrBin(), "plugin", "install", repository, "--ref", candidate, "--yes"], undefined, 600_000);
          self = await this.self();
          const actual = self.source?.resolved_commit;
          if (actual !== candidate) throw new Error("Herdr 安装的提交与正式 Release 提交不一致");
          if (self.plugin_id !== latest.plugin_id || self.source?.kind !== "github" || self.source.requested_ref !== candidate
            || self.source.owner !== source.owner || self.source.repo !== source.repo || (self.source.subdir ?? null) !== (source.subdir ?? null)) throw new Error("准备期间插件安装来源发生变化");
          if (await checked(this.run, ["git", "rev-parse", "HEAD"], self.plugin_root) !== candidate
            || await checked(this.run, ["git", "status", "--porcelain", "--untracked-files=all"], self.plugin_root)) throw new Error("已安装源码与正式 Release 提交不一致");
          await this.describePlugin(self);
          await this.patch({ latest_revision: candidate, latest_tag: tag });
          next = await snapshotSource(self.plugin_root, this.options.stateDir!, this.run); stage = next.directory;
          if (next.sourceRevision !== candidate || next.version !== this.status.latest_version) throw new Error("运行快照与正式 Release 不一致");
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
