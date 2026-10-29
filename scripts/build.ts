import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const output = join(root, "dist");
const stage = mkdtempSync(join(tmpdir(), "bc-build-"));
async function run(cmd: string[], cwd: string) {
  const child = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "inherit" });
  const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code) throw new Error(`${cmd.join(" ")} exited ${code}`);
  return text.trim();
}
try {
  mkdirSync(output, { recursive: true });
  // Explicit allowlist: no user configs, databases, logs or credentials enter the package.
  for (const file of ["src", "scripts", "test", "package.json", "bun.lock", "tsconfig.json", "herdr-plugin.toml", "README.md", "LICENSE"]) {
    cpSync(join(root, file), join(stage, file), { recursive: true });
  }
  const version = JSON.parse(readFileSync(join(stage, "package.json"), "utf8")).version as string;
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) throw new Error("Invalid package version");
  // Use the manifest's production-install contract in a clean directory.
  await run([process.execPath, "install", "--production", "--frozen-lockfile"], stage);
  if (readFileSync(join(stage, "bun.lock"), "utf8") !== readFileSync(join(root, "bun.lock"), "utf8")) throw new Error("Install changed the lockfile");
  const runtime = JSON.parse(await run([process.execPath, "src/service/entry.ts", "describe"], stage));
  for (const path of ["src/web/page.js", "src/web/terminal.js"]) new Bun.Transpiler({ loader: "js" }).transformSync(readFileSync(join(stage, path), "utf8"));
  const assets = JSON.parse(await run([process.execPath, "src/service/entry.ts", "assets"], stage)) as { name: string; path: string }[];
  for (const asset of assets) if (!readFileSync(asset.path).length) throw new Error(`Empty runtime asset: ${asset.name}`);
  const revision = await run(["git", "rev-parse", "HEAD"], root);
  const dirty = !!(await run(["git", "status", "--porcelain"], root));
  const hash = createHash("sha256");
  for (const file of [...new Bun.Glob("**/*").scanSync({ cwd: stage, onlyFiles: true })].filter(f => !f.startsWith("node_modules/")).sort()) hash.update(file).update(readFileSync(join(stage, file)));
  const info = { ...runtime, revision, dirty, sourceSha256: hash.digest("hex"), bun: Bun.version, prHead: process.env.PR_HEAD_SHA || null, run: process.env.GITHUB_RUN_ID || null };
  writeFileSync(join(stage, "build-info.json"), JSON.stringify(info, null, 2) + "\n");
  const archive = `herdr-broadcast-${version}.tar.gz`;
  await run(["tar", "-czf", join(output, archive), "--exclude=node_modules", "-C", stage, "."], root);
  const sha256 = createHash("sha256").update(readFileSync(join(output, archive))).digest("hex");
  writeFileSync(join(output, `${archive}.sha256`), `${sha256}  ${archive}\n`);
  writeFileSync(join(output, "build-info.json"), JSON.stringify(info, null, 2) + "\n");
  console.log(JSON.stringify({ archive, sha256, ...info }, null, 2));
} finally { rmSync(stage, { recursive: true, force: true }); }
