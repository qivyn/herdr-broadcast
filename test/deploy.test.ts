import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("certificate validation handles SAN and CN-only fixtures under errexit and pipefail", async () => {
  const root = mkdtempSync(join(tmpdir(), "bc-cert-test-"));
  const script = readFileSync(new URL("../deploy/headscale/install.sh", import.meta.url), "utf8");
  // Run the actual read-only certificate validation, without executing the root installer.
  const validation = script.slice(script.indexOf('names=$(openssl'), script.indexOf('ok "证书包含域名'));
  try {
    for (const san of [false, true]) {
      const cert = join(root, `${san}.pem`), key = join(root, `${san}.key`);
      const make = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=hs.example.com",
        ...(san ? ["-addext", "subjectAltName=DNS:hs.example.com,DNS:other.example.com"] : []), "-keyout", key, "-out", cert], { stdout: "ignore", stderr: "pipe" });
      const [code, stderr] = await Promise.all([make.exited, new Response(make.stderr).text()]);
      expect({ code, stderr: code ? stderr : "" }).toEqual({ code: 0, stderr: "" });
      for (const domain of ["hs.example.com", "unrelated.example.com"]) {
        const proc = Bun.spawn(["bash", "-c", `set -euo pipefail\ndie() { echo "$*" >&2; exit 1; }\n${validation}\nprintf 'validated\\n'`], {
          env: { ...process.env, CERT: cert, DOMAIN: domain }, stdout: "pipe", stderr: "pipe",
        });
        const [status, out, error] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        expect(status).toBe(domain === "hs.example.com" ? 0 : 1);
        if (status === 0) expect(out).toBe("validated\n");
        else expect(error).toContain("证书不包含域名");
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
