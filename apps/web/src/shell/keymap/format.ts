// Shortcut labels (S05:MN-004, KB-004, KB-013): platform-rendered (`Ctrl+K` vs `⌘K`), web fallbacks
// shown instead of browser-reserved chords, key names from the keyboard layout map when available.
import {
	DEFAULT_KEYMAP,
	effectiveKey,
	type KeyBinding,
	type Platform,
	type Runtime,
} from '../../commands/keymap-defaults.ts';

/**
 * UI command ids used by menus/palette → the id the default keymap binds (WP-00 keymap names). Both ids
 * are registered (the keymap id as a hidden alias), so shortcuts appear next to the canonical entry.
 */
export const KEYMAP_ALIASES: Readonly<Record<string, string>> = {
	'palette.open': 'app.commandPalette',
	'file.save': 'app.save',
	'panel.close': 'app.closePanel',
	'panel.maximize': 'workspace.maximizeActive',
	'panel.focus.project': 'panel.open.project',
	'panel.focus.source': 'panel.open.source',
	'panel.focus.timeline': 'panel.open.timeline',
	'panel.focus.program': 'panel.open.program',
	'panel.focus.effectControls': 'panel.open.effectControls',
	'panel.focus.effects': 'panel.open.effects',
	'panel.focus.agent': 'panel.open.agent',
	'workspace.reset': 'workspace.resetToSaved',
};

let layoutMap: Map<string, string> | null = null;

/** Loads `navigator.keyboard.getLayoutMap()` once (Chromium) so labels follow the user's layout. */
export async function loadKeyboardLayoutMap(): Promise<void> {
	const kb = (
		globalThis.navigator as Navigator & { keyboard?: { getLayoutMap?(): Promise<Map<string, string>> } }
	)?.keyboard;
	if (!kb?.getLayoutMap) return;
	try {
		layoutMap = await kb.getLayoutMap();
	} catch {
		layoutMap = null;
	}
}

const CODE_NAMES: Record<string, string> = {
	Backquote: '`',
	Minus: '-',
	Equal: '=',
	BracketLeft: '[',
	BracketRight: ']',
	Backslash: '\\',
	Semicolon: ';',
	Quote: "'",
	Comma: ',',
	Period: '.',
	Slash: '/',
	Space: 'Space',
	ArrowLeft: '←',
	ArrowRight: '→',
	ArrowUp: '↑',
	ArrowDown: '↓',
	PageUp: 'PgUp',
	PageDown: 'PgDn',
	Delete: 'Del',
	Escape: 'Esc',
	NumpadAdd: 'Num +',
	NumpadSubtract: 'Num -',
};

const MAC_CODE_NAMES: Record<string, string> = { Backspace: '⌫', Delete: '⌦', Enter: '↩', Escape: '⎋' };

export function keyName(code: string, platform: Platform): string {
	if (platform === 'mac' && MAC_CODE_NAMES[code]) return MAC_CODE_NAMES[code];
	const mapped = layoutMap?.get(code);
	if (
		mapped &&
		/^(Key|Digit)|Backquote|Minus|Equal|Bracket|Backslash|Semicolon|Quote|Comma|Period|Slash/.test(code)
	)
		return mapped.length === 1 ? mapped.toUpperCase() : mapped;
	if (code.startsWith('Key')) return code.slice(3);
	if (code.startsWith('Digit')) return code.slice(5);
	return CODE_NAMES[code] ?? code;
}

/** "Ctrl+Shift+KeyZ" → "Ctrl+Shift+Z" (win/linux) or "⇧⌘Z" (mac). */
export function formatChord(chord: string, platform: Platform): string {
	const parts = chord.split('+');
	const code = parts.pop() ?? '';
	if (platform === 'mac') {
		const order = ['Ctrl', 'Opt', 'Alt', 'Shift', 'Cmd', 'Meta'];
		const sym: Record<string, string> = { Ctrl: '⌃', Opt: '⌥', Alt: '⌥', Shift: '⇧', Cmd: '⌘', Meta: '⌘' };
		const mods = [...parts].sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((m) => sym[m] ?? m);
		return `${mods.join('')}${keyName(code, platform)}`;
	}
	return [...parts.map((m) => (m === 'Meta' ? 'Win' : m)), keyName(code, platform)].join('+');
}

/** First binding for a command (or its keymap alias) under the platform/runtime, as a display label. */
export function shortcutFor(
	commandId: string,
	opts: { platform: Platform; runtime: Runtime; keymap?: readonly KeyBinding[] },
): string | null {
	const keymap = opts.keymap ?? DEFAULT_KEYMAP;
	const ids = [commandId, KEYMAP_ALIASES[commandId]].filter(Boolean) as string[];
	for (const id of ids) {
		for (const b of keymap) {
			if (b.command !== id) continue;
			const key = effectiveKey(b, opts.platform, opts.runtime);
			if (key) return formatChord(key, opts.platform);
		}
	}
	return null;
}
