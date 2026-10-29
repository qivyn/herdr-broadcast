/**
 * Links into herdr-web-ui (https://github.com/devswha/herdr-web-ui), whose address names the
 * place it shows (its src/lib/deepLink.ts):
 *
 *   ?machine=<pc>&ws=<workspace-id>-<slug>&pane=<pane-id>&view=chat|terminal
 *
 * `machine` is left out for the local PC. A herdr saved-machine profile appears there under an id
 * derived from the profile id (its server/herdr-profile-state.ts herdrMachineId). The slug guards
 * against a workspace id handed out again by a new session.
 */
import { createHash } from "node:crypto";
import { loadConfig } from "./config.ts";
import { LOCAL } from "./herdr.ts";

export const DEFAULT_WEB_URL = "http://localhost:7317/";

let configured: string | null | undefined;

export function webBaseUrl(): string {
  if (configured === undefined) configured = loadConfig().webUrl;
  return process.env.HERDR_BROADCAST_WEB_URL || configured || DEFAULT_WEB_URL;
}

/** herdr-web-ui's id for a herdr saved-machine profile. */
export function webMachineId(profileId: string): string {
  const digest = createHash("sha256").update("herdr-profile:" + profileId).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

const SLUG_MAX = 24;
const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "g");

/** herdr-web-ui's workspace slug: lowercase ASCII words joined by hyphens, cut short at a word. */
export function slugOf(label: string | null | undefined): string {
  const words = (label ?? "").normalize("NFKD").replace(COMBINING_MARKS, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (words.length <= SLUG_MAX) return words;
  const cut = words.slice(0, SLUG_MAX + 1);
  const end = cut.lastIndexOf("-");
  return (end > SLUG_MAX / 2 ? cut.slice(0, end) : words.slice(0, SLUG_MAX)).replace(/-+$/, "");
}

export interface LinkTarget {
  machineId: string;
  workspaceId: string | null;
  workspaceLabel?: string | null;
  paneId: string | null;
  view?: "chat" | "terminal";
}

export function webLink(target: LinkTarget, base: string = webBaseUrl()): string {
  const url = new URL(base);
  url.search = webLinkQuery(target);
  return url.toString();
}

/** The `?…` part alone, for a page that knows herdr-web-ui's address better (the browser's own host). */
export function webLinkQuery(target: LinkTarget): string {
  const query = new URLSearchParams();
  if (target.machineId !== LOCAL) query.set("machine", webMachineId(target.machineId));
  if (target.workspaceId) {
    const slug = slugOf(target.workspaceLabel);
    query.set("ws", slug ? `${target.workspaceId}-${slug}` : target.workspaceId);
  }
  if (target.paneId) {
    query.set("pane", target.paneId);
    query.set("view", target.view ?? "chat");
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}
