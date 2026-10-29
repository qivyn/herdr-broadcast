/**
 * User settings, in config.toml under the plugin's config directory
 * (`herdr plugin config-dir herdr-broadcast`):
 *
 *   web_url = "http://localhost:7317/"   # herdr-web-ui, for the page's links to it
 *
 *   # the broadcast web page
 *   web_port = 7318
 *   web_host = "127.0.0.1"      # what it listens on; keep it on loopback and reach it through Tailscale or SSH
 *   web_token = "…"             # required from every browser once set; set it before exposing the port
 *   web_hosts = ["mypc.tail1234.ts.net"]   # Host names to accept besides localhost (a proxy's)
 *   web_autostart = true        # start it with Herdr
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  webUrl: string | null;
  webPort: number | null;
  webHost: string | null;
  webToken: string | null;
  webHosts: string[];
  /** start the web page with Herdr (the startup hook) */
  webAutostart: boolean;
}

export function configDir(): string {
  return process.env.HERDR_PLUGIN_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "herdr", "plugins", "config", "herdr-broadcast");
}

export function loadConfig(): Config {
  const file = join(configDir(), "config.toml");
  const config: Config = { webUrl: null, webPort: null, webHost: null, webToken: null, webHosts: [], webAutostart: true };
  if (!existsSync(file)) return config;
  try {
    const parsed = Bun.TOML.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (typeof parsed.web_url === "string" && parsed.web_url) config.webUrl = parsed.web_url;
    if (typeof parsed.web_port === "number" && Number.isInteger(parsed.web_port) && parsed.web_port > 0 && parsed.web_port < 65536) config.webPort = parsed.web_port;
    if (typeof parsed.web_host === "string" && parsed.web_host) config.webHost = parsed.web_host;
    if (typeof parsed.web_token === "string" && parsed.web_token) config.webToken = parsed.web_token;
    if (Array.isArray(parsed.web_hosts)) config.webHosts = parsed.web_hosts.filter((h): h is string => typeof h === "string" && h.length > 0);
    if (typeof parsed.web_autostart === "boolean") config.webAutostart = parsed.web_autostart;
  } catch (error) {
    console.error(`herdr-broadcast: ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return config;
}
