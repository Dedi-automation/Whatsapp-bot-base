'use strict';

// B4 Schema. Covers T-12 and F-07 (trailing spaces), F-12 (field lookup by ID).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateSchema, checkHeaders, headerFor } = require('../src/schema');
const { SchemaError } = require('../src/errors');

const schema = {
  leads: {
    fields: {
      customerId: { header: 'Customer ID', required: true },
      status: { header: 'Status', required: true },
      preferredCallbackTime: { header: 'Preferred callback time', required: false },
    },
  },
};

test('T-12: startup fails when a required header is missing', () => {
  assert.throws(
    () => checkHeaders(schema, 'leads', ['Customer ID', 'Other']),
    (err) => err instanceof SchemaError && err.missing.includes('Status')
  );
});

test('T-12: a renamed required header counts as missing', () => {
  assert.throws(
    () => checkHeaders(schema, 'leads', ['Customer ID', 'status ']),
    (err) => err instanceof SchemaError && err.missing.includes('Status')
  );
});

test('T-12: all required headers present (extra and optional ones allowed) passes', () => {
  assert.doesNotThrow(() => checkHeaders(schema, 'leads', ['Customer ID', 'Status', 'Extra']));
});

test('F-07: a header with a leading or trailing space fails schema validation at startup', () => {
  const bad = { leads: { fields: { status: { header: 'Status ', required: true } } } };
  assert.throws(() => validateSchema(bad), SchemaError);
});

test('F-12: fields are resolved by ID to their header name', () => {
  assert.equal(headerFor(schema, 'leads', 'customerId'), 'Customer ID');
});

test('F-12: an unknown tab or field ID is an error, not a guessed column', () => {
  assert.throws(() => headerFor(schema, 'leads', 'nope'), SchemaError);
  assert.throws(() => headerFor(schema, 'missing-tab', 'status'), SchemaError);
});

// Added in Branch A.

test('F-07: a duplicate header within a tab fails schema validation', () => {
  const bad = {
    leads: { fields: { a: { header: 'Status', required: true }, b: { header: 'Status' } } },
  };
  assert.throws(() => validateSchema(bad), SchemaError);
});

test('F-07: an empty header fails schema validation', () => {
  assert.throws(() => validateSchema({ leads: { fields: { a: { header: '' } } } }), SchemaError);
});

test('a valid schema passes validation and is returned', () => {
  assert.equal(validateSchema(schema), schema);
});

test('T-12: every missing required header is listed, not only the first', () => {
  assert.throws(
    () => checkHeaders(schema, 'leads', ['Preferred callback time']),
    (err) => err instanceof SchemaError && err.missing.length === 2
      && err.missing.includes('Customer ID') && err.missing.includes('Status')
  );
});

test('T-12: an optional header may be missing', () => {
  assert.doesNotThrow(() => checkHeaders(schema, 'leads', ['Customer ID', 'Status']));
});

test('T-12: checkHeaders on an unknown tab is an error', () => {
  assert.throws(() => checkHeaders(schema, 'missing-tab', ['Status']), SchemaError);
});
