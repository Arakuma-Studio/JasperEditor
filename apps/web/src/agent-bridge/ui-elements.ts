// Live-UI automation, element side (docs/wp-notes/mcp-cli.md §4): finds every interactive element drawn in
// the window and gives it a stable automation id, so agents (MCP `ui_*` tools, `jasper` CLI) can find,
// read and operate controls by id instead of by pixel.
//
// Automation ids:
//   1. the element's `data-testid` when no other visible element has the same one ("timeline-toolbar",
//      "project-item-itm_…");
//   2. otherwise `<scope>/<testid-or-role>[<accessible name>]`, where scope is the nearest ancestor with a
//      unique `data-testid` (or `panel.<kind>` inside a dock panel, `dialog`, `menu`, `window`), e.g.
//      `effect-controls/scrubby[Opacity]`, `panel.timeline/button[Toggle Snapping]`;
//   3. an id that is still ambiguous gets `#n` and `stable: false` (the audit spec fails on those).
// Entity targets (timeline clips, tracks, transitions, keyframes…) are listed as `timeline.clip.<id>` etc.
// even when the element itself has no handler (the panel hit-tests them).

export type UiBounds = { x: number; y: number; width: number; height: number };

export type UiElement = {
	id: string;
	stable: boolean;
	role: string;
	name: string;
	/** Dock panel kind the element is in (null: header, menus, dialogs, toasts). */
	panel: string | null;
	panelInstance: string | null;
	testId?: string;
	tag: string;
	bounds: UiBounds;
	enabled: boolean;
	focused: boolean;
	value?: string | number;
	checked?: boolean | 'mixed';
	selected?: boolean;
	expanded?: boolean;
	pressed?: boolean;
	/** `control` (interactive) or `target` (an entity drawn by a panel: clip, track, keyframe…). */
	kind: 'control' | 'target';
	/** Unstable ids only: the element's class list, to tell it apart (and to find it in the source). */
	className?: string;
};

const INTERACTIVE_ROLES = new Set([
	'button',
	'link',
	'checkbox',
	'radio',
	'switch',
	'slider',
	'spinbutton',
	'tab',
	'menuitem',
	'menuitemcheckbox',
	'menuitemradio',
	'option',
	'combobox',
	'textbox',
	'searchbox',
	'treeitem',
	'gridcell',
	'scrollbar',
]);

/** React props handlers that make an element a pointer/keyboard target. */
const HANDLERS = [
	'onClick',
	'onDoubleClick',
	'onPointerDown',
	'onMouseDown',
	'onContextMenu',
	'onDragStart',
	'onKeyDown',
	'onWheel',
] as const;

/**
 * Data attributes of entities a panel draws (and often hit-tests itself) → the entity name in automation ids
 * `<panel>.<entity>.<id>` (e.g. `timeline.clip.clp_…`, `program.clip.clp_…`, `project.item.itm_…`).
 */
const ENTITY_ATTRS: readonly [string, string][] = [
	['data-clip-id', 'clip'],
	['data-track-header', 'trackHeader'],
	['data-track-id', 'track'],
	['data-transition-id', 'transition'],
	['data-kf-id', 'keyframe'],
	['data-tracker-id', 'tracker'],
	['data-item-id', 'item'],
	['data-job-id', 'job'],
	['data-ec-header', 'fx'],
	['data-lane', 'lane'],
];

function entityId(el: Element): string | null {
	const e = ENTITY_ATTRS.find(([a]) => !!el.getAttribute(a));
	if (!e) return null;
	const panel = panelOf(el).kind ?? 'window';
	return `${panel}.${e[1]}.${el.getAttribute(e[0])}`;
}

function reactProps(el: Element): Record<string, unknown> | null {
	for (const k in el)
		if (k.startsWith('__reactProps$')) return (el as unknown as Record<string, unknown>)[k] as never;
	return null;
}

/** Which React handlers an element has (empty when none or not a React element). */
export function handlersOf(el: Element): string[] {
	const p = reactProps(el);
	if (!p) return [];
	return HANDLERS.filter((h) => typeof p[h] === 'function');
}

export function implicitRole(el: Element): string {
	const explicit = el.getAttribute('role');
	if (explicit) return explicit.split(/\s+/)[0]!;
	const tag = el.tagName.toLowerCase();
	if (tag === 'button' || tag === 'summary') return 'button';
	if (tag === 'a' && el.hasAttribute('href')) return 'link';
	if (tag === 'select') return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
	if (tag === 'textarea') return 'textbox';
	if (tag === 'input') {
		const t = ((el as HTMLInputElement).type || 'text').toLowerCase();
		if (t === 'checkbox') return 'checkbox';
		if (t === 'radio') return 'radio';
		if (t === 'range') return 'slider';
		if (t === 'number') return 'spinbutton';
		if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button';
		if (t === 'search') return 'searchbox';
		if (t === 'color') return 'button';
		return 'textbox';
	}
	if ((el as HTMLElement).isContentEditable) return 'textbox';
	return 'generic';
}

/** True for controls a user can operate (native controls, interactive roles, focusable or handler-bearing). */
export function isInteractive(el: Element): boolean {
	const tag = el.tagName.toLowerCase();
	if (tag === 'input') return (el as HTMLInputElement).type !== 'hidden';
	if (['button', 'select', 'textarea', 'summary'].includes(tag)) return true;
	if (tag === 'a' && el.hasAttribute('href')) return true;
	const role = el.getAttribute('role');
	if (role && INTERACTIVE_ROLES.has(role.split(/\s+/)[0]!)) return true;
	if ((el as HTMLElement).isContentEditable && el.getAttribute('contenteditable') !== null) return true;
	const tabindex = el.getAttribute('tabindex');
	if (tabindex !== null && Number(tabindex) >= 0) return true;
	if (el.getAttribute('draggable') === 'true') return true;
	const h = handlersOf(el);
	// onKeyDown alone (no focusability) is a key handler on a container, not a control.
	return h.some((x) => x !== 'onKeyDown');
}

function rectOf(el: Element): UiBounds {
	const r = el.getBoundingClientRect();
	return { x: round(r.left), y: round(r.top), width: round(r.width), height: round(r.height) };
}
const round = (v: number) => Math.round(v * 10) / 10;

/** Drawn and at least 2×2 px inside the window (not display:none, visibility:hidden, aria-hidden or inert). */
export function isVisible(el: Element): boolean {
	const r = el.getBoundingClientRect();
	if (r.width < 2 || r.height < 2) return false;
	if (r.right <= 0 || r.bottom <= 0 || r.left >= window.innerWidth || r.top >= window.innerHeight)
		return false;
	const h = el as HTMLElement & { checkVisibility?(o?: object): boolean };
	if (h.checkVisibility && !h.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true }))
		return false;
	if (el.closest('[aria-hidden="true"],[inert]')) return false;
	// Hidden dock panels stay mounted (Program, Timeline keep-alive): skip what is under a hidden panel body.
	if (el.closest('[data-panel-body][data-visible="false"]')) return false;
	return true;
}

const clean = (s: string | null | undefined, max = 60) => {
	const t = (s ?? '').replace(/\s+/g, ' ').trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** The accessible name: aria-label(ledby), the label of a form control, title, placeholder, alt, or text. */
export function accessibleName(el: Element): string {
	const aria = el.getAttribute('aria-label');
	if (aria?.trim()) return clean(aria);
	const by = el.getAttribute('aria-labelledby');
	if (by) {
		const t = by
			.split(/\s+/)
			.map((id) => document.getElementById(id)?.textContent ?? '')
			.join(' ');
		if (t.trim()) return clean(t);
	}
	const id = el.getAttribute('id');
	if (id && /^(input|select|textarea)$/i.test(el.tagName)) {
		const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
		if (lab?.textContent?.trim()) return clean(lab.textContent);
	}
	const wrap = el.closest('label');
	if (wrap && wrap !== el && wrap.textContent?.trim()) return clean(wrap.textContent);
	const title = el.getAttribute('title');
	if (title?.trim()) return clean(title);
	const ph = el.getAttribute('placeholder');
	if (ph?.trim()) return clean(ph);
	const alt = el.getAttribute('alt');
	if (alt?.trim()) return clean(alt);
	if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return '';
	return clean(el.textContent, 40);
}

function elementValue(el: Element): string | number | undefined {
	if (el instanceof HTMLInputElement) {
		if (el.type === 'checkbox' || el.type === 'radio') return undefined;
		if (el.type === 'range' || el.type === 'number') return el.value === '' ? '' : Number(el.value);
		return el.value;
	}
	if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return el.value;
	const now = el.getAttribute('aria-valuenow');
	if (now !== null && now !== '' && Number.isFinite(Number(now))) return Number(now);
	const text = el.getAttribute('aria-valuetext');
	if (text) return text;
	if ((el as HTMLElement).isContentEditable) return el.textContent ?? '';
	return undefined;
}

function stateOf(el: Element) {
	const out: Pick<UiElement, 'checked' | 'selected' | 'expanded' | 'pressed'> = {};
	if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio'))
		out.checked = el.indeterminate ? 'mixed' : el.checked;
	const ac = el.getAttribute('aria-checked');
	if (ac !== null) out.checked = ac === 'mixed' ? 'mixed' : ac === 'true';
	const as = el.getAttribute('aria-selected') ?? (el.getAttribute('data-selected') !== null ? 'true' : null);
	if (as !== null) out.selected = as === 'true';
	const ae = el.getAttribute('aria-expanded');
	if (ae !== null) out.expanded = ae === 'true';
	const ap = el.getAttribute('aria-pressed');
	if (ap !== null) out.pressed = ap === 'true';
	return out;
}

function isEnabled(el: Element): boolean {
	if ((el as HTMLButtonElement).disabled) return false;
	if (el.closest('[aria-disabled="true"]')) return false;
	if (el.closest('fieldset:disabled')) return false;
	return true;
}

export function panelOf(el: Element): { kind: string | null; instance: string | null } {
	// The dock's panel body / tab carries both attributes; some panels repeat data-panel-kind inside.
	const host = el.closest('[data-panel-instance][data-panel-kind]');
	if (host)
		return { kind: host.getAttribute('data-panel-kind'), instance: host.getAttribute('data-panel-instance') };
	const body = el.closest('[data-panel-kind]');
	return { kind: body?.getAttribute('data-panel-kind') ?? null, instance: null };
}

const slug = (s: string) => s.replace(/[[\]]/g, '');

export type ElementSnapshot = {
	elements: UiElement[];
	/** Element of each id (resolution for input). */
	byId: Map<string, Element>;
};

/**
 * Every visible interactive element and entity target with its automation id. `root` limits the walk
 * (a panel), ids stay window-global either way.
 */
export function snapshotElements(root: ParentNode = document): ElementSnapshot {
	const all = Array.from(document.querySelectorAll('[data-testid]')).filter(isVisible);
	const counts = new Map<string, number>();
	for (const el of all) {
		const t = el.getAttribute('data-testid')!;
		counts.set(t, (counts.get(t) ?? 0) + 1);
	}
	const uniqueTestId = (el: Element) => {
		const t = el.getAttribute('data-testid');
		return t && counts.get(t) === 1 ? t : null;
	};
	const scopeOf = (el: Element): string => {
		for (let p = el.parentElement; p; p = p.parentElement) {
			const entity = entityId(p);
			if (entity) return entity;
			const t = uniqueTestId(p);
			if (t) return t;
			if (p.hasAttribute('data-panel-body')) return `panel.${p.getAttribute('data-panel-kind')}`;
			const role = p.getAttribute('role');
			if (role === 'dialog' || role === 'alertdialog') return 'dialog';
			if (role === 'menu' || role === 'listbox') return role;
		}
		return 'window';
	};
	const candidates: {
		el: Element;
		kind: 'control' | 'target';
		base: string;
		named: boolean;
		entity?: string;
	}[] = [];
	const walk = root.querySelectorAll('*');
	for (const el of Array.from(walk)) {
		const entity = entityId(el);
		const interactive = isInteractive(el);
		if (!interactive && !entity) continue;
		if (!isVisible(el)) continue;
		const t = uniqueTestId(el);
		if (t) {
			candidates.push({ el, kind: interactive ? 'control' : 'target', base: t, named: true });
			continue;
		}
		if (entity) {
			candidates.push({ el, kind: interactive ? 'control' : 'target', base: entity, named: true, entity });
			continue;
		}
		// Dockview's empty tab-strip area (drag the group, double-click to maximize): named after its group's
		// first tab.
		// A floating group's title bar (drag to move it) likewise.
		const dock = el.classList.contains('dv-void-container')
			? 'tabstrip'
			: el.classList.contains('dv-floating-titlebar')
				? 'titlebar'
				: null;
		if (dock) {
			const group = el.closest('.dv-resize-container') ?? el.closest('.dv-groupview');
			const tab = group?.querySelector('[data-testid^="tab-"]')?.getAttribute('data-testid');
			candidates.push({ el, kind: 'control', base: `${tab ?? 'dock'}/${dock}`, named: !!tab });
			continue;
		}
		const name = accessibleName(el);
		const own = el.getAttribute('data-testid') ?? implicitRole(el);
		candidates.push({
			el,
			kind: 'control',
			base: `${scopeOf(el)}/${own}${name ? `[${slug(name)}]` : ''}`,
			named: !!name || !!el.getAttribute('data-testid'),
		});
	}
	// An entity drawn by several elements (a clip's body and its marker line): the largest one stands for it.
	const area = (e: Element) => {
		const r = e.getBoundingClientRect();
		return r.width * r.height;
	};
	const best = new Map<string, Element>();
	for (const c of candidates)
		if (c.entity) {
			const b = best.get(c.base);
			if (!b || area(c.el) > area(b)) best.set(c.base, c.el);
		}
	for (let i = candidates.length - 1; i >= 0; i--) {
		const c = candidates[i]!;
		if (c.entity && best.get(c.base) !== c.el) candidates.splice(i, 1);
	}
	// A focusable wrapper without a name around a control that has a stable id and fills it (dockview's tab
	// around our tab, a list cell around its row): the inner control is the automation element of that area.
	const stableEls = candidates.filter((c) => c.named && !c.entity).map((c) => c.el);
	for (let i = candidates.length - 1; i >= 0; i--) {
		const c = candidates[i]!;
		if (c.named) continue;
		const a = area(c.el);
		const inner = stableEls.find((e) => e !== c.el && c.el.contains(e) && area(e) >= 0.5 * a);
		if (inner) candidates.splice(i, 1);
	}
	const dup = new Map<string, number>();
	for (const c of candidates) dup.set(c.base, (dup.get(c.base) ?? 0) + 1);
	const n = new Map<string, number>();
	const elements: UiElement[] = [];
	const byId = new Map<string, Element>();
	const active = document.activeElement;
	for (const c of candidates) {
		const ambiguous = (dup.get(c.base) ?? 0) > 1;
		let id = c.base;
		if (ambiguous) {
			const i = (n.get(c.base) ?? 0) + 1;
			n.set(c.base, i);
			id = `${c.base}#${i}`;
		}
		const { kind: panel, instance } = panelOf(c.el);
		const v = elementValue(c.el);
		const testId = c.el.getAttribute('data-testid') ?? undefined;
		const el: UiElement = {
			id,
			stable: c.named && !ambiguous,
			role: c.entity ? 'target' : implicitRole(c.el),
			name: accessibleName(c.el),
			panel,
			panelInstance: instance,
			...(testId ? { testId } : {}),
			tag: c.el.tagName.toLowerCase(),
			bounds: rectOf(c.el),
			enabled: isEnabled(c.el),
			focused: c.el === active || c.el.contains(active),
			...(v !== undefined ? { value: v } : {}),
			...stateOf(c.el),
			kind: c.kind,
			...(c.named && !ambiguous ? {} : { className: String(c.el.getAttribute('class') ?? '').slice(0, 120) }),
		};
		elements.push(el);
		byId.set(id, c.el);
	}
	return { elements, byId };
}

/** The element of an automation id (also accepts a bare `data-testid` that is unique). */
export function resolveElement(id: string): Element | null {
	const snap = snapshotElements();
	const hit = snap.byId.get(id);
	if (hit) return hit;
	const byTest = Array.from(document.querySelectorAll(`[data-testid="${CSS.escape(id)}"]`)).filter(isVisible);
	return byTest.length === 1 ? byTest[0]! : null;
}

/** Ids close to an unknown one (for actionable errors). */
export function similarIds(id: string, limit = 8): string[] {
	const want = id.toLowerCase();
	const parts = want.split(/[/.[\]#\s-]+/).filter((p) => p.length > 2);
	const scored = snapshotElements()
		.elements.map((e) => {
			const l = e.id.toLowerCase();
			const score = parts.reduce((s, p) => s + (l.includes(p) ? p.length : 0), 0);
			return { id: e.id, score };
		})
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit).map((x) => x.id);
}
