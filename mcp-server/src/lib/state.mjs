import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isProcessAlive } from "./process.mjs";
import { resolveSharedWorkspace, resolveWorkspace } from "./workspace.mjs";

const PLUGIN_DATA_ENV = "GROK_BUILD_PLUGIN_DATA";
const LEGACY_TEMP_ROOT = path.join(os.tmpdir(), "grok-build-mcp");
const JOB_ID_PATTERN = /^grok-(?:ask|review|task)-[a-z0-9-]+$/;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const COMPLETED_JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const WORKER_LEASE_MAX_AGE_MS = 15_000;

function nowIso() {
  return new Date().toISOString();
}

function workspaceHash(workspaceRoot) {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 32);
}

export function resolveStateRoot(env = process.env, platform = process.platform) {
  if (env[PLUGIN_DATA_ENV]) return path.resolve(env[PLUGIN_DATA_ENV]);
  if (env.XDG_STATE_HOME) return path.join(env.XDG_STATE_HOME, "grok-build-mcp");
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "grok-build-mcp");
  if (platform === "win32" && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, "grok-build-mcp");
  return path.join(os.homedir(), ".local", "state", "grok-build-mcp");
}

function ensurePrivateDir(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
  fs.chmodSync(directory, PRIVATE_DIR_MODE);
}

function writePrivateFile(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  fs.chmodSync(filePath, PRIVATE_FILE_MODE);
}

function assertJobId(jobId) {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new Error(`Invalid Grok job id: ${jobId}`);
  }
}

const JOB_STATUSES = new Set(["queued", "running", "cancelling", "cancelled", "succeeded", "incomplete", "failed", "orphaned"]);

function parsePersistedJob(raw, expectedId = null) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const job = raw;
  if (typeof job.id !== "string" || !JOB_ID_PATTERN.test(job.id)) return null;
  if (expectedId !== null && job.id !== expectedId) return null;
  if (typeof job.status !== "string" || !JOB_STATUSES.has(job.status)) return null;
  for (const field of ["pid", "workerPid", "grokPid"]) {
    const value = job[field];
    if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value <= 0)) return null;
  }
  return job;
}

function resolveLegacyJobsDirs(cwd) {
  const sharedHash = workspaceHash(resolveSharedWorkspace(cwd));
  const worktreeHash = workspaceHash(resolveWorkspace(cwd));
  const currentRoot = resolveStateRoot();
  const directories = [path.join(currentRoot, "jobs", worktreeHash)];
  if (!process.env[PLUGIN_DATA_ENV]) {
    directories.push(
      path.join(LEGACY_TEMP_ROOT, "jobs", sharedHash),
      path.join(LEGACY_TEMP_ROOT, "jobs", worktreeHash)
    );
  }
  return [...new Set(directories)].filter((directory) => directory !== resolveJobsDir(cwd));
}

export function resolveJobsDir(cwd) {
  const workspaceRoot = resolveSharedWorkspace(cwd);
  return path.join(resolveStateRoot(), "jobs", workspaceHash(workspaceRoot));
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
  ensurePrivateDir(resolveStateRoot());
  ensurePrivateDir(path.dirname(jobsDir));
  ensurePrivateDir(jobsDir);
  const filePath = resolveJobFile(cwd, job.id);
  const next = { ...job, updatedAt: nowIso() };
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writePrivateFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(temporaryPath, filePath);
  fs.chmodSync(filePath, PRIVATE_FILE_MODE);
  return next;
}

export function readJob(cwd, jobId) {
  assertJobId(jobId);
  const candidates = [resolveJobFile(cwd, jobId), ...resolveLegacyJobsDirs(cwd).map((directory) => path.join(directory, `${jobId}.json`))];
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const parsed = parsePersistedJob(JSON.parse(fs.readFileSync(filePath, "utf8")), jobId);
      if (parsed) return parsed;
    } catch {
      // Corrupt records are ignored and never used for lifecycle operations.
    }
  }
  return null;
}

/**
 * Annotate a running job with pid liveness for status display.
 * alive/gone from kill(pid, 0); unknown when no grokPid was recorded.
 */
export function attachRunningLiveness(job) {
  if (!job || !isActiveJob(job)) {
    return job;
  }
  const pid = Number.isFinite(job.grokPid) ? job.grokPid : Number.isFinite(job.workerPid) ? job.workerPid : job.pid;
  if (!Number.isFinite(pid)) {
    return { ...job, liveness: "unknown" };
  }
  return {
    ...job,
    liveness: isProcessAlive(pid) ? "alive" : "gone"
  };
}

export function isActiveJob(job) {
  return Boolean(job) && (job.status === "queued" || job.status === "running" || job.status === "cancelling");
}

export function isJobOwnershipFresh(job, now = Date.now()) {
  if (!isActiveJob(job)) return false;
  const request = job.request && typeof job.request === "object" ? job.request : {};
  if (request.background === true) {
    const timestamp = Date.parse(job.workerHeartbeatAt ?? (job.status === "queued" ? job.updatedAt ?? job.createdAt : ""));
    return Number.isFinite(timestamp) && now - timestamp <= WORKER_LEASE_MAX_AGE_MS;
  }
  const timestamp = Date.parse(job.updatedAt ?? job.startedAt ?? job.createdAt ?? "");
  const timeoutMs = Number.isFinite(request.timeoutMs) ? request.timeoutMs : 600_000;
  return Number.isFinite(timestamp) && now - timestamp <= timeoutMs + 60_000;
}

function jobCasLockDir(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.cas.lock`);
}

// mkdir-based per-job mutex that serializes compare-and-swap writes, so a
// concurrent writer can never clobber a terminal state (e.g. "cancelled") with
// a stale "running" read earlier. NOT re-entrant: callers must not nest CAS
// calls on the same job within a single held lock.
async function acquireJobCasLock(cwd, jobId) {
  const lockDir = jobCasLockDir(cwd, jobId);
  const ownerPath = path.join(lockDir, "owner.json");
  ensurePrivateDir(path.dirname(lockDir));
  const deadline = Date.now() + 2000;
  for (;;) {
    let created = false;
    try {
      await fs.promises.mkdir(lockDir, { mode: PRIVATE_DIR_MODE });
      created = true;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      let owner = null;
      try {
        owner = JSON.parse(await fs.promises.readFile(ownerPath, "utf8"));
      } catch {
        owner = null;
      }
      const ownerPid = Number(owner?.pid);
      if (!owner || !Number.isFinite(ownerPid) || !isProcessAlive(ownerPid)) {
        try { await fs.promises.unlink(ownerPath); } catch { /* raced against another reclaimer */ }
        try { await fs.promises.rmdir(lockDir); } catch { /* raced against another reclaimer */ }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for state lock on Grok job ${jobId}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 4 + Math.floor(Math.random() * 5)));
      continue;
    }
    if (!created) {
      continue;
    }
    try {
      writePrivateFile(ownerPath, `${JSON.stringify({ pid: process.pid, at: nowIso() })}\n`);
    } catch (error) {
      try { fs.rmdirSync(lockDir); } catch { /* best effort cleanup after a failed owner write */ }
      throw error;
    }
    return lockDir;
  }
}

async function releaseJobCasLock(lockDir) {
  if (!lockDir) {
    return;
  }
  const ownerPath = path.join(lockDir, "owner.json");
  try { await fs.promises.unlink(ownerPath); } catch { /* already released */ }
  try { await fs.promises.rmdir(lockDir); } catch { /* already released */ }
}

export async function compareAndSwapJobState(cwd, jobId, expectedStatus, nextJob) {
  const lockDir = await acquireJobCasLock(cwd, jobId);
  try {
    const current = readJob(cwd, jobId);
    if (!current || current.status !== expectedStatus) {
      return { success: false, job: current ?? null };
    }
    const written = writeJob(cwd, { ...nextJob, writeToken: randomUUID() });
    return { success: true, job: written };
  } finally {
    await releaseJobCasLock(lockDir);
  }
}

/**
 * Update a job from the freshest record while holding its per-job lock.
 * This avoids lost updates when independent actors patch heartbeat/PID fields.
 * @param {string} cwd
 * @param {string} jobId
 * @param {string|string[]} expectedStatus
 * @param {(current: Record<string, unknown>) => Record<string, unknown>} updater
 */
export async function patchJobState(cwd, jobId, expectedStatus, updater) {
  const lockDir = await acquireJobCasLock(cwd, jobId);
  try {
    const current = readJob(cwd, jobId);
    const allowed = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    if (!current || !allowed.includes(String(current.status))) {
      return { success: false, job: current ?? null };
    }
    const next = updater(current);
    const written = writeJob(cwd, { ...current, ...next, id: current.id, writeToken: randomUUID() });
    return { success: true, job: written };
  } finally {
    await releaseJobCasLock(lockDir);
  }
}

/** @param {Record<string, unknown>|null|undefined} job @returns {number[]} */
export function recordedJobPids(job) {
  if (!job) return [];
  /** @type {number[]} */
  const pids = [];
  for (const value of [job.grokPid, job.workerPid, job.pid]) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) pids.push(value);
  }
  return [...new Set(pids)];
}

/** @param {Record<string, unknown>|null|undefined} job */
export function recordedProcessesGone(job) {
  const pids = recordedJobPids(job);
  if (pids.length === 0 && isActiveJob(job)) return false;
  return pids.every((pid) => !isProcessAlive(pid));
}

function readJobsFromDir(jobsDir) {
  if (!fs.existsSync(jobsDir)) {
    return [];
  }
  return fs
    .readdirSync(jobsDir)
    .filter((entry) => entry.endsWith(".json") && JOB_ID_PATTERN.test(entry.slice(0, -5)))
    .flatMap((entry) => {
      try {
        const expectedId = entry.slice(0, -5);
        const parsed = parsePersistedJob(JSON.parse(fs.readFileSync(path.join(jobsDir, entry), "utf8")), expectedId);
        return parsed ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

function pruneExpiredCompletedJobs(jobsDir) {
  if (!fs.existsSync(jobsDir)) return;
  const cutoff = Date.now() - COMPLETED_JOB_RETENTION_MS;
  for (const job of readJobsFromDir(jobsDir)) {
    const timestamp = Date.parse(job.completedAt ?? job.updatedAt ?? "");
    if (isActiveJob(job) || !Number.isFinite(timestamp) || timestamp >= cutoff) continue;
    try { fs.unlinkSync(path.join(jobsDir, `${job.id}.json`)); } catch { /* best effort */ }
    try { fs.unlinkSync(path.join(jobsDir, `${job.id}.log`)); } catch { /* best effort */ }
  }
}

export function pruneExpiredJobs(cwd) {
  pruneExpiredCompletedJobs(resolveJobsDir(cwd));
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
  for (const legacyDir of resolveLegacyJobsDirs(cwd)) {
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
      (!options.finishedOnly || !isActiveJob(job))
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
  ensurePrivateDir(path.dirname(logFile));
  fs.appendFileSync(logFile, `[${nowIso()}] ${String(message).trimEnd()}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  fs.chmodSync(logFile, PRIVATE_FILE_MODE);
  return logFile;
}

export function acquireWriteLock(cwd, jobId) {
  const lockDir = resolveWriteLockDir(cwd);
  const ownerPath = path.join(lockDir, "owner.json");
  ensurePrivateDir(path.dirname(lockDir));
  let created = false;
  try {
    fs.mkdirSync(lockDir, { mode: PRIVATE_DIR_MODE });
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
      if (Number.isSafeInteger(owner.pid) && isProcessAlive(owner.pid)) {
        throw new Error(`A Grok write lock has a live owner but no readable job record (${owner.jobId}).`);
      }
      reclaim = true;
    } else if (!isActiveJob(owningJob)) {
      if (!recordedProcessesGone(owningJob)) {
        throw new Error(`A completed Grok write task still has a live process (${owner.jobId}).`);
      }
      reclaim = true;
    } else if (!isJobOwnershipFresh(owningJob)) {
      if (!recordedProcessesGone(owningJob)) {
        throw new Error(`A Grok write task has a stale ownership lease but a live process (${owner.jobId}); cancel it before retrying.`);
      }
      writeJob(cwd, {
        ...owningJob,
        status: "orphaned",
        pid: null,
        workerPid: null,
        grokPid: null,
        completedAt: nowIso(),
        errorMessage: "Worker ownership lease expired after all recorded processes exited; write lock reclaimed."
      });
      reclaim = true;
    } else {
      const ownerPids = recordedJobPids(owningJob);
      if (ownerPids.length === 0 || ownerPids.some((pid) => isProcessAlive(pid))) {
        throw new Error(`A Grok write task is already active for this workspace (${owner.jobId}).`);
      }
      reclaim = true;
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
        fs.mkdirSync(lockDir, { mode: PRIVATE_DIR_MODE });
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
    writePrivateFile(ownerPath, `${JSON.stringify({ jobId, pid: process.pid })}\n`);
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
    return false;
  }
  try {
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    if (owner.jobId !== jobId) {
      return false;
    }
  } catch {
    return false;
  }
  try {
    fs.unlinkSync(ownerPath);
    fs.rmdirSync(lockDir);
    return true;
  } catch {
    // Session cleanup and worker teardown must not fail on an already-released lock.
    return false;
  }
}
