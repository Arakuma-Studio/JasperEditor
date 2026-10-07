// Live-UI automation (docs/wp-notes/mcp-cli.md §4): what an agent can ask an open editor window through
// `POST /api/agent/ui` → WS /agent → AgentBridge (kind `ui`). Works the same in the browser and in Electron:
// elements and input are DOM-level (ui-elements.ts, ui-input.ts); screenshots use Electron's capturePage when
// the desktop preload offers it and a DOM rasterisation otherwise; coordinate mapping comes from the panels
// themselves (Timeline time ↔ x and track ↔ y, Program monitor sequence pixels ↔ window points).
import type { RunResult } from '../commands/registry.ts';
import type { CommandCtx, UiCommand } from '../commands/types.ts';
import type { ShellController } from '../shell/context.tsx';
import {
	accessibleName,
	isVisible,
	panelOf,
	resolveElement,
	similarIds,
	snapshotElements,
	type UiBounds,
	type UiElement,
} from './ui-elements.ts';
import {
	type Button,
	click,
	drag,
	type Modifiers,
	nextFrame,
	pressKey,
	typeText,
	wheel,
} from './ui-input.ts';

export class UiAutomationError extends Error {
	constructor(
		readonly code: 'E_NOT_FOUND' | 'E_INVALID_PARAM' | 'E_NOT_AVAILABLE' | 'E_DISABLED',
		message: string,
	) {
		super(message);
		this.name = 'UiAutomationError';
	}
}

// ---------------------------------------------------------------- host (the shell runtime)

/** What the shell gives the automation layer (EditorShell mounts it). */
export type UiAutomationHost = {
	getCtx(): CommandCtx;
	runCommand(id: string, args?: unknown): Promise<RunResult>;
	listCommands(): UiCommand[];
	isEnabled(cmd: UiCommand, ctx: CommandCtx): boolean;
	isChecked(cmd: UiCommand, ctx: CommandCtx): boolean;
	shortcutFor(id: string): string | null;
	labelFor(cmd: UiCommand, ctx: CommandCtx): string;
	shell(): ShellController | null;
};

let host: UiAutomationHost | null = null;

export function setUiAutomationHost(h: UiAutomationHost): () => void {
	host = h;
	return () => {
		if (host === h) host = null;
	};
}

// ---------------------------------------------------------------- locators (panels register them)

export type TimelineLocateArgs = {
	frame?: number;
	track?: string;
	clipId?: string;
	edge?: 'in' | 'out' | 'center';
};
export type TimelineHit = {
	frame: number;
	exactFrame: number;
	timecode: string;
	track: string | null;
	trackId: string | null;
	clipId: string | null;
	zone?: 'in' | 'out' | 'body';
	transitionId?: string;
};

export type TimelineLocator = {
	sequenceId(): string | null;
	/** Window point of a frame (x) on a track row (y): its centre, or of a clip's body / edge. */
	locate(a: TimelineLocateArgs): { x: number; y: number; frame?: number; track?: string };
	hit(x: number, y: number): TimelineHit | null;
	view(): { scrollFrame: number; pxPerFrame: number; area: UiBounds; visibleFrames: [number, number] };
};

export type ProgramLocator = {
	/** Window point of a sequence pixel. */
	toWindow(x: number, y: number): { x: number; y: number };
	/** Sequence pixel of a window point (may lie outside the frame). */
	toSequence(x: number, y: number): { x: number; y: number };
	view(): { frame: UiBounds; scale: number; sequence: { width: number; height: number }; viewport: UiBounds };
};

type LocatorEntry = { kind: 'timeline'; impl: TimelineLocator } | { kind: 'program'; impl: ProgramLocator };
const locators = new Map<string, LocatorEntry & { element(): Element | null }>();

/** A panel publishes its coordinate mapping while it is mounted. */
export function registerUiLocator(
	instanceId: string,
	entry: LocatorEntry & { element(): Element | null },
): () => void {
	locators.set(instanceId, entry);
	return () => {
		if (locators.get(instanceId) === entry) locators.delete(instanceId);
	};
}

function locator<K extends LocatorEntry['kind']>(kind: K): Extract<LocatorEntry, { kind: K }>['impl'] {
	const all = [...locators.values()].filter((l) => l.kind === kind);
	const visible = all.find((l) => {
		const el = l.element();
		return el ? isVisible(el) : false;
	});
	const pick = visible ?? all[0];
	if (!pick)
		throw new UiAutomationError(
			'E_NOT_AVAILABLE',
			`No ${kind === 'timeline' ? 'Timeline' : 'Program monitor'} panel is open: run ui_command {"id": "panel.focus.${kind}"} first`,
		);
	return pick.impl as never;
}

// ---------------------------------------------------------------- arguments

type Args = Record<string, unknown>;
const num = (v: unknown, name: string): number => {
	if (typeof v !== 'number' || !Number.isFinite(v))
		throw new UiAutomationError('E_INVALID_PARAM', `${name} must be a number`);
	return v;
};
const str = (v: unknown, name: string): string => {
	if (typeof v !== 'string' || !v)
		throw new UiAutomationError('E_INVALID_PARAM', `${name} must be a non-empty string`);
	return v;
};
const mods = (v: unknown): Modifiers => {
	if (v === undefined) return {};
	if (!v || typeof v !== 'object')
		throw new UiAutomationError('E_INVALID_PARAM', 'modifiers must be an object');
	return v as Modifiers;
};

function needElement(id: string): Element {
	const el = resolveElement(id);
	if (el) return el;
	const near = similarIds(id);
	throw new UiAutomationError(
		'E_NOT_FOUND',
		`No element "${id}" on screen${near.length ? `; similar: ${near.join(', ')}` : ''}. ui_elements lists the ids (it may be in a closed panel, a scrolled-away row or a menu that is not open).`,
	);
}

/** A target: {id, fx?, fy?} (a point inside the element, default its centre) or {x, y}. */
async function pointOf(
	t: unknown,
	label = 'target',
): Promise<{ x: number; y: number; element: Element | null }> {
	if (!t || typeof t !== 'object')
		throw new UiAutomationError('E_INVALID_PARAM', `${label} must be {id} or {x, y}`);
	const a = t as Args;
	if (typeof a.id === 'string') {
		const el = needElement(a.id);
		let r = el.getBoundingClientRect();
		if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) {
			el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
			await nextFrame();
			r = el.getBoundingClientRect();
		}
		const fx = typeof a.fx === 'number' ? Math.min(1, Math.max(0, a.fx)) : 0.5;
		const fy = typeof a.fy === 'number' ? Math.min(1, Math.max(0, a.fy)) : 0.5;
		return { x: r.left + r.width * fx, y: r.top + r.height * fy, element: el };
	}
	if (a.timeline && typeof a.timeline === 'object') {
		const p = locator('timeline').locate(a.timeline as TimelineLocateArgs);
		return { ...p, element: document.elementFromPoint(p.x, p.y) };
	}
	if (a.program && typeof a.program === 'object') {
		const q = a.program as Args;
		const p = locator('program').toWindow(num(q.x, 'program.x'), num(q.y, 'program.y'));
		return { ...p, element: document.elementFromPoint(p.x, p.y) };
	}
	const x = num(a.x, `${label}.x`);
	const y = num(a.y, `${label}.y`);
	if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight)
		throw new UiAutomationError(
			'E_INVALID_PARAM',
			`(${x}, ${y}) is outside the window (${window.innerWidth}×${window.innerHeight})`,
		);
	return { x, y, element: document.elementFromPoint(x, y) };
}

const describe = (el: Element | null) => {
	if (!el) return null;
	const snap = snapshotElements();
	for (let p: Element | null = el; p; p = p.parentElement)
		for (const [id, e] of snap.byId)
			if (e === p) return { id, role: p.getAttribute('role') ?? p.tagName.toLowerCase() };
	return { id: null, tag: el.tagName.toLowerCase(), name: accessibleName(el) };
};

// ---------------------------------------------------------------- actions

function panelsState() {
	const bodies = Array.from(document.querySelectorAll('[data-panel-body][data-panel-instance]'));
	return bodies.map((b) => {
		const instance = b.getAttribute('data-panel-instance')!;
		const tab = document.querySelector(
			`[data-panel-instance="${CSS.escape(instance)}"]:not([data-panel-body])`,
		);
		const r = b.getBoundingClientRect();
		return {
			kind: b.getAttribute('data-panel-kind'),
			instanceId: instance,
			title: tab?.getAttribute('title') ?? null,
			visible: b.getAttribute('data-visible') === 'true' && r.width > 0 && r.height > 0,
			bounds: { x: r.left, y: r.top, width: r.width, height: r.height },
		};
	});
}

function state() {
	const shell = host?.shell() ?? null;
	const ctx = host?.getCtx();
	const ws = shell?.workspaces.getState();
	const dialogs = Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"]'))
		.filter(isVisible)
		.map((d) => ({ title: accessibleName(d), testId: d.getAttribute('data-testid') }));
	const menus = Array.from(document.querySelectorAll('[role="menu"]')).filter(isVisible).length;
	return {
		url: location.pathname,
		runtime: window.jasperDesktop ? 'desktop' : 'web',
		window: {
			width: window.innerWidth,
			height: window.innerHeight,
			devicePixelRatio: window.devicePixelRatio,
		},
		projectId: ctx?.session?.projectId ?? null,
		sequenceId: ctx?.session?.getState().activeSequenceId ?? null,
		playhead: ctx?.session ? ctx.session.transport.getState().frame : null,
		playing: ctx?.session ? ctx.session.transport.getState().playing : null,
		workspace: ws
			? { id: ws.activeId, name: ws.workspaces[ws.activeId]?.name ?? ws.activeId, available: ws.order }
			: null,
		mode: shell?.getMode() ?? null,
		focusedPanel: ctx?.focus.panel ? { kind: ctx.focus.panel, instanceId: ctx.focus.instanceId } : null,
		maximized: shell?.isMaximized() ?? false,
		panels: panelsState(),
		dialogs,
		openMenus: menus,
		focusedElement: describe(document.activeElement === document.body ? null : document.activeElement),
	};
}

function elements(a: Args) {
	const panel = typeof a.panel === 'string' ? a.panel : null;
	const query = typeof a.query === 'string' ? a.query.toLowerCase() : null;
	const includeTargets = a.targets !== false;
	const limit = typeof a.limit === 'number' ? Math.max(1, Math.min(2000, a.limit)) : 400;
	let list: UiElement[] = snapshotElements().elements;
	if (panel) {
		if (!panelsState().some((p) => p.kind === panel || p.instanceId === panel))
			throw new UiAutomationError(
				'E_NOT_FOUND',
				`No "${panel}" panel is open; open panels: ${panelsState()
					.map((p) => p.kind)
					.join(', ')}`,
			);
		list = list.filter((e) => e.panel === panel || e.panelInstance === panel);
	}
	if (!includeTargets) list = list.filter((e) => e.kind === 'control');
	if (query)
		list = list.filter(
			(e) =>
				e.id.toLowerCase().includes(query) ||
				e.name.toLowerCase().includes(query) ||
				e.role.toLowerCase() === query,
		);
	return {
		count: list.length,
		...(list.length > limit ? { truncated: true, shown: limit } : {}),
		elements: list.slice(0, limit),
	};
}

async function doClick(a: Args) {
	const p = await pointOf(a.id !== undefined ? { id: a.id, fx: a.fx, fy: a.fy } : a);
	if (p.element && a.id !== undefined) {
		const el = p.element as HTMLButtonElement;
		if (el.disabled || el.closest('[aria-disabled="true"]'))
			throw new UiAutomationError('E_DISABLED', `"${a.id}" is disabled`);
	}
	const button = (a.button as Button | undefined) ?? 'left';
	if (!['left', 'right', 'middle'].includes(button))
		throw new UiAutomationError('E_INVALID_PARAM', 'button is left, right or middle');
	const count = typeof a.count === 'number' ? Math.max(1, Math.min(3, Math.round(a.count))) : 1;
	const target = await click(p.x, p.y, button, count, mods(a.modifiers));
	await nextFrame();
	return { x: round(p.x), y: round(p.y), clicked: describe(target) };
}

async function doDrag(a: Args) {
	const from = await pointOf(a.from, 'from');
	const to = await pointOf(a.to, 'to');
	const r = await drag(from, to, {
		steps: typeof a.steps === 'number' ? a.steps : undefined,
		modifiers: mods(a.modifiers),
		holdMs: typeof a.holdMs === 'number' ? a.holdMs : undefined,
		button: a.button as Button | undefined,
	});
	return {
		from: { x: round(from.x), y: round(from.y), element: describe(from.element) },
		to: { x: round(to.x), y: round(to.y), element: describe(document.elementFromPoint(to.x, to.y)) },
		html5DragAndDrop: r.html5,
	};
}

async function doScroll(a: Args) {
	const p = await pointOf(a.id !== undefined ? { id: a.id } : a);
	await wheel(
		p.x,
		p.y,
		typeof a.dx === 'number' ? a.dx : 0,
		typeof a.dy === 'number' ? a.dy : 0,
		mods(a.modifiers),
	);
	return { x: round(p.x), y: round(p.y) };
}

async function focusId(id: unknown) {
	if (id === undefined) return;
	const el = needElement(str(id, 'id')) as HTMLElement;
	const p = await pointOf({ id });
	await click(p.x, p.y);
	if (document.activeElement !== el && typeof el.focus === 'function') el.focus();
}

async function doKey(a: Args) {
	await focusId(a.id);
	const key = str(a.key, 'key');
	let r: { defaultPrevented: boolean };
	try {
		r = await pressKey(key, { repeat: typeof a.repeat === 'number' ? a.repeat : undefined });
	} catch (e) {
		throw new UiAutomationError('E_INVALID_PARAM', (e as Error).message);
	}
	return { key, handled: r.defaultPrevented, focused: describe(document.activeElement) };
}

async function doType(a: Args) {
	await focusId(a.id);
	const text = typeof a.text === 'string' ? a.text : null;
	if (text === null) throw new UiAutomationError('E_INVALID_PARAM', 'text must be a string');
	const el = document.activeElement;
	if (!el || el === document.body)
		throw new UiAutomationError(
			'E_NOT_AVAILABLE',
			'No field has focus: pass the id of the field to type into',
		);
	await typeText(text);
	return {
		typed: text.length,
		focused: describe(document.activeElement),
		value: valueNow(document.activeElement),
	};
}

function valueNow(el: Element | null): unknown {
	if (!el) return null;
	if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)
		return el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')
			? el.checked
			: el.value;
	const now = el.getAttribute('aria-valuenow');
	if (now !== null) return Number(now);
	const checked = el.getAttribute('aria-checked');
	if (checked !== null) return checked === 'true';
	return el.textContent;
}

function setNative(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
	const proto =
		el instanceof HTMLInputElement
			? HTMLInputElement.prototype
			: el instanceof HTMLTextAreaElement
				? HTMLTextAreaElement.prototype
				: HTMLSelectElement.prototype;
	Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
	el.dispatchEvent(new Event('input', { bubbles: true }));
	el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Replaces the text of a focused field and commits it like a user (select all, type, Enter). */
async function replaceText(el: HTMLInputElement | HTMLTextAreaElement, value: string, commit: boolean) {
	el.focus();
	el.select();
	if (!document.execCommand('insertText', false, value)) setNative(el, value);
	await nextFrame();
	if (commit && el.isConnected && el instanceof HTMLInputElement) {
		await pressKey('Enter');
		if (el.isConnected && document.activeElement === el) el.blur();
	}
}

async function doSet(a: Args) {
	const id = str(a.id, 'id');
	const el = needElement(id);
	const value = a.value;
	const commit = a.commit !== false;
	if ((el as HTMLButtonElement).disabled || el.closest('[aria-disabled="true"]'))
		throw new UiAutomationError('E_DISABLED', `"${id}" is disabled`);
	const role = el.getAttribute('role');
	if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
		if (typeof value !== 'boolean')
			throw new UiAutomationError('E_INVALID_PARAM', `${id} is a ${el.type}: value must be true/false`);
		if (el.checked !== value) await doClick({ id });
	} else if (el instanceof HTMLSelectElement) {
		const v = String(value);
		const opt = Array.from(el.options).find((o) => o.value === v || o.label === v || o.text === v);
		if (!opt)
			throw new UiAutomationError(
				'E_INVALID_PARAM',
				`${id} has no option "${v}"; options: ${Array.from(el.options)
					.map((o) => o.label || o.value)
					.join(', ')}`,
			);
		setNative(el, opt.value);
	} else if (
		el instanceof HTMLInputElement &&
		(el.type === 'range' || el.type === 'color' || el.type === 'date')
	) {
		setNative(el, String(value));
	} else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
		await replaceText(el, String(value), commit);
	} else if (
		role === 'checkbox' ||
		role === 'switch' ||
		(role === 'button' && el.hasAttribute('aria-pressed'))
	) {
		if (typeof value !== 'boolean')
			throw new UiAutomationError('E_INVALID_PARAM', `${id} is a ${role}: value must be true/false`);
		const on = (el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed')) === 'true';
		if (on !== value) await doClick({ id });
	} else if (role === 'spinbutton' || role === 'textbox' || (el as HTMLElement).isContentEditable) {
		// Display-mode fields (scrubby numbers, timecodes) switch to a text input on Enter.
		if ((el as HTMLElement).isContentEditable) {
			(el as HTMLElement).focus();
			document.execCommand('selectAll');
			document.execCommand('insertText', false, String(value));
			if (commit) await pressKey('Enter');
		} else {
			(el as HTMLElement).focus();
			await pressKey('Enter');
			await nextFrame();
			const input = document.activeElement;
			if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement))
				throw new UiAutomationError(
					'E_NOT_AVAILABLE',
					`${id} did not open a text field on Enter; use ui_click / ui_type`,
				);
			await replaceText(input, String(value), commit);
		}
	} else if (role === 'combobox' || role === 'listbox' || el.getAttribute('aria-haspopup')) {
		await doClick({ id });
		await nextFrame();
		const want = String(value).toLowerCase();
		const options = Array.from(
			document.querySelectorAll('[role="option"],[role="menuitem"],[role="menuitemradio"]'),
		).filter(isVisible);
		const opt =
			options.find((o) => accessibleName(o).toLowerCase() === want) ??
			options.find((o) => accessibleName(o).toLowerCase().includes(want));
		if (!opt) {
			await pressKey('Escape');
			throw new UiAutomationError(
				'E_INVALID_PARAM',
				`${id} offers no "${value}"; options: ${options.map((o) => accessibleName(o)).join(', ')}`,
			);
		}
		const r = opt.getBoundingClientRect();
		await click(r.left + r.width / 2, r.top + r.height / 2);
	} else {
		throw new UiAutomationError(
			'E_INVALID_PARAM',
			`${id} (${role ?? el.tagName.toLowerCase()}) has no settable value; use ui_click, ui_drag or ui_type`,
		);
	}
	await nextFrame();
	const after = resolveElement(id);
	return { id, value: valueNow(after ?? el) };
}

function doLocate(a: Args) {
	if (a.timeline && typeof a.timeline === 'object') {
		const t = locator('timeline');
		const p = t.locate(a.timeline as TimelineLocateArgs);
		return { timeline: { ...a.timeline, ...p, view: t.view() } };
	}
	if (a.program && typeof a.program === 'object') {
		const pr = locator('program');
		const q = a.program as Args;
		return {
			program: {
				x: num(q.x, 'program.x'),
				y: num(q.y, 'program.y'),
				window: pr.toWindow(num(q.x, 'program.x'), num(q.y, 'program.y')),
				view: pr.view(),
			},
		};
	}
	if (typeof a.id === 'string') {
		const el = needElement(a.id);
		const r = el.getBoundingClientRect();
		return {
			id: a.id,
			bounds: { x: r.left, y: r.top, width: r.width, height: r.height },
			center: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
		};
	}
	throw new UiAutomationError(
		'E_INVALID_PARAM',
		'Give timeline: {frame?, track?, clipId?, edge?}, program: {x, y} or id',
	);
}

function doHit(a: Args) {
	const x = num(a.x, 'x');
	const y = num(a.y, 'y');
	const el = document.elementFromPoint(x, y);
	const { kind, instance } = el ? panelOf(el) : { kind: null, instance: null };
	const out: Record<string, unknown> = { x, y, panel: kind, panelInstance: instance, element: describe(el) };
	const timeline = [...locators.values()].find(
		(l) => l.kind === 'timeline' && l.element()?.contains(el ?? null),
	);
	if (timeline?.kind === 'timeline') {
		const h = timeline.impl.hit(x, y);
		if (h) out.timeline = h;
	}
	const program = [...locators.values()].find(
		(l) => l.kind === 'program' && l.element()?.contains(el ?? null),
	);
	if (program?.kind === 'program') {
		const s = program.impl.toSequence(x, y);
		const v = program.impl.view();
		out.program = {
			x: round(s.x),
			y: round(s.y),
			inside: s.x >= 0 && s.y >= 0 && s.x < v.sequence.width && s.y < v.sequence.height,
		};
	}
	return out;
}

function needHost(): UiAutomationHost {
	if (!host)
		throw new UiAutomationError('E_NOT_AVAILABLE', 'The editor shell is not ready yet; retry in a moment');
	return host;
}

function doCommands(a: Args) {
	const h = needHost();
	const ctx = h.getCtx();
	const filter = typeof a.filter === 'string' ? a.filter.toLowerCase() : null;
	const out = h
		.listCommands()
		.filter((c) => !filter || c.id.toLowerCase().includes(filter) || c.label.toLowerCase().includes(filter))
		.map((c) => {
			const enabled = h.isEnabled(c, ctx);
			let why: string | undefined;
			if (!enabled) {
				try {
					why = c.disabledReason?.(ctx);
				} catch {
					why = undefined;
				}
				why ??=
					c.capability && !ctx.capabilities.has(c.capability)
						? `Needs the "${c.capability}" capability, which this engine/runtime lacks`
						: typeof c.scope === 'string' &&
								!['global', 'editing'].includes(c.scope) &&
								ctx.focus.panel !== c.scope
							? `Works in the ${c.scope} panel: focus it first (ui_command panel.focus.${c.scope})`
							: !ctx.session && c.scope !== 'global'
								? 'Needs an open project'
								: 'Not available in the current state (selection, playhead or focus)';
			}
			const shortcut = h.shortcutFor(c.id);
			const checked = c.checked ? h.isChecked(c, ctx) : undefined;
			return {
				id: c.id,
				label: h.labelFor(c, ctx),
				scope: c.scope,
				enabled,
				...(why ? { why } : {}),
				...(checked !== undefined ? { checked } : {}),
				...(shortcut ? { shortcut } : {}),
				...(c.argsSchema ? { takesArgs: true } : {}),
				...(c.hidden ? { hidden: true } : {}),
				...(c.description ? { description: c.description } : {}),
			};
		})
		.filter((c) => a.enabledOnly !== true || c.enabled)
		.sort((x, y) => x.id.localeCompare(y.id));
	return { count: out.length, commands: out };
}

async function doCommand(a: Args) {
	const h = needHost();
	const id = str(a.id, 'id');
	const cmd = h.listCommands().find((c) => c.id === id);
	if (!cmd) {
		const near = h
			.listCommands()
			.map((c) => c.id)
			.filter((c) => c.includes(id.split('.').pop() ?? id))
			.slice(0, 8);
		throw new UiAutomationError(
			'E_NOT_FOUND',
			`Unknown UI command "${id}"${near.length ? `; similar: ${near.join(', ')}` : ''}. ui_commands lists them.`,
		);
	}
	const r = await h.runCommand(id, a.args);
	await nextFrame();
	if (!r.ran) {
		const ctx = h.getCtx();
		if (r.reason === 'disabled') {
			let why: string | undefined;
			try {
				why = cmd.disabledReason?.(ctx);
			} catch {
				why = undefined;
			}
			throw new UiAutomationError('E_DISABLED', `${id} is disabled${why ? `: ${why}` : ''}`);
		}
		if (r.reason === 'invalid-args')
			throw new UiAutomationError(
				'E_INVALID_PARAM',
				`${id}: invalid args (${String((r.error as Error)?.message ?? r.error)})`,
			);
		throw new UiAutomationError(
			'E_INVALID_PARAM',
			`${id} failed: ${String((r.error as Error)?.message ?? r.reason)}`,
		);
	}
	return { id, ran: true, state: { focusedPanel: h.getCtx().focus.panel, url: location.pathname } };
}

// ---------------------------------------------------------------- screenshots

type ShotArgs = { panel?: string; id?: string; maxWidth?: number };

async function screenshot(a: ShotArgs) {
	let rect: UiBounds = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
	let node: Element = document.documentElement;
	if (a.panel) {
		const p = panelsState().find((x) => (x.kind === a.panel || x.instanceId === a.panel) && x.visible);
		if (!p)
			throw new UiAutomationError(
				'E_NOT_FOUND',
				`No visible "${a.panel}" panel; visible panels: ${panelsState()
					.filter((x) => x.visible)
					.map((x) => x.kind)
					.join(', ')}`,
			);
		rect = p.bounds;
		node =
			document.querySelector(`[data-panel-body][data-panel-instance="${CSS.escape(p.instanceId)}"]`) ?? node;
	} else if (a.id) {
		const el = needElement(a.id);
		const r = el.getBoundingClientRect();
		rect = { x: r.left, y: r.top, width: r.width, height: r.height };
		node = el;
	}
	rect = {
		x: Math.max(0, Math.floor(rect.x)),
		y: Math.max(0, Math.floor(rect.y)),
		width: Math.max(1, Math.round(Math.min(rect.width, window.innerWidth - rect.x))),
		height: Math.max(1, Math.round(Math.min(rect.height, window.innerHeight - rect.y))),
	};
	const maxWidth = typeof a.maxWidth === 'number' ? Math.max(64, Math.min(4096, a.maxWidth)) : 1600;
	const desktop = window.jasperDesktop?.capturePage;
	if (desktop) {
		const shot = await desktop(rect, maxWidth);
		return { ...shot, bounds: rect, via: 'electron' };
	}
	const { domToPng } = await import('modern-screenshot');
	const scale = Math.min(window.devicePixelRatio || 1, maxWidth / rect.width);
	const isWindow = node === document.documentElement;
	const url = await domToPng(isWindow ? document.body : (node as HTMLElement), {
		scale,
		width: isWindow ? window.innerWidth : undefined,
		height: isWindow ? window.innerHeight : undefined,
		// The app background token, so transparent areas match what the user sees.
		backgroundColor: getComputedStyle(document.body).getPropertyValue('--pr-bg-app').trim() || null,
		timeout: 15_000,
	});
	const png = url.slice(url.indexOf(',') + 1);
	return {
		png,
		width: Math.round(rect.width * scale),
		height: Math.round(rect.height * scale),
		bounds: rect,
		via: 'dom',
		note: 'Rasterised from the DOM: WebGL canvases (GPU effects in the Program monitor) may show their last drawn frame or nothing; use render_frame for the rendered picture.',
	};
}

const round = (v: number) => Math.round(v * 10) / 10;

/** Runs one UI action (the relay's `ui` request). */
export async function runUiAction(action: string, raw: unknown): Promise<unknown> {
	try {
		return await dispatchUiAction(action, raw);
	} catch (e) {
		if (e instanceof UiAutomationError) throw e;
		// Panels' locators and the DOM report plain errors: they are about the arguments.
		throw new UiAutomationError('E_INVALID_PARAM', e instanceof Error ? e.message : String(e));
	}
}

async function dispatchUiAction(action: string, raw: unknown): Promise<unknown> {
	const a = (raw && typeof raw === 'object' ? raw : {}) as Args;
	switch (action) {
		case 'state':
			return state();
		case 'elements':
			return elements(a);
		case 'screenshot':
			return screenshot(a as ShotArgs);
		case 'click':
			return doClick(a);
		case 'drag':
			return doDrag(a);
		case 'scroll':
			return doScroll(a);
		case 'key':
			return doKey(a);
		case 'type':
			return doType(a);
		case 'set':
			return doSet(a);
		case 'locate':
			return doLocate(a);
		case 'hit':
			return doHit(a);
		case 'commands':
			return doCommands(a);
		case 'command':
			return doCommand(a);
		default:
			throw new UiAutomationError('E_INVALID_PARAM', `Unknown UI action "${action}"`);
	}
}
