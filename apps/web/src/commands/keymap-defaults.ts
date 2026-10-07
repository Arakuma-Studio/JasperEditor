// The complete default keymap (ARCHITECTURE §7.3): S02:TL-903 + R-PUI §16 + S05:KB-010, bound on
// KeyboardEvent.code with Windows/Linux modifiers ("Ctrl" becomes Cmd on macOS unless `mac` overrides),
// plus web/PWA fallbacks for browser-reserved combos (S05:KB-013). Command ids that are not
// registered yet are simply inert. The dispatcher (WP-2A) resolves focused panel → editing → global.
import type { CommandScope } from './types.ts';

export type KeyBinding = {
	command: string;
	/** Chord: modifiers in the order Ctrl, Alt, Shift, Meta, then a KeyboardEvent.code, e.g. "Ctrl+Shift+KeyZ". */
	key: string;
	scope: CommandScope;
	/** macOS chord when it differs beyond Ctrl→Cmd ("Cmd"/"Opt"/"Ctrl" = physical Control). */
	mac?: string;
	/** Web/PWA fallback when `key` is browser-reserved (KB-013). */
	web?: string;
	/** Honor auto-repeat (KB-006). */
	repeat?: boolean;
	/** Dispatch keyup too (KB-007). */
	keyup?: boolean;
	args?: unknown;
};

const b = (
	command: string,
	key: string,
	scope: CommandScope,
	extra: Omit<KeyBinding, 'command' | 'key' | 'scope'> = {},
): KeyBinding => ({ command, key, scope, ...extra });
const R = { repeat: true };
/** Transport keys work in the Timeline, Program and Source monitors (S02:TL-900) → `editing` scope. */
const E: CommandScope = 'editing';
const T: CommandScope = 'timeline';
const G: CommandScope = 'global';

export const DEFAULT_KEYMAP: readonly KeyBinding[] = [
	// ---------------------------------------------------------------- S02:TL-903 transport
	b('transport.playStop', 'Space', E),
	b('transport.shuttleReverse', 'KeyJ', E, { keyup: true }),
	b('transport.shuttleStop', 'KeyK', E, { keyup: true }),
	b('transport.shuttleForward', 'KeyL', E, { keyup: true }),
	b('transport.shuttleSlowReverse', 'Shift+KeyJ', E),
	b('transport.shuttleSlowForward', 'Shift+KeyL', E),
	b('transport.stepBack', 'ArrowLeft', E, R),
	b('transport.stepForward', 'ArrowRight', E, R),
	b('transport.stepBackMany', 'Shift+ArrowLeft', E, R),
	b('transport.stepForwardMany', 'Shift+ArrowRight', E, R),
	b('transport.goToStart', 'Home', E),
	b('transport.goToEnd', 'End', E),
	b('transport.prevEdit', 'ArrowUp', E, R),
	b('transport.nextEdit', 'ArrowDown', E, R),
	b('transport.prevEditAny', 'Shift+ArrowUp', E, R),
	b('transport.nextEditAny', 'Shift+ArrowDown', E, R),
	b('transport.playInToOut', 'Ctrl+Shift+Space', E, { mac: 'Opt+KeyK' }),
	b('transport.playAround', 'Shift+KeyK', E),
	b('transport.toggleAudioScrub', 'Shift+KeyS', E),

	// ---------------------------------------------------------------- S02:TL-903 marking and editing
	b('timeline.markIn', 'KeyI', E),
	b('timeline.markOut', 'KeyO', E),
	b('timeline.markClip', 'KeyX', T),
	b('timeline.markSelection', 'Slash', T),
	b('timeline.clearIn', 'Ctrl+Shift+KeyI', E, { mac: 'Opt+KeyI' }),
	b('timeline.clearOut', 'Ctrl+Shift+KeyO', E, { mac: 'Opt+KeyO' }),
	b('timeline.clearInOut', 'Ctrl+Shift+KeyX', E, { mac: 'Opt+KeyX' }),
	b('timeline.goToIn', 'Shift+KeyI', E),
	b('timeline.goToOut', 'Shift+KeyO', E),
	b('timeline.lift', 'Semicolon', E),
	b('timeline.extract', 'Quote', E),
	b('timeline.insertFromSource', 'Comma', E),
	b('timeline.overwriteFromSource', 'Period', E),
	b('timeline.addMarker', 'KeyM', E),
	b('timeline.nextMarker', 'Shift+KeyM', E),
	b('timeline.prevMarker', 'Ctrl+Shift+KeyM', E),
	b('timeline.clearMarker', 'Ctrl+Alt+KeyM', E, { mac: 'Opt+KeyM' }),
	b('timeline.clearAllMarkers', 'Ctrl+Alt+Shift+KeyM', E, { mac: 'Opt+Cmd+KeyM' }),
	b('timeline.addEdit', 'Ctrl+KeyK', E),
	b('timeline.addEditAllTracks', 'Ctrl+Shift+KeyK', E),
	b('timeline.rippleTrimPrevToPlayhead', 'KeyQ', T),
	b('timeline.rippleTrimNextToPlayhead', 'KeyW', T),
	b('timeline.trimPrevToPlayhead', 'Alt+KeyQ', T),
	b('timeline.trimNextToPlayhead', 'Alt+KeyW', T),
	b('timeline.extendEditToPlayhead', 'KeyE', T),
	b('timeline.cycleTrimType', 'Shift+KeyT', T, { mac: 'Cmd+KeyT' }),
	b('timeline.trimBack', 'Ctrl+ArrowLeft', T, { ...R, mac: 'Ctrl+ArrowLeft' }),
	b('timeline.trimForward', 'Ctrl+ArrowRight', T, { ...R, mac: 'Ctrl+ArrowRight' }),
	b('timeline.trimBackMany', 'Ctrl+Shift+ArrowLeft', T, { ...R, mac: 'Ctrl+Shift+ArrowLeft' }),
	b('timeline.trimForwardMany', 'Ctrl+Shift+ArrowRight', T, { ...R, mac: 'Ctrl+Shift+ArrowRight' }),
	b('timeline.nudgeLeft', 'Alt+ArrowLeft', T, { ...R, mac: 'Cmd+ArrowLeft' }),
	b('timeline.nudgeRight', 'Alt+ArrowRight', T, { ...R, mac: 'Cmd+ArrowRight' }),
	b('timeline.nudgeLeftMany', 'Alt+Shift+ArrowLeft', T, { ...R, mac: 'Shift+Cmd+ArrowLeft' }),
	b('timeline.nudgeRightMany', 'Alt+Shift+ArrowRight', T, { ...R, mac: 'Shift+Cmd+ArrowRight' }),
	b('timeline.nudgeUp', 'Alt+ArrowUp', T, R),
	b('timeline.nudgeDown', 'Alt+ArrowDown', T, R),
	b('timeline.slipLeft', 'Ctrl+Alt+ArrowLeft', T, { ...R, mac: 'Opt+Cmd+ArrowLeft' }),
	b('timeline.slipRight', 'Ctrl+Alt+ArrowRight', T, { ...R, mac: 'Opt+Cmd+ArrowRight' }),
	b('timeline.slipLeftMany', 'Ctrl+Alt+Shift+ArrowLeft', T, { ...R, mac: 'Opt+Shift+Cmd+ArrowLeft' }),
	b('timeline.slipRightMany', 'Ctrl+Alt+Shift+ArrowRight', T, { ...R, mac: 'Opt+Shift+Cmd+ArrowRight' }),
	b('timeline.slideLeft', 'Alt+Comma', T, R),
	b('timeline.slideRight', 'Alt+Period', T, R),
	b('timeline.slideLeftMany', 'Alt+Shift+Comma', T, R),
	b('timeline.slideRightMany', 'Alt+Shift+Period', T, R),
	b('timeline.clear', 'Delete', T),
	b('timeline.clear', 'Backspace', T),
	b('timeline.rippleDelete', 'Shift+Delete', T),
	b('timeline.rippleDelete', 'Alt+Backspace', T, { mac: 'Opt+Backspace' }),
	b('timeline.selectAll', 'Ctrl+KeyA', T),
	b('timeline.deselectAll', 'Ctrl+Shift+KeyA', T),
	b('timeline.selectClipAtPlayhead', 'KeyD', T),
	b('timeline.selectNextClip', 'Shift+Semicolon', T),
	b('timeline.selectPrevClip', 'Ctrl+Shift+Semicolon', T, { mac: 'Opt+Semicolon' }),
	b('timeline.toggleSnap', 'KeyS', T),
	b('timeline.linkUnlink', 'Ctrl+KeyL', T),
	b('timeline.group', 'Ctrl+KeyG', T),
	b('timeline.ungroup', 'Ctrl+Shift+KeyG', T),
	b('timeline.toggleEnable', 'Shift+KeyE', T, { mac: 'Shift+Cmd+KeyE' }),
	b('timeline.speedDuration', 'Ctrl+KeyR', T),
	b('timeline.audioGain', 'KeyG', T),
	b('timeline.audioChannels', 'Shift+KeyG', T),
	b('timeline.matchFrame', 'KeyF', E),
	b('timeline.reverseMatchFrame', 'Shift+KeyR', E),
	// edit-structure (Premiere defaults: Sequence ▸ Make Subsequence Shift+U, Reveal Nested Sequence Ctrl+Shift+F).
	b('sequence.makeSubsequence', 'Shift+KeyU', E),
	b('timeline.revealNested', 'Ctrl+Shift+KeyF', E, { mac: 'Shift+Cmd+KeyF' }),
	b('timeline.applyDefaultVideoTransition', 'Ctrl+KeyD', T),
	b('timeline.applyDefaultAudioTransition', 'Ctrl+Shift+KeyD', T),
	b('timeline.applyDefaultTransitionsToSelection', 'Shift+KeyD', T),
	b('timeline.duplicate', 'Ctrl+Shift+Slash', T),
	b('timeline.copy', 'Ctrl+KeyC', T),
	b('timeline.cut', 'Ctrl+KeyX', T),
	b('timeline.paste', 'Ctrl+KeyV', T),
	b('timeline.pasteInsert', 'Ctrl+Shift+KeyV', T),
	b('timeline.pasteAttributes', 'Ctrl+Alt+KeyV', T),
	b('timeline.zoomIn', 'Equal', T, R),
	b('timeline.zoomIn', 'NumpadAdd', T, R),
	b('timeline.zoomOut', 'Minus', T, R),
	b('timeline.zoomOut', 'NumpadSubtract', T, R),
	b('timeline.zoomToSequence', 'Backslash', T),
	b('timeline.videoTracksTaller', 'Ctrl+Equal', T),
	b('timeline.videoTracksShorter', 'Ctrl+Minus', T),
	b('timeline.audioTracksTaller', 'Alt+Equal', T),
	b('timeline.audioTracksShorter', 'Alt+Minus', T),
	b('timeline.expandAllTracks', 'Shift+Equal', T),
	b('timeline.minimizeAllTracks', 'Shift+Minus', T),
	b('timeline.pageLeft', 'PageUp', T, R),
	b('timeline.pageRight', 'PageDown', T, R),
	b('timeline.renderInToOut', 'Enter', T),
	b('timeline.setWorkAreaIn', 'Alt+BracketLeft', T),
	b('timeline.setWorkAreaOut', 'Alt+BracketRight', T),
	b('timeline.addCaptionTrack', 'Ctrl+Alt+KeyA', T, { mac: 'Opt+Cmd+KeyA' }),
	b('timeline.addCaptionAtPlayhead', 'Ctrl+Alt+KeyC', T, { mac: 'Opt+Cmd+KeyC' }),
	b('timeline.nextCaptionSegment', 'Ctrl+Alt+ArrowDown', T),
	b('timeline.prevCaptionSegment', 'Ctrl+Alt+ArrowUp', T),
	b('gesture.cancel', 'Escape', E),

	// ---------------------------------------------------------------- tools (S02:TL-590, R-PUI §16.3)
	b('tool.selection', 'KeyV', E),
	b('tool.trackSelectForward', 'KeyA', E),
	b('tool.trackSelectBackward', 'Shift+KeyA', E),
	b('tool.ripple', 'KeyB', E),
	b('tool.rolling', 'KeyN', E),
	b('tool.rateStretch', 'KeyR', E),
	b('tool.razor', 'KeyC', E),
	b('tool.slip', 'KeyY', E),
	b('tool.slide', 'KeyU', E),
	b('tool.pen', 'KeyP', E),
	b('tool.hand', 'KeyH', E, { keyup: true }),
	b('tool.zoom', 'KeyZ', E),
	b('tool.type', 'KeyT', E),

	// ---------------------------------------------------------------- global (R-PUI §16.1)
	b('app.newProject', 'Ctrl+Alt+KeyN', G),
	b('app.newSequence', 'Ctrl+KeyN', G, { web: 'Alt+KeyN' }),
	b('app.openProject', 'Ctrl+KeyO', G),
	b('app.closePanel', 'Ctrl+KeyW', G, { web: 'Alt+KeyW' }),
	b('app.closeProject', 'Ctrl+Shift+KeyW', G, { web: 'Alt+Shift+KeyW' }),
	b('app.save', 'Ctrl+KeyS', G),
	b('app.saveAs', 'Ctrl+Shift+KeyS', G),
	b('app.saveCopy', 'Ctrl+Alt+KeyS', G),
	b('project.import', 'Ctrl+KeyI', G),
	b('project.importFromMediaBrowser', 'Ctrl+Alt+KeyI', G),
	b('export.media', 'Ctrl+KeyM', G),
	b('export.queue', 'Alt+Shift+KeyM', G),
	b('project.mediaProperties', 'Ctrl+Shift+KeyH', G),
	b('app.quit', 'Ctrl+KeyQ', G),
	b('app.keyboardShortcuts', 'Ctrl+Alt+KeyK', G),
	b('history.undo', 'Ctrl+KeyZ', G, R),
	b('history.redo', 'Ctrl+Shift+KeyZ', G, R),
	b('history.redo', 'Ctrl+KeyY', G, R),
	b('edit.cut', 'Ctrl+KeyX', G),
	b('edit.copy', 'Ctrl+KeyC', G),
	b('edit.paste', 'Ctrl+KeyV', G),
	b('edit.pasteInsert', 'Ctrl+Shift+KeyV', G),
	b('edit.pasteAttributes', 'Ctrl+Alt+KeyV', G),
	b('edit.clear', 'Delete', G),
	b('edit.rippleDelete', 'Shift+Delete', G),
	b('edit.duplicate', 'Ctrl+Shift+Slash', G),
	b('edit.selectAll', 'Ctrl+KeyA', G),
	b('edit.deselectAll', 'Ctrl+Shift+KeyA', G),
	b('edit.find', 'Ctrl+KeyF', G),
	b('edit.editOriginal', 'Ctrl+KeyE', G),
	b('workspace.maximizeUnderCursor', 'Backquote', G),
	b('workspace.maximizeActive', 'Shift+Backquote', G),
	b('monitor.fullScreenVideo', 'Ctrl+Backquote', G, { mac: 'Ctrl+Backquote' }),
	b('workspace.nextPanel', 'Ctrl+Shift+Period', G, { mac: 'Ctrl+Shift+Period' }),
	b('workspace.prevPanel', 'Ctrl+Shift+Comma', G, { mac: 'Ctrl+Shift+Comma' }),
	b('graphics.newTextLayer', 'Ctrl+KeyT', G, { web: 'Alt+KeyT' }),
	b('graphics.newRectangle', 'Ctrl+Alt+KeyR', G),
	b('graphics.newEllipse', 'Ctrl+Alt+KeyE', G),

	// ---------------------------------------------------------------- panels and workspaces (R-PUI §16.2, S05:KB-010)
	b('panel.open.project', 'Shift+Digit1', G),
	b('panel.open.source', 'Shift+Digit2', G),
	b('panel.open.timeline', 'Shift+Digit3', G),
	b('panel.open.program', 'Shift+Digit4', G),
	b('panel.open.effectControls', 'Shift+Digit5', G),
	b('panel.open.audioTrackMixer', 'Shift+Digit6', G),
	b('panel.open.effects', 'Shift+Digit7', G),
	b('panel.open.mediaBrowser', 'Shift+Digit8', G),
	b('panel.open.audioClipMixer', 'Shift+Digit9', G),
	...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) =>
		b(`workspace.switch.${n}`, `Alt+Shift+Digit${n}`, G, { mac: `Opt+Shift+Digit${n}` }),
	),
	b('workspace.resetToSaved', 'Alt+Shift+Digit0', G, { mac: 'Opt+Shift+Digit0' }),
	b('app.commandPalette', 'Ctrl+Shift+KeyP', G),
	b('app.cycleRegions', 'F6', G),
	b('app.shortcutReference', 'Ctrl+Alt+Slash', G),

	// ---------------------------------------------------------------- panel-scoped (R-PUI §16.7)
	b('monitor.fit', 'Ctrl+Digit0', 'program'),
	b('monitor.fit', 'Ctrl+Digit0', 'source'),
	b('program.showRulers', 'Ctrl+KeyR', 'program'),
	b('program.showGuides', 'Ctrl+Semicolon', 'program'),
	b('program.snapInMonitor', 'Ctrl+Shift+Semicolon', 'program'),
	b('program.lockGuides', 'Ctrl+Alt+Shift+KeyR', 'program'),
	// wp-clipboard-2 (S03:XF-050 Arrange ▸, Premiere's Graphics ▸ Arrange chords)
	b('arrange.bringToFront', 'Ctrl+Shift+BracketRight', 'program'),
	b('arrange.bringForward', 'Ctrl+BracketRight', 'program'),
	b('arrange.sendBackward', 'Ctrl+BracketLeft', 'program'),
	b('arrange.sendToBack', 'Ctrl+Shift+BracketLeft', 'program'),
	b('program.nudgeLeft', 'Ctrl+ArrowLeft', 'program', R),
	b('program.nudgeRight', 'Ctrl+ArrowRight', 'program', R),
	b('program.nudgeUp', 'Ctrl+ArrowUp', 'program', R),
	b('program.nudgeDown', 'Ctrl+ArrowDown', 'program', R),
	b('program.nudgeLeftMany', 'Ctrl+Shift+ArrowLeft', 'program', R),
	b('program.nudgeRightMany', 'Ctrl+Shift+ArrowRight', 'program', R),
	b('program.nudgeUpMany', 'Ctrl+Shift+ArrowUp', 'program', R),
	b('program.nudgeDownMany', 'Ctrl+Shift+ArrowDown', 'program', R),
	b('monitor.toggleLoop', 'Ctrl+KeyL', 'program'),
	b('monitor.toggleLoop', 'Ctrl+KeyL', 'source'),
	b('project.newBin', 'Ctrl+KeyB', 'project'),
	b('project.listView', 'Ctrl+PageUp', 'project'),
	b('project.iconView', 'Ctrl+PageDown', 'project'),
	b('project.toggleView', 'Shift+Backslash', 'project'),
	b('project.hoverScrub', 'Shift+KeyH', 'project'),
	b('project.thumbnailLarger', 'Shift+BracketRight', 'project'),
	b('project.thumbnailSmaller', 'Shift+BracketLeft', 'project'),
	b('project.openInSource', 'Shift+KeyO', 'project'),
	b('project.deleteWithOptions', 'Ctrl+Delete', 'project'),
	b('project.zoomIn', 'Equal', 'project'),
	b('project.zoomOut', 'Minus', 'project'),
	b('project.setPosterFrame', 'Shift+KeyP', 'project', { mac: 'Cmd+KeyP' }),
	// Moved from Ctrl+Shift+P (now the command palette, S05:KB-010).
	b('project.clearPosterFrame', 'Alt+Shift+KeyP', 'project', { mac: 'Opt+Shift+KeyP' }),
	b('project.makeSubclip', 'Ctrl+KeyU', 'project'),
	b('effects.newCustomBin', 'Ctrl+Slash', 'effects'),
	b('effects.deleteCustomItem', 'Backspace', 'effects'),
	b('effectControls.removeEffect', 'Backspace', 'effectControls'),
	b('effectControls.removeEffect', 'Delete', 'effectControls'),
	b('effectControls.toggleLoop', 'Ctrl+KeyL', 'effectControls'),
	b('history.stepBackward', 'ArrowLeft', 'history', R),
	b('history.stepForward', 'ArrowRight', 'history', R),
];

/** Browser-reserved chords that never reach web pages (S05:KB-013). */
const BROWSER_RESERVED: readonly string[] = [
	'Ctrl+KeyN',
	'Ctrl+KeyW',
	'Ctrl+KeyT',
	'Ctrl+Shift+KeyN',
	'Ctrl+Shift+KeyT',
	'Ctrl+Shift+KeyW',
	'Ctrl+Tab',
	'Ctrl+KeyQ',
];

export type Platform = 'win' | 'linux' | 'mac';
export type Runtime = 'web' | 'pwa' | 'desktop';

/** Effective chord for a platform/runtime: web fallbacks replace browser-reserved chords. */
export function effectiveKey(binding: KeyBinding, platform: Platform, runtime: Runtime): string | null {
	if (runtime !== 'desktop' && BROWSER_RESERVED.includes(binding.key)) return binding.web ?? null;
	if (platform === 'mac')
		return binding.mac ?? binding.key.replace(/^Ctrl\+/, 'Cmd+').replace(/\+Ctrl\+/, '+Cmd+');
	return binding.key;
}

type KeyEventLike = { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean };

/** Normalizes a keyboard event into a chord in the keymap's notation for the platform. */
export function chordFromEvent(e: KeyEventLike, platform: Platform): string {
	const mods: string[] = [];
	if (platform === 'mac') {
		if (e.ctrlKey) mods.push('Ctrl');
		if (e.altKey) mods.push('Opt');
		if (e.shiftKey) mods.push('Shift');
		if (e.metaKey) mods.push('Cmd');
	} else {
		if (e.ctrlKey) mods.push('Ctrl');
		if (e.altKey) mods.push('Alt');
		if (e.shiftKey) mods.push('Shift');
		if (e.metaKey) mods.push('Meta');
	}
	return [...mods, e.code].join('+');
}

/** Canonical form of a chord (sorted modifiers) so "Shift+Ctrl+KeyZ" equals "Ctrl+Shift+KeyZ". */
export function normalizeChord(chord: string): string {
	const parts = chord.split('+');
	const code = parts.pop()!;
	const order = ['Ctrl', 'Alt', 'Opt', 'Shift', 'Cmd', 'Meta'];
	return [...parts.sort((a, b2) => order.indexOf(a) - order.indexOf(b2)), code].join('+');
}

/**
 * Resolves a chord to bindings along a scope chain (focused panel → editing → global, S05:KB-002).
 * Returns candidates in priority order; the dispatcher runs the first enabled one.
 */
export function resolveBindings(
	chord: string,
	scopes: readonly CommandScope[],
	opts: { platform: Platform; runtime: Runtime; keymap?: readonly KeyBinding[] },
): KeyBinding[] {
	const keymap = opts.keymap ?? DEFAULT_KEYMAP;
	const target = normalizeChord(chord);
	const out: KeyBinding[] = [];
	for (const scope of scopes) {
		for (const k of keymap) {
			if (k.scope !== scope) continue;
			const key = effectiveKey(k, opts.platform, opts.runtime);
			if (key && normalizeChord(key) === target) out.push(k);
		}
	}
	return out;
}

/** Scope chain for a focused panel kind (S05:KB-002: `editing` = Timeline, Program, Source, Tools). */
export function scopeChain(panel: CommandScope | null): CommandScope[] {
	const editing = panel === 'timeline' || panel === 'program' || panel === 'source' || panel === 'tools';
	const chain: CommandScope[] = [];
	if (panel && panel !== 'global' && panel !== 'editing') chain.push(panel);
	if (editing) chain.push('editing');
	chain.push('global');
	return chain;
}
