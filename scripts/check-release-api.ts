/** Run against a local Postman simulation. This never installs or updates a plugin. */
import assert from "node:assert/strict";
import { latestRelease, type ReleaseFetch } from "../src/service/github-release.ts";

const base = process.argv[2];
if (!base || !["127.0.0.1", "localhost"].includes(new URL(base).hostname)) throw new Error("Pass the local simulation URL, including /github");
const request: ReleaseFetch = (url, init) => fetch(`${base.replace(/\/$/, "")}${new URL(url).pathname}`, init);
const check = (repo: string, timeout?: number) => latestRelease("test", repo, new AbortController().signal, request, timeout);
assert.deepEqual(await check("stable"), { tag: "v0.3.1", version: "0.3.1" });
assert.equal(await check("empty"), null);
for (const [repo, error] of [["missing", /HTTP 404/], ["limited", /HTTP 403/], ["outage", /HTTP 503/], ["prerelease", /正式 Release/]] as const) {
  await assert.rejects(check(repo), error);
}
await assert.rejects(check("slow", 30), /超时/);
console.log("Release API simulation: 7 scenarios passed (stable, empty, missing, rate limit, outage, prerelease, timeout)");
