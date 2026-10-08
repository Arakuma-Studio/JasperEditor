// The single keyboard dispatcher (S05 §18, KB-001…007, KB-013): exactly one capture-phase keydown and
// one keyup listener per window. Resolution: focused panel scope → `editing` (Timeline, Program,
// Source, Tools) → `global`; the first *enabled* registered command wins. Matching uses
// KeyboardEvent.code (physical keys). Single-key and Shift+key shortcuts are suspended while an editable
// element has focus; Esc, Enter and modifier combos the widget does not handle still dispatch (after the
// widget had its chance: they run in the bubble phase unless the widget called preventDefault).
// Widgets with their own key handling (lists, scrubby numbers) mark themselves `data-keymap-local` and
// get the same "widget first" treatment. Key repeat is honored only for repeatable commands (KB-006);
// hold-to-act commands receive keyup (KB-007).

import { type ClipboardData, readClipboardEvent } from '../../clipboard/system.ts';
import {
	chordFromEvent,
	getActiveKeymap,
	type KeyBinding,
	type Platform,
	type Runtime,
	resolveBindings,
	scopeChain,
} from '../../commands/keymap-defaults.ts';
import { getCommand, isCommandEnabled } from '../../commands/registry.ts';
import type { CommandCtx, UiCommand } from '../../commands/types.ts';
import type { PanelKind } from '../../panels/types.ts';

export type DispatcherEnv = {
	/** Live command context (session, focus, capabilities…). */
	getCtx(): CommandCtx;
	/** Focused panel kind (from the focus store). */
	getFocusKind(): PanelKind | null;
	platform: Platform;
	runtime: Runtime;
	keymap?: readonly KeyBinding[];
	/** Runs a command (the shell's runner: runCommand + recent-commands bookkeeping). */
	run(command: UiCommand, ctx: CommandCtx, args?: unknown): void;
	/** Alt tap / F10 focus the menubar (S05:MN-003). */
	focusMenubar?(): void;
	/** Globally suspend (e.g. while a modal dialog of ours is open). */
	isSuspended?(): boolean;
};

export type KeyResolution = { binding: KeyBinding; command: UiCommand };

/** Resolves a chord along the scope chain; the first enabled registered command wins (KB-002). */
export function resolveKey(
	chord: string,
	focus: PanelKind | null,
	ctx: CommandCtx,
	opts: { platform: Platform; runtime: Runtime; keymap?: readonly KeyBinding[] },
): KeyResolution | null {
	const candidates = resolveBindings(chord, scopeChain(focus), {
		platform: opts.platform,
		runtime: opts.runtime,
		keymap: opts.keymap ?? getActiveKeymap(),
	});
	for (const binding of candidates) {
		const command = getCommand(binding.command);
		if (command && isCommandEnabled(command, ctx)) return { binding, command };
	}
	return null;
}

const TEXT_INPUT_TYPES = new Set([
	'',
	'text',
	'search',
	'email',
	'number',
	'password',
	'url',
	'tel',
	'date',
	'time',
	'datetime-local',
	'month',
	'week',
]);

export type TargetKind = 'editable' | 'overlay' | 'local' | 'normal';

export function classifyTarget(target: EventTarget | null): TargetKind {
	const el = target as HTMLElement | null;
	if (!el || typeof el.closest !== 'function') return 'normal';
	if (
		el.closest(
			'[data-keymap-suspend],[role="dialog"][aria-modal="true"],[role="alertdialog"],[role="menu"],[role="listbox"]',
		)
	)
		return 'overlay';
	const tag = el.tagName;
	if (tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return 'editable';
	if (tag === 'INPUT' && TEXT_INPUT_TYPES.has(((el as HTMLInputElement).type ?? '').toLowerCase()))
		return 'editable';
	if (el.closest('[contenteditable=""],[contenteditable="true"]')) return 'editable';
	if (el.closest('[data-keymap-local]')) return 'local';
	return 'normal';
}

type Mods = { ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean };

/** Chords that text fields handle natively (never stolen from an editable element). */
function isTextEditingChord(e: Mods & { code: string }, platform: Platform): boolean {
	const primary = platform === 'mac' ? e.metaKey : e.ctrlKey;
	if (primary && !e.altKey && ['KeyA', 'KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyY'].includes(e.code)) return true;
	if ((primary || e.altKey) && /^(Arrow|Backspace|Delete|Home|End)/.test(e.code)) return true;
	if (/^(Home|End|PageUp|PageDown|Tab)$/.test(e.code)) return true;
	return false;
}

/** Suspended in editable elements: single keys and Shift+key, except Esc/Enter (KB-005). */
function suspendedInEditable(e: Mods & { code: string }): boolean {
	if (e.code === 'Escape' || e.code === 'Enter' || e.code === 'NumpadEnter') return false;
	return !e.ctrlKey && !e.altKey && !e.metaKey;
}

const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;

/** Installs the dispatcher on a window; returns the uninstaller. */
export function installKeyboardDispatcher(win: Window, env: DispatcherEnv): () => void {
	const held = new Map<string, { command: UiCommand; ctx: CommandCtx }>();
	let pending: ((e: KeyboardEvent) => void) | null = null;
	let altTap = false;
	// Pointers held down right now. Esc during a pointer drag belongs to the drag (S03:XF-053, S02:TL-903): the
	// gesture's own listener cancels it. If the keymap ran `gesture.cancel` first, it would also deselect, and the
	// re-render that follows could swap out the gesture's listener in the middle of the dispatch, so the drag
	// survived the Escape (e2e/shapes.spec.ts, "Escape cancels").
	const pressed = new Set<number>();
	const onPointerDown = (e: PointerEvent) => pressed.add(e.pointerId);
	const onPointerUp = (e: PointerEvent) => pressed.delete(e.pointerId);
	const onPointerMove = (e: PointerEvent) => {
		// A release outside the window can go unseen; the next move without buttons tells.
		if (e.buttons === 0) pressed.delete(e.pointerId);
	};

	const clearPending = () => {
		if (pending) win.removeEventListener('keydown', pending);
		pending = null;
	};

	const execute = (e: KeyboardEvent, res: KeyResolution, ctx: CommandCtx) => {
		const { binding, command } = res;
		if (command.nativeClipboard === 'paste') {
			// wp-clipboard (S01:CLB-002): the browser's paste event follows this keydown with the clipboard data.
			if (!e.repeat)
				awaitNativePaste(win, (data) => env.run(command, ctx, { ...(binding.args ?? {}), clipboard: data }));
			return;
		}
		e.preventDefault();
		if (e.repeat && !(binding.repeat || command.repeat)) return; // toggles ignore auto-repeat (KB-006)
		if (!e.repeat && (binding.keyup || command.onKeyUp)) held.set(e.code, { command, ctx });
		env.run(command, ctx, binding.args);
	};

	const onKeyDown = (e: KeyboardEvent) => {
		clearPending();
		if (MODIFIER_CODES.test(e.code)) {
			altTap = e.key === 'Alt' && !e.ctrlKey && !e.shiftKey && !e.metaKey;
			return;
		}
		altTap = false;
		if (e.isComposing || env.isSuspended?.()) return;
		if (e.code === 'Escape' && pressed.size > 0) return;
		const kind = classifyTarget(e.target);
		if (kind === 'overlay') return;
		if (e.code === 'F10' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && env.focusMenubar) {
			e.preventDefault();
			env.focusMenubar();
			return;
		}
		if (kind === 'editable' && (suspendedInEditable(e) || isTextEditingChord(e, env.platform))) return;
		const ctx = env.getCtx();
		const chord = chordFromEvent(e, env.platform);
		const res = resolveKey(chord, env.getFocusKind(), ctx, env);
		if (!res) return;
		if (kind === 'normal') {
			execute(e, res, ctx);
			return;
		}
		// Editable / local widgets get the event first; run in the bubble phase if they did not consume it.
		const event = e;
		pending = (be: KeyboardEvent) => {
			clearPending();
			if (be !== event || be.defaultPrevented) return;
			execute(be, res, env.getCtx());
		};
		win.addEventListener('keydown', pending);
	};

	const onKeyUp = (e: KeyboardEvent) => {
		if (e.key === 'Alt' && altTap && env.platform !== 'mac' && env.focusMenubar) {
			altTap = false;
			e.preventDefault();
			env.focusMenubar();
			return;
		}
		altTap = false;
		const h = held.get(e.code);
		if (!h) return;
		held.delete(e.code);
		h.command.onKeyUp?.(env.getCtx());
	};

	const onBlur = () => {
		altTap = false;
		pressed.clear();
		for (const [code, h] of held) {
			held.delete(code);
			h.command.onKeyUp?.(env.getCtx());
		}
	};

	win.addEventListener('keydown', onKeyDown, true);
	win.addEventListener('keyup', onKeyUp, true);
	win.addEventListener('blur', onBlur);
	win.addEventListener('pointerdown', onPointerDown, true);
	win.addEventListener('pointerup', onPointerUp, true);
	win.addEventListener('pointercancel', onPointerUp, true);
	win.addEventListener('pointermove', onPointerMove, true);
	return () => {
		clearPending();
		win.removeEventListener('keydown', onKeyDown, true);
		win.removeEventListener('keyup', onKeyUp, true);
		win.removeEventListener('blur', onBlur);
		win.removeEventListener('pointerdown', onPointerDown, true);
		win.removeEventListener('pointerup', onPointerUp, true);
		win.removeEventListener('pointercancel', onPointerUp, true);
		win.removeEventListener('pointermove', onPointerMove, true);
	};
}

/** How long a paste chord waits for the browser's paste event before running without its data. */
const NATIVE_PASTE_WAIT_MS = 120;

/**
 * Lets the default action of a paste chord happen and runs `run` with the data of the paste event it fires
 * (captured and stopped here), or with `null` when the browser fires none.
 */
function awaitNativePaste(win: Window, run: (data: ClipboardData | null) => void): void {
	let done = false;
	const finish = (data: ClipboardData | null) => {
		if (done) return;
		done = true;
		win.removeEventListener('paste', onPaste, true);
		win.clearTimeout(timer);
		run(data);
	};
	const onPaste = (e: Event) => {
		e.preventDefault();
		e.stopImmediatePropagation();
		finish(readClipboardEvent(e as ClipboardEvent));
	};
	win.addEventListener('paste', onPaste, true);
	const timer = win.setTimeout(() => finish(null), NATIVE_PASTE_WAIT_MS);
}
