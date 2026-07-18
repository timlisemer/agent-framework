import fsModule from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import {
  isAlreadyExistsFileError,
  isFileSystemErrorCode,
  isMissingFileError,
} from "../../utils/filesystem-errors.js";
import { errorMessage } from "../../utils/output.js";
import { withCleanup } from "../../utils/resource-lifecycle.js";

const fs = fsModule.promises;

export type RunLockOptions = {
  timeoutMs?: number;
  staleAfterMs?: number;
  retryMs?: number;
};

export type RunLock = {
  diagnostics: string[];
  stopHeartbeat(): Promise<readonly string[]>;
  release(): Promise<readonly string[]>;
};

/** Acquire a run lock for one operation and release it with primary-error precedence. */
export async function withAcquiredRunLock<T>(
  runDir: string,
  operation: (lock: RunLock) => Promise<T>,
  options: RunLockOptions = {},
): Promise<T> {
  const lock = await acquireRunLock(runDir, options);
  return withCleanup(
    () => operation(lock),
    () => lock.release(),
  );
}

type LockOwner = {
  pid: number;
  processIdentity: string;
  lockId: string;
  acquiredAt: string;
};

const currentProcessFallbackIdentity =
  `process-start-epoch-ms:${Math.floor(Date.now() - process.uptime() * 1_000)}`;

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function acquireRunLock(runDir: string, options: RunLockOptions = {}): Promise<RunLock> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const staleAfterMs = options.staleAfterMs ?? 30_000;
  const retryMs = options.retryMs ?? 20;
  const lockDir = path.join(runDir, ".write.lock");
  const startedAt = Date.now();
  const diagnostics: string[] = [];

  await fs.mkdir(runDir, { recursive: true });
  const processIdentity = await readProcessIdentity(process.pid) ?? currentProcessFallbackIdentity;
  while (true) {
    let created = false;
    try {
      await fs.mkdir(lockDir);
      created = true;
      const lockId = randomUUID();
      const ownerPath = path.join(lockDir, "owner.json");
      await fs.writeFile(ownerPath, JSON.stringify({
        pid: process.pid,
        processIdentity,
        lockId,
        acquiredAt: new Date().toISOString(),
      }), { encoding: "utf8", mode: 0o600 });
      let heartbeatFailed = false;
      let heartbeatTail = Promise.resolve();
      const heartbeatInterval = setInterval(() => {
        heartbeatTail = heartbeatTail.then(() => refreshHeartbeat(ownerPath, lockId)).catch((error: unknown) => {
            if (heartbeatFailed) return;
            heartbeatFailed = true;
            diagnostics.push(`Run lock heartbeat failed: ${errorMessage(error)}`);
          });
      }, Math.max(10, Math.floor(staleAfterMs / 3)));
      heartbeatInterval.unref();
      let heartbeatStopped = false;
      let released = false;
      const stopHeartbeat = async (): Promise<readonly string[]> => {
        if (heartbeatStopped) return diagnostics;
        heartbeatStopped = true;
        clearInterval(heartbeatInterval);
        await heartbeatTail;
        return diagnostics;
      };
      return {
        diagnostics,
        stopHeartbeat,
        async release(): Promise<readonly string[]> {
          if (released) return diagnostics;
          released = true;
          await stopHeartbeat();
          const owner = await readLockOwner(lockDir);
          if (owner?.lockId === lockId) await fs.rm(lockDir, { recursive: true, force: true });
          return diagnostics;
        },
      };
    } catch (error) {
      if (!isAlreadyExistsFileError(error)) {
        if (created) await fs.rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      if (await recoverDeadOwner(lockDir, staleAfterMs)) {
        diagnostics.push("Recovered a stale run transaction lock");
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out acquiring run transaction lock: ${lockDir}`);
      }
      await delay(retryMs);
    }
  }
}

async function refreshHeartbeat(ownerPath: string, lockId: string): Promise<void> {
  try {
    const owner = await readLockOwner(path.dirname(ownerPath));
    if (owner?.lockId === lockId) {
      const now = new Date();
      await fs.utimes(ownerPath, now, now);
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

async function recoverDeadOwner(lockDir: string, staleAfterMs: number): Promise<boolean> {
  const observed = await observeLock(lockDir);
  if (!observed || Date.now() - observed.mtimeMs <= staleAfterMs) return false;
  if (observed.owner && await isOwnerProcessAlive(observed.owner)) return false;

  const confirmed = await observeLock(lockDir);
  if (!confirmed || confirmed.directoryInode !== observed.directoryInode) return false;
  if (confirmed.owner?.lockId !== observed.owner?.lockId) return false;
  if (confirmed.owner && await isOwnerProcessAlive(confirmed.owner)) return false;

  const recoveryDir = `${lockDir}.recovered-${randomUUID()}`;
  try {
    await fs.rename(lockDir, recoveryDir);
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
  await fs.rm(recoveryDir, { recursive: true, force: true });
  return true;
}

async function observeLock(lockDir: string): Promise<{
  owner: LockOwner | null;
  mtimeMs: number;
  directoryInode: number;
} | null> {
  const owner = await readLockOwner(lockDir);
  try {
    const [directoryStat, leaseStat] = await Promise.all([
      fs.stat(lockDir),
      fs.stat(owner ? path.join(lockDir, "owner.json") : lockDir),
    ]);
    return { owner, mtimeMs: leaseStat.mtimeMs, directoryInode: directoryStat.ino };
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

async function readLockOwner(lockDir: string): Promise<LockOwner | null> {
  let contents: string;
  try {
    contents = await fs.readFile(path.join(lockDir, "owner.json"), "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
  try {
    const value = JSON.parse(contents) as Partial<LockOwner>;
    if (
      typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0 &&
      typeof value.processIdentity === "string" && value.processIdentity.length > 0 &&
      typeof value.lockId === "string" && value.lockId.length > 0 &&
      typeof value.acquiredAt === "string"
    ) return value as LockOwner;
  } catch {
    return null;
  }
  return null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isFileSystemErrorCode(error, "ESRCH")) return false;
    if (isFileSystemErrorCode(error, "EPERM")) return true;
    return true;
  }
}

async function isOwnerProcessAlive(owner: LockOwner): Promise<boolean> {
  if (!isProcessAlive(owner.pid)) return false;
  const processIdentity = await readProcessIdentity(owner.pid) ??
    (owner.pid === process.pid ? currentProcessFallbackIdentity : null);
  return processIdentity === null || processIdentity === owner.processIdentity;
}

async function readProcessIdentity(pid: number): Promise<string | null> {
  try {
    const [bootId, processStat] = await Promise.all([
      fs.readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      fs.readFile(`/proc/${pid}/stat`, "utf8"),
    ]);
    const closingParenthesis = processStat.lastIndexOf(")");
    if (closingParenthesis < 0) return null;
    const fieldsAfterCommand = processStat.slice(closingParenthesis + 1).trim().split(/\s+/);
    const startTimeTicks = fieldsAfterCommand[19];
    const normalizedBootId = bootId.trim();
    if (!normalizedBootId || !startTimeTicks || !/^\d+$/.test(startTimeTicks)) return null;
    return `linux-proc:${normalizedBootId}:${startTimeTicks}`;
  } catch (error) {
    if (isMissingFileError(error) || isFileSystemErrorCode(error, "EACCES") ||
      isFileSystemErrorCode(error, "EPERM")) return null;
    throw error;
  }
}
