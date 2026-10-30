// Contract: https://docs.github.com/en/rest/releases/releases#get-the-latest-release
// Synthetic repositories select deterministic outcomes; no GitHub credentials or writes.
const http = require("node:http");
http.createServer(async (req, res) => {
  const match = /^\/repos\/test\/(stable|empty|missing|limited|outage|prerelease|slow)(\/releases\/latest)?$/.exec(new URL(req.url, "http://localhost").pathname);
  const send = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
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
