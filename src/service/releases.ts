import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { checked, runCommand, type Run } from "./commands.ts";
import { PROTOCOL, SCHEMA, readJSON, runtimeState, type Release } from "./state.ts";
import { pidAlive } from "../db.ts";

/** Keep confirmed rollback versions and directories still referenced by a live process. */
export function pruneReleases(dir: string): void {
  const state = runtimeState(dir);
  const keep = new Set([state.current, state.previous, state.transaction?.previous, state.transaction?.next].filter(Boolean).map(r => r!.directory));
  const root = join(dir, "releases");
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, e.name);
    if (!e.isDirectory() || !e.name.startsWith("release-") || keep.has(path)) continue;
    const leases = join(path, "leases");
    if (existsSync(leases) && readdirSync(leases).some(name => { const lease = readJSON<{ pid: number }>(join(leases, name)); return lease && pidAlive(lease.pid); })) continue;
    rmSync(path, { recursive: true, force: true });
  }
}

export function sourceHash(root: string, includeVendor = true): string {
  const hash = createHash("sha256");
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, e.name);
      if (!includeVendor && relative(root, path) === "src/web/vendor") continue;
      if (e.isDirectory()) walk(path);
      else if (e.isFile()) hash.update(relative(root, path)).update(readFileSync(path));
    }
  };
  walk(join(root, "src"));
  for (const f of ["package.json", "bun.lock", "herdr-plugin.toml", "tsconfig.json"]) if (existsSync(join(root, f))) hash.update(f).update(readFileSync(join(root, f)));
  return hash.digest("hex");
}
export function releaseDirectory(dir: string): string { mkdirSync(join(dir, "releases"), { recursive: true }); return mkdtempSync(join(dir, "releases", "release-")); }
export async function snapshotSource(root: string, dir: string, run: Run = runCommand): Promise<Release> {
  const stage = releaseDirectory(dir);
  try {
    const originalHash = sourceHash(root);
    for (const f of ["src", "test", "scripts", "package.json", "bun.lock", "herdr-plugin.toml", "tsconfig.json"]) {
      if (existsSync(join(root, f))) cpSync(join(root, f), join(stage, f), { recursive: true });
    }
    // Source snapshots (including local edits) carry installed browser assets, not symlinks to a mutable checkout.
    const assets = JSON.parse(await checked(run, [process.execPath, join(root, "src/service/entry.ts"), "assets"], root)) as { name: string; path: string }[];
    mkdirSync(join(stage, "src/web/vendor"), { recursive: true });
    for (const a of assets) cpSync(a.path, join(stage, "src/web/vendor", a.name));
    const revision = await checked(run, ["git", "rev-parse", "HEAD"], root).catch(() => null);
    if (sourceHash(root) !== originalHash) throw new Error("制作快照期间源码发生变化，请重试");
    return await describeRelease(stage, root, revision, originalHash, revision, run);
  } catch (e) { rmSync(stage, { recursive: true, force: true }); throw e; }
}
export async function describeRelease(stage: string, sourceRoot: string, revision: string | null, originalHash: string, sourceRevision: string | null, run: Run): Promise<Release> {
  const info = JSON.parse(await checked(run, [process.execPath, "src/service/entry.ts", "describe"], stage)) as { protocol: number; schema: number; version: string };
  if (info.protocol !== PROTOCOL || info.schema !== SCHEMA) throw new Error("新版运行协议或数据库版本不兼容；需要单独迁移");
  const release: Release = { directory: resolve(stage), sourceRoot: resolve(sourceRoot), revision, sourceRevision, sourceHash: originalHash, version: info.version, hash: sourceHash(stage), protocol: info.protocol, schema: info.schema };
  writeFileSync(join(stage, "release.json"), JSON.stringify(release));
  return release;
}
export async function validateStage(stage: string, run: Run = runCommand, step: (s: string) => unknown = () => {}): Promise<void> {
  await step("dependencies"); await checked(run, [process.execPath, "install", "--frozen-lockfile"], stage, 300_000);
  await step("typecheck"); await checked(run, [process.execPath, "run", "typecheck"], stage, 120_000);
  await step("resources");
  // A local snapshot initially carries old browser assets; resolve the newly installed dependencies.
  rmSync(join(stage, "src/web/vendor"), { recursive: true, force: true });
  const assets = JSON.parse(await checked(run, [process.execPath, "src/service/entry.ts", "assets"], stage)) as { name: string; path: string }[];
  for (const f of ["package.json", "bun.lock", "tsconfig.json", "herdr-plugin.toml", "src/web/page.html", "src/web/page.js", "src/web/terminal.js", "src/web/icon.svg"]) if (!statSync(join(stage, f)).isFile()) throw new Error(`Missing resource ${f}`);
  mkdirSync(join(stage, "src/web/vendor"), { recursive: true });
  for (const a of assets) { const dest = join(stage, "src/web/vendor", a.name); if (resolve(a.path) !== resolve(dest)) cpSync(a.path, dest); }
}
