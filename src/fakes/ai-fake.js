'use strict';

// Fake for B6 AI client (step 0). Returns queued tool inputs. No network.

/**
 * @param {Array<Record<string, unknown>>} [queued] tool inputs returned in order
 * @returns {import('../ai').AiClient & {calls: Array<object>}}
 */
function createFakeAiClient(queued = []) {
  const calls = [];
  const replies = [...queued];

  return {
    calls,
    async reply(input) {
      calls.push(input);
      if (replies.length === 0) {
        throw new Error('fake AI client has no queued reply');
      }
      return replies.shift();
    },
  };
}

module.exports = { createFakeAiClient };
