import { resolve } from "node:path";

// Fast component/helper tests. unit.test.ts also contains small SQLite/HTTP fixtures.
// Everything else defaults to integration, so adding a test cannot silently omit it from CI.
const unit = new Set(["unit.test.ts", "page.test.ts", "session-file.test.ts", "update-state.test.ts", "release-policy.test.ts"]);
const [suite, ...args] = process.argv.slice(2);
if (suite !== "unit" && suite !== "integration") throw new Error("Usage: bun scripts/test-suite.ts unit|integration [bun test options]");
const root = resolve(import.meta.dir, "..");
const discovered = [...new Bun.Glob("**/*.test.ts").scanSync({ cwd: resolve(root, "test") })].sort();
for (const file of unit) if (!discovered.includes(file)) throw new Error(`Missing unit suite file: ${file}`);
const files = discovered.filter(file => unit.has(file) === (suite === "unit")).map(file => `./test/${file}`);
if (!files.length) throw new Error(`Empty test suite: ${suite}`);
console.log(JSON.stringify({ suite, files }));
if (!args.includes("--list")) {
  const child = Bun.spawn([process.execPath, "test", ...files, ...args], { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  process.exit(await child.exited);
}
