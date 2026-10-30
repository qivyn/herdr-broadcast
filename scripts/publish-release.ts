/** Publish only the candidate produced by the successful main CI run. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
export function releaseVersion(pkg: unknown, manifest: unknown): string {
  if (typeof pkg !== "string" || !stable.test(pkg) || pkg !== manifest) throw new Error("Package and manifest must have the same stable MAJOR.MINOR.PATCH version");
  return pkg;
}
export function canPublish(event: string | undefined, ref: string | undefined, needs: Record<string, { result?: string }>): boolean {
  return event === "push" && ref === "refs/heads/main" && ["tests", "e2e", "build"].every(job => needs[job]?.result === "success");
}
export interface Candidate { version: string; sha: string; run: string; assets: { name: string; data: Buffer }[] }
export function readCandidate(root: string, sha: string, run: string): Candidate {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const manifest = Bun.TOML.parse(readFileSync(join(root, "herdr-plugin.toml"), "utf8")) as { version?: unknown };
  const version = releaseVersion(pkg.version, manifest.version);
  const archive = `herdr-broadcast-${version}.tar.gz`;
  const assets = [archive, `${archive}.sha256`, "build-info.json"].map(name => ({ name, data: readFileSync(join(root, "dist", name)) }));
  const info = JSON.parse(assets[2]!.data.toString());
  if (!/^[a-f0-9]{40}$/.test(sha) || !/^\d+$/.test(run) || info.revision !== sha || info.prHead !== sha || info.run !== run || info.version !== version || info.dirty !== false) {
    throw new Error("Build artifact does not match this clean CI commit, version and run");
  }
  if (!assets[0]!.data.length || assets[1]!.data.toString().trim() !== `${digest(assets[0]!.data)}  ${archive}`) throw new Error("Build archive checksum mismatch");
  return { version, sha, run, assets };
}
type ApiRelease = { id: number; tag_name: string; draft: boolean; prerelease: boolean; body: string | null; upload_url: string };
type GitObject = { type: string; sha: string };
type Asset = { id: number; name: string; state: string; size: number; digest: string | null };
export type ReleaseRequest = (url: string, init: RequestInit) => Promise<Response>;
export async function publishRelease(repository: string, token: string, candidate: Candidate, request: ReleaseRequest = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !token) throw new Error("Repository and GitHub token are required");
  const { version, sha, run, assets } = candidate;
  releaseVersion(version, version);
  const base = `https://api.github.com/repos/${repository}`, tag = `v${version}`;
  const api = async (path: string, method = "GET", body?: unknown, missing = false, binary?: Buffer): Promise<any> => {
    const url = path.startsWith("https://") ? path : `${base}${path}`;
    const response = await request(url, { method, redirect: "error", signal: AbortSignal.timeout(60_000), headers: {
      Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "herdr-broadcast-release", "Content-Type": binary ? "application/octet-stream" : "application/json",
    }, body: binary ? new Uint8Array(binary) : (body === undefined ? undefined : JSON.stringify(body)) });
    if (missing && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`GitHub ${method} ${new URL(url).pathname}: HTTP ${response.status}`); }
    return response.status === 204 ? null : response.json();
  };
  const releases: ApiRelease[] = [];
  for (let page = 1; ; page++) {
    const batch = await api(`/releases?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error("Invalid release list");
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  // Compare all published stable versions, not GitHub's chronological ordering.
  for (const release of releases) {
    const previous = release.tag_name.replace(/^v/, "");
    if (!release.draft && !release.prerelease && Bun.semver.satisfies(previous, ">=0.0.0") && Bun.semver.order(version, previous) <= 0) {
      return { published: false, reason: `Version ${version} is not newer than ${release.tag_name}` };
    }
  }
  const marker = `<!-- herdr-broadcast CI ${sha} run ${run} -->`;
  let release = releases.find(item => item.tag_name === tag);
  if (release && (!release.draft || !release.body?.includes(marker))) throw new Error(`Release ${tag} already exists outside this CI run`);
  const ref = await api(`/git/ref/tags/${tag}`, "GET", undefined, true);
  if (ref) {
    let object: GitObject = ref.object;
    for (let depth = 0; object.type === "tag" && depth < 10; depth++) object = (await api(`/git/tags/${object.sha}`)).object;
    if (object.type !== "commit" || object.sha !== sha) throw new Error(`Tag ${tag} does not point to tested commit ${sha}`);
  } else await api("/git/refs", "POST", { ref: `refs/tags/${tag}`, sha });
  if (!release) release = await api("/releases", "POST", {
    tag_name: tag, target_commitish: sha, name: tag, body: marker,
    draft: true, prerelease: false, generate_release_notes: true,
  }) as ApiRelease;
  const upload = new URL(release.upload_url.replace(/\{.*$/, ""));
  if (upload.origin !== "https://uploads.github.com" || upload.pathname !== `/repos/${repository}/releases/${release.id}/assets`) throw new Error("Unexpected release upload URL");
  const existing = await api(`/releases/${release.id}/assets?per_page=100`) as Asset[];
  if (existing.some(asset => !assets.some(local => local.name === asset.name))) throw new Error("CI draft contains unexpected assets");
  for (const asset of assets) {
    const remote = existing.find(item => item.name === asset.name);
    const checksum = `sha256:${digest(asset.data)}`;
    if (remote?.state === "uploaded" && remote.size === asset.data.length && remote.digest === checksum) continue;
    // Only our own draft is mutable; this also recovers GitHub's failed 'starter' uploads.
    if (remote) await api(`/releases/assets/${remote.id}`, "DELETE");
    upload.search = new URLSearchParams({ name: asset.name }).toString();
    const saved = await api(upload.toString(), "POST", undefined, false, asset.data) as Asset;
    if (saved.state !== "uploaded" || saved.name !== asset.name || saved.size !== asset.data.length || (saved.digest && saved.digest !== checksum)) throw new Error(`Asset verification failed: ${asset.name}`);
  }
  // GitHub ignores target_commitish for existing tags, so recheck the tag before publication.
  const finalRef = await api(`/git/ref/tags/${tag}`);
  let object: GitObject = finalRef.object;
  for (let depth = 0; object.type === "tag" && depth < 10; depth++) object = (await api(`/git/tags/${object.sha}`)).object;
  if (object.type !== "commit" || object.sha !== sha) throw new Error(`Tag ${tag} changed before publication`);
  const published = await api(`/releases/${release.id}`, "PATCH", { draft: false, prerelease: false, make_latest: "true" });
  if (published.draft !== false || published.prerelease !== false || published.tag_name !== tag) throw new Error("Release publication was not confirmed");
  return { published: true, tag, url: published.html_url as string };
}

if (import.meta.main) {
  const env = process.env;
  if (!canPublish(env.GITHUB_EVENT_NAME, env.GITHUB_REF, JSON.parse(env.RELEASE_NEEDS || "{}"))) {
    console.log("Release skipped: requires a main push and successful Unit, Integration, Core E2E and Build");
  } else {
    const root = resolve(import.meta.dir, "..");
    const result = await publishRelease(env.GITHUB_REPOSITORY || "", env.GITHUB_TOKEN || "", readCandidate(root, env.GITHUB_SHA || "", env.GITHUB_RUN_ID || ""));
    console.log(JSON.stringify(result));
  }
}
