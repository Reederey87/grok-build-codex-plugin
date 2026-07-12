/**
 * Prompt builders for Grok Build invocations. Extracted verbatim from the
 * reference companion script so the wrapping/guardrail text stays identical
 * across the CLI-era and MCP-era implementations.
 */

/**
 * Wraps a user prompt for a strictly read-only Grok Build invocation.
 * @param {string} userPrompt
 * @param {string} purpose
 * @returns {string}
 */
export function readOnlyPrompt(userPrompt, purpose) {
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

/**
 * Wraps a user prompt for a bounded, write-capable Grok Build invocation.
 * @param {string} userPrompt
 * @returns {string}
 */
export function writePrompt(userPrompt) {
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

/**
 * Builds a read-only code review prompt from collected review context.
 * @param {{ content: string }} context
 * @returns {string}
 */
export function reviewPrompt(context) {
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
