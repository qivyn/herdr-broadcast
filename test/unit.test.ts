import { describe, expect, test } from "bun:test";
import { questionIn, terminalText } from "../src/web/add-job.ts";
import { assetIn, herdrAsset, platformOf, versionOf } from "../src/web/herdr-asset.ts";
import { sanitizeKeepStyle } from "../src/text.ts";
import { slugOf, webLink, webMachineId } from "../src/weblink.ts";
import { agentNameFor, resolveCwd, shapePrompt, tabLabelFor, workspaceLabelFor } from "../src/engine.ts";
import { defaultDbPath, sessionName, Store } from "../src/db.ts";
import { listDirs } from "../src/web/dirs.ts";
import { addCommand, classifySshError, configEntry, insertEntry, inspectKey, parseMachineStatus, parseSession, parseTarget, parseWebUiMachines, sameHerdr, suggestEntryName, tightenKey, webUiMachines } from "../src/web/ssh.ts";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";

describe("folders for the form", () => {
  test("suggests the folders under what is typed, hidden ones only when a dot is typed", () => {
    const root = mkdtempSync(join(tmpdir(), "bcast-dirs-"));
    try {
      for (const dir of ["app/src", "api", "docs", ".cache"]) mkdirSync(join(root, dir), { recursive: true });
      expect(listDirs(`${root}/`).suggestions.map((s) => s.value)).toEqual([`${root}/api/`, `${root}/app/`, `${root}/docs/`]);
      expect(listDirs(`${root}/a`).suggestions.map((s) => s.value)).toEqual([`${root}/api/`, `${root}/app/`]);
      expect(listDirs(`${root}/.`).suggestions.map((s) => s.value)).toEqual([`${root}/.cache/`]);
      expect(listDirs(`${root}/app/`).suggestions.map((s) => s.value)).toEqual([`${root}/app/src/`]);
      expect(listDirs(`${root}/app`).target).toEqual({ exists: true });
      expect(listDirs(`${root}/nope`).target).toEqual({ exists: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("~ is the home folder", () => {
    expect(listDirs("~").suggestions.every((s) => s.value.startsWith("~/"))).toBe(true);
  });
});

describe("text", () => {
  test("a screen keeps its colors and styles, and loses everything that would move a cursor", () => {
    const styled = "\x1b[1;38;2;215;119;87m✻ Claude\x1b[0m \x1b[38;5;244mready\x1b[39m";
    expect(sanitizeKeepStyle(styled)).toBe(styled);
    expect(sanitizeKeepStyle("\x1b[2J\x1b[Ha\x1b[?25lb\x1b]0;title\x07c\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\\r\nd\x1b(B\x1b7e")).toBe("abclink\nde");
  });
});

describe("herdr-web-ui links", () => {
  test("local links name the workspace and pane; remote ones the derived machine id", () => {
    const local = new URL(webLink({ machineId: "local", workspaceId: "w3", workspaceLabel: "📡12 Check login", paneId: "w3:p2" }, "http://localhost:7317/"));
    expect(local.searchParams.get("machine")).toBeNull();
    expect(local.searchParams.get("ws")).toBe("w3-12-check-login");
    expect(local.searchParams.get("pane")).toBe("w3:p2");
    expect(local.searchParams.get("view")).toBe("chat");

    const remote = new URL(webLink({ machineId: "prof-1", workspaceId: "w1", paneId: "w1:p1", view: "terminal" }, "http://localhost:7317/"));
    expect(remote.searchParams.get("machine")).toBe(webMachineId("prof-1"));
    expect(remote.searchParams.get("view")).toBe("terminal");
  });

  test("the machine id matches herdr-web-ui's herdrMachineId", () => {
    // sha256("herdr-profile:abc") = 2d1c3c3b...; shape is a UUID
    expect(webMachineId("abc")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("slugs follow herdr-web-ui", () => {
    expect(slugOf("Café API")).toBe("cafe-api");
    expect(slugOf("检查登录")).toBe("");
    expect(slugOf("a very long workspace name that goes on")).toBe("a-very-long-workspace");
  });
});

describe("ssh machines", () => {
  test("addresses are read as Herdr takes them, and anything a shell could misread is refused", () => {
    expect(parseTarget("workbox")).toMatchObject({ user: null, host: "workbox", port: null, text: "workbox" });
    expect(parseTarget(" qi@10.0.0.5 ")).toMatchObject({ user: "qi", host: "10.0.0.5", port: null, text: "qi@10.0.0.5" });
    expect(parseTarget("qi@box.lan:2222").text).toBe("ssh://qi@box.lan:2222");
    expect(parseTarget("ssh://qi@box.lan:2222").port).toBe(2222);
    expect(parseTarget("qi@box:22").text).toBe("qi@box");
    expect(parseTarget("qi@[::1]:2200").text).toBe("ssh://qi@[::1]:2200");
    for (const bad of ["", "-oProxyCommand=x", "qi@box;rm", "qi@box space", "$(id)@box", "qi@box:99999", "a@b@c d"]) expect(() => parseTarget(bad)).toThrow();
  });

  test("ssh's failures are told apart", () => {
    expect(classifySshError("qi@box: Permission denied (publickey,password).")).toBe("auth");
    expect(classifySshError("Host key verification failed.")).toBe("host-key");
    expect(classifySshError("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@")).toBe("host-key-changed");
    expect(classifySshError("ssh: Could not resolve hostname nope: nodename nor servname provided")).toBe("dns");
    expect(classifySshError("ssh: connect to host box port 22: Connection refused")).toBe("refused");
    expect(classifySshError("ssh: connect to host box port 22: Operation timed out")).toBe("timeout");
  });

  test("a Host entry goes before the first Host or Match block, so a `Host *` cannot override it", () => {
    const entry = "Host box\n  HostName 1.2.3.4\n";
    expect(insertEntry(null, entry)).toBe(`# added by herdr-broadcast\n${entry}`);
    // global options stay global, above the entry
    expect(insertEntry("AddKeysToAgent yes\n\nHost *\n  User x\n", entry)).toBe(`AddKeysToAgent yes\n\n# added by herdr-broadcast\n${entry}\nHost *\n  User x\n`);
    expect(insertEntry("Include ~/.orbstack/ssh/config\n", entry)).toBe(`Include ~/.orbstack/ssh/config\n\n# added by herdr-broadcast\n${entry}`);
  });

  test("a .pem is read as ssh will find it: too open, and a Host entry for it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bcast-pem-"));
    try {
      const pem = join(dir, "server.pem");
      expect(Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", pem]).exitCode).toBe(0);
      chmodSync(pem, 0o644);
      const loose = await inspectKey(pem);
      expect(loose).toMatchObject({ path: pem, loose: true, passphrase: false, invalid: false });
      expect((await tightenKey(pem)).loose).toBe(false);
      writeFileSync(join(dir, "not-a-key.pem"), "hello");
      expect((await inspectKey(join(dir, "not-a-key.pem"))).invalid).toBe(true);
      await expect(inspectKey(join(dir, "missing.pem"))).rejects.toThrow("找不到私钥文件");

      const entry = await configEntry(parseTarget("ubuntu@10.0.0.5:2201"), pem, "gpu");
      expect(entry.text).toBe(`Host gpu\n  HostName 10.0.0.5\n  User ubuntu\n  Port 2201\n  IdentityFile ${pem}\n  IdentitiesOnly yes\n`);
      await expect(configEntry(parseTarget("10.0.0.5"), pem, "gpu")).rejects.toThrow("用户名");
      await expect(configEntry(parseTarget("ubuntu@10.0.0.5"), pem, "bad name")).rejects.toThrow("配置名");
      expect(suggestEntryName(parseTarget("ubuntu@10.0.0.5"), "GPU Box")).toBe("gpu-box");
      expect(suggestEntryName(parseTarget("ubuntu@10.0.0.5"), "训练机")).toBe("10-0-0-5");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("herdr-web-ui's own PCs are read as the wizard takes them", () => {
    const dir = "/state/herdr-web-ui";
    const saved = JSON.stringify([
      { id: "a", name: "box@1", target: { destination: "node@127.0.0.1", port: 2221, identity_file: "~/.ssh/id_rsa" }, enabled: true },
      { id: "b", name: "rl", target: { destination: "root@117.50.47.141", identity_file: "/keys/RL.pem", session: "default" }, enabled: false },
      { id: "c", name: "app key", target: { destination: "qi@::1", port: 22, identity_file: `${dir}/ssh/c`, session: "work" } },
      { id: "d", herdr_profile_id: "p-1", name: "from herdr", target: { destination: "gpu" } },
      { id: "e", name: "odd", target: { destination: "qi@box;rm" } },
      { id: "local", name: "This PC" },
    ]);
    expect(parseWebUiMachines(saved, dir)).toEqual([
      { id: "a", name: "box@1", target: "ssh://node@127.0.0.1:2221", key: null, appKey: false, session: null, enabled: true, error: null },
      { id: "b", name: "rl", target: "root@117.50.47.141", key: "/keys/RL.pem", appKey: false, session: null, enabled: false, error: null },
      { id: "c", name: "app key", target: "qi@[::1]", key: `${dir}/ssh/c`, appKey: true, session: "work", enabled: true, error: null },
      { id: "e", name: "odd", target: "qi@box;rm", key: null, appKey: false, session: null, enabled: true, error: "地址不对：box;rm" },
    ]);
    expect(() => parseWebUiMachines("{", dir)).toThrow("JSON");
    // a session goes to `herdr machine add` only as a plain name
    expect(parseSession("work")).toBe("work");
    expect(parseSession("default")).toBeNull();
    expect(() => parseSession("-x")).toThrow();
    expect(addCommand(parseTarget("qi@box"), null, "work")).toEndWith("machine add qi@box --remote-session work");
  });

  test("a herdr-web-ui PC Herdr already has is not offered again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bcast-webui-"));
    try {
      expect(await webUiMachines([], dir)).toEqual({ file: null, machines: [] });
      writeFileSync(join(dir, "machines.json"), JSON.stringify([
        { id: "a", name: "one", target: { destination: "node@127.0.0.1", port: 2221 } },
        { id: "b", name: "two", target: { destination: "root@10.9.9.9" } },
        { id: "c", name: "three", target: { destination: "root@10.9.9.9", session: "work" } },
      ]));
      const left = await webUiMachines([{ target: "ssh://node@127.0.0.1:2221", session: "default" }, { target: "root@10.9.9.9", session: "default" }], dir);
      expect(left.machines.map((m) => m.id)).toEqual(["c"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a terminal's questions are read from what it shows", () => {
    expect(terminalText("\x1b[32mok\x1b[0m\r\ndownloading 10%\rdownloading 100%\nnext")).toBe("ok\ndownloading 100%\nnext");
    expect(questionIn('matching herdr 0.9.5 is not installed\nInstall the 0.9.5 stable asset for linux-x86_64 to "$HOME/.local/bin/herdr"? [Y/n] '))
      .toMatchObject({ kind: "install", defaultYes: true });
    expect(questionIn("stop and update the remote server, then continue attaching? [y/N] ")).toMatchObject({ kind: "server", defaultYes: false });
    expect(questionIn("  server: v0.9.3\nThis stops active remote pane processes.\nrestart the remote server now? [y/N] ")).toMatchObject({ kind: "server", context: "  server: v0.9.3\nThis stops active remote pane processes." });
    expect(questionIn("Install ...? [Y/n] y\ninstalling")).toBeNull();
    expect(sameHerdr("herdr 0.9.5", "herdr 0.9.5")).toBe(true);
    expect(sameHerdr("herdr 0.9.3", "herdr 0.9.5")).toBe(false);
    expect(sameHerdr(null, "herdr 0.9.5")).toBe(false);
  });

  test("the Herdr build a server needs is found in the release manifest", () => {
    expect(platformOf("Linux aarch64")).toBe("linux-aarch64");
    expect(platformOf("Darwin arm64")).toBe("macos-aarch64");
    expect(platformOf("Linux x86_64")).toBe("linux-x86_64");
    expect(platformOf("FreeBSD amd64")).toBeNull();
    expect(versionOf("herdr 0.9.5")).toBe("0.9.5");
    const sha = "a".repeat(64);
    const manifest = { version: "0.9.5", assets: { "linux-x86_64": "https://x/new" }, sha256: { "linux-x86_64": sha },
      releases: { "0.9.3": { assets: { "linux-x86_64": "https://x/old" }, sha256: { "linux-x86_64": sha } } } };
    expect(assetIn(manifest, "0.9.3", "linux-x86_64").url).toBe("https://x/old");
    expect(assetIn(manifest, "0.9.5", "linux-x86_64").url).toBe("https://x/new");
    expect(() => assetIn(manifest, "0.9.5", "linux-aarch64")).toThrow("linux-aarch64");
  });

  test("a download that drops is resumed, checked, and kept for the next server", async () => {
    const body = new Uint8Array(300_000).map((_, i) => i % 251);
    const sha = new Bun.CryptoHasher("sha256").update(body).digest("hex");
    let requests = 0;
    const ranges: (string | null)[] = [];
    let interrupted: ServerResponse | undefined;
    const server = createServer((req, res) => {
      if (req.url === "/latest.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ version: "0.9.5", assets: { "linux-aarch64": `http://${req.headers.host}/bin` }, sha256: { "linux-aarch64": sha } }));
        return;
      }
      requests += 1;
      ranges.push(req.headers.range ?? null);
      const from = Number(/bytes=(\d+)-/.exec(req.headers.range ?? "")?.[1] ?? 0);
      res.writeHead(from ? 206 : 200, { "content-length": String(body.length - from),
        ...(from ? { "content-range": `bytes ${from}-${body.length - 1}/${body.length}` } : {}) });
      if (requests === 1) {
        interrupted = res;
        res.write(body.slice(0, 150_000));
      } else res.end(body.slice(from));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as { port: number };
    const dir = mkdtempSync(join(tmpdir(), "bcast-asset-"));
    process.env.HERDR_BROADCAST_RELEASES_URL = `http://127.0.0.1:${address.port}/latest.json`;
    try {
      const file = await herdrAsset(dir, "0.9.5", "linux-aarch64", (progress) => {
        // Drop the transport only after the client saved the first half. No artificial
        // server exception is logged, and the next request must resume those bytes.
        if (interrupted && progress.done === 150_000) {
          interrupted.destroy();
          interrupted = undefined;
        }
      }, AbortSignal.timeout(5_000));
      expect(new Uint8Array(await Bun.file(file).arrayBuffer())).toEqual(body);
      expect(requests).toBe(2);
      expect(ranges).toEqual([null, "bytes=150000-"]);
      await herdrAsset(dir, "0.9.5", "linux-aarch64", () => undefined, new AbortController().signal);
      expect(requests).toBe(2);
    } finally {
      delete process.env.HERDR_BROADCAST_RELEASES_URL;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  test("machine status is matched to machines by id or label", () => {
    const machines = [{ id: "m-1", label: "gpu" }, { id: "m-2", label: "build" }];
    const parsed = { result: { machines: [{ profile_id: "m-1", state: "reachable" }, { label: "build", state: "attention", error: "auth failed" }] } };
    expect(parseMachineStatus(parsed, machines)).toEqual({ "m-1": { ok: true, text: "reachable" }, "m-2": { ok: false, text: "attention: auth failed" } });
  });
});

describe("the database", () => {
  test("an older database loses its worktree columns and keeps its broadcasts", () => {
    const dir = mkdtempSync(join(tmpdir(), "bcast-db-"));
    const path = join(dir, "old.sqlite");
    try {
      // a version 3 database, as an older plugin left it
      const old = new Database(path, { create: true });
      old.exec(`
        CREATE TABLE broadcasts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, prompt TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE executions (
          id INTEGER PRIMARY KEY AUTOINCREMENT, broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
          machine_id TEXT NOT NULL, machine_label TEXT NOT NULL, target_kind TEXT NOT NULL, agent_kind TEXT, agent_name TEXT, cwd TEXT,
          worktree_branch TEXT, trust_repository INTEGER NOT NULL DEFAULT 0, slot INTEGER NOT NULL DEFAULT 0,
          workspace_id TEXT, workspace_label TEXT, tab_id TEXT, pane_id TEXT, terminal_id TEXT, session_kind TEXT, session_value TEXT,
          state TEXT NOT NULL, seq_before INTEGER, saw_working INTEGER NOT NULL DEFAULT 0, error TEXT, note TEXT, owner_pid INTEGER,
          created_at INTEGER NOT NULL, sent_at INTEGER, finished_at INTEGER, updated_at INTEGER NOT NULL);
        CREATE TABLE locks (name TEXT PRIMARY KEY, pid INTEGER NOT NULL, heartbeat INTEGER NOT NULL);
        INSERT INTO broadcasts (title, prompt, created_at) VALUES ('旧广播', 'p', 1);
        INSERT INTO executions (broadcast_id, machine_id, machine_label, target_kind, cwd, worktree_branch, state, created_at, updated_at)
          VALUES (1, 'local', '本机', 'new', '/src', 'broadcast/1-claude-1', 'completed', 1, 1);
        PRAGMA user_version = 3;
      `);
      old.close();
      const store = new Store(path);
      try {
        const columns = new Set(store.db.query<{ name: string }, []>("PRAGMA table_info(executions)").all().map((c) => c.name));
        expect(columns.has("worktree_branch")).toBe(false);
        expect(columns.has("trust_repository")).toBe(false);
        expect(store.listBroadcasts().map((b) => b.title)).toEqual(["旧广播"]);
        expect(store.executions(1)[0]!.cwd).toBe("/src");
        // and a new one writes the same schema
        store.createBroadcast({ title: "新", prompt: "p", executions: [{ machine_id: "local", machine_label: "本机", target_kind: "new", cwd: "/src", slot: 1 }] });
        expect(store.executions(2)[0]!.state).toBe("submitting");
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("names", () => {
  test("each herdr session has its own database", () => {
    const saved = { ...process.env };
    delete process.env.HERDR_BROADCAST_SESSION;
    process.env.HERDR_SOCKET_PATH = "/Users/x/.config/herdr/herdr.sock";
    expect(sessionName()).toBe("default");
    process.env.HERDR_SOCKET_PATH = "/Users/x/.config/herdr/sessions/bctest/herdr.sock";
    expect(sessionName()).toBe("bctest");
    process.env.HERDR_PLUGIN_STATE_DIR = "/tmp/herdr-broadcast-session-test";
    expect(defaultDbPath()).toBe("/tmp/herdr-broadcast-session-test/broadcast-bctest.sqlite");
    process.env = saved;
  });

  test("agent names fit Herdr's pattern", () => {
    const name = agentNameFor(12345, "Claude Code!", 3);
    expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    expect(name).toBe("bc12345-claudecode-3");
  });

  test("a prompt ending in an @mention gets a space so Enter sends it", () => {
    expect(shapePrompt("look at @src/app.ts")).toBe("look at @src/app.ts ");
    expect(shapePrompt("mail me@example.com please")).toBe("mail me@example.com please");
  });

  test("workspace and tab labels", () => {
    expect(Array.from(workspaceLabelFor(7, "x".repeat(100))).length).toBe(36);
    expect(tabLabelFor("codex", 2, "/src/app/")).toBe("codex-2 · app");
  });

  test("local ~ is expanded, remote ~ is left for the remote machine", () => {
    expect(resolveCwd("local", "~/repo")).toBe(`${process.env.HOME}/repo`);
    expect(resolveCwd("m-1", "~/repo")).toBe("~/repo");
  });
});
