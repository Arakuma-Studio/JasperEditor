// monitor view options beyond monitor-store (Premiere's Program monitor wrench/View menu): rulers, guides
// and guide templates, the comparison view, the dropped-frame indicator and the button editor's transport layout.
// UI state only: never in the document, never undoable; persisted in localStorage (tolerant parse) like
// monitor-store. Guides are kept per sequence (Premiere keeps guides with the sequence); templates are global.
// FilmCraft docs/monitors.md / ui-egui monitor_view.rs (MIT OR Apache-2.0, Copyright (c) 2026 ArtCraft Team and the
// FilmCraft contributors) informed the guide behaviour (frame pixels, drag from rulers, drop outside to delete).
import { createStore } from 'zustand/vanilla';

export type Guide = {
	id: string;
	orientation: 'horizontal' | 'vertical' /** Frame pixels. */;
	position: number;
};
export type GuideTemplate = { name: string; guides: Omit<Guide, 'id'>[]; builtIn?: boolean };

export type ComparisonMode = 'side-by-side' | 'vertical' | 'horizontal';
/** Where the reference frame comes from: a frame of a sequence (this one at another time, or another sequence). */
export type ComparisonReference = { kind: 'sequence-frame'; sequenceId: string; frame: number };

export type MonitorExtrasState = {
	showRulers: boolean;
	showGuides: boolean;
	lockGuides: boolean;
	/** Guides per sequence id. */
	guides: Record<string, Guide[]>;
	templates: GuideTemplate[];
	comparison: {
		enabled: boolean;
		mode: ComparisonMode;
		/** Split position 0..1 (vertical / horizontal split). */
		split: number;
		/** Reference on the right / bottom instead of the left / top. */
		swapped: boolean;
		reference: ComparisonReference | null;
	};
	showDroppedFrames: boolean;
	/** Transport button ids per monitor (Button Editor); null = the default layout. */
	buttons: { program: string[] | null; source: string[] | null };
};

const KEY = 'jasper.monitor.extras.v1';

/** Built-in guide templates (positions as fractions of the frame, resolved per sequence size). */
export const BUILT_IN_TEMPLATES: {
	name: string;
	guides: { orientation: Guide['orientation']; fraction: number }[];
}[] = [
	{
		name: 'Center Cross',
		guides: [
			{ orientation: 'vertical', fraction: 0.5 },
			{ orientation: 'horizontal', fraction: 0.5 },
		],
	},
	{
		name: 'Rule of Thirds',
		guides: [
			{ orientation: 'vertical', fraction: 1 / 3 },
			{ orientation: 'vertical', fraction: 2 / 3 },
			{ orientation: 'horizontal', fraction: 1 / 3 },
			{ orientation: 'horizontal', fraction: 2 / 3 },
		],
	},
];

const DEFAULTS: MonitorExtrasState = {
	showRulers: false,
	showGuides: true,
	lockGuides: false,
	guides: {},
	templates: [],
	comparison: { enabled: false, mode: 'side-by-side', split: 0.5, swapped: false, reference: null },
	showDroppedFrames: false,
	buttons: { program: null, source: null },
};

const num = (v: unknown, lo: number, hi: number, d: number) =>
	typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;

function parseGuide(g: unknown): Guide | null {
	const o = g as Record<string, unknown> | null;
	if (!o || (o.orientation !== 'horizontal' && o.orientation !== 'vertical')) return null;
	const position = num(o.position, -100000, 100000, Number.NaN);
	if (!Number.isFinite(position)) return null;
	return {
		id: typeof o.id === 'string' ? o.id.slice(0, 40) : newGuideId(),
		orientation: o.orientation,
		position,
	};
}

export function parseMonitorExtras(raw: unknown): MonitorExtrasState {
	const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const guides: Record<string, Guide[]> = {};
	for (const [seq, list] of Object.entries((o.guides as Record<string, unknown>) ?? {}).slice(0, 500))
		if (Array.isArray(list))
			guides[seq] = list
				.map(parseGuide)
				.filter((g): g is Guide => !!g)
				.slice(0, 200);
	const templates: GuideTemplate[] = Array.isArray(o.templates)
		? (o.templates as unknown[])
				.map((t) => {
					const x = t as { name?: unknown; guides?: unknown } | null;
					if (!x || typeof x.name !== 'string' || !Array.isArray(x.guides)) return null;
					return {
						name: x.name.slice(0, 60),
						guides: (x.guides as unknown[])
							.map(parseGuide)
							.filter((g): g is Guide => !!g)
							.map(({ orientation, position }) => ({ orientation, position })),
					};
				})
				.filter((t): t is GuideTemplate => !!t)
				.slice(0, 100)
		: [];
	const c = (o.comparison ?? {}) as Record<string, unknown>;
	const ref = c.reference as Record<string, unknown> | null | undefined;
	const reference: ComparisonReference | null =
		ref && ref.kind === 'sequence-frame' && typeof ref.sequenceId === 'string'
			? {
					kind: 'sequence-frame',
					sequenceId: ref.sequenceId,
					frame: Math.max(0, Math.round(num(ref.frame, 0, 1e9, 0))),
				}
			: null;
	const modes: ComparisonMode[] = ['side-by-side', 'vertical', 'horizontal'];
	const b = (o.buttons ?? {}) as Record<string, unknown>;
	const ids = (v: unknown) =>
		Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 40) : null;
	return {
		showRulers: o.showRulers === true,
		showGuides: o.showGuides !== false,
		lockGuides: o.lockGuides === true,
		guides,
		templates,
		comparison: {
			enabled: c.enabled === true,
			mode: modes.includes(c.mode as ComparisonMode) ? (c.mode as ComparisonMode) : 'side-by-side',
			split: num(c.split, 0.05, 0.95, 0.5),
			swapped: c.swapped === true,
			reference,
		},
		showDroppedFrames: o.showDroppedFrames === true,
		buttons: { program: ids(b.program), source: ids(b.source) },
	};
}

function load(): MonitorExtrasState {
	try {
		const raw = globalThis.localStorage?.getItem(KEY);
		return raw ? parseMonitorExtras(JSON.parse(raw)) : structuredClone(DEFAULTS);
	} catch {
		return structuredClone(DEFAULTS);
	}
}

export const monitorExtras = createStore<MonitorExtrasState>(() => load());
monitorExtras.subscribe((s) => {
	try {
		globalThis.localStorage?.setItem(KEY, JSON.stringify(s));
	} catch {
		// storage full or unavailable: view state is best-effort
	}
});

let guideCounter = 0;
export function newGuideId(): string {
	guideCounter++;
	return `g${Date.now().toString(36)}${guideCounter.toString(36)}`;
}

export function guidesOf(sequenceId: string | null): Guide[] {
	return sequenceId ? (monitorExtras.getState().guides[sequenceId] ?? []) : [];
}

function setGuides(sequenceId: string, guides: Guide[]): void {
	monitorExtras.setState((s) => ({ guides: { ...s.guides, [sequenceId]: guides } }));
}

export function addGuide(sequenceId: string, g: Omit<Guide, 'id'>): Guide {
	const guide = { ...g, id: newGuideId(), position: Math.round(g.position * 100) / 100 };
	setGuides(sequenceId, [...guidesOf(sequenceId), guide]);
	return guide;
}

export function moveGuide(sequenceId: string, id: string, position: number): void {
	setGuides(
		sequenceId,
		guidesOf(sequenceId).map((g) => (g.id === id ? { ...g, position: Math.round(position * 100) / 100 } : g)),
	);
}

export function removeGuide(sequenceId: string, id: string): void {
	setGuides(
		sequenceId,
		guidesOf(sequenceId).filter((g) => g.id !== id),
	);
}

export function clearGuides(sequenceId: string): void {
	setGuides(sequenceId, []);
}

/** Every template: the built-ins (resolved for a W×H frame) then the user's. */
export function allTemplates(width: number, height: number): GuideTemplate[] {
	return [
		...BUILT_IN_TEMPLATES.map((t) => ({
			name: t.name,
			builtIn: true,
			guides: t.guides.map((g) => ({
				orientation: g.orientation,
				position: Math.round((g.orientation === 'vertical' ? width : height) * g.fraction * 100) / 100,
			})),
		})),
		...monitorExtras.getState().templates,
	];
}

/** Save Guides as Template… (replaces a user template of the same name). */
export function saveGuidesAsTemplate(sequenceId: string, name: string): string | null {
	const n = name.trim();
	if (!n) return 'Enter a template name';
	if (BUILT_IN_TEMPLATES.some((t) => t.name === n)) return 'That name belongs to a built-in template';
	const guides = guidesOf(sequenceId).map(({ orientation, position }) => ({ orientation, position }));
	if (!guides.length) return 'There are no guides to save';
	monitorExtras.setState((s) => ({
		templates: [...s.templates.filter((t) => t.name !== n), { name: n, guides }],
	}));
	return null;
}

export function deleteGuideTemplate(name: string): void {
	monitorExtras.setState((s) => ({ templates: s.templates.filter((t) => t.name !== name) }));
}

/** Applies a template: its guides replace the sequence's guides (Premiere "Apply"). */
export function applyGuideTemplate(sequenceId: string, name: string, width: number, height: number): boolean {
	const t = allTemplates(width, height).find((x) => x.name === name);
	if (!t) return false;
	setGuides(
		sequenceId,
		t.guides.map((g) => ({ ...g, id: newGuideId() })),
	);
	monitorExtras.setState({ showGuides: true });
	return true;
}

export function setComparison(patch: Partial<MonitorExtrasState['comparison']>): void {
	monitorExtras.setState((s) => ({ comparison: { ...s.comparison, ...patch } }));
}
