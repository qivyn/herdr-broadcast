import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runHerdr, herdrResult } from "../src/herdr.ts";

/** A fresh config is essential: a named session alone still runs installed plugin hooks. */
export async function isolatedHerdr(label: string) {
  const binary = process.env.HERDR_BIN_PATH || Bun.which("herdr");
  if (!binary) throw new Error("Install Herdr 0.9.5+ before running Core E2E");
  const root = realpathSync(mkdtempSync(`/tmp/bc-${label}-`));
  const session = `${label}-${process.pid}`;
  const log = join(root, "server.log");
  const logDir = process.env.E2E_LOG_DIR ? resolve(process.env.E2E_LOG_DIR) : null;
  for (const key of Object.keys(process.env)) if (/^(HERDR|OMO|SENPI|PI)_/.test(key)) delete process.env[key];
  Object.assign(process.env, {
    XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_RUNTIME_DIR: join(root, "run"),
    HERDR_BIN_PATH: binary, HERDR_BROADCAST_SESSION: session, SHELL: "/bin/sh",
    BROADCAST_E2E_RECEIPTS_DIR: root,
  });
  mkdirSync(join(root, "run"), { mode: 0o700 });
  mkdirSync(join(root, "config", "herdr"), { recursive: true });
  writeFileSync(join(root, "config", "herdr", "config.toml"), 'onboarding = false\n[shell]\ndefault_shell = "/bin/sh"\n');
  const daemon = Bun.spawn([binary, "--session", session, "server"], { env: process.env, stdout: Bun.file(log), stderr: Bun.file(log) });
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    try { await runHerdr(["server", "stop"], { timeoutMs: 5000 }); }
    finally {
      daemon.kill(); await daemon.exited;
      try {
        if (logDir) { mkdirSync(logDir, { recursive: true }); copyFileSync(log, join(logDir, `${label}-herdr.log`)); }
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }
  try {
    const end = Date.now() + 15_000;
    while (true) {
      try { await herdrResult(["api", "snapshot"], { timeoutMs: 1000 }); break; }
      catch (error) {
        if (daemon.exitCode !== null || Date.now() >= end) throw error;
        await Bun.sleep(100);
      }
    }
    console.log(`[e2e] isolated ${label}: ${root}, session ${session}`);
    return { root, close, diagnostics: () => console.error(readFileSync(log, "utf8").slice(-16_000)) };
  } catch (error) {
    console.error(readFileSync(log, "utf8").slice(-16_000));
    await close(); throw error;
  }
}
