'use strict';

// B4 Schema.
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

const { SchemaError } = require('./errors');

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
  if (!isPlainObject(schema)) throw new SchemaError('Schema must be an object of tabs');
  for (const [tab, def] of Object.entries(schema)) {
    if (!isPlainObject(def) || !isPlainObject(def.fields)) {
      throw new SchemaError(`Tab "${tab}" must have a fields object`);
    }
    const seen = new Set();
    for (const [fieldId, field] of Object.entries(def.fields)) {
      if (!isPlainObject(field) || typeof field.header !== 'string' || field.header === '') {
        throw new SchemaError(`Field "${tab}.${fieldId}" must have a non-empty header`);
      }
      if (field.header !== field.header.trim()) {
        throw new SchemaError(`Header of field "${tab}.${fieldId}" has a leading or trailing space: "${field.header}"`);
      }
      if (seen.has(field.header)) {
        throw new SchemaError(`Duplicate header "${field.header}" in tab "${tab}"`);
      }
      seen.add(field.header);
    }
  }
  return schema;
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
  const fields = tabFields(schema, tab);
  if (!Array.isArray(headers)) throw new SchemaError(`Header row of tab "${tab}" must be an array`);
  // Exact match only: "status " or "status" does not count as "Status" (F-07).
  const present = new Set(headers);
  const missing = Object.values(fields)
    .filter((field) => field.required && !present.has(field.header))
    .map((field) => field.header);
  if (missing.length > 0) {
    throw new SchemaError(`Tab "${tab}" is missing required headers: ${missing.join(', ')}`, missing);
  }
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
  const fields = tabFields(schema, tab);
  if (!Object.hasOwn(fields, fieldId)) {
    throw new SchemaError(`Unknown field "${fieldId}" in tab "${tab}"`);
  }
  return fields[fieldId].header;
}

function tabFields(schema, tab) {
  if (!isPlainObject(schema) || !Object.hasOwn(schema, tab) || !isPlainObject(schema[tab].fields)) {
    throw new SchemaError(`Unknown tab "${tab}"`);
  }
  return schema[tab].fields;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

module.exports = { validateSchema, checkHeaders, headerFor };
