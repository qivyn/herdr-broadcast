import { join } from "node:path";
import { atomicJSON, readJSON } from "./state.ts";
export type UpdatePhase = "idle" | "checking" | "updating" | "restarting" | "error";
export interface UpdateStatus {
  kind: "github" | "local" | "unmanaged"; root: string | null;
  action?: "apply" | "install" | "restart" | null;
  current_version: string | null; current_revision: string | null;
  latest_version: string | null; latest_revision: string | null;
  latest_tag?: string | null;
  available: boolean; phase: UpdatePhase; blocked_reason: string | null; error: string | null; checked_at: number | null;
  source_revision?: string | null; source_version?: string | null;
  step?: string | null; operation_id?: string | null;
  outcome?: "running" | "succeeded" | "failed" | null;
}
export const emptyStatus = (): UpdateStatus => ({ kind: "unmanaged", root: null, current_version: null, current_revision: null, latest_version: null, latest_revision: null, available: false, phase: "idle", blocked_reason: null, error: null, checked_at: null });

export type UpdateGuard = Pick<UpdateStatus, "operation_id" | "phase" | "step" | "outcome">;
export const updateGuard = (s: UpdateGuard): UpdateGuard => ({ operation_id: s.operation_id ?? null, phase: s.phase, step: s.step ?? null, outcome: s.outcome ?? null });

/** Owned by the launcher. Managers send partial changes, never write this file. */
export class UpdateJournal {
  private value: UpdateStatus;
  constructor(private dir: string) { this.value = { ...emptyStatus(), ...readJSON<UpdateStatus>(join(dir, "update.json")) }; }
  get status(): UpdateStatus { return { ...this.value }; }
  commit(patch: Partial<UpdateStatus>, expected?: UpdateGuard): UpdateStatus {
    if (expected && JSON.stringify(updateGuard(this.value)) !== JSON.stringify(updateGuard(expected))) throw new Error("更新状态已改变，拒绝过期操作");
    if (expected && patch.operation_id && patch.operation_id !== this.value.operation_id && this.value.outcome === "running") throw new Error("已有更新操作正在运行");
    if (expected && this.value.phase === "restarting" && patch.phase === "updating") throw new Error("无效的更新阶段转换");
    // A completed operation may be checked again, but cannot re-enter preparation/switching.
    if (expected && ["updating", "restarting"].includes(patch.phase ?? "") && this.value.outcome !== "running"
      && !(patch.phase === "updating" && patch.outcome === "running" && patch.operation_id && patch.operation_id !== this.value.operation_id)) throw new Error("无效的更新阶段转换");
    const next = { ...this.value, ...patch };
    const legacy = next as UpdateStatus & { mode?: unknown; source_changed?: unknown };
    delete legacy.mode; delete legacy.source_changed;
    atomicJSON(join(this.dir, "update.json"), next);
    this.value = next;
    return this.status;
  }
}
