import { resolve } from "node:path";

// Real Herdr / PTY / HTTP / WebSocket paths with a deterministic agent; no model calls.
for (const script of ["e2e-real.ts", "e2e-terminal.ts", "e2e-manual.ts"]) {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, script)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) process.exit(code);
}
