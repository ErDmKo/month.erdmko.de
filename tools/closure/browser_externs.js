/**
 * @fileoverview Project-specific browser fields that must not be renamed by
 * Closure ADVANCED. Standard DOM, WebSocket and WebRTC APIs use Closure's
 * built-in browser externs.
 * @externs
 */

/** @type {string} */
DOMStringMap.prototype.roomId;

// Looked up using KeyboardEvent.code and strings from phoneControlsMap.
/** @record */
function TetrisKeyBindings() {}
TetrisKeyBindings.prototype.Space;
TetrisKeyBindings.prototype.KeyA;
TetrisKeyBindings.prototype.KeyD;
TetrisKeyBindings.prototype.KeyE;
TetrisKeyBindings.prototype.KeyQ;
TetrisKeyBindings.prototype.KeyS;

// Object.keys() becomes a speech grammar; recognized words index this map.
/** @record */
function TennisVoiceCommands() {}
TennisVoiceCommands.prototype.first;
TennisVoiceCommands.prototype.second;
TennisVoiceCommands.prototype.stop;
TennisVoiceCommands.prototype.back;
