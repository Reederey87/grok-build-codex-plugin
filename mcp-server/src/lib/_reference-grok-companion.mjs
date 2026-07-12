#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { collectReviewContext } from "./lib/git-context.mjs";
import {
  classifyGrokCompletion,
  deleteGrokSession,
  getGrokAvailability,
  getGrokInspect,
  resolveMaxTurns,
  runReadOnlyGrok,
  runWriteGrok
} from "./lib/grok-cli.mjs";
import { binaryAvailable, isProcessAlive, runCommand, terminateProcessTree } from "./lib/process.mjs";
import {
  renderCleanupReport,
  renderGrokResult,
  renderIncompleteBanner,
  renderJobResult,
  renderSetup,
  renderStatus,
  renderWriteSummary
} from "./lib/render.mjs";
import {
  acquireWriteLock,
  appendJobLog,
  attachRunningLiveness,
  compareAndSwapJobState,
  createJob,
  listJobs,
  readJob,
  releaseWriteLock,
  resolveJobLogFile,
  resolveJobReference,
  writeJob
} from "./lib/state.mjs";
import { canonicalDirectory, getGitRepositoryRoot } from "./lib/workspace.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const SESSION_ID_ENV = "GROK_COMPANION_SESSION_ID";

function usage() {
  return [
    "Usage:",
    "  node scripts/grok-companion.mjs setup [--json] [--cwd <dir>]",
    "  node scripts/grok-companion.mjs ask [--model <model>] [--cwd <dir>] [question]",
    "  node scripts/grok-companion.mjs review [--background] [--base <ref>] [--scope working-tree|branch|repo] [--model <model>] [--cwd <dir>]",
    "  node scripts/grok-companion.mjs task [--background|--wait] [--resume|--fresh] [--write] [--always-approve|--yolo] [--model <model>] [--cwd <dir>] [task]",
    "  node scripts/grok-companion.mjs status [job-id] [--all] [--json] [--cwd <dir>]",
    "  node scripts/grok-companion.mjs result [job-id] [--json] [--cwd <dir>]",
    "  node scripts/grok-companion.mjs cancel [job-id] [--json] [--cwd <dir>]",
    "  node scripts/grok-companion.mjs task-resume-candidate [--json] [--cwd <dir>]",
    "  node scripts/grok-companion.mjs cleanup [--json] [--cwd <dir>]"
  ].join("\n");
}

function output(value, asJson = false) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(value.endsWith("\n") ? value : `${value}\n`);
}

function normalizeArgv(argv) {
  if (argv.length !== 1) {
    return argv;
  }
  return splitRawArgumentString(argv[0]);
}

function parseCommand(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), config);
}

function resolveCwd(options) {
  return canonicalDirectory(options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd());
}

function assertNotRecursive() {
  if (process.env.GROK_BUILD_COMPANION_ACTIVE === "1") {
    throw new Error("Refusing recursive Grok companion invocation.");
  }
}

function requirePrompt(positionals, label) {
  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    throw new Error(`Provide a ${label}.`);
  }
  return prompt;
}

function ensureGrok(cwd) {
  const availability = getGrokAvailability(cwd);
  if (!availability.available) {
    throw new Error("Grok CLI is not available. Install Grok Build, run `grok login`, then retry `/grok:setup`.");
  }
}

function readOnlyPrompt(userPrompt, purpose) {
  return [
    "You are Grok Build invoked by a Claude Code plugin.",
    `Purpose: ${purpose}.`,
    "This is a strictly read-only task. Do not create, edit, delete, rename, stage, commit, reset, checkout, or otherwise mutate files or Git state.",
    "Use only permitted read operations and Git inspection. Do not inspect dotfiles, credentials, environment files, keychains, or secrets.",
    "Do not invoke this plugin, its companion script, Claude Code slash commands, or another Grok session.",
    "Return findings, explanations, or a proposed plan only.",
    "",
    "User request:",
    userPrompt
  ].join("\n");
}

function writePrompt(userPrompt) {
  return [
    "You are Grok Build invoked by a Claude Code plugin.",
    "Purpose: implement a bounded, predefined task in the current Git workspace.",
    "Make only the changes required by the user's request. Do not inspect dotfiles, credentials, environment files, keychains, or secrets.",
    "Do not invoke this plugin, its companion script, Claude Code slash commands, or another Grok session.",
    "Do not stage, commit, reset, checkout, switch branches, or use destructive commands.",
    "",
    "User request:",
    userPrompt
  ].join("\n");
}

function rejectTaskOnlyWriteFlags(options, command) {
  const flag = options.write ? "--write" : options["always-approve"] ? "--always-approve" : options.yolo ? "--yolo" : null;
  if (flag) {
    throw new Error(`${flag} is only supported by \`grok task\`; ${command} is strictly read-only.`);
  }
}

function reviewPrompt(context) {
  return [
    "You are Grok Build acting as an external read-only code reviewer.",
    "Do not modify files or Git state. Do not inspect dotfiles, credentials, environment files, keychains, or secrets.",
    "Do not invoke this plugin, its companion script, Claude Code slash commands, or another Grok session.",
    "Review for correctness, security, data loss, races, regressions, and missing tests.",
    "Return only actionable findings. For each finding provide severity, path, evidence, and a suggested fix. Clearly state when no serious findings exist.",
    "",
    context.content
  ].join("\n");
}

function makeJobRequest(kind, cwd, model, prompt, summary) {
  const claudeSessionId = getCurrentClaudeSessionId();
  return {
    kind,
    cwd,
    model: model ?? null,
    prompt,
    summary,
    jobFields: claudeSessionId ? { claudeSessionId } : {}
  };
}

function jobHeading(kind) {
  if (kind === "review") {
    return "Grok Review";
  }
  if (kind === "ask") {
    return "Grok Answer";
  }
  return "Grok Rescue";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] || null;
}

function isActiveJob(job) {
  return job.status === "queued" || job.status === "running";
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.claudeSessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return jobs.find(
    (job) => job.kind === "task" && !isActiveJob(job) && typeof job.grokSessionId === "string" && job.grokSessionId
  ) ?? null;
}

function captureGitStatus(cwd) {
  const paths = new Set();
  const hasHead = runCommand("git", ["rev-parse", "--verify", "HEAD"], { cwd });
  if (hasHead.status === 0) {
    const diff = runCommand("git", ["diff", "--name-only", "HEAD", "-z"], { cwd });
    if (diff.error) {
      throw diff.error;
    }
    if (diff.status !== 0) {
      throw new Error(diff.stderr.trim() || "Unable to capture Git diff for this write task.");
    }
    for (const entry of String(diff.stdout ?? "").split("\0")) {
      if (entry) {
        paths.add(entry);
      }
    }
  }
  const untracked = runCommand("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd });
  if (untracked.error) {
    throw untracked.error;
  }
  if (untracked.status !== 0) {
    throw new Error(untracked.stderr.trim() || "Unable to capture untracked files for this write task.");
  }
  for (const entry of String(untracked.stdout ?? "").split("\0")) {
    if (entry) {
      paths.add(entry);
    }
  }
  return paths;
}

function summarizeWriteChanges(before, after) {
  const changedFiles = [
    ...[...after].filter((filePath) => !before.has(filePath)),
    ...[...before].filter((filePath) => !after.has(filePath))
  ].sort();
  return {
    before: [...before].sort(),
    after: [...after].sort(),
    changedFiles
  };
}

async function runStoredJob(cwd, job) {
  const result = compareAndSwapJobState(cwd, job.id, "queued", {
    ...job,
    status: "running",
    pid: process.pid,
    grokPid: null,
    startedAt: new Date().toISOString()
  });
  if (!result.success) {
    if (job.request.write) {
      releaseWriteLock(cwd, job.id);
    }
    return result.job ?? job;
  }
  const running = result.job;
  appendJobLog(cwd, running.id, `Started ${running.kind} job.`);

  try {
    const before = running.request.write ? captureGitStatus(running.request.cwd) : null;
    const onPid = (pid) => {
      // Record the Grok subprocess pid only while the job is still running.
      // Route through the locked CAS so a concurrent cancel that flipped the
      // state to "cancelled" cannot be clobbered back to "running".
      compareAndSwapJobState(cwd, running.id, "running", { ...running, grokPid: pid });
    };
    const grokResult = running.request.write
      ? await runWriteGrok({
          cwd: running.request.cwd,
          prompt: running.request.prompt,
          model: running.request.model ?? undefined,
          sessionId: running.request.grokSessionId,
          resumeSessionId: running.request.resumeSessionId,
          alwaysApprove: running.request.alwaysApprove,
          effort: running.request.effort,
          maxTurns: running.request.maxTurns,
          jsonSchema: running.request.jsonSchema,
          onPid
        })
      : await runReadOnlyGrok({
          cwd: running.request.cwd,
          prompt: running.request.prompt,
          model: running.request.model ?? undefined,
          sessionId: running.request.grokSessionId,
          resumeSessionId: running.request.resumeSessionId,
          effort: running.request.effort,
          maxTurns: running.request.maxTurns,
          jsonSchema: running.request.jsonSchema,
          onPid
        });
    const writeSummary = before ? summarizeWriteChanges(before, captureGitStatus(running.request.cwd)) : null;
    const status = classifyGrokCompletion({
      exitStatus: grokResult.status,
      stopReason: grokResult.output.stopReason
    });
    const rendered = [
      ...(status === "incomplete" ? [...renderIncompleteBanner(grokResult.output.stopReason), ""] : []),
      renderGrokResult(grokResult, jobHeading(running.kind)).trimEnd(),
      ...(writeSummary ? ["", ...renderWriteSummary(writeSummary)] : [])
    ].join("\n") + "\n";
    const stopReason = grokResult.output.stopReason ?? null;
    const completionResult = compareAndSwapJobState(cwd, running.id, "running", {
      ...running,
      status,
      stopReason,
      evidence: {
        stopReason,
        exitStatus: grokResult.status,
        changedFiles: writeSummary ? writeSummary.changedFiles : null
      },
      pid: null,
      grokPid: grokResult.pid ?? running.grokPid ?? null,
      completedAt: new Date().toISOString(),
      result: {
        grok: {
          status: grokResult.status,
          stderr: grokResult.stderr,
          stdout: grokResult.stdout,
          model: grokResult.model,
          parsed: grokResult.output.parsed,
          rawOutput: grokResult.output.rawOutput,
          parseError: grokResult.output.parseError
        }
      },
      writeSummary,
      rendered,
      errorMessage:
        status === "failed"
          ? grokResult.stderr.trim() || `Grok exited with status ${grokResult.status}.`
          : status === "incomplete"
            ? `Grok stopped early (stopReason: ${stopReason ?? "unknown"}).`
            : null
    });
    if (!completionResult.success) {
      appendJobLog(cwd, running.id, "Job was cancelled while Grok was running.");
      return completionResult.job ?? running;
    }
    const completed = completionResult.job;
    const completionKind = status === "succeeded"
      ? "Completed"
      : status === "incomplete"
        ? "Completed with incomplete status"
        : "Failed";
    appendJobLog(cwd, completed.id, `${completionKind} ${completed.kind} job.`);
    return completed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failResult = compareAndSwapJobState(cwd, running.id, "running", {
      ...running,
      status: "failed",
      pid: null,
      completedAt: new Date().toISOString(),
      errorMessage: message
    });
    const failed = failResult.success ? failResult.job : (failResult.job ?? running);
    appendJobLog(cwd, running.id, failResult.success ? "Failed before Grok produced a result." : "Job was cancelled before Grok produced a result.");
    return failed;
  } finally {
    if (job.request.write) {
      releaseWriteLock(cwd, job.id);
    }
  }
}

function enqueueBackgroundJob(cwd, request) {
  ensureGrok(cwd);
  const job = createJob(request.kind, cwd, {
    summary: request.summary,
    request,
    logFile: null,
    ...request.jobFields
  });
  const logFile = resolveJobLogFile(cwd, job.id);
  if (request.write) {
    acquireWriteLock(cwd, job.id);
  }
  let queued;
  try {
    queued = writeJob(cwd, { ...job, logFile });
  } catch (error) {
    if (request.write) {
      releaseWriteLock(cwd, job.id);
    }
    throw error;
  }
  appendJobLog(cwd, queued.id, "Queued for detached background execution.");

  const env = { ...process.env };
  delete env.GROK_BUILD_COMPANION_ACTIVE;
  let child;
  try {
    child = spawn(process.execPath, [SCRIPT_PATH, "worker", "--cwd", cwd, "--job-id", queued.id], {
      cwd,
      env,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
  } catch (error) {
    if (request.write) {
      releaseWriteLock(cwd, queued.id);
    }
    throw error;
  }

  return {
    jobId: queued.id,
    status: queued.status,
    pid: child.pid ?? null,
    summary: queued.summary
  };
}

async function runForegroundJob(cwd, request, asJson) {
  ensureGrok(cwd);
  const initialJob = createJob(request.kind, cwd, {
    summary: request.summary,
    request,
    ...request.jobFields
  });
  const job = {
    ...initialJob,
    logFile: resolveJobLogFile(cwd, initialJob.id)
  };
  if (request.write) {
    acquireWriteLock(cwd, job.id);
  }
  try {
    writeJob(cwd, job);
  } catch (error) {
    if (request.write) {
      releaseWriteLock(cwd, job.id);
    }
    throw error;
  }
  const completed = await runStoredJob(cwd, job);
  output(asJson ? completed : completed.rendered, asJson);
  // Incomplete gets a distinct exit code because the diff often landed — callers must verify, not blindly retry.
  if (completed.status === "incomplete") {
    process.exitCode = 2;
  } else if (completed.status !== "succeeded") {
    process.exitCode = 1;
  }
}

async function handleSetup(argv) {
  const { options } = parseCommand(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCwd(options);
  const node = binaryAvailable("node", ["--version"], { cwd });
  const grok = getGrokAvailability(cwd);
  const inspectResult = grok.available ? await getGrokInspect(cwd) : null;
  const inspect = inspectResult
    ? {
        available: inspectResult.status === 0,
        detail: inspectResult.status === 0 ? "available" : inspectResult.stderr.trim() || "inspect failed"
      }
    : { available: false, detail: "skipped because Grok is unavailable" };
  const nextSteps = [];
  if (!grok.available) {
    nextSteps.push("Install Grok Build using the official xAI installer.");
  } else if (!inspect.available) {
    nextSteps.push("Run `grok login` once, then retry `/grok:setup`.");
  }
  const report = {
    ready: node.available && grok.available && inspect.available,
    node,
    grok,
    inspect,
    nextSteps
  };
  output(options.json ? report : renderSetup(report), options.json);
}

async function handleAsk(argv) {
  const { options, positionals } = parseCommand(argv, {
    valueOptions: ["cwd", "model", "effort", "max-turns", "json-schema"],
    booleanOptions: ["write", "always-approve", "yolo", "json"]
  });
  rejectTaskOnlyWriteFlags(options, "ask");
  resolveMaxTurns(options["max-turns"], process.env);
  const cwd = resolveCwd(options);
  const prompt = readOnlyPrompt(requirePrompt(positionals, "question"), "answer a repository question");
  const request = {
    ...makeJobRequest("ask", cwd, options.model, prompt, "Read-only question"),
    effort: options.effort,
    maxTurns: options["max-turns"],
    jsonSchema: options["json-schema"]
  };
  await runForegroundJob(cwd, request, options.json);
}

async function handleReview(argv) {
  const { options } = parseCommand(argv, {
    valueOptions: ["cwd", "model", "base", "scope", "effort", "max-turns", "json-schema"],
    booleanOptions: ["background", "json", "write", "always-approve", "yolo"]
  });
  rejectTaskOnlyWriteFlags(options, "review");
  resolveMaxTurns(options["max-turns"], process.env);
  const cwd = resolveCwd(options);
  const context = collectReviewContext(cwd, { base: options.base, scope: options.scope });
  const request = {
    ...makeJobRequest("review", context.repoRoot, options.model, reviewPrompt(context), `Review ${context.targetLabel}`),
    effort: options.effort,
    maxTurns: options["max-turns"],
    jsonSchema: options["json-schema"]
  };
  if (options.background) {
    const queued = enqueueBackgroundJob(context.repoRoot, request);
    output(options.json ? queued : `Grok review queued as ${queued.jobId}. Check /grok:status ${queued.jobId} for progress.\n`, options.json);
    return;
  }
  await runForegroundJob(context.repoRoot, request, options.json);
}

async function handleTask(argv) {
  const { options, positionals } = parseCommand(argv, {
    valueOptions: ["cwd", "model", "effort", "max-turns", "json-schema"],
    booleanOptions: ["background", "wait", "resume", "fresh", "json", "write", "always-approve", "yolo"]
  });
  if (options.background && options.wait) {
    throw new Error("Choose either --background or --wait.");
  }
  if (options.resume && options.fresh) {
    throw new Error("Choose either --resume or --fresh.");
  }
  resolveMaxTurns(options["max-turns"], process.env);
  const write = Boolean(options.write);
  const alwaysApprove = Boolean(options["always-approve"] || options.yolo);
  if (alwaysApprove && !write) {
    throw new Error("--always-approve/--yolo requires --write.");
  }
  if (write && !alwaysApprove) {
    throw new Error("Write tasks require explicit --always-approve (or --yolo) for headless execution.");
  }

  const requestedCwd = resolveCwd(options);
  const cwd = write ? getGitRepositoryRoot(requestedCwd) : requestedCwd;
  const taskText = positionals.join(" ").trim() || (options.resume ? "Continue the previous task." : requirePrompt(positionals, "task"));
  const claudeSessionId = getCurrentClaudeSessionId();
  const sessionJobs = filterJobsForCurrentClaudeSession(listJobs(cwd));
  const activeTask = sessionJobs.find((job) => job.kind === "task" && isActiveJob(job));
  if (options.resume && activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /grok:status before continuing it.`);
  }
  const candidate = options.resume
    ? findLatestResumableTaskJob(sessionJobs)
    : null;
  if (options.resume && !candidate) {
    throw new Error("No previous Grok task session was found for this Claude session.");
  }
  const grokSessionId = candidate?.grokSessionId ?? randomUUID();
  const request = {
    ...makeJobRequest(
      "task",
      cwd,
      options.model,
      write ? writePrompt(taskText) : readOnlyPrompt(taskText, "diagnose or plan a task"),
      write ? "Write rescue task" : "Read-only rescue task"
    ),
    write,
    alwaysApprove,
    effort: options.effort,
    maxTurns: options["max-turns"],
    jsonSchema: options["json-schema"],
    grokSessionId,
    resumeSessionId: candidate?.grokSessionId ?? null,
    jobFields: {
      ...(claudeSessionId ? { claudeSessionId } : {}),
      grokSessionId
    }
  };
  if (options.background) {
    const queued = enqueueBackgroundJob(cwd, request);
    output(options.json ? queued : `Grok rescue queued as ${queued.jobId}. Check /grok:status ${queued.jobId} for progress.\n`, options.json);
    return;
  }
  await runForegroundJob(cwd, request, options.json);
}

async function handleWorker(argv) {
  const { options } = parseCommand(argv, {
    valueOptions: ["cwd", "job-id"]
  });
  if (!options["job-id"]) {
    throw new Error("Missing --job-id for background worker.");
  }
  const cwd = resolveCwd(options);
  const job = readJob(cwd, options["job-id"]);
  if (!job?.request) {
    throw new Error(`No queued Grok job found for ${options["job-id"]}.`);
  }
  await runStoredJob(cwd, job);
}

function handleStatus(argv) {
  const { options, positionals } = parseCommand(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "all"]
  });
  const cwd = resolveCwd(options);
  const job = positionals[0] ? resolveJobReference(cwd, positionals[0]) : null;
  if (positionals[0] && !job) {
    throw new Error(`No Grok job found for "${positionals[0]}".`);
  }
  if (job) {
    const enriched = attachRunningLiveness(job);
    output(options.json ? enriched : renderStatus([enriched]), options.json);
    return;
  }

  const allJobs = listJobs(cwd);
  const payload = (options.all ? allJobs : filterJobsForCurrentClaudeSession(allJobs)).map(
    attachRunningLiveness
  );
  if (options.json) {
    output(payload, true);
    return;
  }

  let rendered = renderStatus(payload);
  if (!options.all) {
    const hiddenCount = allJobs.length - payload.length;
    if (hiddenCount > 0) {
      const note = `${hiddenCount} other job(s) from other sessions/worktrees — run /grok:status --all`;
      rendered = payload.length === 0
        ? `# Grok Status\n\n${note}\n`
        : `${rendered.trimEnd()}\n\n${note}\n`;
    }
  }
  output(rendered, false);
}

function handleResult(argv) {
  const { options, positionals } = parseCommand(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCwd(options);
  const job = resolveJobReference(cwd, positionals[0] ?? "", {
    finishedOnly: true,
    sessionId: positionals[0] ? null : getCurrentClaudeSessionId()
  });
  if (!job) {
    throw new Error("No finished Grok job found for this workspace.");
  }
  output(options.json ? job : renderJobResult(job), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommand(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCwd(options);
  const sessionId = getCurrentClaudeSessionId();
  const candidate = findLatestResumableTaskJob(filterJobsForCurrentClaudeSession(listJobs(cwd)));
  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            summary: candidate.summary ?? null,
            grokSessionId: candidate.grokSessionId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };
  output(options.json ? payload : candidate ? `Resumable task found: ${candidate.id} (${candidate.status}).\n` : "No resumable task found for this session.\n", options.json);
}

function handleCancel(argv) {
  const { options, positionals } = parseCommand(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCwd(options);
  let job;
  if (positionals[0]) {
    job = resolveJobReference(cwd, positionals[0]);
    if (!job) {
      throw new Error(`No Grok job found for "${positionals[0]}".`);
    }
  } else {
    const activeJobs = filterJobsForCurrentClaudeSession(listJobs(cwd)).filter(isActiveJob);
    job = activeJobs[0] ?? null;
    if (!job) {
      throw new Error("No active Grok job found for this workspace.");
    }
  }

  let cancelledJob = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = readJob(cwd, job.id);
    if (!current || !isActiveJob(current)) {
      throw new Error(`Job ${job.id} is already ${current?.status ?? "unknown"}.`);
    }
    const result = compareAndSwapJobState(cwd, job.id, current.status, {
      ...current,
      status: "cancelled",
      pid: null,
      grokPid: null,
      completedAt: new Date().toISOString(),
      errorMessage: "Cancelled by user."
    });
    if (result.success) {
      cancelledJob = result.job;
      break;
    }
  }
  if (!cancelledJob) {
    throw new Error(`Job ${job.id} state changed before cancellation could complete.`);
  }

  terminateProcessTree(job.grokPid ?? job.pid ?? Number.NaN);
  if (job.request?.write) {
    releaseWriteLock(cwd, job.id);
  }
  appendJobLog(cwd, job.id, "Cancelled by user.");
  const payload = {
    jobId: cancelledJob.id,
    status: "cancelled",
    summary: cancelledJob.summary ?? null
  };
  output(options.json ? payload : `Grok job ${cancelledJob.id} cancelled.\n`, options.json);
}

function handleCleanup(argv) {
  const { options } = parseCommand(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCwd(options);
  const jobs = listJobs(cwd);
  const preserved = findLatestResumableTaskJob(jobs);
  const preservedSessionId = preserved?.grokSessionId ?? null;

  const terminalSessionIds = [
    ...new Set(
      jobs
        .filter((job) => !isActiveJob(job) && typeof job.grokSessionId === "string" && job.grokSessionId)
        .map((job) => job.grokSessionId)
        .filter((sessionId) => sessionId !== preservedSessionId)
    )
  ];

  const results = terminalSessionIds.map((sessionId) => {
    const outcome = deleteGrokSession(cwd, sessionId);
    return { sessionId, ok: outcome.ok, detail: outcome.detail };
  });

  const payload = {
    attempted: results.length,
    preservedSessionId,
    results
  };

  output(options.json ? payload : renderCleanupReport(payload), options.json);
}

async function main() {
  assertNotRecursive();
  const [command, ...argv] = process.argv.slice(2);
  switch (command) {
    case "setup":
      await handleSetup(argv);
      break;
    case "ask":
      await handleAsk(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "task":
      await handleTask(argv);
      break;
    case "worker":
      await handleWorker(argv);
      break;
    case "status":
      handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "cancel":
      handleCancel(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cleanup":
      handleCleanup(argv);
      break;
    default:
      output(usage());
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
