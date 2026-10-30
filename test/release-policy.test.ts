import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { releaseVersion, canPublish } from "../scripts/publish-release.ts";

test("release versions are stable and agree across package and manifest", () => {
  expect(releaseVersion("0.3.1", "0.3.1")).toBe("0.3.1");
  for (const [pkg, manifest] of [["0.3.1", "0.3.0"], ["0.3.1-rc.1", "0.3.1-rc.1"], ["01.3.1", "01.3.1"], [undefined, undefined]]) {
    expect(() => releaseVersion(pkg, manifest)).toThrow();
  }
});

test("only main pushes with all required jobs successful may publish", () => {
  const success = { tests: { result: "success" }, e2e: { result: "success" }, build: { result: "success" } };
  expect(canPublish("push", "refs/heads/main", success)).toBe(true);
  for (const event of ["pull_request", "workflow_dispatch", "pull_request_target"]) expect(canPublish(event, "refs/heads/main", success)).toBe(false);
  expect(canPublish("push", "refs/heads/feature", success)).toBe(false);
  for (const job of ["tests", "e2e", "build"]) {
    for (const result of ["failure", "cancelled", "skipped", ""]) expect(canPublish("push", "refs/heads/main", { ...success, [job]: { result } })).toBe(false);
  }
  expect(canPublish("push", "refs/heads/main", {})).toBe(false);
});

test("workflow gates publishing behind the four checks and uses the same build", () => {
  const workflow = Bun.YAML.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")) as any;
  const release = workflow.jobs.release;
  expect(release.needs.sort()).toEqual(["build", "e2e", "tests"]);
  expect(release.if).toContain("github.event_name == 'push'");
  expect(release.if).toContain("github.ref == 'refs/heads/main'");
  expect(release.permissions).toEqual({ contents: "write" });
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.concurrency["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
  const download = release.steps.find((step: any) => step.uses?.startsWith("actions/download-artifact@"));
  expect(download.with).toEqual({ name: "plugin-${{ github.sha }}", path: "dist/" });
  const publish = release.steps.find((step: any) => step.run === "bun scripts/publish-release.ts");
  expect(publish.env.RELEASE_NEEDS).toBe("${{ toJSON(needs) }}");
});
