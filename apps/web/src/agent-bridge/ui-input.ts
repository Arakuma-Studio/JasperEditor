// Live-UI automation, input side (docs/wp-notes/mcp-cli.md §4): synthetic pointer, wheel, HTML5 drag-and-drop
// and keyboard input dispatched into the page the way the browser would, so React handlers, the keymap
// dispatcher (KeyboardEvent.code) and panel gestures (pointer capture, per-frame coalescing) see a user.
//
// Pointer capture: synthetic events are always dispatched to the target given, so `setPointerCapture` from a
// handler is recorded while our pointerdown is dispatched and later moves / the release go to that element.

export type Modifiers = { shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean; command?: boolean };
export type Button = 'left' | 'right' | 'middle';

const BUTTON: Record<Button, { button: number; buttons: number }> = {
	left: { button: 0, buttons: 1 },
	middle: { button: 1, buttons: 4 },
	right: { button: 2, buttons: 2 },
};

export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** `command` = ⌘ on macOS, Ctrl elsewhere (like the keymap's primary modifier). */
function mods(m: Modifiers = {}) {
	const primary = !!m.command;
	return {
		shiftKey: !!m.shift,
		altKey: !!m.alt,
		ctrlKey: !!m.ctrl || (primary && !isMac()),
		metaKey: !!m.meta || (primary && isMac()),
	};
}

/** Waits for the next rendered frame (or 50 ms when frames are throttled: hidden windows). */
export function nextFrame(): Promise<void> {
	return new Promise((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			resolve();
		};
		requestAnimationFrame(() => finish());
		setTimeout(finish, 50);
	});
}

function elementAt(x: number, y: number): Element {
	return document.elementFromPoint(x, y) ?? document.body;
}

type PointerState = {
	x: number;
	y: number;
	captured: Element | null;
	buttons: number;
	downTarget: Element | null;
};

const pointer: PointerState = { x: 0, y: 0, captured: null, buttons: 0, downTarget: null };

/** Runs `fn` while recording `setPointerCapture` / `releasePointerCapture` calls of synthetic pointer 1. */
function trackingCapture<T>(fn: () => T): T {
	const set = Element.prototype.setPointerCapture;
	const release = Element.prototype.releasePointerCapture;
	Element.prototype.setPointerCapture = function (this: Element, id: number) {
		pointer.captured = this;
		try {
			set.call(this, id);
		} catch {
			// no real pointer is down: the capture is emulated
		}
	};
	Element.prototype.releasePointerCapture = function (this: Element, id: number) {
		if (pointer.captured === this) pointer.captured = null;
		try {
			release.call(this, id);
		} catch {
			// not captured for real
		}
	};
	try {
		return fn();
	} finally {
		Element.prototype.setPointerCapture = set;
		Element.prototype.releasePointerCapture = release;
	}
}

function pointerInit(
	x: number,
	y: number,
	m: Modifiers,
	extra: Partial<PointerEventInit> = {},
): PointerEventInit {
	const dx = x - pointer.x;
	const dy = y - pointer.y;
	return {
		bubbles: true,
		cancelable: true,
		composed: true,
		clientX: x,
		clientY: y,
		screenX: x + window.screenX,
		screenY: y + window.screenY,
		movementX: dx,
		movementY: dy,
		pointerId: 1,
		pointerType: 'mouse',
		isPrimary: true,
		width: 1,
		height: 1,
		pressure: pointer.buttons ? 0.5 : 0,
		view: window,
		...mods(m),
		...extra,
	};
}

function fire(target: Element, type: string, init: PointerEventInit): boolean {
	const isPointer =
		type.startsWith('pointer') || type === 'gotpointercapture' || type === 'lostpointercapture';
	const ev = isPointer ? new PointerEvent(type, init) : new MouseEvent(type, init);
	return trackingCapture(() => target.dispatchEvent(ev));
}

/** Moves the pointer to (x, y): pointermove + mousemove to the capturing element or the element there. */
export function pointerMove(x: number, y: number, m: Modifiers = {}): void {
	const prev = elementAt(pointer.x, pointer.y);
	const target = pointer.captured ?? elementAt(x, y);
	const init = pointerInit(x, y, m, { buttons: pointer.buttons, button: -1 });
	if (!pointer.captured && target !== prev) {
		fire(prev, 'pointerout', { ...init, relatedTarget: target });
		fire(prev, 'mouseout', { ...init, relatedTarget: target });
		fire(target, 'pointerover', { ...init, relatedTarget: prev });
		fire(target, 'mouseover', { ...init, relatedTarget: prev });
	}
	fire(target, 'pointermove', init);
	fire(target, 'mousemove', init);
	pointer.x = x;
	pointer.y = y;
}

function focusFor(target: Element): void {
	// The browser focuses the nearest focusable ancestor on mousedown (a default action synthetic events lack).
	const f = target.closest<HTMLElement>(
		'input,select,textarea,button,a[href],[tabindex],[contenteditable=""],[contenteditable="true"]',
	);
	if (f && typeof f.focus === 'function') f.focus({ preventScroll: true });
	else if (document.activeElement instanceof HTMLElement && !target.contains(document.activeElement))
		document.activeElement.blur();
}

export function pointerDown(
	x: number,
	y: number,
	button: Button = 'left',
	m: Modifiers = {},
	detail = 1,
): Element {
	pointerMove(x, y, m);
	const target = elementAt(x, y);
	const b = BUTTON[button];
	pointer.buttons = b.buttons;
	pointer.downTarget = target;
	pointer.captured = null;
	const init = pointerInit(x, y, m, { button: b.button, buttons: b.buttons, detail });
	const okPointer = fire(target, 'pointerdown', init);
	// pointerdown.preventDefault() suppresses the compatibility mousedown (and its focus change).
	if (okPointer) {
		const okMouse = fire(target, 'mousedown', init);
		if (okMouse && button !== 'middle') focusFor(target);
	}
	if (pointer.captured) fire(pointer.captured, 'gotpointercapture', init);
	return target;
}

export function pointerUp(
	x: number,
	y: number,
	button: Button = 'left',
	m: Modifiers = {},
	detail = 1,
): void {
	if (pointer.x !== x || pointer.y !== y) pointerMove(x, y, m);
	const b = BUTTON[button];
	pointer.buttons = 0;
	const captured = pointer.captured;
	const target = captured ?? elementAt(x, y);
	const init = pointerInit(x, y, m, { button: b.button, buttons: 0, detail });
	fire(target, 'pointerup', init);
	fire(target, 'mouseup', init);
	if (captured) {
		pointer.captured = null;
		fire(captured, 'lostpointercapture', init);
	}
	// click goes to the common ancestor of the press and release targets.
	const down = pointer.downTarget;
	pointer.downTarget = null;
	const under = elementAt(x, y);
	let common: Element | null = down;
	while (common && !common.contains(under)) common = common.parentElement;
	if (!common) return;
	if (button === 'left') fire(common, 'click', init);
	else if (button === 'middle') fire(common, 'auxclick', init);
	else {
		fire(common, 'auxclick', init);
		fire(under, 'contextmenu', init);
	}
	if (button === 'left' && detail === 2) fire(common, 'dblclick', init);
}

/** A click (count 2 = double-click: two presses, then dblclick). */
export async function click(
	x: number,
	y: number,
	button: Button = 'left',
	count = 1,
	m: Modifiers = {},
): Promise<Element> {
	const target = elementAt(x, y);
	for (let i = 1; i <= Math.max(1, count); i++) {
		pointerDown(x, y, button, m, i);
		pointerUp(x, y, button, m, i);
		if (i < count) await nextFrame();
	}
	await nextFrame();
	return target;
}

/** Press, `steps` moves (one per frame, the timeline coalesces moves per frame), release. */
export async function drag(
	from: { x: number; y: number },
	to: { x: number; y: number },
	opts: { steps?: number; button?: Button; modifiers?: Modifiers; holdMs?: number } = {},
): Promise<{ html5: boolean }> {
	const m = opts.modifiers ?? {};
	const steps = Math.max(1, Math.min(200, opts.steps ?? 12));
	const source = elementAt(from.x, from.y).closest('[draggable="true"]');
	if (source) {
		await dragAndDrop(source, from, to, steps, m);
		return { html5: true };
	}
	pointerDown(from.x, from.y, opts.button ?? 'left', m);
	await nextFrame();
	for (let i = 1; i <= steps; i++) {
		const t = i / steps;
		pointerMove(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, m);
		await nextFrame();
	}
	if (opts.holdMs) await new Promise((r) => setTimeout(r, Math.min(5000, opts.holdMs!)));
	pointerUp(to.x, to.y, opts.button ?? 'left', m);
	await nextFrame();
	await nextFrame();
	return { html5: false };
}

/** HTML5 drag-and-drop (dragstart / dragover / drop / dragend with one shared DataTransfer). */
async function dragAndDrop(
	source: Element,
	from: { x: number; y: number },
	to: { x: number; y: number },
	steps: number,
	m: Modifiers,
): Promise<void> {
	const dt = new DataTransfer();
	const init = (x: number, y: number): DragEventInit => ({
		bubbles: true,
		cancelable: true,
		composed: true,
		clientX: x,
		clientY: y,
		screenX: x + window.screenX,
		screenY: y + window.screenY,
		dataTransfer: dt,
		...mods(m),
	});
	pointerDown(from.x, from.y, 'left', m);
	if (!source.dispatchEvent(new DragEvent('dragstart', init(from.x, from.y)))) {
		pointerUp(from.x, from.y, 'left', m);
		return;
	}
	pointer.buttons = 0;
	let over: Element | null = null;
	let accepted = false;
	for (let i = 1; i <= steps; i++) {
		const t = i / steps;
		const x = from.x + (to.x - from.x) * t;
		const y = from.y + (to.y - from.y) * t;
		source.dispatchEvent(new DragEvent('drag', init(x, y)));
		const target = elementAt(x, y);
		if (target !== over) {
			if (over) over.dispatchEvent(new DragEvent('dragleave', { ...init(x, y), relatedTarget: target }));
			target.dispatchEvent(new DragEvent('dragenter', { ...init(x, y), relatedTarget: over }));
			over = target;
		}
		// dragover.preventDefault() = this target accepts the drop.
		accepted = !target.dispatchEvent(new DragEvent('dragover', init(x, y)));
		await nextFrame();
	}
	if (over && accepted) over.dispatchEvent(new DragEvent('drop', init(to.x, to.y)));
	else if (over) over.dispatchEvent(new DragEvent('dragleave', init(to.x, to.y)));
	source.dispatchEvent(new DragEvent('dragend', init(to.x, to.y)));
	pointer.downTarget = null;
	await nextFrame();
}

export async function wheel(x: number, y: number, dx: number, dy: number, m: Modifiers = {}): Promise<void> {
	pointerMove(x, y, m);
	elementAt(x, y).dispatchEvent(
		new WheelEvent('wheel', {
			bubbles: true,
			cancelable: true,
			composed: true,
			clientX: x,
			clientY: y,
			deltaX: dx,
			deltaY: dy,
			deltaMode: 0,
			...mods(m),
		}),
	);
	await nextFrame();
}

// ---------------------------------------------------------------- keyboard

const NAMED: Record<string, { key: string; code: string }> = {
	space: { key: ' ', code: 'Space' },
	enter: { key: 'Enter', code: 'Enter' },
	return: { key: 'Enter', code: 'Enter' },
	tab: { key: 'Tab', code: 'Tab' },
	escape: { key: 'Escape', code: 'Escape' },
	esc: { key: 'Escape', code: 'Escape' },
	backspace: { key: 'Backspace', code: 'Backspace' },
	delete: { key: 'Delete', code: 'Delete' },
	del: { key: 'Delete', code: 'Delete' },
	insert: { key: 'Insert', code: 'Insert' },
	home: { key: 'Home', code: 'Home' },
	end: { key: 'End', code: 'End' },
	pageup: { key: 'PageUp', code: 'PageUp' },
	pagedown: { key: 'PageDown', code: 'PageDown' },
	up: { key: 'ArrowUp', code: 'ArrowUp' },
	down: { key: 'ArrowDown', code: 'ArrowDown' },
	left: { key: 'ArrowLeft', code: 'ArrowLeft' },
	right: { key: 'ArrowRight', code: 'ArrowRight' },
	arrowup: { key: 'ArrowUp', code: 'ArrowUp' },
	arrowdown: { key: 'ArrowDown', code: 'ArrowDown' },
	arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft' },
	arrowright: { key: 'ArrowRight', code: 'ArrowRight' },
	'`': { key: '`', code: 'Backquote' },
	backquote: { key: '`', code: 'Backquote' },
	'-': { key: '-', code: 'Minus' },
	minus: { key: '-', code: 'Minus' },
	'=': { key: '=', code: 'Equal' },
	equal: { key: '=', code: 'Equal' },
	plus: { key: '=', code: 'Equal' },
	'[': { key: '[', code: 'BracketLeft' },
	']': { key: ']', code: 'BracketRight' },
	'\\': { key: '\\', code: 'Backslash' },
	';': { key: ';', code: 'Semicolon' },
	"'": { key: "'", code: 'Quote' },
	',': { key: ',', code: 'Comma' },
	comma: { key: ',', code: 'Comma' },
	'.': { key: '.', code: 'Period' },
	period: { key: '.', code: 'Period' },
	'/': { key: '/', code: 'Slash' },
	slash: { key: '/', code: 'Slash' },
	numpadenter: { key: 'Enter', code: 'NumpadEnter' },
	contextmenu: { key: 'ContextMenu', code: 'ContextMenu' },
};

const SHIFTED: Record<string, string> = {
	'~': '`',
	'!': '1',
	'@': '2',
	'#': '3',
	$: '4',
	'%': '5',
	'^': '6',
	'&': '7',
	'*': '8',
	'(': '9',
	')': '0',
	_: '-',
	'+': '=',
	'{': '[',
	'}': ']',
	'|': '\\',
	':': ';',
	'"': "'",
	'<': ',',
	'>': '.',
	'?': '/',
};

/** `key`/`code` of one key name or printable character (shift: whether Shift produces it). */
export function keyOf(name: string): { key: string; code: string; shift: boolean } {
	const lower = name.toLowerCase();
	if (NAMED[lower]) return { ...NAMED[lower]!, shift: false };
	if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower))
		return { key: name.toUpperCase(), code: name.toUpperCase(), shift: false };
	if (/^numpad[0-9]$/.test(lower))
		return { key: lower.slice(6), code: `Numpad${lower.slice(6)}`, shift: false };
	if (name.length === 1) {
		if (/[a-z]/.test(name)) return { key: name, code: `Key${name.toUpperCase()}`, shift: false };
		if (/[A-Z]/.test(name)) return { key: name, code: `Key${name}`, shift: true };
		if (/[0-9]/.test(name)) return { key: name, code: `Digit${name}`, shift: false };
		if (SHIFTED[name]) {
			const base = keyOf(SHIFTED[name]!);
			return { key: name, code: base.code, shift: true };
		}
		if (NAMED[name]) return { ...NAMED[name]!, shift: false };
		return { key: name, code: '', shift: false };
	}
	throw new Error(`Unknown key "${name}"`);
}

const MOD_NAMES: Record<string, keyof Modifiers> = {
	shift: 'shift',
	alt: 'alt',
	option: 'alt',
	opt: 'alt',
	ctrl: 'ctrl',
	control: 'ctrl',
	meta: 'meta',
	win: 'meta',
	super: 'meta',
	cmd: 'command',
	command: 'command',
	mod: 'command',
};

/** "Ctrl+Shift+Z", "Cmd+K", "Shift+Delete", "Space", "a" → modifiers + key. */
export function parseChord(chord: string): { mods: Modifiers; key: string } {
	const parts = chord.split(/\+(?!$)/).map((p) => p.trim());
	const key = parts.pop() ?? '';
	const m: Modifiers = {};
	for (const p of parts) {
		const k = MOD_NAMES[p.toLowerCase()];
		if (!k) throw new Error(`Unknown modifier "${p}" in "${chord}" (use Shift, Alt, Ctrl, Meta or Cmd)`);
		m[k] = true;
	}
	if (!key) throw new Error(`No key in "${chord}"`);
	return { mods: m, key };
}

const MOD_KEYS: { flag: 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'; key: string; code: string }[] = [
	{ flag: 'ctrlKey', key: 'Control', code: 'ControlLeft' },
	{ flag: 'metaKey', key: 'Meta', code: 'MetaLeft' },
	{ flag: 'altKey', key: 'Alt', code: 'AltLeft' },
	{ flag: 'shiftKey', key: 'Shift', code: 'ShiftLeft' },
];

function keyTarget(): Element {
	return document.activeElement && document.activeElement !== document.body
		? document.activeElement
		: document.body;
}

function isTextField(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement | HTMLElement {
	if (!el) return false;
	if (el instanceof HTMLTextAreaElement) return true;
	if (el instanceof HTMLInputElement)
		return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file', 'image'].includes(
			el.type,
		);
	return (el as HTMLElement).isContentEditable;
}

/** Inserts text at the caret of the focused field like typing does (trusted input events via execCommand). */
function insertText(text: string): void {
	const el = document.activeElement;
	if (!isTextField(el)) return;
	if (document.execCommand('insertText', false, text)) return;
	if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
		const start = el.selectionStart ?? el.value.length;
		const end = el.selectionEnd ?? el.value.length;
		const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
		const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
		const next = el.value.slice(0, start) + text + el.value.slice(end);
		set?.call(el, next);
		el.setSelectionRange?.(start + text.length, start + text.length);
		el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
	}
}

/** Presses a key or chord: modifier downs, keydown (+ text insertion when it prints), keyup, modifier ups. */
export async function pressKey(
	chord: string,
	opts: { repeat?: number } = {},
): Promise<{ defaultPrevented: boolean }> {
	const { mods: m, key } = parseChord(chord);
	const k = keyOf(key);
	const flags = mods({ ...m, shift: m.shift || k.shift });
	const target = keyTarget();
	const base = { bubbles: true, cancelable: true, composed: true, view: window };
	const active = MOD_KEYS.filter((x) => flags[x.flag]);
	const held = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };
	for (const x of active) {
		held[x.flag] = true;
		target.dispatchEvent(new KeyboardEvent('keydown', { ...base, ...held, key: x.key, code: x.code }));
	}
	let prevented = false;
	const times = Math.max(1, Math.min(50, opts.repeat ?? 1));
	for (let i = 0; i < times; i++) {
		const t = keyTarget();
		const down = new KeyboardEvent('keydown', { ...base, ...flags, key: k.key, code: k.code, repeat: i > 0 });
		const ok = t.dispatchEvent(down);
		prevented = prevented || !ok;
		// Printable keys without Ctrl/Meta type into a focused field (the browser's default action).
		if (ok && !flags.ctrlKey && !flags.metaKey && (k.key.length === 1 || k.key === 'Enter')) {
			if (k.key === 'Enter') {
				if (t instanceof HTMLTextAreaElement || (t as HTMLElement).isContentEditable) insertText('\n');
				else if (t instanceof HTMLInputElement && t.form) t.form.requestSubmit();
			} else {
				const press = new KeyboardEvent('keypress', { ...base, ...flags, key: k.key, code: k.code });
				if (t.dispatchEvent(press)) insertText(k.key);
			}
		}
		if (ok && k.key === 'Backspace' && isTextField(t)) document.execCommand('delete');
		if (ok && k.key === 'Delete' && isTextField(t)) document.execCommand('forwardDelete');
		if (ok && k.key === 'Tab') moveFocus(flags.shiftKey ? -1 : 1);
		await nextFrame();
	}
	keyTarget().dispatchEvent(new KeyboardEvent('keyup', { ...base, ...flags, key: k.key, code: k.code }));
	for (const x of [...active].reverse()) {
		held[x.flag] = false;
		keyTarget().dispatchEvent(new KeyboardEvent('keyup', { ...base, ...held, key: x.key, code: x.code }));
	}
	await nextFrame();
	return { defaultPrevented: prevented };
}

function moveFocus(dir: 1 | -1): void {
	const focusable = Array.from(
		document.querySelectorAll<HTMLElement>(
			'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
		),
	).filter((e) => e.offsetParent !== null);
	const i = focusable.indexOf(document.activeElement as HTMLElement);
	const next = focusable[(i + dir + focusable.length) % focusable.length];
	next?.focus();
}

/** Types text into the focused field: one key press per character ("\n" presses Enter). */
export async function typeText(text: string): Promise<void> {
	for (const ch of text) {
		if (ch === '\n') await pressKey('Enter');
		else if (ch === '\t') await pressKey('Tab');
		else {
			const k = keyOf(ch === ' ' ? 'Space' : ch);
			const t = keyTarget();
			const base = { bubbles: true, cancelable: true, composed: true, view: window, shiftKey: k.shift };
			const ok = t.dispatchEvent(new KeyboardEvent('keydown', { ...base, key: ch, code: k.code }));
			if (ok && t.dispatchEvent(new KeyboardEvent('keypress', { ...base, key: ch, code: k.code })))
				insertText(ch);
			t.dispatchEvent(new KeyboardEvent('keyup', { ...base, key: ch, code: k.code }));
		}
	}
	await nextFrame();
}
