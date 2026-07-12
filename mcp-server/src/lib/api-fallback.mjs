/**
 * TODO: Replace this placeholder with the xAI API implementation supplied by
 * the API-fallback work item.
 *
 * @param {{ prompt: string, model: string|null }} _options
 * @returns {Promise<{source: "xai_api_fallback", model: string|null, write_supported: false, text: string}>}
 */
export async function runXaiApiFallback(_options) {
  throw new Error("xAI API fallback is not implemented in this build.");
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function apiFallbackAvailable(env = process.env) {
  return Boolean(env.XAI_API_KEY);
}
