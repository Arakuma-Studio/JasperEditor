// edit-ux: the user's keyboard layout (Premiere's Edit ▸ Keyboard Shortcuts…): a layout preset (Premiere Pro
// default, Avid Media Composer, Final Cut Pro 7, Final Cut Pro) or a custom layout derived from one, persisted in
// localStorage and pushed into the active keymap (dispatcher, menus, tooltips, the shortcut reference).
//
// Editing a built-in layout creates (or updates) the custom layout "Custom", as Premiere does. Assigning a chord
// that another command uses in the same scope takes it from that command (Premiere: "This shortcut is already in
// use… [the other command] loses it"); deliberate contextual pairs (KeyBinding.contextual) are not conflicts.
// Browser-reserved chords cannot be assigned in the web/PWA runtime.
import {
	BROWSER_RESERVED,
	effectiveKey,
	getActiveKeymap,
	type KeyBinding,
	normalizeChord,
	type Platform,
	type Runtime,
	scopeChain,
	setActiveKeymap,
} from '../../commands/keymap-defaults.ts';
import { LAYOUTS, type LayoutId, layoutKeymap } from '../../commands/keymap-presets.ts';
import type { CommandScope } from '../../commands/types.ts';

export const KEYMAP_STORAGE_KEY = 'jasper:keymap:v1';

export type KeymapPrefs = {
	/** A built-in layout id or `custom:<name>`. */
	layout: string;
	custom: Record<string, { base: LayoutId; bindings: KeyBinding[] }>;
};

const DEFAULT_PREFS: KeymapPrefs = { layout: 'premiere', custom: {} };

function storage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

const isLayoutId = (v: unknown): v is LayoutId => LAYOUTS.some((l) => l.id === v);

function validBinding(b: unknown): b is KeyBinding {
	const o = b as Record<string, unknown> | null;
	return (
		!!o &&
		typeof o.command === 'string' &&
		o.command.length > 0 &&
		o.command.length < 200 &&
		typeof o.key === 'string' &&
		/^[A-Za-z0-9+]+$/.test(o.key) &&
		typeof o.scope === 'string' &&
		(o.mac === undefined || (typeof o.mac === 'string' && /^[A-Za-z0-9+]+$/.test(o.mac)))
	);
}

/** Tolerant parse: unknown layouts fall back to the default; malformed bindings are dropped. */
export function parseKeymapPrefs(raw: unknown): KeymapPrefs {
	const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const custom: KeymapPrefs['custom'] = {};
	const c = (o.custom && typeof o.custom === 'object' ? o.custom : {}) as Record<string, unknown>;
	for (const [name, v] of Object.entries(c).slice(0, 50)) {
		const e = v as { base?: unknown; bindings?: unknown } | null;
		if (!e || !Array.isArray(e.bindings) || name.length === 0 || name.length > 60) continue;
		custom[name] = {
			base: isLayoutId(e.base) ? e.base : 'premiere',
			bindings: e.bindings.filter(validBinding).slice(0, 2000) as KeyBinding[],
		};
	}
	let layout = typeof o.layout === 'string' ? o.layout : 'premiere';
	if (!isLayoutId(layout) && !(layout.startsWith('custom:') && custom[layout.slice(7)])) layout = 'premiere';
	return { layout, custom };
}

let prefs: KeymapPrefs = load();
const listeners = new Set<() => void>();

function load(): KeymapPrefs {
	try {
		return parseKeymapPrefs(JSON.parse(storage()?.getItem(KEYMAP_STORAGE_KEY) ?? '{}'));
	} catch {
		return { ...DEFAULT_PREFS };
	}
}

function save(): void {
	try {
		storage()?.setItem(KEYMAP_STORAGE_KEY, JSON.stringify(prefs));
	} catch {
		// Storage full or unavailable: the layout still applies for this session.
	}
}

/** Bindings of a layout id (`premiere`, `avid`, `fcp7`, `fcpx`, `custom:<name>`). */
export function keymapOf(p: KeymapPrefs, layout = p.layout): readonly KeyBinding[] {
	if (isLayoutId(layout)) return layoutKeymap(layout);
	return p.custom[layout.slice(7)]?.bindings ?? layoutKeymap('premiere');
}

function apply(): void {
	setActiveKeymap(keymapOf(prefs));
	for (const l of [...listeners]) l();
}

export const keymapStore = {
	getState: (): KeymapPrefs => prefs,
	subscribe(listener: () => void): () => void {
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
	/** Re-reads storage (tests, other windows). */
	reload(): void {
		prefs = load();
		apply();
	},
};

function set(next: KeymapPrefs): void {
	prefs = next;
	save();
	apply();
}

export function setLayout(layout: string): void {
	if (!isLayoutId(layout) && !(layout.startsWith('custom:') && prefs.custom[layout.slice(7)])) return;
	set({ ...prefs, layout });
}

/** Save the current bindings as a custom layout and switch to it. */
export function saveLayoutAs(name: string): string | null {
	const n = name.trim();
	if (!n || n.length > 60) return 'Enter a name (up to 60 characters)';
	if (LAYOUTS.some((l) => l.label.toLowerCase() === n.toLowerCase()))
		return 'That name belongs to a built-in layout';
	const base = isLayoutId(prefs.layout)
		? prefs.layout
		: (prefs.custom[prefs.layout.slice(7)]?.base ?? 'premiere');
	set({
		layout: `custom:${n}`,
		custom: { ...prefs.custom, [n]: { base, bindings: [...getActiveKeymap()] } },
	});
	return null;
}

export function deleteCustomLayout(name: string): void {
	if (!prefs.custom[name]) return;
	const { [name]: _gone, ...rest } = prefs.custom;
	set({ layout: prefs.layout === `custom:${name}` ? 'premiere' : prefs.layout, custom: rest });
}

/** Replaces the active bindings (editing a built-in layout makes it the custom layout "Custom"). */
function setBindings(bindings: KeyBinding[]): void {
	if (isLayoutId(prefs.layout)) {
		set({ layout: 'custom:Custom', custom: { ...prefs.custom, Custom: { base: prefs.layout, bindings } } });
		return;
	}
	const name = prefs.layout.slice(7);
	const cur = prefs.custom[name];
	set({ ...prefs, custom: { ...prefs.custom, [name]: { base: cur?.base ?? 'premiere', bindings } } });
}

/** A chord captured on `platform` → the keymap's notation (`key` in Windows/Linux terms, `mac` when on macOS). */
export function bindingKeys(captured: string, platform: Platform): { key: string; mac?: string } {
	if (platform !== 'mac') return { key: normalizeChord(captured) };
	const parts = captured.split('+');
	const code = parts.pop()!;
	// macOS ⌘ is our Ctrl, ⌥ our Alt; a physical Control has no Windows twin, so it stays Ctrl (the mac override
	// records the exact chord).
	const win = parts.map((m) => (m === 'Cmd' ? 'Ctrl' : m === 'Opt' ? 'Alt' : m));
	return { key: normalizeChord([...new Set(win), code].join('+')), mac: normalizeChord(captured) };
}

/** Whether a chord may be bound in this runtime (browser-reserved chords never reach a web page). */
export function chordAllowed(captured: string, platform: Platform, runtime: Runtime): string | null {
	const code = captured.split('+').pop() ?? '';
	if (/^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(code)) return 'Press a key with the modifiers';
	if (runtime !== 'desktop') {
		const { key } = bindingKeys(captured, platform);
		if (BROWSER_RESERVED.includes(key))
			return 'The browser keeps this shortcut for itself; it works in the desktop app only';
	}
	return null;
}

export type Conflict = { command: string; scope: CommandScope; shadow: boolean; contextual: boolean };

/**
 * Commands using `captured` (on platform/runtime) in `scope` — conflicts — and in scopes on the same chain
 * (`shadow`: the more specific scope wins while it is focused, so both keep working).
 */
export function conflictsFor(
	keymap: readonly KeyBinding[],
	captured: string,
	scope: CommandScope,
	platform: Platform,
	runtime: Runtime,
	except?: string,
): Conflict[] {
	const target = normalizeChord(captured);
	const chain = new Set<CommandScope>([...scopeChain(scope), scope]);
	const out: Conflict[] = [];
	for (const b of keymap) {
		if (b.command === except) continue;
		const k = effectiveKey(b, platform, runtime);
		if (!k || normalizeChord(k) !== target) continue;
		const related = b.scope === scope || chain.has(b.scope) || scopeChain(b.scope).includes(scope);
		if (!related) continue;
		out.push({ command: b.command, scope: b.scope, shadow: b.scope !== scope, contextual: !!b.contextual });
	}
	return out;
}

/**
 * Binds `captured` to `command` in `scope` (in addition to its other shortcuts, or replacing `replace`). Commands that
 * used the chord in the same scope lose it (contextual pairs excepted). Returns the commands that lost it.
 */
export function assignShortcut(
	command: string,
	scope: CommandScope,
	captured: string,
	platform: Platform,
	runtime: Runtime,
	replace?: KeyBinding,
): string[] {
	const keymap = getActiveKeymap();
	const target = normalizeChord(captured);
	const lost: string[] = [];
	const proto = keymap.find((b) => b.command === command);
	const next = keymap.filter((b) => {
		if (b === replace) return false;
		if (b.scope !== scope || b.contextual) return true;
		const k = effectiveKey(b, platform, runtime);
		if (!k || normalizeChord(k) !== target) return true;
		if (b.command !== command) lost.push(b.command);
		return false;
	});
	next.push({
		command,
		scope,
		...bindingKeys(captured, platform),
		...(proto?.repeat ? { repeat: true } : {}),
		...(proto?.keyup ? { keyup: true } : {}),
		...(proto?.args !== undefined ? { args: proto.args } : {}),
	});
	setBindings(next);
	return [...new Set(lost)];
}

export function removeShortcut(binding: KeyBinding): void {
	setBindings(getActiveKeymap().filter((b) => b !== binding));
}

/** Removes every shortcut of a command ("Clear"). */
export function clearShortcuts(command: string): void {
	setBindings(getActiveKeymap().filter((b) => b.command !== command));
}

/** Restores a command's shortcuts from the layout the current one is based on. */
export function resetShortcuts(command: string): void {
	const base = isLayoutId(prefs.layout)
		? prefs.layout
		: (prefs.custom[prefs.layout.slice(7)]?.base ?? 'premiere');
	const original = layoutKeymap(base).filter((b) => b.command === command);
	const used = new Set(original.map((b) => `${b.scope}|${normalizeChord(b.key)}`));
	setBindings([
		...getActiveKeymap().filter(
			(b) => b.command !== command && !used.has(`${b.scope}|${normalizeChord(b.key)}`),
		),
		...original,
	]);
}

/** Replaces the active bindings wholesale (the editor's Undo). */
export function restoreBindings(bindings: readonly KeyBinding[]): void {
	setBindings([...bindings]);
}

// Apply the stored layout at startup.
apply();
