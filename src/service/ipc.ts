import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import type { ChildProcess } from "node:child_process";

export function callSocket(path: string, command: string, timeoutMs = 150_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path); let data = "";
    const timer = setTimeout(() => socket.destroy(new Error("服务管理请求超时")), timeoutMs);
    socket.on("connect", () => socket.write(JSON.stringify({ command }) + "\n"));
    socket.on("data", chunk => {
      data += chunk; if (data.length > 1_000_000) return socket.destroy(new Error("Invalid response"));
      if (!data.includes("\n")) return;
      try { const response = JSON.parse(data.split("\n")[0]!); response.error ? reject(new Error(response.error)) : resolve(response.value); }
      catch (e) { reject(e); } finally { socket.end(); clearTimeout(timer); }
    });
    socket.on("error", reject); socket.on("close", () => { clearTimeout(timer); reject(new Error("服务管理连接已关闭")); });
  });
}
export async function serveSocket(path: string, handle: (command: string) => Promise<unknown>) {
  try { const stat = lstatSync(path); if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error("Control socket is not owned by this user"); rmSync(path); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const server = createServer(socket => {
    let data = "", handled = false;
    socket.setTimeout(150_000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", chunk => {
      if (handled) return; data += chunk;
      if (data.length > 4096) { socket.destroy(); return; }
      if (!data.includes("\n")) return; handled = true;
      try { const { command } = JSON.parse(data.split("\n")[0]!); void handle(command).then(value => socket.end(JSON.stringify({ value }) + "\n"), error => socket.end(JSON.stringify({ error: String(error.message ?? error) }) + "\n")); }
      catch { socket.end('{"error":"Invalid command"}\n'); }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, () => { chmodSync(path, 0o600); resolve(); }); });
  return server;
}
export function requestChild(child: ChildProcess, command: string, value?: unknown, timeoutMs = 130_000): Promise<any> {
  if (!child.connected) return Promise.reject(new Error(`Service unavailable during ${command}`));
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const done = () => { clearTimeout(timer); child.off("message", message); child.off("exit", exit); };
    const message = (m: any) => { if (m?.reply !== id) return; done(); m.error ? reject(new Error(m.error)) : resolve(m.value); };
    const exit = () => { done(); reject(new Error(`Service exited during ${command}`)); };
    const timer = setTimeout(() => { done(); reject(new Error(`${command} timed out`)); }, timeoutMs);
    child.on("message", message); child.once("exit", exit);
    try { child.send({ request: id, command, value }, error => { if (error) { done(); reject(error); } }); }
    catch (e) { done(); reject(e); }
  });
}
export function handleParent(handle: (command: string, value: any) => Promise<unknown>) {
  const listener = (m: any) => {
    if (!m?.request) return;
    const reply = (response: object) => { if (process.connected) process.send?.({ reply: m.request, ...response }, () => {}); };
    void handle(m.command, m.value).then(value => reply({ value }), error => reply({ error: String(error.message ?? error) }));
  };
  process.on("message", listener);
  return () => process.off("message", listener);
}
export function requestParent(command: string, timeoutMs = 30_000, value?: unknown): Promise<any> {
  if (!process.connected) return Promise.reject(new Error("Update manager unavailable"));
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const done = () => { clearTimeout(timer); process.off("message", listener); process.off("disconnect", disconnected); };
    const disconnected = () => { done(); reject(new Error("Update manager disconnected")); };
    const listener = (m: any) => { if (m?.parent_reply !== id) return; done(); m.error ? reject(new Error(m.error)) : resolve(m.value); };
    const timer = setTimeout(() => { done(); reject(new Error("Update manager unavailable")); }, timeoutMs);
    process.on("message", listener);
    process.once("disconnect", disconnected);
    process.send?.({ parent_request: id, command, value }, error => { if (error) { done(); reject(error); } });
  });
}
