import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishRelease, readCandidate, type Candidate, type ReleaseRequest } from "../scripts/publish-release.ts";

const roots: string[] = [], servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { servers.splice(0).forEach(server => server.stop(true)); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const sha = "a".repeat(40), run = "123";
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
function candidate() {
  const root = mkdtempSync(join(tmpdir(), "bc-publish-")); roots.push(root);
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.3.1" }));
  writeFileSync(join(root, "herdr-plugin.toml"), 'version = "0.3.1"');
  const archive = "herdr-broadcast-0.3.1.tar.gz", data = Buffer.from("isolated build fixture");
  writeFileSync(join(root, "dist", archive), data);
  writeFileSync(join(root, "dist", `${archive}.sha256`), `${hash(data)}  ${archive}\n`);
  writeFileSync(join(root, "dist", "build-info.json"), JSON.stringify({ revision: sha, prHead: sha, version: "0.3.1", run, dirty: false }));
  return { root, value: readCandidate(root, sha, run) };
}
function fixture() {
  const state = { tag: null as { type: string; sha: string } | null, releases: [] as any[], assets: [] as any[],
    calls: [] as { method: string; path: string; body: any }[], uploads: [] as Buffer[], fail: "", failStatus: 503, failAfterPublish: false, moveTag: false, pages: null as any[][] | null };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url), path = url.pathname.replace("/repos/test/broadcast", "");
    const bytes = Buffer.from(await req.arrayBuffer());
    const binary = req.headers.get("content-type") === "application/octet-stream";
    const body = bytes.length ? (binary ? bytes : JSON.parse(bytes.toString())) : null;
    state.calls.push({ method: req.method, path: path + url.search, body });
    if (req.headers.get("authorization") !== "Bearer fixture-token") return new Response(null, { status: 401 });
    if (`${req.method} ${path}` === state.fail) return new Response(null, { status: state.failStatus });
    const json = (value: any, status = 200) => Response.json(value, { status });
    if (req.method === "GET" && path === "/releases") return json(state.pages?.[Number(url.searchParams.get("page")) - 1] ?? state.releases);
    if (req.method === "GET" && path === "/git/ref/tags/v0.3.1") return state.tag ? json({ object: state.tag }) : new Response(null, { status: 404 });
    if (req.method === "GET" && path.startsWith("/git/tags/")) return json({ object: { type: "commit", sha } });
    if (req.method === "POST" && path === "/git/refs") { state.tag = { type: "commit", sha: body.sha }; return json({ object: state.tag }, 201); }
    if (req.method === "POST" && path === "/releases") {
      const release = { id: 1, ...body, upload_url: "https://uploads.github.com/repos/test/broadcast/releases/1/assets{?name,label}" };
      state.releases.push(release); return json(release, 201);
    }
    if (req.method === "GET" && path === "/releases/1/assets") return json(state.assets);
    if (req.method === "POST" && path === "/releases/1/assets") {
      state.uploads.push(bytes);
      const asset = { id: state.assets.length + 1, name: url.searchParams.get("name"), state: "uploaded", size: bytes.length, digest: `sha256:${hash(bytes)}` };
      state.assets.push(asset);
      if (state.moveTag) state.tag = { type: "commit", sha: "b".repeat(40) };
      return json(asset, 201);
    }
    if (req.method === "DELETE" && path.startsWith("/releases/assets/")) { state.assets = state.assets.filter(asset => asset.id !== Number(path.split("/").at(-1))); return new Response(null, { status: 204 }); }
    if (req.method === "PATCH" && path === "/releases/1") {
      Object.assign(state.releases[0], body);
      if (state.failAfterPublish) return new Response(null, { status: 503 });
      return json({ ...state.releases[0], html_url: "https://github.com/test/broadcast/releases/tag/v0.3.1" });
    }
    return json({ message: "Endpoint not modeled" }, 501);
  } });
  servers.push(server);
  const request: ReleaseRequest = (url, init) => fetch(new URL(new URL(url).pathname + new URL(url).search, server.url), init);
  const publish = (value = candidate().value) => publishRelease("test/broadcast", "fixture-token", value, request);
  return { state, publish };
}

test("publishes the tested SHA, exact build bytes and stable Release only after all uploads", async () => {
  const f = fixture(), c = candidate().value;
  expect(await f.publish(c)).toEqual({ published: true, tag: "v0.3.1", url: "https://github.com/test/broadcast/releases/tag/v0.3.1" });
  expect(f.state.tag).toEqual({ type: "commit", sha });
  expect(f.state.uploads).toEqual(c.assets.map(asset => asset.data));
  expect(f.state.assets.map(asset => asset.name)).toEqual(c.assets.map(asset => asset.name));
  const mutations = f.state.calls.filter(call => call.method !== "GET");
  expect(mutations.map(call => call.method)).toEqual(["POST", "POST", "POST", "POST", "POST", "PATCH"]);
  expect(mutations[0]!.body).toEqual({ ref: "refs/tags/v0.3.1", sha });
  expect(mutations[1]!.body).toMatchObject({ target_commitish: sha, draft: true, prerelease: false, generate_release_notes: true });
  expect(mutations.at(-1)!.body).toEqual({ draft: false, prerelease: false, make_latest: "true" });
  f.state.calls = [];
  expect((await f.publish(c)).published).toBe(false);
  expect(f.state.calls.every(call => call.method === "GET")).toBe(true);
});
for (const version of ["v0.3.1", "0.4.0", "v0.10.0"]) test(`unchanged or older version skips without writes: ${version}`, async () => {
  const f = fixture(); f.state.releases = [{ tag_name: version, draft: false, prerelease: false }];
  expect((await f.publish()).published).toBe(false);
  expect(f.state.calls.every(call => call.method === "GET")).toBe(true);
});
test("pagination finds higher versions beyond drafts and prereleases", async () => {
  const f = fixture(); f.state.pages = [Array.from({ length: 100 }, () => ({ tag_name: "v9.0.0-rc.1", draft: false, prerelease: true })), [{ tag_name: "v0.4.0", draft: false, prerelease: false }]];
  expect((await f.publish()).published).toBe(false);
  expect(f.state.calls.map(call => call.path)).toEqual(["/releases?per_page=100&page=1", "/releases?per_page=100&page=2"]);
});
test("drafts and prereleases do not prevent a new stable version", async () => {
  const f = fixture(); f.state.pages = [[{ tag_name: "v8.0.0", draft: true }, { tag_name: "v9.0.0-rc.1", draft: false, prerelease: true }]];
  expect((await f.publish()).published).toBe(true);
});
test("existing annotated tag at the tested commit can be used", async () => {
  const f = fixture(); f.state.tag = { type: "tag", sha: "c".repeat(40) };
  expect((await f.publish()).published).toBe(true);
  expect(f.state.calls.some(call => call.method === "POST" && call.path === "/git/refs")).toBe(false);
});
test("a conflicting tag or an unrelated draft is never overwritten", async () => {
  const f = fixture(); f.state.tag = { type: "commit", sha: "b".repeat(40) };
  await expect(f.publish()).rejects.toThrow("tested commit");
  f.state.tag = null; f.state.releases = [{ tag_name: "v0.3.1", draft: true, body: "manual draft" }];
  await expect(f.publish()).rejects.toThrow("outside this CI run");
  expect(f.state.calls.every(call => call.method === "GET")).toBe(true);
});
test("failed upload remains draft and rerun resumes without duplicate tag or Release", async () => {
  const f = fixture(), c = candidate().value;
  f.state.fail = "POST /releases/1/assets";
  await expect(f.publish(c)).rejects.toThrow("HTTP 503");
  expect(f.state.releases[0].draft).toBe(true);
  expect(f.state.calls.some(call => call.method === "PATCH")).toBe(false);
  f.state.fail = ""; f.state.assets = [{ id: 1, name: c.assets[0]!.name, state: "starter", size: 0, digest: null }];
  expect((await f.publish(c)).published).toBe(true);
  expect(f.state.releases).toHaveLength(1);
  expect(f.state.calls.filter(call => call.method === "POST" && call.path === "/git/refs")).toHaveLength(1);
  expect(f.state.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
});
test("publication failure preserves complete draft assets and resumes on rerun", async () => {
  const f = fixture(), c = candidate().value; f.state.fail = "PATCH /releases/1";
  await expect(f.publish(c)).rejects.toThrow("HTTP 503");
  expect(f.state.releases[0].draft).toBe(true);
  f.state.fail = "";
  expect((await f.publish(c)).published).toBe(true);
  expect(f.state.uploads).toHaveLength(3);
});
test("lost publication response does not republish an already successful Release", async () => {
  const f = fixture(), c = candidate().value; f.state.failAfterPublish = true;
  await expect(f.publish(c)).rejects.toThrow("HTTP 503");
  expect(f.state.releases[0].draft).toBe(false);
  f.state.calls = [];
  expect((await f.publish(c)).published).toBe(false);
  expect(f.state.calls.every(call => call.method === "GET")).toBe(true);
});
for (const status of [401, 403, 404, 429, 503]) test(`release-list HTTP ${status} blocks all writes`, async () => {
  const f = fixture(); f.state.fail = "GET /releases"; f.state.failStatus = status;
  await expect(f.publish()).rejects.toThrow(`HTTP ${status}`);
  expect(f.state.calls).toHaveLength(1);
  expect(f.state.tag).toBeNull();
});
test("tag movement during upload prevents publication", async () => {
  const f = fixture(); f.state.moveTag = true;
  await expect(f.publish()).rejects.toThrow("changed before publication");
  expect(f.state.releases[0].draft).toBe(true);
});
for (const field of ["revision", "prHead", "run", "version", "dirty"]) test(`rejects an artifact from the wrong ${field}`, () => {
  const c = candidate(), path = join(c.root, "dist", "build-info.json");
  const info = JSON.parse(readFileSync(path, "utf8")); info[field] = field === "dirty" ? true : "wrong";
  writeFileSync(path, JSON.stringify(info));
  expect(() => readCandidate(c.root, sha, run)).toThrow("does not match");
});
test("rejects corrupted archives and mismatched package versions", () => {
  const c = candidate(); writeFileSync(join(c.root, "dist", c.value.assets[0]!.name), "corrupt");
  expect(() => readCandidate(c.root, sha, run)).toThrow("checksum");
  writeFileSync(join(c.root, "herdr-plugin.toml"), 'version = "0.3.0"');
  expect(() => readCandidate(c.root, sha, run)).toThrow("same stable");
});
