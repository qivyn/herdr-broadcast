/** Terminal output on its way to a page. */

/**
 * Keeps SGR (`ESC [ … m`: colors and text styles) for the page to draw, and removes every other
 * sequence a pane's output may carry: OSC (titles, hyperlinks), cursor and mode changes, charset
 * switches, control characters. Nothing that would move a cursor survives.
 */
export function sanitizeKeepStyle(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[([0-9;:?<=>]*)([ -/]*)([@-~])/g, (all, params: string, inter: string, final: string) => (final === "m" && !inter && !/[?<=>]/.test(params) ? all : ""))
    .replace(/\x1b[()*+#%][0-9A-Za-z@]?/g, "")
    .replace(/\x1b[0-9A-Za-z=>\\]/g, "")
    .replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, "")
    // an ESC left on its own is not the start of a style any more
    .replace(/\x1b(?!\[)/g, "");
}
