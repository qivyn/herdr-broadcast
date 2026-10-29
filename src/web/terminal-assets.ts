import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Detached runtime copies carry these assets; development resolves the installed packages. */
export function terminalAssets(): { name: string; path: string; type: string }[] {
  return [
    ["xterm.js", "@xterm/xterm", "text/javascript"],
    ["xterm.css", "@xterm/xterm/css/xterm.css", "text/css"],
    ["fit.js", "@xterm/addon-fit", "text/javascript"],
    ["unicode.js", "@xterm/addon-unicode-graphemes", "text/javascript"],
    ["xterm-LICENSE.txt", "@xterm/xterm/LICENSE", "text/plain"],
    ["fit-LICENSE.txt", "@xterm/addon-fit/LICENSE", "text/plain"],
    ["unicode-LICENSE.txt", "@xterm/addon-unicode-graphemes/LICENSE", "text/plain"],
  ].map(([name, specifier, type]) => {
    const local = join(import.meta.dir, "vendor", name!);
    return { name: name!, type: type!, path: existsSync(local) ? local : fileURLToPath(import.meta.resolve(specifier!)) };
  });
}
