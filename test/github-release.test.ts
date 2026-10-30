import { afterEach, expect, test } from "bun:test";
import { latestRelease, type ReleaseFetch } from "../src/service/github-release.ts";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop(true));
const published = { tag_name: "v0.3.1", draft: false, prerelease: false, published_at: "2026-10-30T00:00:00Z", target_commitish: "main" };
function api(handler: (request: Request) => Response | Promise<Response>) {
  const requests: { url: string; headers: Headers }[] = [];
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    requests.push({ url: request.url, headers: new Headers(request.headers) }); return handler(request);
  } });
  const request: ReleaseFetch = (url, init) => {
    expect(new URL(url).origin).toBe("https://api.github.com");
    return fetch(new URL(new URL(url).pathname, server!.url), init);
  };
  return { request, requests };
}
test("release client requests the latest full release and uses its tag, not target_commitish", async () => {
  const f = api(() => Response.json(published));
  expect(await latestRelease("test", "broadcast", new AbortController().signal, f.request)).toEqual({ tag: "v0.3.1", version: "0.3.1" });
  expect(f.requests.map(r => new URL(r.url).pathname)).toEqual(["/repos/test/broadcast/releases/latest"]);
  expect(f.requests[0]!.headers.get("Accept")).toBe("application/vnd.github+json");
  expect(f.requests[0]!.headers.get("User-Agent")).toBe("herdr-broadcast");
});
test("404 means no release only if the repository remains accessible", async () => {
  const f = api(r => new URL(r.url).pathname.endsWith("/latest") ? new Response(null, { status: 404 }) : Response.json({ id: 1 }));
  expect(await latestRelease("test", "broadcast", new AbortController().signal, f.request)).toBeNull();
  expect(f.requests.map(r => new URL(r.url).pathname)).toEqual(["/repos/test/broadcast/releases/latest", "/repos/test/broadcast"]);
});
for (const status of [403, 404, 429, 500, 503]) test(`HTTP ${status} cannot be reported as up to date`, async () => {
  const f = api(() => new Response("upstream failed", { status }));
  await expect(latestRelease("test", "broadcast", new AbortController().signal, f.request)).rejects.toThrow(`HTTP ${status}`);
  expect(f.requests.length).toBe(status === 404 ? 2 : 1);
});
for (const value of [null, {}, { ...published, draft: true }, { ...published, prerelease: true }, { ...published, published_at: null },
  { ...published, tag_name: "v0.4.0-rc.1" }, { ...published, tag_name: "../main" }, { ...published, tag_name: "v01.2.3" }]) {
  test(`malformed or non-stable metadata cannot select an update: ${JSON.stringify(value)}`, async () => {
    const f = api(() => Response.json(value));
    await expect(latestRelease("test", "broadcast", new AbortController().signal, f.request)).rejects.toThrow("正式 Release");
  });
}
test("malformed JSON is a check error", async () => {
  const f = api(() => new Response("<html>gateway error</html>"));
  await expect(latestRelease("test", "broadcast", new AbortController().signal, f.request)).rejects.toThrow();
});
test("release requests have a deadline", async () => {
  const f = api(async () => { await Bun.sleep(150); return Response.json(published); });
  await expect(latestRelease("test", "broadcast", new AbortController().signal, f.request, 20)).rejects.toThrow("超时");
});
test("cancelling an in-flight request ends the check", async () => {
  const controller = new AbortController();
  const f = api(async () => { controller.abort(); await Bun.sleep(150); return Response.json(published); });
  await expect(latestRelease("test", "broadcast", controller.signal, f.request)).rejects.toThrow("取消");
});
