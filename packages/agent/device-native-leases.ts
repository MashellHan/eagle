import { randomUUID } from "node:crypto";
import type {
  OperationRequest,
  OperationResult,
} from "../contracts/src/devices.ts";
import type { DeviceRuntime } from "./device-runtime.ts";

type Session = { id: string; closed: boolean };
type Lease = {
  leaseId: string;
  sessionId: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};
/** A native tool owns one socket-bound, renewable admission; never an execution queue. */
export class NativeDeviceLeases {
  private runtime: DeviceRuntime;
  private leaseMs: number;
  private leases = new Map<string, Lease>();
  private onFailure: (error: unknown) => void;
  constructor(
    runtime: DeviceRuntime,
    leaseMs = 30000,
    onFailure: (error: unknown) => void = () => {},
  ) {
    if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 30000)
      throw new Error("invalid_native_lease");
    this.runtime = runtime;
    this.leaseMs = leaseMs;
    this.onFailure = onFailure;
  }
  private timer(
    operationId: string,
    leaseId: string,
  ): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      if (this.leases.get(operationId)?.leaseId !== leaseId) return;
      try {
        this.abandon(operationId);
      } catch (error) {
        this.onFailure(error);
      }
    }, this.leaseMs);
  }
  async begin(
    request: OperationRequest,
    session: Session,
  ): Promise<{
    accepted: boolean;
    result: OperationResult;
    leaseId?: string;
    expiresAt?: number;
  }> {
    if (session.closed)
      return {
        accepted: false,
        result: { status: "unknown", error: "native_session_closed" },
      };
    const admitted = await this.runtime.beginNative(
      request,
      this.runtime.device,
    );
    if (!admitted.accepted) return admitted;
    if (session.closed) {
      return {
        accepted: false,
        result: this.runtime.abandonNative(request.operationId),
      };
    }
    const leaseId = randomUUID();
    const expiresAt = Date.now() + this.leaseMs;
    this.leases.set(request.operationId, {
      leaseId,
      sessionId: session.id,
      expiresAt,
      timer: this.timer(request.operationId, leaseId),
    });
    return { ...admitted, leaseId, expiresAt };
  }
  private owned(
    operationId: string,
    leaseId: string,
    sessionId: string,
  ): Lease {
    const lease = this.leases.get(operationId);
    if (!lease || lease.leaseId !== leaseId || lease.sessionId !== sessionId)
      throw new Error("native_lease_mismatch");
    return lease;
  }
  heartbeat(
    operationId: string,
    leaseId: string,
    sessionId: string,
  ): { expiresAt: number } {
    const lease = this.owned(operationId, leaseId, sessionId);
    if (lease.expiresAt <= Date.now()) {
      this.abandon(operationId);
      throw new Error("native_lease_expired");
    }
    clearTimeout(lease.timer);
    lease.expiresAt = Date.now() + this.leaseMs;
    lease.timer = this.timer(operationId, leaseId);
    return { expiresAt: lease.expiresAt };
  }
  complete(
    operationId: string,
    leaseId: string,
    sessionId: string,
    result: OperationResult,
  ): OperationResult {
    const lease = this.owned(operationId, leaseId, sessionId);
    const completed = this.runtime.completeNative(operationId, result);
    if (["completed", "failed", "cancelled"].includes(completed.status)) {
      clearTimeout(lease.timer);
      this.leases.delete(operationId);
    }
    return completed;
  }
  private abandon(operationId: string): void {
    const lease = this.leases.get(operationId);
    if (!lease) return;
    this.runtime.abandonNative(operationId);
    clearTimeout(lease.timer);
  }
  disconnect(sessionId: string): void {
    for (const [operationId, lease] of this.leases)
      if (lease.sessionId === sessionId) this.abandon(operationId);
  }
  close(): void {
    for (const operationId of this.leases.keys()) this.abandon(operationId);
    this.leases.clear();
  }
}
