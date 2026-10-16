'use strict';
// Existing launchers remain valid while new installations use BOOST_CODEX_*.
function normalizeEnvironment(env = process.env) {
  for (const key of Object.keys(env)) {
    if (key.startsWith('BETTER_CODEX_')) {
      const current = 'BOOST_CODEX_' + key.slice('BETTER_CODEX_'.length);
      if (env[current] === undefined) env[current] = env[key];
    }
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith('BOOST_CODEX_')) env['BETTER_CODEX_' + key.slice('BOOST_CODEX_'.length)] = env[key];
  }
  return env;
}
module.exports = { normalizeEnvironment };
