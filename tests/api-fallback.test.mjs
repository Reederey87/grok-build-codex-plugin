import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { handler as prompt } from "../mcp-server/src/tools/prompt.mjs";
import { handler as task } from "../mcp-server/src/tools/task.mjs";
import { resolveFallbackEndpoint } from "../mcp-server/src/lib/api-fallback.mjs";

function parseContent(response) {
  return JSON.parse(response.content[0].text);
}

async function withEnvironment(changes, callback) {
  const previous = new Map();
  for (const [key, value] of Object.entries(changes)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * @param {import("node:test").TestContext} t
 * @param {{status?: number, body?: string|Record<string, unknown>}} [options]
 */
async function makeStub(t, options = {}) {
  const { status = 200, body = { output_text: "fallback response" } } = options;
  const requests = [];
  const server = http.createServer((request, response) => {
    let input = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { input += chunk; });
    request.on("end", () => {
      requests.push({ url: request.url, authorization: request.headers.authorization, body: input });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(typeof body === "string" ? body : JSON.stringify(body));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert(address && typeof address === "object");
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

function makeContext() {
  const root = makeTempDir("grok-api-fallback-");
  const cwd = path.join(root, "workspace");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(cwd);
  fs.mkdirSync(binDir);
  const gitPath = run("which", ["git"]).stdout.trim();
  if (gitPath) fs.symlinkSync(gitPath, path.join(binDir, "git"));
  return { root, cwd, noGrokPath: binDir };
}

test("an explicitly allowed prompt falls back to the local xAI stub when Grok is absent", async (t) => {
  const stub = await makeStub(t);
  const context = makeContext();
  try {
    await withEnvironment({
      PATH: context.noGrokPath,
      GROK_BUILD_XAI_BASE_URL: stub.baseUrl,
      GROK_BUILD_API_FALLBACK: undefined,
      XAI_API_KEY: "test"
    }, async () => {
      const response = await prompt({ cwd: context.cwd, prompt: "Use the fallback", allow_api_fallback: true });
      assert.equal(response.isError, undefined);
      const body = parseContent(response);
      assert.equal(body.source, "xai_api_fallback");
      assert.equal(body.write_supported, false);
      assert.equal(body.text, "fallback response");
      assert.equal(stub.requests.length, 1);
      assert.equal(stub.requests[0].url, "/responses");
      assert.equal(stub.requests[0].authorization, "Bearer test");
      const requestBody = JSON.parse(stub.requests[0].body);
      assert.equal(requestBody.model, "grok-4.5");
      assert.equal(typeof requestBody.input, "string");
      assert.equal(requestBody.store, false);
    });
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("fallback does not fire without input or environment opt-in", async (t) => {
  const stub = await makeStub(t);
  const context = makeContext();
  try {
    await withEnvironment({
      PATH: context.noGrokPath,
      GROK_BUILD_XAI_BASE_URL: stub.baseUrl,
      GROK_BUILD_API_FALLBACK: undefined,
      XAI_API_KEY: "test"
    }, async () => {
      const response = await prompt({ cwd: context.cwd, prompt: "Do not fall back" });
      assert.equal(response.isError, true);
      assert.equal(stub.requests.length, 0);
    });
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("fallback does not fire without XAI_API_KEY even when allowed", async (t) => {
  const stub = await makeStub(t);
  const context = makeContext();
  try {
    await withEnvironment({
      PATH: context.noGrokPath,
      GROK_BUILD_XAI_BASE_URL: stub.baseUrl,
      GROK_BUILD_API_FALLBACK: undefined,
      XAI_API_KEY: undefined
    }, async () => {
      const response = await prompt({ cwd: context.cwd, prompt: "Missing credentials", allow_api_fallback: true });
      assert.equal(response.isError, true);
      assert.equal(stub.requests.length, 0);
    });
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("write tasks never use API fallback", async (t) => {
  const stub = await makeStub(t);
  const context = makeContext();
  initGitRepo(context.cwd);
  try {
    await withEnvironment({
      PATH: context.noGrokPath,
      GROK_BUILD_XAI_BASE_URL: stub.baseUrl,
      GROK_BUILD_API_FALLBACK: "true",
      GROK_BUILD_ALLOW_WRITE: "true",
      XAI_API_KEY: "test"
    }, async () => {
      const response = await task({ cwd: context.cwd, task: "Write something", write: true, allow_api_fallback: true });
      assert.equal(response.isError, true);
      assert.equal(stub.requests.length, 0);
    });
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("a non-2xx fallback response surfaces its status without echoing its body", async (t) => {
  const stub = await makeStub(t, { status: 503, body: { error: "stub unavailable" } });
  const context = makeContext();
  try {
    await withEnvironment({
      PATH: context.noGrokPath,
      GROK_BUILD_XAI_BASE_URL: stub.baseUrl,
      GROK_BUILD_API_FALLBACK: undefined,
      XAI_API_KEY: "test"
    }, async () => {
      const response = await prompt({ cwd: context.cwd, prompt: "Surface the failure", allow_api_fallback: true });
      assert.equal(response.isError, true);
      assert.match(parseContent(response).error, /status 503/);
      assert.doesNotMatch(parseContent(response).error, /stub unavailable/);
      assert.equal(stub.requests.length, 1);
    });
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("fallback rejects invalid configured timeouts before making a request", async (t) => {
  const stub = await makeStub(t);
  const context = makeContext();
  try {
    await withEnvironment({
      PATH: context.noGrokPath,
      GROK_BUILD_XAI_BASE_URL: stub.baseUrl,
      GROK_BUILD_XAI_TIMEOUT_MS: "-1",
      XAI_API_KEY: "test"
    }, async () => {
      const response = await prompt({ cwd: context.cwd, prompt: "Reject bad timeout", allow_api_fallback: true });
      assert.equal(response.isError, true);
      assert.match(parseContent(response).error, /GROK_BUILD_XAI_TIMEOUT_MS/);
      assert.equal(stub.requests.length, 0);
    });
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test("fallback base URLs require an explicit trust decision for custom hosts", () => {
  assert.equal(resolveFallbackEndpoint({}), "https://api.x.ai/v1/responses");
  assert.equal(resolveFallbackEndpoint({ GROK_BUILD_XAI_BASE_URL: "http://127.0.0.1:8123/v1" }), "http://127.0.0.1:8123/v1/responses");
  assert.throws(
    () => resolveFallbackEndpoint({ GROK_BUILD_XAI_BASE_URL: "https://gateway.example/v1" }),
    /TRUST_CUSTOM_XAI_BASE_URL/
  );
  assert.equal(
    resolveFallbackEndpoint({ GROK_BUILD_XAI_BASE_URL: "https://gateway.example/v1", GROK_BUILD_TRUST_CUSTOM_XAI_BASE_URL: "true" }),
    "https://gateway.example/v1/responses"
  );
  assert.throws(() => resolveFallbackEndpoint({ GROK_BUILD_XAI_BASE_URL: "https://user:secret@api.x.ai/v1" }), /must not contain URL credentials/);
  assert.throws(() => resolveFallbackEndpoint({ GROK_BUILD_XAI_BASE_URL: "http://api.x.ai/v1" }), /must use HTTPS/);
});
