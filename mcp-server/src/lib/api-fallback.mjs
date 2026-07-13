const DEFAULT_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_MODEL = "grok-4.5";
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 600000;
const CUSTOM_BASE_URL_TRUST_ENV = "GROK_BUILD_TRUST_CUSTOM_XAI_BASE_URL";

function configuredTimeout(env = process.env) {
  const raw = env.GROK_BUILD_XAI_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_TIMEOUT_MS) {
    throw new Error(`GROK_BUILD_XAI_TIMEOUT_MS must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
  }
  return parsed;
}

/**
 * @param {unknown} json
 * @returns {string}
 */
function extractOutputText(json) {
  if (json && typeof json === "object" && "output_text" in json && typeof json.output_text === "string") {
    return json.output_text;
  }
  if (json && typeof json === "object" && "output" in json && Array.isArray(json.output)) {
    const text = json.output
      .flatMap((entry) => {
        if (!entry || typeof entry !== "object" || !Array.isArray(entry.content)) return [];
        return entry.content
          .filter((item) => item && typeof item === "object" && typeof item.type === "string" && item.type.includes("text"))
          .map((item) => (typeof item.text === "string" ? item.text : ""));
      })
      .join("");
    if (text) return text;
  }
  return JSON.stringify(json);
}

export function resolveFallbackEndpoint(env = process.env) {
  const configured = env.GROK_BUILD_XAI_BASE_URL || DEFAULT_BASE_URL;
  let base;
  try {
    base = new URL(configured);
  } catch {
    throw new Error("GROK_BUILD_XAI_BASE_URL must be a valid absolute URL.");
  }
  if (base.username || base.password) throw new Error("GROK_BUILD_XAI_BASE_URL must not contain URL credentials.");
  if (base.hash || base.search) throw new Error("GROK_BUILD_XAI_BASE_URL must not contain a query string or fragment.");
  const loopback = base.hostname === "localhost" || base.hostname === "127.0.0.1" || base.hostname === "[::1]" || base.hostname === "::1";
  if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) {
    throw new Error("GROK_BUILD_XAI_BASE_URL must use HTTPS; HTTP is allowed only for loopback test endpoints.");
  }
  const official = base.protocol === "https:" && base.hostname === "api.x.ai";
  if (!official && !loopback && env[CUSTOM_BASE_URL_TRUST_ENV] !== "true") {
    throw new Error(`Custom xAI fallback hosts require ${CUSTOM_BASE_URL_TRUST_ENV}=true.`);
  }
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return new URL("responses", base).toString();
}

/**
 * @param {{ prompt: string, model: string|null }} options
 * @returns {Promise<{source: "xai_api_fallback", model: string, write_supported: false, text: string}>}
 */
export async function runXaiApiFallback(options) {
  const endpoint = resolveFallbackEndpoint();
  const timeoutMs = configuredTimeout();
  const model = options.model || DEFAULT_MODEL;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let bodyText;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.XAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model, input: options.prompt, store: false }),
      signal: controller.signal
    });
    // Read the body inside the timeout window: a stalled body stream must
    // abort just like stalled headers.
    bodyText = await response.text();
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`xAI API fallback request failed with status ${response.status}.`);
  }

  /** @type {unknown} */
  let json;
  try {
    json = JSON.parse(bodyText);
  } catch {
    json = bodyText;
  }

  return {
    source: "xai_api_fallback",
    model,
    write_supported: false,
    text: extractOutputText(json)
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function apiFallbackAvailable(env = process.env) {
  return Boolean(env.XAI_API_KEY);
}
