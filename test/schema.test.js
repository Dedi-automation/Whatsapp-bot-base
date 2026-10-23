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
