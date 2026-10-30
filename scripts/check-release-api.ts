/** Run against a local Postman simulation. This never installs or updates a plugin. */
import assert from "node:assert/strict";
import { latestRelease, type ReleaseFetch } from "../src/service/github-release.ts";
import { publishRelease, type Candidate } from "./publish-release.ts";

const base = process.argv[2];
if (!base || !["127.0.0.1", "localhost"].includes(new URL(base).hostname)) throw new Error("Pass the local simulation URL, including /github");
const request: ReleaseFetch = (url, init) => fetch(`${base.replace(/\/$/, "")}${new URL(url).pathname}${new URL(url).search}`, init);
const check = (repo: string, timeout?: number) => latestRelease("test", repo, new AbortController().signal, request, timeout);
assert.deepEqual(await check("stable"), { tag: "v0.3.1", version: "0.3.1" });
assert.equal(await check("empty"), null);
for (const [repo, error] of [["missing", /HTTP 404/], ["limited", /HTTP 403/], ["outage", /HTTP 503/], ["prerelease", /正式 Release/]] as const) {
  await assert.rejects(check(repo), error);
}
await assert.rejects(check("slow", 30), /超时/);
console.log("Release API simulation: 7 scenarios passed (stable, empty, missing, rate limit, outage, prerelease, timeout)");

const candidate: Candidate = { version: "0.3.1", sha: "a".repeat(40), run: "123", assets: [
  { name: "herdr-broadcast-0.3.1.tar.gz", data: Buffer.from("synthetic archive") },
  { name: "herdr-broadcast-0.3.1.tar.gz.sha256", data: Buffer.from("synthetic checksum") },
  { name: "build-info.json", data: Buffer.from("{}") },
] };
const publish = (repo: string) => publishRelease(`test/${repo}`, "simulation-token", candidate, request);
const state = async (repo: string) => (await fetch(`${base.replace(/\/$/, "")}/_release-state/${repo}`)).json() as Promise<any>;
assert.equal((await publish("publish-ok")).published, true);
const first = await state("publish-ok");
assert.equal(first.tag, candidate.sha); assert.equal(first.release.draft, false); assert.equal(first.release.prerelease, false);
assert.deepEqual(first.assets.map((asset: any) => asset.name), candidate.assets.map(asset => asset.name));
assert.equal((await publish("publish-ok")).published, false);
assert.deepEqual((await state("publish-ok")).writes, first.writes);
await assert.rejects(publish("upload-failure"), /HTTP 502/);
assert.equal((await state("upload-failure")).release.draft, true);
assert.equal((await publish("upload-failure")).published, true);
await assert.rejects(publish("lost-response"), /HTTP 503/);
assert.equal((await state("lost-response")).release.draft, false);
assert.equal((await publish("lost-response")).published, false);
await assert.rejects(publish("conflicting-tag"), /tested commit/);
assert.deepEqual((await state("conflicting-tag")).writes, []);
console.log("Publication simulation: 4 scenarios passed (publish/idempotency, upload failure/recovery, lost response, conflicting tag)");
