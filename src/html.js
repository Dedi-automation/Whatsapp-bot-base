'use strict';

// Central HTML escape layer (F-21). Every value from the database, a customer or
// a config file goes through escapeHtml before it is placed in HTML: email bodies
// (B10, F-22) and the admin dashboard (B11, F-01).
//
// escapeHtml escapes the five characters that matter in element content and in
// quoted attribute values: & < > " '. null and undefined become the empty string.
//
// The `html` template tag escapes every interpolated value unless it is a SafeHtml
// (the result of another `html` call, or of `raw` for fixed markup written in code).
// Arrays are joined, each item escaped the same way. So a page built only with
// `html` cannot contain an unescaped value from the database.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

class SafeHtml {
  /** @param {string} value already safe markup */
  constructor(value) {
    this.value = value;
  }

  toString() {
    return this.value;
  }
}

/**
 * Markup written in code, never data. Do not pass a value from the database here.
 * @param {string} markup
 */
function raw(markup) {
  return new SafeHtml(String(markup));
}

function render(value) {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === false || value === null || value === undefined) return '';
  return escapeHtml(value);
}

/**
 * Template tag: html`<p>${name}</p>` escapes name.
 * @returns {SafeHtml}
 */
function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    out += render(values[i]) + strings[i + 1];
  }
  return new SafeHtml(out);
}

module.exports = { escapeHtml, html, raw, SafeHtml };
