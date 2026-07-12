import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isProcessAlive } from "./process.mjs";
import { resolveSharedWorkspace, resolveWorkspace } from "./workspace.mjs";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_ROOT = path.join(os.tmpdir(), "grok-companion");
const JOB_ID_PATTERN = /^grok-(?:ask|review|task)-[a-z0-9-]+$/;

function nowIso() {
  return new Date().toISOString();
}

function workspaceHash(workspaceRoot) {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 32);
}

function stateRoot() {
  return process.env[PLUGIN_DATA_ENV] || FALLBACK_ROOT;
}

function assertJobId(jobId) {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new Error(`Invalid Grok job id: ${jobId}`);
  }
}

function resolveLegacyJobsDir(cwd) {
  return path.join(stateRoot(), "jobs", workspaceHash(resolveWorkspace(cwd)));
}

export function resolveJobsDir(cwd) {
  const workspaceRoot = resolveSharedWorkspace(cwd);
  return path.join(stateRoot(), "jobs", workspaceHash(workspaceRoot));
}

export function resolveJobFile(cwd, jobId) {
  assertJobId(jobId);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

export function resolveJobLogFile(cwd, jobId) {
  assertJobId(jobId);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

/** Per-worktree write lock inside the shared jobs directory. */
export function resolveWriteLockDir(cwd) {
  return path.join(resolveJobsDir(cwd), `write.${workspaceHash(resolveWorkspace(cwd))}.lock`);
}

export function createJob(kind, cwd, fields = {}) {
  const workspaceRoot = resolveSharedWorkspace(cwd);
  const worktreeRoot = resolveWorkspace(cwd);
  const createdAt = nowIso();
  return {
    id: `grok-${kind}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    kind,
    workspaceRoot,
    worktreeRoot,
    status: "queued",
    createdAt,
    updatedAt: createdAt,
    ...fields
  };
}

export function writeJob(cwd, job) {
  assertJobId(job.id);
  const jobsDir = resolveJobsDir(cwd);
  fs.mkdirSync(jobsDir, { recursive: true });
  const filePath = resolveJobFile(cwd, job.id);
  const next = { ...job, updatedAt: nowIso() };
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
  return next;
}

export function readJob(cwd, jobId) {
  const filePath = resolveJobFile(cwd, jobId);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * Annotate a running job with pid liveness for status display.
 * alive/gone from kill(pid, 0); unknown when no grokPid was recorded.
 */
export function attachRunningLiveness(job) {
  if (!job || job.status !== "running") {
    return job;
  }
  if (typeof job.grokPid !== "number" || !Number.isFinite(job.grokPid)) {
    return { ...job, liveness: "unknown" };
  }
  return {
    ...job,
    liveness: isProcessAlive(job.grokPid) ? "alive" : "gone"
  };
}

export function isActiveJob(job) {
  return Boolean(job) && (job.status === "queued" || job.status === "running");
}

function jobCasLockDir(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.cas.lock`);
}

// mkdir-based per-job mutex that serializes compare-and-swap writes, so a
// concurrent writer can never clobber a terminal state (e.g. "cancelled") with
// a stale "running" read earlier. NOT re-entrant: callers must not nest CAS
// calls on the same job within a single held lock.
function acquireJobCasLock(cwd, jobId) {
  const lockDir = jobCasLockDir(cwd, jobId);
  const ownerPath = path.join(lockDir, "owner.json");
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const deadline = Date.now() + 2000;
  for (;;) {
    let created = false;
    try {
      fs.mkdirSync(lockDir);
      created = true;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      let owner = null;
      try {
        owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
      } catch {
        owner = null;
      }
      const ownerPid = Number(owner?.pid);
      if (!owner || !Number.isFinite(ownerPid) || !isProcessAlive(ownerPid)) {
        try { fs.unlinkSync(ownerPath); } catch { /* raced against another reclaimer */ }
        try { fs.rmdirSync(lockDir); } catch { /* raced against another reclaimer */ }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for state lock on Grok job ${jobId}.`);
      }
      const spinUntil = Date.now() + 4;
      while (Date.now() < spinUntil) { /* brief backoff to avoid a tight CPU loop */ }
      continue;
    }
    if (!created) {
      continue;
    }
    try {
      fs.writeFileSync(ownerPath, `${JSON.stringify({ pid: process.pid, at: nowIso() })}\n`, "utf8");
    } catch (error) {
      try { fs.rmdirSync(lockDir); } catch { /* best effort cleanup after a failed owner write */ }
      throw error;
    }
    return lockDir;
  }
}

function releaseJobCasLock(lockDir) {
  if (!lockDir) {
    return;
  }
  const ownerPath = path.join(lockDir, "owner.json");
  try { fs.unlinkSync(ownerPath); } catch { /* already released */ }
  try { fs.rmdirSync(lockDir); } catch { /* already released */ }
}

export function compareAndSwapJobState(cwd, jobId, expectedStatus, nextJob) {
  const lockDir = acquireJobCasLock(cwd, jobId);
  try {
    const current = readJob(cwd, jobId);
    if (!current || current.status !== expectedStatus) {
      return { success: false, job: current ?? null };
    }
    const written = writeJob(cwd, { ...nextJob, writeToken: randomUUID() });
    return { success: true, job: written };
  } finally {
    releaseJobCasLock(lockDir);
  }
}

function readJobsFromDir(jobsDir) {
  if (!fs.existsSync(jobsDir)) {
    return [];
  }
  return fs
    .readdirSync(jobsDir)
    .filter((entry) => entry.endsWith(".json"))
    .flatMap((entry) => {
      try {
        return [JSON.parse(fs.readFileSync(path.join(jobsDir, entry), "utf8"))];
      } catch {
        return [];
      }
    });
}

export function listJobs(cwd) {
  const jobsDir = resolveJobsDir(cwd);
  const jobsById = new Map();
  for (const job of readJobsFromDir(jobsDir)) {
    if (job?.id) {
      jobsById.set(job.id, job);
    }
  }

  // Legacy read-only: worktree-keyed jobs dir (pre-shared-root). Never write/move/delete there.
  const legacyDir = resolveLegacyJobsDir(cwd);
  if (legacyDir !== jobsDir) {
    for (const job of readJobsFromDir(legacyDir)) {
      if (job?.id && !jobsById.has(job.id)) {
        jobsById.set(job.id, job);
      }
    }
  }

  return [...jobsById.values()].sort((left, right) =>
    String(right.updatedAt).localeCompare(String(left.updatedAt))
  );
}

export function resolveJobReference(cwd, reference, options = {}) {
  const jobs = listJobs(cwd).filter(
    (job) =>
      (!options.finishedOnly || (job.status !== "queued" && job.status !== "running")) &&
      (reference || !options.sessionId || job.claudeSessionId === options.sessionId)
  );
  if (!reference) {
    return jobs[0] ?? null;
  }
  const matches = jobs.filter((job) => job.id === reference || job.id.startsWith(reference));
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }
  return null;
}

export function appendJobLog(cwd, jobId, message) {
  const logFile = resolveJobLogFile(cwd, jobId);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, `[${nowIso()}] ${String(message).trimEnd()}\n`, "utf8");
  return logFile;
}

export function acquireWriteLock(cwd, jobId) {
  const lockDir = resolveWriteLockDir(cwd);
  const ownerPath = path.join(lockDir, "owner.json");
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  let created = false;
  try {
    fs.mkdirSync(lockDir);
    created = true;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
    let owner = null;
    try {
      owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    } catch {
      owner = null;
    }
    if (!owner || !owner.jobId) {
      throw new Error(
        "A stale Grok write lock exists for this workspace but has no owner record. Remove the lock directory manually and retry."
      );
    }
    const owningJob = readJob(cwd, owner.jobId);
    let reclaim = false;
    if (!owningJob) {
      reclaim = true;
    } else if (owningJob.status !== "queued" && owningJob.status !== "running") {
      reclaim = true;
    } else if (typeof owningJob.grokPid === "number" && Number.isFinite(owningJob.grokPid)) {
      if (!isProcessAlive(owningJob.grokPid)) {
        reclaim = true;
      } else {
        throw new Error(`A Grok write task is already active for this workspace (${owner.jobId}).`);
      }
    } else if (typeof owningJob.pid === "number" && Number.isFinite(owningJob.pid)) {
      if (!isProcessAlive(owningJob.pid)) {
        reclaim = true;
      } else {
        throw new Error(`A Grok write task is already active for this workspace (${owner.jobId}).`);
      }
    } else {
      throw new Error(`A Grok write task is already active for this workspace (${owner.jobId}).`);
    }
    if (reclaim) {
      try {
        fs.unlinkSync(ownerPath);
      } catch {
        // Best effort: the owner record may already be gone.
      }
      try {
        fs.rmdirSync(lockDir);
      } catch {
        // Best effort: another reclaimer may have removed the directory.
      }
      try {
        fs.mkdirSync(lockDir);
        created = true;
      } catch (reclaimError) {
        if (
          reclaimError &&
          typeof reclaimError === "object" &&
          "code" in reclaimError &&
          reclaimError.code === "EEXIST"
        ) {
          throw new Error(
            "A stale Grok write lock exists for this workspace but could not be reclaimed. Remove the lock directory manually and retry."
          );
        }
        throw reclaimError;
      }
    }
  }
  if (!created) {
    // Should be unreachable; guard against silent state corruption.
    throw new Error("A Grok write task is already active for this workspace.");
  }
  try {
    fs.writeFileSync(ownerPath, `${JSON.stringify({ jobId, pid: process.pid })}\n`, "utf8");
  } catch (error) {
    try {
      fs.rmdirSync(lockDir);
    } catch {
      // Best effort cleanup after a failed lock acquisition.
    }
    throw error;
  }
}

export function releaseWriteLock(cwd, jobId) {
  const lockDir = resolveWriteLockDir(cwd);
  const ownerPath = path.join(lockDir, "owner.json");
  if (!fs.existsSync(lockDir)) {
    return;
  }
  try {
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    if (owner.jobId !== jobId) {
      return;
    }
  } catch {
    return;
  }
  try {
    fs.unlinkSync(ownerPath);
    fs.rmdirSync(lockDir);
  } catch {
    // Session cleanup and worker teardown must not fail on an already-released lock.
  }
}
