const DEFAULT_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_MODEL = "grok-4.5";
const DEFAULT_TIMEOUT_MS = 120000;

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

/**
 * @param {{ prompt: string, model: string|null }} options
 * @returns {Promise<{source: "xai_api_fallback", model: string, write_supported: false, text: string}>}
 */
export async function runXaiApiFallback(options) {
  const baseUrl = process.env.GROK_BUILD_XAI_BASE_URL || DEFAULT_BASE_URL;
  const timeoutMs = Number(process.env.GROK_BUILD_XAI_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const model = options.model || DEFAULT_MODEL;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.XAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model, input: options.prompt }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  const bodyText = await response.text();
  if (!response.ok) {
    const truncated = bodyText.length > 300 ? `${bodyText.slice(0, 300)}...` : bodyText;
    throw new Error(`xAI API fallback request failed with status ${response.status}: ${truncated}`);
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
