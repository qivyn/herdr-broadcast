/**
 * The Herdr binary a server needs, downloaded here before `herdr machine add` runs.
 *
 * Herdr downloads it itself with a fixed time limit, which a slow link to GitHub does not meet
 * ("download failed"). Here it is fetched with no limit but a stall, resumed where a dropped
 * connection left it, checked against the release's SHA-256, kept for the next server, and handed
 * to Herdr as `HERDR_REMOTE_BINARY`, which Herdr uploads over the SSH connection it already has.
 */
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

/** Herdr's release manifest; another address only in tests */
const manifestUrl = () => process.env.HERDR_BROADCAST_RELEASES_URL || "https://herdr.dev/latest.json";
/** a download that receives nothing for this long is dropped and resumed */
const STALL_MS = 60_000;
const ATTEMPTS = 8;

export interface Progress {
  done: number;
  total: number | null;
}

/** `uname -sm` as Herdr names its builds: `linux-aarch64`, `macos-x86_64`. */
export function platformOf(system: string | null): string | null {
  const [os = "", cpu = ""] = (system ?? "").trim().split(/\s+/);
  const o = /^linux$/i.test(os) ? "linux" : /^darwin$/i.test(os) ? "macos" : null;
  const c = /^(x86_64|amd64)$/i.test(cpu) ? "x86_64" : /^(aarch64|arm64)$/i.test(cpu) ? "aarch64" : null;
  return o && c ? `${o}-${c}` : null;
}

/** `herdr 0.9.5` → `0.9.5` */
export function versionOf(text: string | null): string | null {
  return text ? /\d+\.\d+\.\d+[\w.-]*/.exec(text)?.[0] ?? null : null;
}

interface Release {
  assets?: Record<string, string>;
  sha256?: Record<string, string>;
}

/** Where a version's build for a platform is, and its checksum, from Herdr's release manifest. */
export function assetIn(manifest: unknown, version: string, platform: string): { url: string; sha256: string } {
  const m = (manifest ?? {}) as Release & { version?: string; releases?: Record<string, Release> };
  const release = m.releases?.[version] ?? (m.version === version ? m : null);
  const url = release?.assets?.[platform];
  const sha256 = release?.sha256?.[platform];
  if (!url || !sha256) throw new Error(`Herdr ${version} 没有 ${platform} 的版本`);
  // https, or this computer (tests); the checksum is checked either way
  if (!/^(https:\/\/|http:\/\/127\.0\.0\.1[:/])/.test(url) || !/^[0-9a-f]{64}$/i.test(sha256)) throw new Error("Herdr 的发布清单格式不对");
  return { url, sha256: sha256.toLowerCase() };
}

async function sha256Of(file: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(file).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

async function fetchManifest(signal: AbortSignal): Promise<unknown> {
  let last: unknown = null;
  for (let i = 0; i < 3; i += 1) {
    try {
      const res = await fetch(manifestUrl(), { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (error) {
      if (signal.aborted) throw error;
      last = error;
      await Bun.sleep(2_000);
    }
  }
  throw new Error(`读不到 Herdr 的发布清单（${manifestUrl()}）：${last instanceof Error ? last.message : String(last)}`);
}

/** One pass at the file: appends to what `part` already has, until done, a stall or an error. */
async function fetchInto(url: string, part: string, onProgress: (p: Progress) => void, signal: AbortSignal): Promise<void> {
  let have = existsSync(part) ? statSync(part).size : 0;
  const stall = new AbortController();
  let timer = setTimeout(() => stall.abort(), STALL_MS);
  try {
    const res = await fetch(url, { headers: have ? { range: `bytes=${have}-` } : {}, signal: AbortSignal.any([signal, stall.signal]) });
    if (res.status === 416) return; // nothing left to send: the checksum decides
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (have && res.status !== 206) have = 0; // the server sent it all again
    const range = /\/(\d+)$/.exec(res.headers.get("content-range") ?? "");
    const length = Number(res.headers.get("content-length"));
    const total = range ? Number(range[1]) : length ? have + length : null;
    const fd = openSync(part, have ? "a" : "w");
    try {
      onProgress({ done: have, total });
      for await (const chunk of res.body!) {
        writeSync(fd, chunk);
        have += chunk.length;
        clearTimeout(timer);
        timer = setTimeout(() => stall.abort(), STALL_MS);
        onProgress({ done: have, total });
      }
    } finally {
      closeSync(fd);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The verified binary for `version` on `platform`, in `dir`: from an earlier download, or
 * downloaded now. Throws when it cannot be had.
 */
export async function herdrAsset(dir: string, version: string, platform: string, onProgress: (p: Progress) => void, signal: AbortSignal): Promise<string> {
  const folder = join(dir, "herdr-assets", version);
  const file = join(folder, `herdr-${platform}`);
  const manifest = await fetchManifest(signal);
  const { url, sha256 } = assetIn(manifest, version, platform);
  if (existsSync(file) && (await sha256Of(file)) === sha256) return file;
  mkdirSync(folder, { recursive: true });
  const part = `${file}.part`;
  let last: unknown = null;
  for (let i = 0; i < ATTEMPTS; i += 1) {
    try {
      await fetchInto(url, part, onProgress, signal);
      if ((await sha256Of(part)) === sha256) {
        chmodSync(part, 0o755);
        renameSync(part, file);
        return file;
      }
      // complete but wrong: start over once more rather than resume a bad file
      rmSync(part, { force: true });
      last = new Error("下载的文件校验不通过");
    } catch (error) {
      if (signal.aborted) throw error;
      last = error;
    }
    await Bun.sleep(Math.min(2_000 * (i + 1), 10_000));
  }
  throw new Error(`下载 Herdr ${version}（${platform}）失败：${last instanceof Error ? last.message : String(last)}`);
}
