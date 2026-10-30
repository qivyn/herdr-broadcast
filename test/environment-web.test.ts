import { afterEach, expect, test } from "bun:test";
import { AGENTS } from "../src/agents.ts";
import { Store } from "../src/db.ts";
import { startWebServer } from "../src/web/server.ts";
import { FakeHerdr, until } from "./helpers.ts";

let web: ReturnType<typeof startWebServer> | undefined, store: Store, fake: FakeHerdr;
afterEach(async () => { await web?.stop(); web = undefined; store?.close(); fake?.cleanup(); });
test("environment HTTP enforces method/auth/origin/local writes, coalesces preparation and drains accepted work", async () => {
  fake = new FakeHerdr(); store = new Store(fake.dbFile);
  let installCount = 0, installed = false, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  web = startWebServer(store, { host: "127.0.0.1", port: 0, token: "fixture", hosts: [] }, undefined, undefined, async (_machine, script, signal) => {
    if (script.includes("integration install")) {
      installCount++; await pending;
      if (signal?.aborted) throw new Error("cancelled");
      installed = true; return { code: 0, stdout: "", stderr: "" };
    }
    if (script.includes("integration status")) return { code: 0, stderr: "", stdout: AGENTS.map(a => `${a.integration}: ${installed ? "current (v10)" : "not installed"} (/tmp/${a.kind}${a.configSuffix})`).join("\n") };
    return { code: 0, stdout: "/bin/fixture\n1.2.3\n__BC_VERSION_CODE__0\n__BC_CONFIG__yes", stderr: "" };
  });
  const base = web.url.replace(/\/$/, "");
  const path = "/api/machines/local/prepare-agents";
  const headers = { authorization: "Bearer fixture", origin: base, "content-type": "application/json" };
  const body = JSON.stringify({ integrations: ["pi"] });
  try {
    expect((await fetch(base + path, { method: "POST", body })).status).toBe(401);
    expect((await fetch(base + path, { method: "POST", headers: { ...headers, origin: "https://other.invalid" }, body })).status).toBe(403);
    expect((await fetch(base + path, { method: "POST", headers: { ...headers, "x-forwarded-for": "1.2.3.4" }, body })).status).toBe(403);
    expect((await fetch(base + path, { headers })).status).toBe(405);
    expect((await fetch(base + path, { method: "POST", headers, body: JSON.stringify({ integrations: ["evil"] }) })).status).toBe(400);
    const one = await fetch(base + path, { method: "POST", headers, body }); expect(one.status).toBe(202);
    const accepted = await one.json() as any;
    const repeated = await (await fetch(base + path, { method: "POST", headers, body })).json() as any;
    expect(repeated.operationId).toBe(accepted.operationId);
    await until(() => installCount === 1);
    expect(await web.drain(20)).toBe(false);
    release(); await web.environments.settle();
    expect(web.environments.get(accepted.operationId)?.state).toBe("done");
    expect(await web.drain(1000)).toBe(true);
    expect((await fetch(base + path, { method: "POST", headers, body })).status).toBe(503);
    const state = await (await fetch(base + "/api/state", { headers })).json() as any;
    expect(state.environmentOperations[0].state).toBe("done");
    expect(state.environments[0].agents.find((a: any) => a.kind === "pi").ready).toBe(true);
    expect(fake.server().prompts).toEqual([]);
  } finally { release(); }
});
