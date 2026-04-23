import * as fs from "fs";
import * as path from "path";

const MUTEX_TIMEOUT_MS = 90_000;   // max wait for contention
const STALE_THRESHOLD_MS = 180_000; // must exceed MUTEX_TIMEOUT_MS so an in-flight holder is never reclaimed

export async function withSessionLock<T>(
  sessionDir: string,
  fn: () => Promise<T>,
  opts?: { label?: string },
): Promise<T> {
  const lockPath = path.join(sessionDir, ".session.lock");
  const deadline = Date.now() + MUTEX_TIMEOUT_MS;
  const retryMs = 25;

  // Register the exit handler EARLY, guarded by a flag, so there is no race
  // window between successful lock acquisition and handler registration.
  // If a signal or crash kills the process after open() succeeds but before
  // we'd otherwise have installed the handler, the lock still gets cleaned.
  let heldLock = false;
  const releaseLockSync = () => {
    if (!heldLock) return;
    try { fs.unlinkSync(lockPath); } catch {}
  };
  process.on("exit", releaseLockSync);
  // Also catch common termination signals so we don't leave a fresh stale
  // lock that would block siblings for 180 s.
  const signalHandler = (sig: NodeJS.Signals) => {
    releaseLockSync();
    // Re-raise default signal behavior by exiting with standard Unix code.
    process.exit(128 + (sig === "SIGINT" ? 2 : sig === "SIGTERM" ? 15 : sig === "SIGHUP" ? 1 : 0));
  };
  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);
  process.on("SIGHUP", signalHandler);

  try {
    while (true) {
      try {
        const fd = await fs.promises.open(lockPath, "wx");
        // Set heldLock IMMEDIATELY — before any further await — so a signal
        // arriving between open() success and writeFile completion triggers
        // releaseLockSync to unlink the (possibly empty) inode we just created.
        // Otherwise a SIGINT here would leak a fresh-mtime lock that blocks
        // siblings for the full STALE_THRESHOLD_MS.
        heldLock = true;
        try {
          await fd.writeFile(`${process.pid}\n${opts?.label ?? ""}\n${Date.now()}`);
        } catch (writeErr) {
          // Inode created but write failed (e.g. ENOSPC): unlink so a fresh
          // empty lock doesn't block siblings. Reset heldLock so the outer
          // finally's releaseLockSync is a clean no-op rather than a
          // second unlink attempt on the already-removed file.
          try { await fs.promises.unlink(lockPath); } catch {}
          try { await fd.close(); } catch {}
          heldLock = false;
          throw writeErr;
        }
        try { await fd.close(); } catch {}
        break;
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "EEXIST") throw err;
        try {
          const stat = await fs.promises.stat(lockPath);
          if (Date.now() - stat.mtimeMs > STALE_THRESHOLD_MS) {
            const staged = `${lockPath}.${process.pid}.reclaim`;
            try { await fs.promises.rename(lockPath, staged); await fs.promises.unlink(staged); } catch {}
            continue;
          }
        } catch { continue; }
        if (Date.now() > deadline) {
          throw new Error(`session-mutex: timeout after ${MUTEX_TIMEOUT_MS}ms waiting for ${lockPath}`);
        }
        await new Promise((r) => setTimeout(r, retryMs));
      }
    }

    return await fn();
  } finally {
    process.removeListener("exit", releaseLockSync);
    process.removeListener("SIGINT", signalHandler);
    process.removeListener("SIGTERM", signalHandler);
    process.removeListener("SIGHUP", signalHandler);
    releaseLockSync();
    heldLock = false;
  }
}
