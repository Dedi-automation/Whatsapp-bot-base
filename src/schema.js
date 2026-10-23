'use strict';

// B4 Schema. Contract only (step 0). Logic comes in Branch A.
//
// Field names are referenced by ID in code. Header names (for example Hebrew
// column headers from a sheet import) are checked at startup, so a renamed or
// missing header fails loudly (T-12, F-07, F-12). Trailing spaces in a header are
// an error, not a silent mismatch (F-07).
//
// Schema shape (example):
//   {
//     leads: {
//       fields: {
//         customerId: { header: 'Customer ID', required: true },
//         status:     { header: 'Status',      required: true },
//       },
//     },
//   }

const { NotImplementedError } = require('./errors');

/**
 * @typedef {{header: string, required?: boolean}} FieldDef
 * @typedef {Record<string, {fields: Record<string, FieldDef>}>} Schema
 */

/**
 * Validate the schema itself at startup. Rejects duplicate headers within a tab,
 * and headers with leading or trailing spaces.
 *
 * Errors: SchemaError.
 *
 * @param {Schema} schema
 * @returns {Schema}
 */
function validateSchema(schema) {
  void schema;
  throw new NotImplementedError('validateSchema');
}

/**
 * Check that a header row contains every required header of a tab (T-12).
 *
 * Errors: SchemaError with `.missing` listing each missing header.
 *
 * @param {Schema} schema
 * @param {string} tab
 * @param {string[]} headers  Header row as read from the source.
 * @returns {void}
 */
function checkHeaders(schema, tab, headers) {
  void schema; void tab; void headers;
  throw new NotImplementedError('checkHeaders');
}

/**
 * Resolve a field ID to its header name. Used everywhere instead of column positions (F-12).
 *
 * Errors: SchemaError for an unknown tab or field ID.
 *
 * @param {Schema} schema
 * @param {string} tab
 * @param {string} fieldId
 * @returns {string}
 */
function headerFor(schema, tab, fieldId) {
  void schema; void tab; void fieldId;
  throw new NotImplementedError('headerFor');
}

module.exports = { validateSchema, checkHeaders, headerFor };
