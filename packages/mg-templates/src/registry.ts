import type {
	MgTemplateInfo,
	MgTemplateMotionTiming,
	MgTemplateRegistry,
	MgTemplateUpgrade,
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
};

const key = (id: string, version: number) => `${id}@${version}`;

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
			})),
	};
}
