'use strict';

// Central HTML escape layer (F-21). Every value from the database, a customer or
// a config file goes through escapeHtml before it is placed in HTML: email bodies
// (B10, F-22) and the admin dashboard (B11, F-01).
//
// Escapes the five characters that matter in element content and in quoted
// attribute values: & < > " '. null and undefined become the empty string.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

module.exports = { escapeHtml };
