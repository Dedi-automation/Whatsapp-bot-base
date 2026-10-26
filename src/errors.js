'use strict';

// Shared error types. Contracts only: no behavior here.

class NotImplementedError extends Error {
  constructor(name) {
    super(`${name} is not implemented yet (step 0 stub)`);
    this.name = 'NotImplementedError';
  }
}

class ConfigError extends Error {
  /** @param {string[]} missing names of missing environment variables */
  constructor(missing) {
    super(`Missing required environment variables: ${missing.join(', ')}`);
    this.name = 'ConfigError';
    this.missing = missing;
  }
}

class SchemaError extends Error {
  /** @param {string} message @param {string[]} [missing] */
  constructor(message, missing = []) {
    super(message);
    this.name = 'SchemaError';
    this.missing = missing;
  }
}

class PromptVariableError extends Error {
  /** @param {string[]} missing names of template variables with no usable value */
  constructor(missing) {
    super(`Prompt variables missing or empty: ${missing.join(', ')}`);
    this.name = 'PromptVariableError';
    this.missing = missing;
  }
}

class AiResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AiResponseError';
  }
}

class WhatsAppError extends Error {
  /** @param {string} message @param {{status?: number, code?: number}} [details] */
  constructor(message, details = {}) {
    super(message);
    this.name = 'WhatsAppError';
    this.status = details.status;
    this.code = details.code;
  }
}

class StorageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StorageError';
  }
}

class EmailError extends Error {
  /** @param {string} message @param {{status?: number}} [details] */
  constructor(message, details = {}) {
    super(message);
    this.name = 'EmailError';
    this.status = details.status;
  }
}

module.exports = {
  NotImplementedError,
  ConfigError,
  SchemaError,
  PromptVariableError,
  AiResponseError,
  WhatsAppError,
  StorageError,
  EmailError,
};
