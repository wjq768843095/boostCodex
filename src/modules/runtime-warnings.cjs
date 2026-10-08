'use strict';

// Node 24 emits this notice on every CLI/runtime SQLite import.
// Keep unrelated experimental notices and all operational warnings visible.
function installSQLiteWarningFilter(target = process) {
  const original = target.emitWarning;
  target.emitWarning = function (warning, ...args) {
    const message = typeof warning === 'string' ? warning : warning?.message;
    const type = warning instanceof Error ? warning.name :
      (typeof args[0] === 'object' ? args[0]?.type : args[0]);
    if (message === 'SQLite is an experimental feature and might change at any time' && type === 'ExperimentalWarning') return;
    return original.call(this, warning, ...args);
  };
}

module.exports = { installSQLiteWarningFilter };
