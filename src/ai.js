'use strict';

// B6 AI client. Contract only (step 0). Logic comes in Branch C.
//
// - Prompt is rendered from a closed list of fields. A missing or empty value is
//   an explicit error, never an empty string in the prompt (F-10, F-29, T-07, T-14).
// - The model string comes from config only (decisions.md: model set in config).
// - The reply must match the tool schema; otherwise it is rejected, not sent (T-06).
// Fake for tests: src/fakes/ai-fake.js.

const { NotImplementedError } = require('./errors');

/**
 * Render a prompt template with {name} placeholders.
 *
 * Errors: PromptVariableError with `.missing` listing every placeholder whose
 * value is undefined, null or the empty string. Placeholders not in `template`
 * are ignored. Values not used by the template are ignored.
 *
 * @param {string} template
 * @param {Record<string, string | null | undefined>} values
 * @returns {string}
 */
function renderPrompt(template, values) {
  void template; void values;
  throw new NotImplementedError('renderPrompt');
}

/**
 * @typedef {Object} ToolDefinition
 * @property {string} name                 e.g. 'send_whatsapp_reply'
 * @property {Record<string, unknown>} inputSchema  JSON schema of the tool input
 *
 * @typedef {Object} AiClient
 * @property {(input: {systemPrompt: string, messages: Array<{role: 'user'|'assistant', content: string}>, tool: ToolDefinition}) => Promise<Record<string, unknown>>} reply
 *   Forces the given tool. Resolves with the validated tool input only.
 */

/**
 * @param {{apiKey: string, model: string, fetch?: typeof fetch}} options
 *   `model` is required. There is no default model in code.
 * @returns {AiClient}
 * Errors: AiResponseError when the reply does not match the tool schema or the tool was not used.
 */
function createAiClient(options) {
  void options;
  throw new NotImplementedError('createAiClient');
}

module.exports = { renderPrompt, createAiClient };
