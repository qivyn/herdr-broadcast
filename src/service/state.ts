import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const PROTOCOL = 1;
export const SCHEMA = 9;
export interface Release {
  directory: string; revision: string | null; version: string | null; hash: string;
  sourceRoot: string; sourceHash: string; sourceRevision: string | null;
  protocol: number; schema: number;
}
export interface Transaction { id: string; previous: Release; next?: Release; step: string }
export interface RuntimeState { current?: Release; previous?: Release; transaction?: Transaction }
export function stateDirectory(database: string): string {
  return basename(database) === "broadcast.sqlite" ? dirname(database) : join(dirname(database), "web", basename(database));
}
export function readJSON<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return null; }
}
export function atomicJSON(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  const parent = openSync(dirname(file), "r");
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
export function runtimeState(dir: string): RuntimeState { return readJSON<RuntimeState>(join(dir, "current.json")) ?? {}; }
export function saveRuntime(dir: string, value: RuntimeState): void { atomicJSON(join(dir, "current.json"), value); }
export function releaseEntry(release: Release): string { return join(release.directory, "src", "service", "entry.ts"); }
export function validRelease(dir: string, release: Release): boolean {
  return resolve(release.directory).startsWith(resolve(dir, "releases") + "/") && release.schema === SCHEMA && release.protocol === PROTOCOL && existsSync(releaseEntry(release));
}
export function socketPath(database: string): string {
  // macOS limits Unix socket names to 104 bytes; don't put a long workspace path in one.
  return `/tmp/herdr-broadcast-${process.getuid?.() ?? "user"}-${createHash("sha256").update(resolve(database)).digest("hex").slice(0, 24)}.sock`;
}
