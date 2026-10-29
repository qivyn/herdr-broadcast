import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { terminalAssets } from "../web/terminal-assets.ts";
import { SCHEMA_VERSION } from "../db.ts";
import { PROTOCOL, atomicJSON, type Release } from "./state.ts";
import { emptyStatus, type UpdateController, type UpdateStatus } from "../update.ts";
import { requestParent } from "./ipc.ts";

const [mode, database, dir, serialized] = process.argv.slice(2);
try {
  if (mode === "assets") console.log(JSON.stringify(terminalAssets()));
  else if (mode === "describe") {
    for (const asset of terminalAssets()) if (!existsSync(asset.path)) throw new Error(`Missing asset ${asset.name}`);
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8"));
    const manifest = Bun.TOML.parse(readFileSync(join(import.meta.dir, "../../herdr-plugin.toml"), "utf8")) as { version?: string; events?: unknown[]; actions?: { id: string }[] };
    if (manifest.version !== pkg.version) throw new Error("Package and manifest versions differ");
    if (manifest.events?.length || manifest.actions?.some(a => a.id === "worker")) throw new Error("Legacy execution entrypoints remain in manifest");
    console.log(JSON.stringify({ protocol: PROTOCOL, schema: SCHEMA_VERSION, version: pkg.version }));
  } else {
    if (!database || !dir || !serialized) throw new Error("Missing managed runtime arguments");
    const release = JSON.parse(serialized) as Release;
    const lease = join(release.directory, "leases", `${process.pid}.json`);
    atomicJSON(lease, { pid: process.pid, mode, database });
    process.on("exit", () => { try { rmSync(lease, { force: true }); } catch {} });
    if (mode === "web") {
      const { Store } = await import("../db.ts");
      const { runWeb } = await import("../web/launch.ts");
      const controller: UpdateController = {
        status: emptyStatus(), start() {}, stop() {},
        async describe() { return this.status = await requestParent("describe"); },
        async check() { return this.status = await requestParent("check", 660_000); },
        async install() { return this.status = await requestParent("install"); },
        async applyLocal() { return this.status = await requestParent("apply"); },
        async restart() { return this.status = await requestParent("restart"); },
      };
      process.on("message", (m: any) => { if (m?.event === "update") controller.status = m.status as UpdateStatus; });
      const store = new Store(database);
      await runWeb(store, console.log, { release, controller, bootId: process.env.HERDR_BROADCAST_BOOT_ID! });
      store.close(); process.exit(0);
    } else {
      const { runLauncher, runManager } = await import("./managed.ts");
      if (mode === "launcher") await runLauncher(database, dir, release);
      else if (mode === "manager") await runManager(database, dir, release);
      else throw new Error("Unknown managed runtime mode");
    }
  }
} catch (e) { console.error(e); process.exit(1); }
