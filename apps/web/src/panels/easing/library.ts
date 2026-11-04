// Easing panel ▸ the user's curve library and the panel settings: a per-user preference (localStorage, never in
// the project), validated with zod on load and on import, with a schema version. A damaged entry is dropped on its
// own (its neighbours stay) and the panel reports how many were skipped. Built-in presets are read-only: Duplicate
// copies one into a user group. Export/import uses a small JSON file (`jasper-ease-presets`, version 1), capped in
// size and entry count, every preset validated with `EasePresetSchema`.
import {
	type EaseCurve,
	EaseCurveSchema,
	type EasePreset,
	EasePresetSchema,
	EaseSectionSchema,
	LABEL_COLORS,
	type LabelColor,
} from '@jasper/project';
import { useSyncExternalStore } from 'react';
import { z } from 'zod';
import { t } from '../../i18n/runtime.ts';
import { curvesEqual } from './curve-edit.ts';

export const EASE_LIBRARY_VERSION = 1;
const STORAGE_KEY = 'jasper.easing.v1';
export const MAX_USER_PRESETS = 1000;
export const MAX_USER_GROUPS = 100;
export const MAX_IMPORT_BYTES = 1_000_000;
const MAX_RECENT = 8;
const MAX_FAVOURITES = 200;
/** The user group that always exists (presets of a deleted group move here). */
export const DEFAULT_GROUP_ID = 'user';

const NameSchema = z.string().trim().min(1).max(200);

export const UserGroupSchema = z.strictObject({ id: z.string().min(1).max(200), name: NameSchema });
export type UserGroup = z.infer<typeof UserGroupSchema>;

export const UserPresetSchema = EasePresetSchema.extend({
	/** Colour label (the label palette of the design tokens). */
	color: z.enum(LABEL_COLORS).nullable().optional(),
});
export type UserPreset = EasePreset & { color?: LabelColor | null };

export const VIEWS = ['curve', 'library', 'both'] as const;
export type EasingView = (typeof VIEWS)[number];

const SettingsSchema = z.strictObject({
	view: z.enum(VIEWS),
	/** Library thumbnail size (px). */
	thumb: z.number().int().min(40).max(160),
	/** Library columns: fitted to the width, or fixed. */
	columns: z.union([z.literal('auto'), z.number().int().min(1).max(12)]),
	/** Explicit In | Middle | Out choice; empty = automatic. */
	sections: z.array(EaseSectionSchema).max(3),
	autoApply: z.boolean(),
	/** Active library tab (group id). */
	group: z.string().max(200),
	/** The curve last edited or chosen. */
	curve: EaseCurveSchema.nullable(),
});
export type EasingSettings = z.infer<typeof SettingsSchema>;

export type EaseLibraryState = {
	version: typeof EASE_LIBRARY_VERSION;
	groups: UserGroup[];
	presets: UserPreset[];
	favourites: string[];
	recent: EaseCurve[];
	settings: EasingSettings;
};

export const DEFAULT_SETTINGS: EasingSettings = {
	view: 'both',
	thumb: 64,
	columns: 'auto',
	sections: [],
	autoApply: false,
	group: DEFAULT_GROUP_ID,
	curve: null,
};

export function emptyLibrary(): EaseLibraryState {
	return {
		version: EASE_LIBRARY_VERSION,
		groups: [{ id: DEFAULT_GROUP_ID, name: 'My Curves' }],
		presets: [],
		favourites: [],
		recent: [],
		settings: { ...DEFAULT_SETTINGS, sections: [] },
	};
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, 10_000) : []);

/**
 * Tolerant load of a stored value of any shape: each group, preset, favourite, recent curve and setting is
 * validated on its own; `dropped` counts what had to be left out. A newer version is not read (defaults instead,
 * and the stored value is left untouched until the user changes something).
 */
export function parseLibrary(raw: unknown): { state: EaseLibraryState; dropped: number; newer: boolean } {
	const state = emptyLibrary();
	if (!raw || typeof raw !== 'object') return { state, dropped: 0, newer: false };
	const o = raw as Record<string, unknown>;
	if (typeof o.version === 'number' && o.version > EASE_LIBRARY_VERSION)
		return { state, dropped: 0, newer: true };
	let dropped = 0;
	const groups = new Map<string, UserGroup>(state.groups.map((g) => [g.id, g]));
	for (const g of arr(o.groups)) {
		const r = UserGroupSchema.safeParse(g);
		if (r.success && groups.size < MAX_USER_GROUPS) groups.set(r.data.id, r.data);
		else dropped++;
	}
	state.groups = [...groups.values()];
	const ids = new Set<string>();
	for (const p of arr(o.presets)) {
		const r = UserPresetSchema.safeParse(p);
		if (!r.success || ids.has(r.data.id) || state.presets.length >= MAX_USER_PRESETS) {
			dropped++;
			continue;
		}
		ids.add(r.data.id);
		state.presets.push({ ...r.data, group: groups.has(r.data.group) ? r.data.group : DEFAULT_GROUP_ID });
	}
	for (const f of arr(o.favourites)) {
		if (typeof f === 'string' && f.length <= 200 && state.favourites.length < MAX_FAVOURITES)
			state.favourites.push(f);
		else dropped++;
	}
	for (const c of arr(o.recent)) {
		const r = EaseCurveSchema.safeParse(c);
		if (r.success && state.recent.length < MAX_RECENT) state.recent.push(r.data);
		else dropped++;
	}
	const s = (o.settings && typeof o.settings === 'object' ? o.settings : {}) as Record<string, unknown>;
	const shape = SettingsSchema.shape;
	const settings = { ...state.settings } as Record<string, unknown>;
	for (const key of Object.keys(shape) as (keyof EasingSettings)[]) {
		if (!(key in s)) continue;
		const r = shape[key].safeParse(s[key]);
		if (r.success) settings[key] = r.data;
		else dropped++;
	}
	state.settings = settings as EasingSettings;
	state.settings.sections = [...new Set(state.settings.sections)];
	return { state, dropped, newer: false };
}

let counter = 0;
/** A new user preset / group id (unique within this library). */
export function newLibraryId(prefix: 'ease' | 'group', taken: ReadonlySet<string>): string {
	for (;;) {
		const id = `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
		if (!taken.has(id)) return id;
	}
}

const takenIds = (s: EaseLibraryState) =>
	new Set([...s.presets.map((p) => p.id), ...s.groups.map((g) => g.id)]);

export type LibraryResult = { ok: true; state: EaseLibraryState; id?: string } | { ok: false; error: string };

const fail = (error: string): LibraryResult => ({ ok: false, error });

export function savePreset(
	s: EaseLibraryState,
	input: { name: string; curve: EaseCurve; group?: string },
): LibraryResult {
	if (s.presets.length >= MAX_USER_PRESETS)
		return fail(t('The library is full ({0} curves)', MAX_USER_PRESETS));
	const group = s.groups.some((g) => g.id === input.group) ? input.group! : DEFAULT_GROUP_ID;
	const id = newLibraryId('ease', takenIds(s));
	const r = UserPresetSchema.safeParse({ id, name: input.name, group, curve: input.curve });
	if (!r.success) return fail(t('This curve cannot be saved: {0}', r.error.issues[0]?.message ?? ''));
	return { ok: true, id, state: { ...s, presets: [...s.presets, r.data] } };
}

const updatePreset = (
	s: EaseLibraryState,
	id: string,
	patch: (p: UserPreset) => UserPreset | string,
): LibraryResult => {
	const i = s.presets.findIndex((p) => p.id === id);
	if (i < 0) return fail(t('That curve is not in your library'));
	const next = patch(s.presets[i]!);
	if (typeof next === 'string') return fail(next);
	const presets = s.presets.slice();
	presets[i] = next;
	return { ok: true, id, state: { ...s, presets } };
};

export function renamePreset(s: EaseLibraryState, id: string, name: string): LibraryResult {
	const r = NameSchema.safeParse(name);
	if (!r.success) return fail(t('Enter a name (1–200 characters)'));
	return updatePreset(s, id, (p) => ({ ...p, name: r.data }));
}

export function setPresetColor(s: EaseLibraryState, id: string, color: LabelColor | null): LibraryResult {
	return updatePreset(s, id, (p) => ({ ...p, color }));
}

export function movePresetToGroup(s: EaseLibraryState, id: string, group: string): LibraryResult {
	if (!s.groups.some((g) => g.id === group)) return fail(t('That group does not exist'));
	return updatePreset(s, id, (p) => ({ ...p, group }));
}

export function deletePreset(s: EaseLibraryState, id: string): LibraryResult {
	if (!s.presets.some((p) => p.id === id)) return fail(t('That curve is not in your library'));
	return {
		ok: true,
		state: {
			...s,
			presets: s.presets.filter((p) => p.id !== id),
			favourites: s.favourites.filter((f) => f !== id),
		},
	};
}

/** Moves a preset to position `to` among the presets of its group (clamped), keeping the other groups' order. */
export function reorderPreset(s: EaseLibraryState, id: string, to: number): LibraryResult {
	const p = s.presets.find((x) => x.id === id);
	if (!p) return fail(t('That curve is not in your library'));
	const same = s.presets.filter((x) => x.group === p.group);
	const from = same.indexOf(p);
	const target = Math.max(0, Math.min(same.length - 1, Number.isFinite(to) ? Math.round(to) : from));
	if (target === from) return { ok: true, id, state: s };
	const order = same.filter((x) => x !== p);
	order.splice(target, 0, p);
	let k = 0;
	const presets = s.presets.map((x) => (x.group === p.group ? order[k++]! : x));
	return { ok: true, id, state: { ...s, presets } };
}

export function addGroup(s: EaseLibraryState, name: string): LibraryResult {
	const r = NameSchema.safeParse(name);
	if (!r.success) return fail(t('Enter a name (1–200 characters)'));
	if (s.groups.length >= MAX_USER_GROUPS)
		return fail(t('You have the most groups allowed ({0})', MAX_USER_GROUPS));
	const id = newLibraryId('group', takenIds(s));
	return { ok: true, id, state: { ...s, groups: [...s.groups, { id, name: r.data }] } };
}

export function renameGroup(s: EaseLibraryState, id: string, name: string): LibraryResult {
	const r = NameSchema.safeParse(name);
	if (!r.success) return fail(t('Enter a name (1–200 characters)'));
	if (!s.groups.some((g) => g.id === id)) return fail(t('That group does not exist'));
	return {
		ok: true,
		id,
		state: { ...s, groups: s.groups.map((g) => (g.id === id ? { ...g, name: r.data } : g)) },
	};
}

/** Deletes a user group; its curves move to the default group (never lost). */
export function deleteGroup(s: EaseLibraryState, id: string): LibraryResult {
	if (id === DEFAULT_GROUP_ID) return fail(t('The default group cannot be deleted'));
	if (!s.groups.some((g) => g.id === id)) return fail(t('That group does not exist'));
	return {
		ok: true,
		state: {
			...s,
			groups: s.groups.filter((g) => g.id !== id),
			presets: s.presets.map((p) => (p.group === id ? { ...p, group: DEFAULT_GROUP_ID } : p)),
			settings: s.settings.group === id ? { ...s.settings, group: DEFAULT_GROUP_ID } : s.settings,
		},
	};
}

export function toggleFavourite(s: EaseLibraryState, presetId: string): EaseLibraryState {
	const has = s.favourites.includes(presetId);
	if (!has && s.favourites.length >= MAX_FAVOURITES) return s;
	return { ...s, favourites: has ? s.favourites.filter((f) => f !== presetId) : [...s.favourites, presetId] };
}

/** Remembers an applied curve (newest first, no duplicates). */
export function pushRecent(s: EaseLibraryState, curve: EaseCurve): EaseLibraryState {
	const r = EaseCurveSchema.safeParse(curve);
	if (!r.success) return s;
	return {
		...s,
		recent: [r.data, ...s.recent.filter((c) => !curvesEqual(c, r.data, 1e-6))].slice(0, MAX_RECENT),
	};
}

/** A built-in preset copied into a user group, so it can be edited. */
export function duplicatePreset(s: EaseLibraryState, preset: EasePreset, group?: string): LibraryResult {
	return savePreset(s, { name: t('{0} copy', preset.name), curve: preset.curve, group });
}

export const EXPORT_FORMAT = 'jasper-ease-presets';

/** The JSON of an export: the given presets (default all) and the groups they use. */
export function exportLibrary(s: EaseLibraryState, presetIds?: readonly string[]): string {
	const want = presetIds ? new Set(presetIds) : null;
	const presets = s.presets.filter((p) => !want || want.has(p.id));
	const used = new Set(presets.map((p) => p.group));
	return `${JSON.stringify(
		{
			format: EXPORT_FORMAT,
			version: EASE_LIBRARY_VERSION,
			groups: s.groups.filter((g) => used.has(g.id)),
			presets: presets.map(({ id, name, group, curve, color }) => ({
				id,
				name,
				group,
				curve,
				...(color ? { color } : {}),
			})),
		},
		null,
		2,
	)}\n`;
}

export type ImportReport = { added: number; skipped: number; errors: string[] };

const MAX_REPORTED = 5;

/**
 * Adds the presets of an export file. Never throws: an unreadable file is an error; each invalid preset is skipped
 * with a reason; ids that clash get new ones; groups are matched by id, else created; the library limits hold.
 */
export function importLibrary(
	s: EaseLibraryState,
	text: string,
): { state: EaseLibraryState; report: ImportReport } {
	const report: ImportReport = { added: 0, skipped: 0, errors: [] };
	const err = (m: string) => {
		if (report.errors.length < MAX_REPORTED) report.errors.push(m);
	};
	if (typeof text !== 'string' || text.length > MAX_IMPORT_BYTES) {
		err(t('The file is larger than {0} KB', Math.round(MAX_IMPORT_BYTES / 1000)));
		return { state: s, report };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		err(t('The file is not valid JSON'));
		return { state: s, report };
	}
	const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null) as Record<
		string,
		unknown
	> | null;
	if (!o || o.format !== EXPORT_FORMAT) {
		err(t('This is not an ease preset file'));
		return { state: s, report };
	}
	if (typeof o.version !== 'number' || o.version > EASE_LIBRARY_VERSION) {
		err(t('The file comes from a newer version of JasperEditor'));
		return { state: s, report };
	}
	let next: EaseLibraryState = { ...s, groups: s.groups.slice(), presets: s.presets.slice() };
	const groupMap = new Map<string, string>();
	for (const g of arr(o.groups)) {
		const r = UserGroupSchema.safeParse(g);
		if (!r.success) continue;
		const same = next.groups.find((x) => x.id === r.data.id || x.name === r.data.name);
		if (same) groupMap.set(r.data.id, same.id);
		else if (next.groups.length < MAX_USER_GROUPS) {
			const id = takenIds(next).has(r.data.id) ? newLibraryId('group', takenIds(next)) : r.data.id;
			next.groups.push({ id, name: r.data.name });
			groupMap.set(r.data.id, id);
		}
	}
	const list = Array.isArray(o.presets) ? o.presets : [];
	if (!Array.isArray(o.presets)) err(t('The file has no presets list'));
	list.forEach((p, i) => {
		const r = UserPresetSchema.safeParse(p);
		if (!r.success) {
			report.skipped++;
			const issue = r.error.issues[0];
			err(t('Preset {0}: {1}', i + 1, `${issue?.path.join('.') || 'value'} — ${issue?.message ?? ''}`));
			return;
		}
		if (next.presets.length >= MAX_USER_PRESETS) {
			report.skipped++;
			err(t('The library is full ({0} curves)', MAX_USER_PRESETS));
			return;
		}
		const group = groupMap.get(r.data.group) ?? DEFAULT_GROUP_ID;
		const taken = takenIds(next);
		const id = taken.has(r.data.id) ? newLibraryId('ease', taken) : r.data.id;
		next = { ...next, presets: [...next.presets, { ...r.data, id, group }] };
		report.added++;
	});
	return { state: next, report };
}

// ── persistence ─────────────────────────────────────────────────────────────────────────────────────────────────

function load(): { state: EaseLibraryState; dropped: number; newer: boolean } {
	try {
		const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
		return parseLibrary(raw ? JSON.parse(raw) : null);
	} catch {
		return { state: emptyLibrary(), dropped: 1, newer: false };
	}
}

const loaded = load();
let state = loaded.state;
const listeners = new Set<() => void>();
let saveError: string | null = null;

function persist(): void {
	// A library written by a newer build is never overwritten by this one.
	if (loaded.newer) return;
	try {
		globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
		saveError = null;
	} catch {
		saveError = t('Your curve library could not be saved in this browser (storage is full or unavailable)');
	}
}

export const easeLibrary = {
	get: (): EaseLibraryState => state,
	/** What the load left out (damaged entries) and whether a newer build's library was found. */
	loadReport: () => ({ dropped: loaded.dropped, newer: loaded.newer, saveError }),
	set(next: EaseLibraryState): void {
		if (next === state) return;
		state = next;
		persist();
		for (const l of [...listeners]) l();
	},
	update(fn: (s: EaseLibraryState) => EaseLibraryState): void {
		easeLibrary.set(fn(state));
	},
	/** Applies a library operation; returns its error, if any. */
	run(op: (s: EaseLibraryState) => LibraryResult): string | null {
		const r = op(state);
		if (!r.ok) return r.error;
		easeLibrary.set(r.state);
		return null;
	},
	settings(patch: Partial<EasingSettings>): void {
		easeLibrary.set({ ...state, settings: { ...state.settings, ...patch } });
	},
	subscribe(l: () => void): () => void {
		listeners.add(l);
		return () => listeners.delete(l);
	},
};

export function useEaseLibrary(): EaseLibraryState {
	return useSyncExternalStore(easeLibrary.subscribe, easeLibrary.get, easeLibrary.get);
}
