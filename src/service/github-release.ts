/** Public GitHub release metadata. Git, not target_commitish, resolves the tag's commit. */
export type ReleaseFetch = (url: string, init?: RequestInit) => Promise<Response>;
export interface PublishedRelease { tag: string; version: string }
const stableTag = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;

export async function latestRelease(owner: string, repo: string, signal: AbortSignal,
  request: ReleaseFetch = fetch, timeoutMs = 10_000): Promise<PublishedRelease | null> {
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) throw new Error("无效的 GitHub 来源");
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const get = async (url: string) => request(url, { signal: deadline, headers: {
    Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "herdr-broadcast",
  } });
  const ensureOK = (response: Response) => {
    if (!response.ok) throw new Error(response.status === 403 || response.status === 429
      ? `GitHub Release 检查受限（HTTP ${response.status}），请稍后重试`
      : `GitHub Release 检查失败（HTTP ${response.status}）`);
  };
  try {
    const response = await get(`${base}/releases/latest`);
    if (response.status === 404) {
      await response.body?.cancel();
      // A missing/inaccessible repository also returns 404; it is not "no releases".
      const repository = await get(base);
      await repository.body?.cancel();
      ensureOK(repository);
      return null;
    }
    if (!response.ok) { await response.body?.cancel(); ensureOK(response); }
    const release = await response.json() as Record<string, unknown>;
    const match = typeof release?.tag_name === "string" ? stableTag.exec(release.tag_name) : null;
    if (!match || release.draft !== false || release.prerelease !== false
      || typeof release.published_at !== "string" || !Number.isFinite(Date.parse(release.published_at))) {
      throw new Error("GitHub 未返回有效的正式 Release（需要已发布的稳定版本 tag）");
    }
    deadline.throwIfAborted();
    return { tag: release.tag_name as string, version: match[1]! };
  } catch (error) {
    if (signal.aborted) throw new Error("更新已取消");
    if (deadline.aborted) throw new Error("GitHub Release 检查超时，请稍后重试");
    throw error;
  }
}
