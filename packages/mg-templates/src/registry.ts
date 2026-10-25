import {
	MG_PRESET_ID,
	type MgTemplateInfo,
	type MgTemplateMotionTiming,
	type MgTemplatePreset,
	type MgTemplateRegistry,
	type MgTemplateUi,
	type MgTemplateUpgrade,
	TEMPLATE_MEDIA_KIND,
	TEMPLATE_PARAM_KIND_KEY,
} from '@jasper/project';
import { z } from 'zod';
import { svgTemplateSpeed } from './motion.ts';
import { animeTemplateSpeed, hasAnimeMotionModel } from './templates/anime/motion.ts';
import { type AnyMgTemplate, isAnimeTemplate } from './types.ts';

export type MgRegistry = MgTemplateRegistry & {
	upgrade(
		id: string,
		fromVersion: number,
		params: Record<string, unknown>,
		toVersion?: number,
	): MgTemplateUpgrade | null;
	definitions(): AnyMgTemplate[];
	getDefinition(id: string, version: number): AnyMgTemplate | undefined;
	/** Catalog entries with JSON Schemas (shape of `GET /api/motion-graphics/templates`). */
	catalogJson(): MgCatalogEntryJson[];
};

export type MgCatalogEntryJson = {
	id: string;
	version: number;
	name: string;
	category: string;
	paramsSchema: z.core.JSONSchema.BaseSchema;
	defaults: Record<string, unknown>;
	introFrames: number;
	outroFrames: number;
	defaultDurationSeconds: number;
	description?: string;
	canvases: string[];
	/** Absent means fframes, matching the native renderer catalog. */
	renderer?: 'anime';
	/** Named param presets (absent when the template has none). */
	presets?: MgTemplatePreset[];
	/** UI hints of the params (absent when the template has none). */
	ui?: MgTemplateUiJson;
};

/** `MgTemplateUi` as plain JSON (mutable arrays, the shape of `@jasper/api` `MgTemplateUiSchema`). */
export type MgTemplateUiJson = {
	groups?: { id: string; label: string; params: string[] }[];
	params?: Record<
		string,
		{
			label?: string;
			description?: string;
			multiline?: boolean;
			visibleWhen?: { param: string; in: unknown[] };
			control?: string;
			options?: Record<string, string>;
		}
	>;
	addAnother?: { reroll: string[] };
	import?: {
		aliases?: Record<string, string | { byParam: string; map: Record<string, string>; otherwise: string }>;
		ignored?: Record<string, string>;
		trimPrefix?: Record<string, string>;
	};
};

const key = (id: string, version: number) => `${id}@${version}`;

/** True when the template's params schema declares a media param (`x-jasper-kind: "media"`) anywhere. */
function hasMediaParams(d: AnyMgTemplate): boolean {
	let json: unknown;
	try {
		json = z.toJSONSchema(d.paramsSchema, { unrepresentable: 'any', io: 'input' });
	} catch {
		return false;
	}
	const walk = (v: unknown, depth: number): boolean =>
		!!v &&
		typeof v === 'object' &&
		depth < 32 &&
		((v as Record<string, unknown>)[TEMPLATE_PARAM_KIND_KEY] === TEMPLATE_MEDIA_KIND ||
			Object.values(v as Record<string, unknown>).some((x) => walk(x, depth + 1)));
	return walk(json, 0);
}

/** Measured picture speeds kept per registry (sound design derives and resolves anchors repeatedly). */
const MOTION_CACHE_SIZE = 32;

/** A small least-recently-used cache of `motionSpeed` results (Map iteration order = insertion order). */
function motionCache() {
	const entries = new Map<string, number[] | null>();
	return (k: string | null, compute: () => number[] | null): number[] | null => {
		if (k === null) return compute();
		if (entries.has(k)) {
			const hit = entries.get(k)!;
			entries.delete(k);
			entries.set(k, hit);
			return hit;
		}
		const value = compute();
		entries.set(k, value);
		if (entries.size > MOTION_CACHE_SIZE) entries.delete(entries.keys().next().value!);
		return value;
	};
}

type MotionCache = ReturnType<typeof motionCache>;

function toTemplateInfo(def: AnyMgTemplate, cache: MotionCache): MgTemplateInfo {
	return {
		id: def.id,
		version: def.version,
		name: def.name,
		category: def.category,
		paramsSchema: def.paramsSchema,
		defaults: def.defaults,
		introFrames: def.introFrames,
		outroFrames: def.outroFrames,
		canvasDefault: 'sequence',
		canvases: def.canvases,
		...(isAnimeTemplate(def) ? { renderer: 'anime' as const } : {}),
		...(def.description ? { description: def.description } : {}),
		...(def.presets?.length ? { presets: def.presets } : {}),
		...(def.ui ? { ui: def.ui } : {}),
		defaultDurationSeconds: def.defaultDurationSeconds,
		...(def.fill ? { fill: def.fill.bind(def) } : {}),
		// fframes templates: measured on their SVG twins. Anime templates are drawn by @jasper/motion (anime.js),
		// which this layer may not import (ARCHITECTURE §3.1): they are measured on their motion model (the phases
		// and eases the implementations share with it, `anime/motion.ts`); a template without a model falls back to
		// the declared intro / outro.
		...(isAnimeTemplate(def) && !hasAnimeMotionModel(def)
			? {}
			: {
					motionSpeed: (params: Record<string, unknown>, timing: MgTemplateMotionTiming) => {
						let k: string | null = null;
						try {
							k = `${key(def.id, def.version)}|${timing.fps}|${timing.totalFrames}|${JSON.stringify(params)}`;
						} catch {
							k = null; // unserialisable params: measured, not cached
						}
						const measure = () =>
							isAnimeTemplate(def)
								? animeTemplateSpeed(def, params, timing)
								: svgTemplateSpeed(def, params, timing);
						return cache(k, measure)?.slice() ?? null;
					},
				}),
	};
}

/**
 * Template version upgrade (S11:ATP-009). Definitions carry `upgrades: [{fromVersion, migrate}]` (params
 * of `id@fromVersion` → params of that definition's version). The steps form a graph over the installed versions
 * (edges only go up); a depth-first search tries the larger jumps first and backtracks: a step whose migration
 * throws or yields params the target's schema rejects (defaults filled in) is skipped, and the other steps from
 * that version are tried. Without `toVersion` the result is the highest version reachable; with it, the first
 * path that reaches exactly `toVersion`. Null when no version above `fromVersion` is reachable (or `toVersion`
 * is not).
 */
export function upgradeParams(
	defs: readonly AnyMgTemplate[],
	id: string,
	fromVersion: number,
	params: Record<string, unknown>,
	toVersion?: number,
): MgTemplateUpgrade | null {
	type Step = { def: AnyMgTemplate; migrate: (p: Record<string, unknown>) => Record<string, unknown> };
	/** Steps out of `version`, largest jump first (never above `toVersion`). */
	const stepsFrom = (version: number): Step[] => {
		const out: Step[] = [];
		for (const d of defs) {
			if (d.id !== id || d.version <= version) continue;
			if (toVersion !== undefined && d.version > toVersion) continue;
			const step = d.upgrades?.find((u) => u.fromVersion === version);
			if (step) out.push({ def: d, migrate: step.migrate });
		}
		return out.sort((a, b) => b.def.version - a.def.version);
	};
	const top = defs.reduce((m, d) => (d.id === id ? Math.max(m, d.version) : m), fromVersion);
	const goal = toVersion ?? top;
	/** The best upgrade reachable from (`version`, `current`), itself included (versions strictly increase: finite). */
	const search = (version: number, current: Record<string, unknown>): MgTemplateUpgrade | null => {
		const here = toVersion === undefined || version === toVersion ? { version, params: current } : null;
		if (version === goal) return here;
		let best = here;
		for (const step of stepsFrom(version)) {
			let migrated: ReturnType<typeof step.migrate>;
			try {
				migrated = step.migrate({ ...current });
			} catch {
				continue;
			}
			const parsed = step.def.paramsSchema.safeParse(migrated);
			if (!parsed.success) continue;
			const found = search(step.def.version, parsed.data);
			if (found && (!best || found.version > best.version)) best = found;
			if (best && best.version === goal) break;
		}
		return best;
	};
	const result = search(fromVersion, params);
	return result && result.version !== fromVersion ? result : null;
}

export function createMgRegistry(defs: readonly AnyMgTemplate[]): MgRegistry {
	const map = new Map<string, AnyMgTemplate>();
	for (const d of defs) {
		const k = key(d.id, d.version);
		if (map.has(k)) throw new Error(`Duplicate motion-graphic template ${k}`);
		const check = d.paramsSchema.safeParse(d.defaults);
		if (!check.success) throw new Error(`Defaults of ${k} do not match its params schema`);
		const names = paramNames(d);
		checkPresets(d, k, names);
		checkUi(d, k, names);
		// Media params (`mediaParam()`) are drawn by anime templates only: the native fframes renderer has no images.
		if (!isAnimeTemplate(d) && hasMediaParams(d))
			throw new Error(`${k} has media params, which only anime templates can draw`);
		map.set(k, d);
	}
	const cache = motionCache();
	return {
		get: (id, version) => {
			const d = map.get(key(id, version));
			return d ? toTemplateInfo(d, cache) : undefined;
		},
		list: () => [...map.values()].map((d) => toTemplateInfo(d, cache)),
		upgrade: (id, fromVersion, params, toVersion) =>
			upgradeParams([...map.values()], id, fromVersion, params, toVersion),
		definitions: () => [...map.values()],
		getDefinition: (id, version) => map.get(key(id, version)),
		catalogJson: () =>
			[...map.values()].map((d) => ({
				id: d.id,
				version: d.version,
				name: d.name,
				category: d.category,
				paramsSchema: z.toJSONSchema(d.paramsSchema, { unrepresentable: 'any', io: 'input' }),
				defaults: d.defaults,
				introFrames: d.introFrames,
				outroFrames: d.outroFrames,
				defaultDurationSeconds: d.defaultDurationSeconds,
				...(d.description ? { description: d.description } : {}),
				canvases: d.canvases.map((c) => `${c.width}x${c.height}`),
				...(isAnimeTemplate(d) ? { renderer: 'anime' as const } : {}),
				...(d.presets?.length ? { presets: d.presets.map(presetJson) } : {}),
				...(d.ui ? { ui: uiJson(d.ui) } : {}),
			})),
	};
}

/** The params of a preset applied to the template defaults (undefined when the template has no such preset). */
export function templatePresetParams(
	def: Pick<AnyMgTemplate, 'defaults' | 'presets'>,
	presetId: string,
): Record<string, unknown> | undefined {
	const preset = def.presets?.find((p) => p.id === presetId);
	return preset ? { ...def.defaults, ...preset.params } : undefined;
}

/** Param names of a template (the top-level properties of its params JSON Schema). */
function paramNames(d: AnyMgTemplate): Set<string> {
	const json = z.toJSONSchema(d.paramsSchema, { unrepresentable: 'any', io: 'input' }) as {
		properties?: Record<string, unknown>;
	};
	return new Set(Object.keys(json.properties ?? {}));
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
/** Longest preset / group id (they appear in refs and section ids). */
const MAX_ID_LENGTH = 64;

function firstIssue(r: { error?: { issues: { path: PropertyKey[]; message: string }[] } }): string {
	const i = r.error?.issues[0];
	return i ? `${i.path.map(String).join('.') || '(params)'}: ${i.message}` : 'invalid';
}

/** Presets (S: social comments): unique valid ids, names, only known params, defaults ⊕ params pass the schema. */
function checkPresets(d: AnyMgTemplate, k: string, names: ReadonlySet<string>): void {
	if (d.presets === undefined) return;
	if (!Array.isArray(d.presets)) throw new Error(`Presets of ${k} must be an array`);
	const ids = new Set<string>();
	for (const p of d.presets as unknown[]) {
		if (!isPlainObject(p)) throw new Error(`A preset of ${k} is not an object`);
		const id = p.id;
		if (typeof id !== 'string' || id.length > MAX_ID_LENGTH || !MG_PRESET_ID.test(id))
			throw new Error(
				`Preset id ${JSON.stringify(id)} of ${k} must match [a-z0-9][a-z0-9-]* (≤ ${MAX_ID_LENGTH})`,
			);
		if (ids.has(id)) throw new Error(`Duplicate preset ${k}:${id}`);
		ids.add(id);
		if (!nonEmpty(p.name)) throw new Error(`Preset ${k}:${id} needs a name`);
		if (p.description !== undefined && typeof p.description !== 'string')
			throw new Error(`The description of preset ${k}:${id} must be a string`);
		if (!isPlainObject(p.params)) throw new Error(`The params of preset ${k}:${id} must be an object`);
		for (const name of Object.keys(p.params))
			if (!names.has(name)) throw new Error(`Preset ${k}:${id} sets an unknown param "${name}"`);
		const r = d.paramsSchema.safeParse({ ...d.defaults, ...p.params });
		if (!r.success) throw new Error(`Preset ${k}:${id} does not match the params schema (${firstIssue(r)})`);
	}
}

/** UI hints: groups and per-param hints name existing params; `visibleWhen` values are valid for their param. */
function checkUi(d: AnyMgTemplate, k: string, names: ReadonlySet<string>): void {
	const ui = d.ui as unknown;
	if (ui === undefined) return;
	if (!isPlainObject(ui)) throw new Error(`The ui hints of ${k} must be an object`);
	const {
		groups,
		params,
		addAnother,
		import: importHints,
	} = ui as {
		groups?: unknown;
		params?: unknown;
		addAnother?: unknown;
		import?: unknown;
	};
	checkAddAnother(d, k, names, addAnother);
	checkImportHints(k, names, importHints);
	if (groups !== undefined) {
		if (!Array.isArray(groups)) throw new Error(`ui.groups of ${k} must be an array`);
		const ids = new Set<string>();
		const placed = new Set<string>();
		for (const g of groups as unknown[]) {
			if (!isPlainObject(g)) throw new Error(`A ui group of ${k} is not an object`);
			if (!nonEmpty(g.id) || g.id.length > MAX_ID_LENGTH)
				throw new Error(`A ui group of ${k} needs an id (≤ ${MAX_ID_LENGTH} characters)`);
			if (ids.has(g.id)) throw new Error(`Duplicate ui group "${g.id}" in ${k}`);
			ids.add(g.id);
			if (!nonEmpty(g.label)) throw new Error(`ui group "${g.id}" of ${k} needs a label`);
			if (!Array.isArray(g.params)) throw new Error(`ui group "${g.id}" of ${k} needs a params array`);
			for (const name of g.params as unknown[]) {
				if (typeof name !== 'string' || !names.has(name))
					throw new Error(`ui group "${g.id}" of ${k} lists an unknown param ${JSON.stringify(name)}`);
				if (placed.has(name)) throw new Error(`Param "${name}" of ${k} is in more than one ui group`);
				placed.add(name);
			}
		}
	}
	if (params === undefined) return;
	if (!isPlainObject(params)) throw new Error(`ui.params of ${k} must be an object`);
	for (const [name, h] of Object.entries(params)) {
		if (!names.has(name)) throw new Error(`ui.params of ${k} names an unknown param "${name}"`);
		if (!isPlainObject(h)) throw new Error(`ui.params.${name} of ${k} must be an object`);
		for (const key of ['label', 'description', 'control'] as const)
			if (h[key] !== undefined && !nonEmpty(h[key]))
				throw new Error(`ui.params.${name}.${key} of ${k} must be a non-empty string`);
		if (h.multiline !== undefined && typeof h.multiline !== 'boolean')
			throw new Error(`ui.params.${name}.multiline of ${k} must be a boolean`);
		if (h.options !== undefined) {
			if (!isPlainObject(h.options)) throw new Error(`ui.params.${name}.options of ${k} must be an object`);
			for (const [value, label] of Object.entries(h.options)) {
				if (!nonEmpty(label))
					throw new Error(`ui.params.${name}.options.${value} of ${k} must be a non-empty string`);
				if (!d.paramsSchema.safeParse({ ...d.defaults, [name]: value }).success)
					throw new Error(`ui.params.${name}.options of ${k}: "${value}" is not a valid value of "${name}"`);
			}
		}
		const w = h.visibleWhen;
		if (w === undefined) continue;
		if (!isPlainObject(w) || typeof w.param !== 'string' || !Array.isArray(w.in) || w.in.length === 0)
			throw new Error(`ui.params.${name}.visibleWhen of ${k} must be {param, in: [values…]}`);
		if (w.param === name || !names.has(w.param))
			throw new Error(`ui.params.${name}.visibleWhen of ${k} must name another param of the template`);
		for (const v of w.in as unknown[]) {
			const r = d.paramsSchema.safeParse({ ...d.defaults, [w.param]: v });
			if (!r.success)
				throw new Error(
					`ui.params.${name}.visibleWhen of ${k}: ${JSON.stringify(v)} is not a valid value of "${w.param}"`,
				);
		}
	}
}

/** `ui.addAnother`: `{reroll: [param…]}` naming params of the template; needs the fill hook that re-randomizes them. */
function checkAddAnother(d: AnyMgTemplate, k: string, names: ReadonlySet<string>, v: unknown): void {
	if (v === undefined) return;
	if (!isPlainObject(v) || !Array.isArray(v.reroll))
		throw new Error(`ui.addAnother of ${k} must be {reroll: [param names…]}`);
	if (!d.fill) throw new Error(`ui.addAnother of ${k} needs a fill hook to re-randomize its params`);
	for (const name of v.reroll as unknown[])
		if (typeof name !== 'string' || !names.has(name))
			throw new Error(`ui.addAnother.reroll of ${k} names an unknown param ${JSON.stringify(name)}`);
}

/** `ui.import`: aliases to params of the template (or per-row choices by another param), ignored columns, prefixes. */
function checkImportHints(k: string, names: ReadonlySet<string>, v: unknown): void {
	if (v === undefined) return;
	if (!isPlainObject(v)) throw new Error(`ui.import of ${k} must be an object`);
	const param = (name: unknown, where: string) => {
		if (typeof name !== 'string' || !names.has(name))
			throw new Error(`${where} of ${k} names an unknown param ${JSON.stringify(name)}`);
	};
	const { aliases, ignored, trimPrefix } = v as {
		aliases?: unknown;
		ignored?: unknown;
		trimPrefix?: unknown;
	};
	if (aliases !== undefined) {
		if (!isPlainObject(aliases)) throw new Error(`ui.import.aliases of ${k} must be an object`);
		for (const [column, target] of Object.entries(aliases)) {
			if (!nonEmpty(column)) throw new Error(`ui.import.aliases of ${k} has an empty column name`);
			const where = `ui.import.aliases.${column}`;
			if (typeof target === 'string') {
				param(target, where);
				continue;
			}
			if (!isPlainObject(target) || !isPlainObject(target.map))
				throw new Error(`${where} of ${k} must be a param name or {byParam, map, otherwise}`);
			param(target.byParam, `${where}.byParam`);
			param(target.otherwise, `${where}.otherwise`);
			for (const to of Object.values(target.map)) param(to, `${where}.map`);
		}
	}
	if (ignored !== undefined) {
		if (!isPlainObject(ignored)) throw new Error(`ui.import.ignored of ${k} must be an object`);
		for (const [column, reason] of Object.entries(ignored))
			if (!nonEmpty(column) || !nonEmpty(reason))
				throw new Error(`ui.import.ignored of ${k} needs column names and non-empty reasons`);
	}
	if (trimPrefix !== undefined) {
		if (!isPlainObject(trimPrefix)) throw new Error(`ui.import.trimPrefix of ${k} must be an object`);
		for (const [name, prefix] of Object.entries(trimPrefix)) {
			param(name, 'ui.import.trimPrefix');
			if (typeof prefix !== 'string' || prefix.length === 0)
				throw new Error(`ui.import.trimPrefix.${name} of ${k} must be a non-empty string`);
		}
	}
}

/** JSON-safe copies (the catalogue is served over HTTP and listed to agents). */
function presetJson(p: MgTemplatePreset): MgTemplatePreset {
	return {
		id: p.id,
		name: p.name,
		...(p.description ? { description: p.description } : {}),
		params: JSON.parse(JSON.stringify(p.params)) as Record<string, unknown>,
	};
}

function uiJson(ui: MgTemplateUi): MgTemplateUiJson {
	return JSON.parse(JSON.stringify(ui)) as MgTemplateUiJson;
}
