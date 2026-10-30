/** Real Herdr registration + release preparation, with local Git/API fixtures and no model requests. */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "../src/db.ts";
import { herdrBin, herdrResult } from "../src/herdr.ts";
import { findSelf, installedPlugins, Updater } from "../src/update.ts";
import { checked, runCommand } from "../src/service/commands.ts";
import { snapshotSource, sourceHash } from "../src/service/releases.ts";
import { type Release } from "../src/service/state.ts";
import { isolatedHerdr } from "./e2e-environment.ts";

const environment = await isolatedHerdr("release-update");
const root = resolve(import.meta.dir, ".."), fixture = join(environment.root, "source"), origin = join(environment.root, "origin.git");
const stateDir = join(environment.root, "broadcast"), modeFile = join(environment.root, "api-mode"), finish = join(environment.root, "finish-preview");
process.env.HERDR_PLUGIN_CONFIG_DIR = join(environment.root, "plugin-config");
mkdirSync(process.env.HERDR_PLUGIN_CONFIG_DIR, { recursive: true });
writeFileSync(join(process.env.HERDR_PLUGIN_CONFIG_DIR, "config.toml"), "web_autostart = false\n");
const git = (cwd: string, ...args: string[]) => checked(runCommand, ["git", "-c", "user.name=qivyn", "-c", "user.email=177705776+qivyn@users.noreply.github.com", "-c", "commit.gpgsign=false", ...args], cwd);
let api: ReturnType<typeof Bun.serve> | undefined;
let web: ReturnType<typeof import("../src/web/server.ts").startWebServer> | undefined;
let store: Store | undefined;
const prepared: Release[] = [];
try {
  mkdirSync(fixture);
  for (const path of ["src", "scripts", "test", "package.json", "bun.lock", "tsconfig.json", "herdr-plugin.toml", ".gitignore"]) cpSync(join(root, path), join(fixture, path), { recursive: true });
  await git(fixture, "init", "-q", "-b", "main"); await git(fixture, "add", "."); await git(fixture, "commit", "-qm", "current working tree");
  const first = await git(fixture, "rev-parse", "HEAD");
  const pkg = JSON.parse(readFileSync(join(fixture, "package.json"), "utf8"));
  const originalVersion = pkg.version;
  pkg.version = "99.0.0"; writeFileSync(join(fixture, "package.json"), JSON.stringify(pkg));
  writeFileSync(join(fixture, "herdr-plugin.toml"), readFileSync(join(fixture, "herdr-plugin.toml"), "utf8").replace(`version = "${originalVersion}"`, 'version = "99.0.0"'));
  await git(fixture, "add", "."); await git(fixture, "commit", "-qm", "release candidate");
  await git(fixture, "tag", "-a", "v99.0.0", "-m", "stable release");
  const target = await git(fixture, "rev-parse", "HEAD");
  writeFileSync(join(fixture, "unreleased.txt"), "This commit must never be installed");
  await git(fixture, "add", "."); await git(fixture, "commit", "-qm", "unreleased change");
  await git(environment.root, "clone", "--bare", fixture, origin);
  const count = Number(process.env.GIT_CONFIG_COUNT || "0");
  process.env.GIT_CONFIG_COUNT = String(count + 1);
  process.env[`GIT_CONFIG_KEY_${count}`] = `url.${origin}.insteadOf`;
  process.env[`GIT_CONFIG_VALUE_${count}`] = "https://github.com/test/broadcast.git";
  await checked(runCommand, [herdrBin(), "plugin", "install", "test/broadcast", "--ref", first, "--yes"], undefined, 120_000);
  const installed = findSelf(await installedPlugins())!;
  assert.equal(installed.source?.resolved_commit, first);
  const current = await snapshotSource(installed.plugin_root, stateDir);
  assert.equal(current.sourceRoot, installed.plugin_root);
  assert.equal(current.sourceHash, sourceHash(root), "the running snapshot must contain the current working tree's runtime code");
  assert.equal(current.hash, sourceHash(current.directory));
  writeFileSync(modeFile, "empty");
  api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const mode = readFileSync(modeFile, "utf8").trim(), latest = new URL(request.url).pathname.endsWith("/releases/latest");
    if (mode === "error") return new Response(null, { status: 503 });
    if (!latest) return Response.json({ id: 1 });
    return mode === "empty" ? new Response(null, { status: 404 }) : Response.json({ tag_name: "v99.0.0", draft: false, prerelease: false, published_at: "2026-10-30T00:00:00Z" });
  } });
  // Load the actual server from the verified immutable snapshot.
  const { startWebServer } = await import(join(current.directory, "src/web/server.ts"));
  store = new Store(join(environment.root, "broadcast.sqlite"));
  web = startWebServer(store, { host: "127.0.0.1", port: 0, token: null, hosts: [],
    runtime: { revision: current.revision, hash: current.hash, database: store.path, bootId: "release-preview" } }, undefined, {
    current, stateDir, plugins: installedPlugins,
    fetch: (url: string, init: RequestInit) => fetch(new URL(new URL(url).pathname, api!.url), init),
    activate: async (next: Release) => { prepared.push(next); },
  });
  const health = await (await fetch(new URL("api/health", web!.url))).json() as { hash: string };
  assert.equal(health.hash, current.hash);
  const updater = web!.updater as Updater;
  assert.equal((await updater.check()).blocked_reason, "尚无正式 Release");
  if (process.argv.includes("--preview")) {
    const { root_pane } = await herdrResult<{ root_pane: { pane_id: string } }>(["workspace", "create", "--cwd", environment.root, "--label", "Release preview", "--no-focus"]);
    await Bun.sleep(500);
    const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
    await herdrResult(["pane", "run", root_pane.pane_id, `${quote(process.execPath)} ${quote(join(root, "scripts/fake-agent.ts"))} fakebot 1`]);
    console.log(JSON.stringify({ url: web!.url, modeFile, finish, sourceRoot: current.sourceRoot, sourceHash: current.sourceHash, hash: current.hash, workingTreeVerified: true }));
    const end = Date.now() + 15 * 60_000;
    while (!existsSync(finish)) { if (Date.now() > end) throw new Error("Preview timed out"); await Bun.sleep(250); }
  }
  writeFileSync(modeFile, "stable");
  assert.equal((await updater.check()).latest_revision, target);
  assert.equal(updater.status.available, true);
  await updater.install(); await updater.wait();
  assert.equal(updater.status.error, null);
  assert.equal(prepared.length, 1);
  const actual = findSelf(await installedPlugins())!;
  assert.equal(actual.source?.resolved_commit, target);
  assert.equal(actual.source?.requested_ref, target);
  assert.equal(prepared[0]!.revision, target);
  assert.equal(prepared[0]!.version, "99.0.0");
  assert.equal(existsSync(join(actual.plugin_root, "unreleased.txt")), false);
  console.log("Release update passed: real Herdr registered the exact published commit; full candidate validation passed; unreleased HEAD was excluded.");
} catch (error) { environment.diagnostics(); throw error; }
finally {
  try { await web?.stop(); api?.stop(true); store?.close(); }
  finally { await environment.close(); }
}
