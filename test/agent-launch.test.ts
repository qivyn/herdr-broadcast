import { expect, test } from "bun:test";
import { agentLaunchArgs, codexInputBlock } from "../src/agent-launch.ts";

test("Codex capability is checked on the actual target for launch, picker and exact resume", async () => {
  const seen: string[] = [];
  const run = async (machine: string, script: string) => { seen.push(machine); expect(script).toContain("codex --help"); return { code: 0, stdout: "  --no-daemon\n", stderr: "" }; };
  for (const machine of ["local", "saved-ssh"]) for (const args of [[], ["resume"], ["resume", "original-id"]]) {
    expect(await agentLaunchArgs(machine, "codex", args, run)).toEqual(["--no-daemon", ...args]);
  }
  expect(seen).toEqual(["local", "local", "local", "saved-ssh", "saved-ssh", "saved-ssh"]);
  expect(await agentLaunchArgs("elsewhere", "pi", ["--session", "x"], run)).toEqual(["--session", "x"]);
  expect(seen).toHaveLength(6);
  for (const result of [{ code: 0, stdout: "--daemon\n", stderr: "" }, { code: 255, stdout: "--no-daemon", stderr: "offline" }]) {
    await expect(agentLaunchArgs("saved-ssh", "codex", [], async () => result)).rejects.toThrow("未启动会话");
  }
});

test("Codex modal detection covers review, hooks management and history selection without matching chat prose", () => {
  for (const text of ["  Hooks need review\n1 hook is new or changed\nenter confirm · esc skip", "  Hooks\nLifecycle hooks from config and enabled plugins.\nt trust all · enter review · esc close", "Resume a previous session\nenter select · esc back", "Review SessionStart hook\ncommand: fixture\nt trust · esc back"]) expect(codexInputBlock(text)).not.toBeNull();
  expect(codexInputBlock("› Explain what Hooks need review means\n100% context left")).toBeNull();
  expect(codexInputBlock("Discuss hooks\nThe script says Hooks need review.\n› ")).toBeNull();
});
