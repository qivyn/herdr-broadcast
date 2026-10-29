import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/db.ts";
import { Engine } from "../src/engine.ts";
import { AddJobs, type AddJob } from "../src/web/add-job.ts";
import { executionsFrom, startWebServer } from "../src/web/server.ts";
import { parseTarget } from "../src/web/ssh.ts";
import { FakeHerdr, until } from "./helpers.ts";

let fake: FakeHerdr;
let store: Store;
let engine: Engine;
const session = "01234567-1234-4567-89ab-0123456789ab";

beforeEach(() => {
  fake = new FakeHerdr();
  store = new Store(fake.dbFile);
  engine = new Engine(store, () => {});
});

afterEach(async () => {
  engine.stop();
  await engine.settle();
  store.close();
  fake.cleanup();
});

describe("immediate delivery identity", () => {
  for (const changed of [false, true]) {
    test(`a web target ${changed ? "rejects a switched session" : "sends to the original session while working"}`, async () => {
      const agent = fake.addAgent("local", "claude", "working");
      fake.mutate(s => { s.servers.local!.agents[0]!.agent_session = { agent: "claude", kind: "id", source: "test", value: session }; });
      await engine.refresh("local");
      const executions = executionsFrom({ targets: [{ machine: "local", pane: agent.pane_id, terminal_id: agent.terminal_id }] }, engine);
      const id = store.createBroadcast({ title: "queued", prompt: "original task", executions });
      expect(store.executions(id)[0]).toMatchObject({ session_kind: "id", session_value: session });
      await engine.refresh("local");
      expect(fake.server().prompts).toEqual([]);
      if (changed) fake.mutate(s => { s.servers.local!.agents[0]!.agent_session!.value = "11234567-1234-4567-89ab-0123456789ab"; });
      engine.submit(store.rounds(id)[0]!.id);
      await engine.refresh("local");
      await engine.settle();
      expect(store.executions(id)[0]).toMatchObject({ state: changed ? "failed" : "sent", session_value: session });
      expect(fake.server().prompts).toEqual(changed ? [] : [{ pane_id: agent.pane_id, text: "original task" }]);
    });
  }

  test("CLI submits through Web and retains the selected conversation identity", async () => {
    const agent = fake.addAgent("local", "pi", "working");
    const path = "/tmp/original-session.jsonl";
    fake.mutate(s => { s.servers.local!.agents[0]!.agent_session = { agent: "pi", kind: "path", source: "test", value: path }; });
    const web = startWebServer(store, { host: "127.0.0.1", port: 0, token: null, hosts: [] });
    const configDir = join(fake.dir, "cli-config"); mkdirSync(configDir);
    writeFileSync(join(configDir, "config.toml"), `web_port = ${new URL(web.url).port}\n`);
    await web.engine.refreshMachines(); await web.engine.refresh("local");
    try {
    const proc = Bun.spawn([process.execPath, new URL("../src/main.ts", import.meta.url).pathname, "send", "--prompt", "original task", "--to", agent.pane_id], {
      env: { ...process.env, HERDR_PLUGIN_CONFIG_DIR: configDir, HERDR_PLUGIN_STATE_DIR: fake.dir, HERDR_SOCKET_PATH: "" },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("broadcast #1");
    await until(() => store.executions(1)[0]!.state === "sent");
    expect(store.executions(1)[0]).toMatchObject({ state: "sent", session_kind: "path", session_value: path });
    expect(fake.server().prompts).toEqual([{ pane_id: agent.pane_id, text: "original task" }]);
    } finally { await web.stop(); }
  });
});

describe("adding machines during asynchronous preparation", () => {
  for (const failure of ["spawn", "version"] as const) {
    test(`an unexpected ${failure} failure finishes the add job instead of leaving it running`, async () => {
      const previous = process.env.HERDR_BIN_PATH;
      process.env.HERDR_BIN_PATH = join(fake.dir, "missing-herdr");
      let finish!: (job: AddJob) => void;
      const finished = new Promise<AddJob>(resolve => { finish = resolve; });
      const jobs = new AddJobs(job => finish(job), fake.dir, async () => {
        if (failure === "version") throw new Error("version probe failed");
        return null;
      });
      try {
        const job = jobs.start(parseTarget("user@host"), { label: null, session: null, install: false, system: null });
        const result = await finished;
        expect(result).toMatchObject({ id: job.id, state: "failed", download: null, question: null });
        expect(result.reason).toBeTruthy();
        expect(jobs.get(job.id)).toEqual(result);
        expect(fake.read().machines).toEqual([]);
      } finally {
        jobs.stopAll();
        if (previous === undefined) delete process.env.HERDR_BIN_PATH;
        else process.env.HERDR_BIN_PATH = previous;
      }
    });
  }
  for (const stop of ["cancel", "stopAll"] as const) {
    for (const install of [false, true]) {
      test(`${stop} prevents a pending ${install ? "installation" : "connection"} from starting`, async () => {
        let resolveVersion!: (version: string | null) => void;
        const version = new Promise<string | null>(resolve => { resolveVersion = resolve; });
        const finished: AddJob[] = [];
        const jobs = new AddJobs(job => { finished.push(job); }, fake.dir, () => version);
        const job = jobs.start(parseTarget("user@host"), { label: null, session: null, install, system: "Linux aarch64" });
        if (stop === "cancel") jobs.cancel(job.id);
        else jobs.stopAll();
        expect(jobs.get(job.id)!.state).toBe("cancelled");
        resolveVersion(null);
        await Bun.sleep(0);
        expect(finished).toMatchObject([{ id: job.id, state: "cancelled", download: null }]);
        expect(fake.calls()).toEqual([]);
        expect(fake.read().machines).toEqual([]);
      });
    }
  }
});

describe("adding machines with long terminal output", () => {
  for (const { install, secret } of [{ install: false, secret: false }, { install: true, secret: false }, { install: true, secret: true }]) {
    test(`${install ? "automatic" : "manual"} install answers still detect ${secret ? "password requests" : "later questions"} after repeated buffer truncation`, async () => {
      const bin = join(fake.dir, "verbose-herdr");
      const finalPrompt = secret ? "Password: " : "Restart server? [y/N] ";
      writeFileSync(bin, `#!${process.execPath}
process.stdout.write("x".repeat(33000) + "\\nInstall remote herdr? [y/N] ");
let stage = 0;
for await (const chunk of Bun.stdin.stream()) {
  stage++;
  if (stage === 3) process.exit(0);
  process.stdout.write("x".repeat(33000) + "\\n" + (stage === 1 ? "Stop server? [y/N] " : ${JSON.stringify(finalPrompt)}));
}
`, { mode: 0o755 });
      const previousBin = process.env.HERDR_BIN_PATH;
      process.env.HERDR_BIN_PATH = bin;
      let finish!: () => void;
      const finished = new Promise<void>(resolve => { finish = resolve; });
      const jobs = new AddJobs(() => finish(), fake.dir, async () => null);
      const job = jobs.start(parseTarget("user@host"), { label: null, session: null, install, system: null });
      try {
        if (!install) {
          await until(() => jobs.get(job.id)?.question?.kind === "install");
          jobs.answer(job.id, true);
        }
        await until(() => jobs.get(job.id)?.question?.text === "Stop server? [y/N]");
        expect(jobs.get(job.id)!.output.length).toBeLessThanOrEqual(16000);
        jobs.answer(job.id, true);
        if (secret) {
          await until(() => jobs.get(job.id)?.state === "cancelled");
          expect(jobs.get(job.id)!.reason).toContain("服务器在要密码");
        } else {
          await until(() => jobs.get(job.id)?.question?.text === "Restart server? [y/N]");
          expect(jobs.get(job.id)!.question!.context).not.toContain("Stop server?");
          jobs.answer(job.id, true);
          await until(() => jobs.get(job.id)?.state === "done");
        }
      } finally {
        jobs.stopAll();
        await finished;
        if (previousBin === undefined) delete process.env.HERDR_BIN_PATH;
        else process.env.HERDR_BIN_PATH = previousBin;
      }
    });
  }
});

test("a failed HTTP bind leaves no background intervals", async () => {
  const live = new Set<ReturnType<typeof setInterval>>();
  const interval = globalThis.setInterval;
  const clear = globalThis.clearInterval;
  let stopped: Engine | undefined;
  const stop = Engine.prototype.stop;
  const stopSpy = spyOn(Engine.prototype, "stop").mockImplementation(function (this: Engine) { stopped = this; stop.call(this); });
  const intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms: number) => {
    const timer = interval(fn, ms); live.add(timer); return timer;
  }) as typeof setInterval);
  const clearSpy = spyOn(globalThis, "clearInterval").mockImplementation(timer => {
    live.delete(timer as ReturnType<typeof setInterval>);
    clear(timer as ReturnType<typeof setInterval>);
  });
  const serveSpy = spyOn(Bun, "serve").mockImplementation(() => { throw Object.assign(new Error("port in use"), { code: "EADDRINUSE" }); });
  try {
    expect(() => startWebServer(store, { host: "127.0.0.1", port: 7318, token: null, hosts: [] })).toThrow("port in use");
    expect(live.size).toBe(0);
  } finally {
    for (const timer of live) clear(timer);
    serveSpy.mockRestore(); clearSpy.mockRestore(); intervalSpy.mockRestore(); stopSpy.mockRestore();
    await stopped?.settle();
  }
});

test('offline CLI send does not save a broadcast or start a worker; list opens the database read-only',async()=>{
  const configDir=join(fake.dir,'offline-config');mkdirSync(configDir);
  const probe=Bun.listen({hostname:'127.0.0.1',port:0,socket:{data(){}}});const port=probe.port;probe.stop(true);
  writeFileSync(join(configDir,'config.toml'),`web_port = ${port}\n`);
  const run=async(command:string[])=>{const child=Bun.spawn([process.execPath,join(import.meta.dir,'../src/main.ts'),...command],{env:{...process.env,HERDR_PLUGIN_CONFIG_DIR:configDir,HERDR_PLUGIN_STATE_DIR:fake.dir},stdout:'pipe',stderr:'pipe'});return {code:await child.exited,out:await new Response(child.stdout).text(),error:await new Response(child.stderr).text()};};
  const result=await run(['send','--prompt','offline','--new','claude@/src']);expect(result.code).toBe(1);expect(result.error).toContain('没有保存');expect(store.listBroadcasts()).toEqual([]);
  const schema=store.db.query('PRAGMA user_version').get();expect((await run(['list'])).code).toBe(0);expect(store.db.query('PRAGMA user_version').get()).toEqual(schema);expect(fake.server().prompts).toEqual([]);
});
