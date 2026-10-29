/** Compatibility for old action invocations. Broadcast execution belongs exclusively to Web. */
export const WORKER_LOCK = "worker";
export async function runHook(_store: unknown, event?: string, _payload?: string): Promise<string> {
  return event === "startup" ? "startup: Web service owns broadcasts" : "event ignored: Web service owns broadcasts";
}
