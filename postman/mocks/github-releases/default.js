// Contract: https://docs.github.com/en/rest/releases/releases#get-the-latest-release
// Synthetic repositories select deterministic outcomes; no GitHub credentials or writes.
const http = require("node:http");
const { createHash } = require("node:crypto");
const releasePublication = new Map();
async function publish(req, url, send) {
  const match = /^\/repos\/test\/(publish-ok|upload-failure|lost-response|conflicting-tag)(.*)$/.exec(url.pathname);
  if (!match) return false;
  const [, repo, path] = match;
  if (req.headers.authorization !== "Bearer simulation-token") { send(401, {}); return true; }
  if (!releasePublication.has(repo)) releasePublication.set(repo, { tag: repo === "conflicting-tag" ? "b".repeat(40) : null, release: null, assets: [], failed: false, writes: [] });
  const state = releasePublication.get(repo);
  // Postman's interceptor has already consumed the stream and populated req.body.
  const binary = req.headers["content-type"] === "application/octet-stream";
  const bytes = binary ? Buffer.from(req.body || "") : Buffer.alloc(0);
  const body = binary ? null : req.body;
  if (req.method !== "GET") state.writes.push(`${req.method} ${path}`);
  if (req.method === "GET" && path === "/releases") send(200, state.release ? [state.release] : []);
  else if (req.method === "GET" && path === "/git/ref/tags/v0.3.1") send(state.tag ? 200 : 404, { object: { type: "commit", sha: state.tag } });
  else if (req.method === "POST" && path === "/git/refs") { state.tag = body.sha; send(201, { object: { type: "commit", sha: state.tag } }); }
  else if (req.method === "POST" && path === "/releases") {
    state.release = { id: 1, ...body, upload_url: `https://uploads.github.com/repos/test/${repo}/releases/1/assets{?name,label}` }; send(201, state.release);
  } else if (req.method === "GET" && path === "/releases/1/assets") send(200, state.assets);
  else if (req.method === "POST" && path === "/releases/1/assets") {
    if (repo === "upload-failure" && !state.failed) { state.failed = true; send(502, {}); }
    else {
      const asset = { id: state.assets.length + 1, name: url.searchParams.get("name"), state: "uploaded", size: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
      state.assets.push(asset); send(201, asset);
    }
  } else if (req.method === "PATCH" && path === "/releases/1") {
    Object.assign(state.release, body);
    if (repo === "lost-response" && !state.failed) { state.failed = true; send(503, {}); }
    else send(200, { ...state.release, html_url: `https://github.com/test/${repo}/releases/tag/v0.3.1` });
  } else send(501, { message: "Endpoint not modeled" });
  return true;
}
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  // Local fixture observation only; never forwarded to GitHub.
  if (req.method === "GET" && url.pathname.startsWith("/_release-state/")) return send(200, releasePublication.get(url.pathname.split("/").at(-1)) || null);
  if (await publish(req, url, send)) return;
  const match = /^\/repos\/test\/(stable|empty|missing|limited|outage|prerelease|slow)(\/releases\/latest)?$/.exec(url.pathname);
  if (req.method !== "GET" || !match) return send(501, { message: "Endpoint not modeled" });
  const [, repository, latest] = match;
  if (repository === "missing" || (repository === "empty" && latest)) return send(404, { message: "Not Found" });
  if (repository === "limited") return send(403, { message: "API rate limit exceeded" });
  if (repository === "outage") return send(503, { message: "Service Unavailable" });
  if (!latest) return send(200, { id: 1, name: repository, private: false });
  if (repository === "slow") await new Promise(resolve => setTimeout(resolve, 500));
  send(200, { id: 1, tag_name: "v0.3.1", target_commitish: "main", draft: false,
    prerelease: repository === "prerelease", published_at: "2026-10-30T00:00:00Z" });
}).listen(process.env.PORT);
