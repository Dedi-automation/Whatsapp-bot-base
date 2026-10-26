'use strict';

// B6 AI client (Branch C).
//
// - Prompt is rendered from a closed list of fields. A missing or empty value is
//   an explicit error, never an empty string in the prompt (F-10, F-29, T-07, T-14).
// - The model string comes from config only (decisions.md item 18). No default in code.
// - The reply must match the tool schema; otherwise it is rejected, not sent (T-06).
// - The HTTP call goes through an injected `fetch`, so tests never touch the network.
// Fake for tests: src/fakes/ai-fake.js.

const { PromptVariableError, AiResponseError } = require('./errors');

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 1024;

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Render a prompt template with {name} placeholders.
 *
 * Errors: PromptVariableError with `.missing` listing every placeholder whose
 * value is undefined, null, the empty string or only whitespace (each name once,
 * in order of first use). Placeholders not in `template` are ignored. Values not
 * used by the template are ignored. Values are inserted once; a `{x}` inside a
 * value is not rendered again.
 *
 * @param {string} template
 * @param {Record<string, string | null | undefined>} values
 * @returns {string}
 */
function renderPrompt(template, values) {
  if (typeof template !== 'string') {
    throw new TypeError('renderPrompt: template must be a string');
  }
  const source = values || {};

  const missing = [];
  for (const [, name] of template.matchAll(PLACEHOLDER)) {
    if (!hasValue(source, name) && !missing.includes(name)) {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new PromptVariableError(missing);
  }

  return template.replace(PLACEHOLDER, (_, name) => String(source[name]));
}

function hasValue(source, name) {
  if (!Object.prototype.hasOwnProperty.call(source, name)) return false;
  const value = source[name];
  if (value === undefined || value === null) return false;
  return String(value).trim() !== '';
}

/**
 * @typedef {Object} ToolDefinition
 * @property {string} name                 e.g. 'send_whatsapp_reply'
 * @property {Record<string, unknown>} inputSchema  JSON schema of the tool input
 * @property {string} [description]
 *
 * @typedef {Object} AiClient
 * @property {(input: {systemPrompt: string, messages: Array<{role: 'user'|'assistant', content: string}>, tool: ToolDefinition}) => Promise<Record<string, unknown>>} reply
 *   Forces the given tool. Resolves with the validated tool input only.
 */

/**
 * @param {{apiKey: string, model: string, fetch?: typeof fetch, maxTokens?: number}} options
 *   `model` is required. There is no default model in code.
 *   `fetch` defaults to the global fetch (Node 18+).
 * @returns {AiClient}
 * Errors: AiResponseError when the HTTP call fails, the reply does not match the
 * tool schema, the tool was not used, or the reply was cut off.
 */
function createAiClient(options) {
  const { apiKey, model, maxTokens = DEFAULT_MAX_TOKENS } = options || {};
  const fetchFn = (options && options.fetch) || globalThis.fetch;

  if (typeof model !== 'string' || model.trim() === '') {
    throw new TypeError('createAiClient: model is required (set AI_MODEL in config)');
  }
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new TypeError('createAiClient: apiKey is required (set ANTHROPIC_API_KEY in config)');
  }
  if (typeof fetchFn !== 'function') {
    throw new TypeError('createAiClient: no fetch implementation available');
  }

  async function reply({ systemPrompt, messages, tool }) {
    if (!tool || typeof tool.name !== 'string' || !tool.inputSchema) {
      throw new TypeError('reply: tool with name and inputSchema is required');
    }

    const body = {
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
      tools: [{
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        input_schema: tool.inputSchema,
      }],
      tool_choice: { type: 'tool', name: tool.name },
    };

    let response;
    try {
      response = await fetchFn(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw withCause(new AiResponseError(`AI request failed: ${err.message}`), err);
    }

    if (!response.ok) {
      throw new AiResponseError(`AI request failed with HTTP ${response.status}`);
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      throw withCause(new AiResponseError('AI response is not valid JSON'), err);
    }

    if (data && data.stop_reason === 'max_tokens') {
      throw new AiResponseError('AI reply was cut off (max_tokens); tool input may be incomplete');
    }

    const content = data && Array.isArray(data.content) ? data.content : [];
    const call = content.find((block) => block && block.type === 'tool_use' && block.name === tool.name);
    if (!call) {
      throw new AiResponseError(`AI reply did not use the required tool ${tool.name}`);
    }

    const errors = validate(call.input, tool.inputSchema, 'input');
    if (errors.length > 0) {
      throw new AiResponseError(`AI reply does not match the ${tool.name} schema: ${errors.join('; ')}`);
    }

    return call.input;
  }

  return { reply };
}

function withCause(error, cause) {
  error.cause = cause;
  return error;
}

// Minimal JSON schema check for tool input. Supports: type (string or list),
// enum, const, required, properties, additionalProperties (false or schema),
// items, minItems, maxItems, minLength, maxLength, minimum, maximum.
// Keywords outside this list are not checked.
function validate(value, schema, path) {
  if (!schema || typeof schema !== 'object') return [];
  const errors = [];

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      return [`${path} must be ${types.join(' or ')}`];
    }
  }

  if (schema.enum !== undefined && !schema.enum.some((option) => deepEqual(option, value))) {
    errors.push(`${path} must be one of ${JSON.stringify(schema.enum)}`);
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    errors.push(`${path} must be ${JSON.stringify(schema.const)}`);
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path} is shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} is longer than ${schema.maxLength}`);
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} is below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} is above ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} has fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} has more than ${schema.maxItems} items`);
    if (schema.items) {
      value.forEach((item, i) => errors.push(...validate(item, schema.items, `${path}[${i}]`)));
    }
  }

  if (isPlainObject(value)) {
    const properties = schema.properties || {};
    for (const name of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, name)) errors.push(`${path}.${name} is required`);
    }
    for (const [name, child] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, name)) {
        errors.push(...validate(child, properties[name], `${path}.${name}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${name} is not allowed`);
      } else if (isPlainObject(schema.additionalProperties)) {
        errors.push(...validate(child, schema.additionalProperties, `${path}.${name}`));
      }
    }
  }

  return errors;
}

function matchesType(value, type) {
  switch (type) {
    case 'object': return isPlainObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

module.exports = { renderPrompt, createAiClient };
