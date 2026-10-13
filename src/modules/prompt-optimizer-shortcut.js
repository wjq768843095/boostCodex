"use strict";
(function (root) {
  const DEFAULT = 'Ctrl+Alt+P';
  const modifiers = ['Ctrl', 'Alt', 'Shift', 'Meta'];
  function normalize(value) {
    if (typeof value !== 'string') throw new Error('invalid_shortcut');
    if (!value.trim()) return '';
    const parts = value.replace(/\s/g, '').split('+');
    const key = parts.pop()?.toUpperCase();
    if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-2]))$/.test(key || '') || !parts.length || parts.some(part => !modifiers.includes(part)) || new Set(parts).size !== parts.length || !parts.some(part => ['Ctrl', 'Alt', 'Meta'].includes(part))) throw new Error('invalid_shortcut');
    const combination = [...modifiers.filter(part => parts.includes(part)), key].join('+');
    // Preserve native text editing and the promised undo/redo shortcuts.
    if (/^(?:Ctrl|Meta)\+(?:Shift\+)?[ACVXYZ]$/.test(combination)) throw new Error('reserved_shortcut');
    return combination;
  }
  function fromEvent(event) {
    const code = event.code || '';
    const key = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit[0-9]$/.test(code) ? code.slice(5) : /^F(?:[1-9]|1[0-2])$/.test(code) ? code : null;
    if (!key) return null;
    return [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta', key].filter(Boolean).join('+');
  }
  const api = { DEFAULT, normalize, fromEvent, label: value => value ? value.split('+').join(' + ') : '未启用' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BetterCodexPromptShortcut = api;
})(typeof window !== 'undefined' ? window : globalThis);
