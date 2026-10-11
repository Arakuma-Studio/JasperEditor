import { DEFAULT_KEYMAP, type KeyBinding } from './keymap-defaults.ts';
import type { CommandScope } from './types.ts';

export type LayoutId = 'premiere' | 'avid' | 'fcp7' | 'fcpx';
export const LAYOUTS: readonly { id: LayoutId; label: string }[] = [
	{ id: 'premiere', label: 'Adobe Premiere Pro (default)' },
	{ id: 'avid', label: 'Avid Media Composer' },
	{ id: 'fcp7', label: 'Final Cut Pro 7' },
	{ id: 'fcpx', label: 'Final Cut Pro' },
];

type Entry = [command: string, key: string, scope?: CommandScope];
const E: CommandScope = 'editing';
const T: CommandScope = 'timeline';

/** Avid Media Composer defaults (FilmCraft AVID). */
const AVID: Entry[] = [
	['transport.shuttleReverse', 'KeyJ'],
	['transport.shuttleStop', 'KeyK'],
	['transport.shuttleForward', 'KeyL'],
	['transport.playStop', 'Space'],
	['timeline.markIn', 'KeyI'],
	['timeline.markIn', 'KeyE'],
	['timeline.markOut', 'KeyO'],
	['timeline.markOut', 'KeyR'],
	['timeline.markClip', 'KeyT', T],
	['timeline.clearIn', 'KeyD'],
	['timeline.clearOut', 'KeyF'],
	['timeline.clearInOut', 'KeyG'],
	['timeline.goToIn', 'KeyQ'],
	['timeline.goToOut', 'KeyW'],
	['timeline.insertFromSource', 'KeyV'],
	['timeline.overwriteFromSource', 'KeyB'],
	['timeline.lift', 'KeyZ'],
	['timeline.extract', 'KeyX'],
	['timeline.addEdit', 'KeyH'],
	['transport.stepBackMany', 'Digit1'],
	['transport.stepForwardMany', 'Digit2'],
	['transport.stepBack', 'Digit3'],
	['transport.stepForward', 'Digit4'],
	['transport.prevEdit', 'KeyA'],
	['transport.nextEdit', 'KeyS'],
	['timeline.trimEdit', 'KeyU', T],
	['timeline.trimBackMany', 'KeyM', T],
	['timeline.trimBack', 'Comma', T],
	['timeline.trimForward', 'Period', T],
	['timeline.trimForwardMany', 'Slash', T],
	['timeline.zoomIn', 'Ctrl+BracketRight', T],
	['timeline.zoomOut', 'Ctrl+BracketLeft', T],
	['timeline.addMarker', 'F5'],
];

/** Final Cut Pro 7 defaults (User Manual keyboard shortcut appendix). */
const FCP7: Entry[] = [
	['tool.selection', 'KeyA'],
	['tool.trackSelectForward', 'KeyT'],
	['tool.rolling', 'KeyR'],
	['tool.slip', 'KeyS'],
	['tool.razor', 'KeyB'],
	['tool.zoom', 'KeyZ'],
	['tool.hand', 'KeyH'],
	['tool.pen', 'KeyP'],
	['transport.shuttleReverse', 'KeyJ'],
	['transport.shuttleStop', 'KeyK'],
	['transport.shuttleForward', 'KeyL'],
	['transport.playStop', 'Space'],
	['transport.playAround', 'Backslash'],
	['transport.playInToOut', 'Shift+Backslash'],
	['transport.prevEdit', 'ArrowUp'],
	['transport.nextEdit', 'ArrowDown'],
	['timeline.markIn', 'KeyI'],
	['timeline.markOut', 'KeyO'],
	['timeline.markClip', 'KeyX', T],
	['timeline.goToIn', 'Shift+KeyI'],
	['timeline.goToOut', 'Shift+KeyO'],
	['timeline.clearIn', 'Alt+KeyI'],
	['timeline.clearOut', 'Alt+KeyO'],
	['timeline.clearInOut', 'Alt+KeyX'],
	['timeline.insertFromSource', 'F9'],
	['timeline.overwriteFromSource', 'F10'],
	['timeline.clear', 'Delete', T],
	['timeline.rippleDelete', 'Shift+Delete', T],
	['timeline.addEdit', 'Ctrl+KeyV'],
	['timeline.matchFrame', 'KeyF'],
	['timeline.extendEditToPlayhead', 'KeyE', T],
	['timeline.trimEdit', 'Ctrl+Digit7', T],
	['timeline.toggleTrimType', 'KeyU', T],
	['timeline.trimBack', 'BracketLeft', T],
	['timeline.trimForward', 'BracketRight', T],
	['timeline.trimBackMany', 'Shift+BracketLeft', T],
	['timeline.trimForwardMany', 'Shift+BracketRight', T],
	['timeline.toggleSnap', 'KeyN', T],
	['timeline.toggleLinkedSelection', 'Shift+KeyL'],
	['timeline.speedDuration', 'Ctrl+KeyJ', T],
	['clip.nest', 'Alt+KeyC', T],
	['timeline.addMarker', 'KeyM'],
	['timeline.nextMarker', 'Shift+KeyM'],
	['timeline.prevMarker', 'Alt+KeyM'],
	['timeline.zoomIn', 'Ctrl+Equal', T],
	['timeline.zoomOut', 'Ctrl+Minus', T],
	['timeline.zoomToSequence', 'Shift+KeyZ', T],
	['timeline.applyDefaultVideoTransition', 'Ctrl+KeyT', T],
	['timeline.applyDefaultAudioTransition', 'Ctrl+Alt+KeyT', T],
	['project.makeSubclip', 'Ctrl+KeyU', 'project'],
	['project.makeSubclip', 'Ctrl+KeyU', 'source'],
];

/** Final Cut Pro defaults (FilmCraft FINAL_CUT). */
const FCPX: Entry[] = [
	['tool.selection', 'KeyA'],
	['tool.razor', 'KeyB'],
	['tool.ripple', 'KeyT'],
	['tool.zoom', 'KeyZ'],
	['tool.hand', 'KeyH'],
	['timeline.insertFromSource', 'KeyW'],
	['timeline.overwriteFromSource', 'KeyD'],
	['timeline.addEdit', 'Ctrl+KeyB'],
	['timeline.addEditAllTracks', 'Ctrl+Shift+KeyB'],
	['timeline.rippleDelete', 'Backspace', T],
	['timeline.clear', 'Shift+Backspace', T],
	['timeline.markIn', 'KeyI'],
	['timeline.markOut', 'KeyO'],
	['timeline.markClip', 'KeyX', T],
	['timeline.clearInOut', 'Alt+KeyX'],
	['timeline.addMarker', 'KeyM'],
	['timeline.nextMarker', 'Ctrl+Quote'],
	['timeline.prevMarker', 'Ctrl+Semicolon'],
	['transport.prevEdit', 'ArrowUp'],
	['transport.nextEdit', 'ArrowDown'],
	['transport.stepForwardMany', 'Shift+ArrowRight'],
	['transport.stepBackMany', 'Shift+ArrowLeft'],
	['transport.playStop', 'Space'],
	['transport.shuttleReverse', 'KeyJ'],
	['transport.shuttleStop', 'KeyK'],
	['transport.shuttleForward', 'KeyL'],
	['monitor.toggleLoop', 'Ctrl+KeyL', 'program'],
	['transport.playInToOut', 'Slash'],
	['timeline.toggleSnap', 'KeyN', T],
	['timeline.zoomIn', 'Ctrl+Equal', T],
	['timeline.zoomOut', 'Ctrl+Minus', T],
	['timeline.zoomToSequence', 'Shift+KeyZ', T],
	['timeline.applyDefaultVideoTransition', 'Ctrl+KeyT', T],
	['timeline.speedDuration', 'Ctrl+KeyR', T],
	['timeline.toggleEnable', 'KeyV', T],
	['clip.nest', 'Alt+KeyG', T],
	['timeline.matchFrame', 'Shift+KeyF'],
	['timeline.extendEditToPlayhead', 'Shift+KeyX', T],
	['timeline.trimBack', 'Comma', T],
	['timeline.trimForward', 'Period', T],
	['timeline.trimBackMany', 'Shift+Comma', T],
	['timeline.trimForwardMany', 'Shift+Period', T],
	['project.newBin', 'Alt+KeyN', 'project'],
	['export.media', 'Ctrl+KeyE', 'global'],
	['timeline.renderInToOut', 'Ctrl+KeyR', 'global'],
];

const TABLES: Record<Exclude<LayoutId, 'premiere'>, Entry[]> = { avid: AVID, fcp7: FCP7, fcpx: FCPX };

/** Scope a preset entry binds in: given, else the scope the command has in the default keymap, else editing. */
function scopeFor(command: string, given: CommandScope | undefined): CommandScope {
	if (given) return given;
	return DEFAULT_KEYMAP.find((b) => b.command === command)?.scope ?? E;
}

/** The full keymap of a layout. */
export function layoutKeymap(id: LayoutId): readonly KeyBinding[] {
	if (id === 'premiere') return DEFAULT_KEYMAP;
	const table = TABLES[id].map(([command, key, scope]): KeyBinding => {
		// Repeat / keyup behaviour (and arguments) follow the command's default binding.
		const def = DEFAULT_KEYMAP.find((b) => b.command === command);
		return {
			command,
			key,
			scope: scopeFor(command, scope),
			...(def?.repeat ? { repeat: true } : {}),
			...(def?.keyup ? { keyup: true } : {}),
			...(def?.args !== undefined ? { args: def.args } : {}),
		};
	});
	const commands = new Set(table.map((e) => e.command));
	const mac = (k: string) => k.replace(/^Ctrl\+/, 'Cmd+').replace(/\+Ctrl\+/, '+Cmd+');
	const taken = new Set(table.flatMap((e) => [`${e.scope}|${e.key}`, `${e.scope}|mac:${mac(e.key)}`]));
	const kept = DEFAULT_KEYMAP.filter(
		(b) =>
			!commands.has(b.command) &&
			!taken.has(`${b.scope}|${b.key}`) &&
			!taken.has(`${b.scope}|mac:${b.mac ?? mac(b.key)}`) &&
			!(b.web && taken.has(`${b.scope}|${b.web}`)),
	);
	return [...table, ...kept];
}
