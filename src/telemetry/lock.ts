/**
 * Local Guard Evidence — advisory maintenance lock.
 *
 * WHY THIS EXISTS
 * ---------------
 * Deleting an open SQLite file "succeeds" on Unix while the holder keeps
 * reading the old inode. That means `unlink`-based cleanup would appear to work
 * while silently leaving a running MCP server writing to an orphaned file.
 *
 * Therefore maintenance operations (`purge --apply`, `reset`) NEVER unlink
 * storage files. They instead:
 *   1. acquire this advisory lock (non-blocking),
 *   2. refuse safely if a writer holds it,
 *   3. otherwise DELETE inside a transaction, then checkpoint + VACUUM.
 *
 * The lock file itself is never deleted while held.
 */
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

export interface LockHandle {
  path: string;
  release(): void;
}

export type LockAcquireResult =
  | { ok: true; handle: LockHandle }
  | { ok: false; reason: "held"; ownerPid?: number };

/**
 * Attempt to acquire the advisory lock without blocking.
 *
 * Uses `wx` open semantics (exclusive create) so acquisition is atomic across
 * processes. A stale lock left by a crashed process is detected by probing
 * whether the recorded pid is still alive.
 */
export function acquireMaintenanceLock(lockPath: string): LockAcquireResult {
  const attempt = (): LockAcquireResult => {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return {
        ok: true,
        handle: {
          path: lockPath,
          release() {
            // Best-effort release; never throws.
            try {
              unlinkSync(lockPath);
            } catch {
              /* ignore */
            }
          },
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        return { ok: false, reason: "held", ownerPid: readLockOwner(lockPath) };
      }
      // Any other error (permissions, missing dir) is treated as "cannot lock".
      return { ok: false, reason: "held" };
    }
  };

  const first = attempt();
  if (first.ok) return first;

  // Possible stale lock: if the recorded owner is gone, reclaim it once.
  if (first.reason === "held") {
    const owner = first.ownerPid;
    if (typeof owner === "number" && !isProcessAlive(owner)) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
      return attempt();
    }
  }
  return first;
}

function readLockOwner(lockPath: string): number | undefined {
  try {
    const raw = readFileSync(lockPath, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but we cannot signal it.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
