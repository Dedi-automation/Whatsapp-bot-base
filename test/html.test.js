'use strict';

// Central escape layer. Covers F-21 (and the escaping used by F-01 and F-22).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml } = require('../src/html');

test('F-21: the five HTML-significant characters are escaped', () => {
  assert.equal(escapeHtml(`<script>alert("x")</script> & 'y'`), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;');
});

test('a quote cannot close an attribute value', () => {
  const html = `<a title="${escapeHtml('" onmouseover="alert(1)')}">x</a>`;
  assert.equal(html, '<a title="&quot; onmouseover=&quot;alert(1)">x</a>');
});

test('null and undefined become empty; numbers become text', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
});

test('text that is already safe, including Hebrew, is unchanged', () => {
  assert.equal(escapeHtml('שלום, ליד 12'), 'שלום, ליד 12');
});

test('escaping twice is visible, so callers escape exactly once', () => {
  assert.equal(escapeHtml(escapeHtml('&')), '&amp;amp;');
});
