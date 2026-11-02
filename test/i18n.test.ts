import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/web/i18n.js", import.meta.url), "utf8");
function language(options: { saved?: string; languages?: string[]; blocked?: boolean; document?: any } = {}) {
  const storage = new Map(options.saved ? [["broadcast.language", options.saved]] : []);
  const i18n = runInNewContext(source + "\nBroadcastI18n", {
    navigator: { languages: options.languages || ["en-US"] }, document: options.document,
    localStorage: {
      getItem(key: string) { if (options.blocked) throw new Error("storage blocked"); return storage.get(key) ?? null; },
      setItem(key: string, value: string) { if (options.blocked) throw new Error("storage blocked"); storage.set(key, value); },
    },
  });
  return { i18n, storage };
}

test("language prefers a saved choice, otherwise uses supported browser languages with an English fallback", () => {
  expect(language({ saved: "zh-CN" }).i18n.language).toBe("zh-CN");
  expect(language({ saved: "en", languages: ["zh-TW"] }).i18n.language).toBe("en");
  expect(language({ languages: ["fr-FR", "zh-HK", "en-US"] }).i18n.language).toBe("zh-CN");
  expect(language({ saved: "invalid", languages: ["fr-FR"] }).i18n.language).toBe("en");
  expect(language({ blocked: true, languages: ["zh-CN"] }).i18n.language).toBe("zh-CN");
});

test("language choices persist and survive reload; invalid or blocked writes do not change the active language", () => {
  const { i18n, storage } = language();
  expect(i18n.setLanguage("zh-CN")).toBe(true);
  expect(storage.get("broadcast.language")).toBe("zh-CN");
  expect(language({ saved: storage.get("broadcast.language") }).i18n.t("新建广播")).toBe("新建广播");
  expect(i18n.setLanguage("fr")).toBe(false);
  const blocked = language({ blocked: true }).i18n;
  expect(blocked.setLanguage("zh-CN")).toBe(false); expect(blocked.language).toBe("en");
});

test("translated templates retain literal user values without translating or interpreting them", () => {
  const { i18n } = language();
  expect(i18n.t("第 {0} 轮", [2])).toBe("Round 2");
  expect(i18n.t("添加 {0}", ["设置 $& <img> {1}"])).toBe("Add 设置 $& <img> {1}");
  expect(i18n.message("failed: 本机没有这个目录：/tmp/中文")).toBe("failed: Local directory does not exist: /tmp/中文");
  expect(i18n.message("unrecognized external output")).toBe("unrecognized external output");
});

test("metadata translates diagnostics and the system Local label while preserving all user and identity content", () => {
  const original = { title: "新建广播", prompt: "发送中", agent_name: "设置", cwd: "/tmp/目录", command: "echo 已发送",
    session_value: "已发送", workspace_label: "工作区", machine_id: "local", machine_label: "本机",
    error: "尚未检测到持续运行的 Agent，请先在终端完成启动", output: "发送失败",
    new: [{ kind: "custom", label: "本机", command: "我的命令" }] };
  const { i18n } = language();
  const result = i18n.metadata(original);
  expect(result.machine_label).toBe("Local");
  expect(result.error).toBe("No persistent Agent process detected yet. Complete startup in the terminal first.");
  for (const key of ["title", "prompt", "agent_name", "cwd", "command", "session_value", "workspace_label", "output", "new"] as const) expect(result[key]).toEqual(original[key]);
  expect(original.machine_label).toBe("本机");
});

test("static navigation localizes text, accessibility names, placeholders and document language", () => {
  const text = { textContent: "", getAttribute: () => "新建广播" };
  const attrs: Record<string, string> = {};
  const input = { getAttribute: () => "搜索广播", setAttribute: (name: string, value: string) => { attrs[name] = value; } };
  const doc = { documentElement: { lang: "" }, title: "", querySelectorAll: (selector: string) => selector === "[data-i18n]" ? [text] : [input] };
  language({ document: doc }).i18n.applyStatic();
  expect(doc.documentElement.lang).toBe("en"); expect(doc.title).toBe("Herdr Broadcast");
  expect(text.textContent).toBe("New broadcast"); expect(attrs["aria-label"]).toBe("Search broadcasts"); expect(attrs.placeholder).toBe("Search broadcasts");
});

test("every declared UI message has an English translation with all template values intact", () => {
  const i18n = language().i18n;
  const page = readFileSync(new URL("../src/web/page.js", import.meta.url), "utf8");
  const tree = ts.createSourceFile("page.js", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const keys = new Set<string>();
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "t" && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) keys.add(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  const html = readFileSync(new URL("../src/web/page.html", import.meta.url), "utf8");
  expect(html).not.toMatch(/content:\s*["'][^"']*\p{Script=Han}/u);
  for (const match of html.matchAll(/data-i18n(?:-[\w-]+)?="([^"]+)"/g)) keys.add(match[1]!);
  expect(keys.size).toBeGreaterThan(500);
  for (const key of keys) {
    const values = Array.from({ length: 10 }, (_, i) => `<value-${i}>`);
    const translated = i18n.t(key, values);
    expect(translated, key).not.toMatch(/\p{Script=Han}/u);
    for (const match of key.matchAll(/\{(\d+)\}/g)) expect(translated, key).toContain(values[Number(match[1])]);
  }
});
