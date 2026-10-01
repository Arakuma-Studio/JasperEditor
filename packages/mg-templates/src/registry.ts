import type { MgTemplateInfo, MgTemplateRegistry, MgTemplateUpgrade } from '@jasper/project';
import { z } from 'zod';
import { type AnyMgTemplate, isAnimeTemplate } from './types.ts';

export type MgRegistry = MgTemplateRegistry & {
	/** S11:ATP-009 (FIX-005): always implemented here (see `upgradeParams`). */
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
	paramsSchema: Record<string, unknown>;
	defaults: Record<string, unknown>;
	introFrames: number;
	outroFrames: number;
	defaultDurationSeconds: number;
	description?: string;
	canvases: string[];
	/** M2 (S11:ATP-008): present for anime templates only (absent = fframes, unchanged for jasper-mg parity). */
	renderer?: 'anime';
};

const key = (id: string, version: number) => `${id}@${version}`;
function toTemplateInfo(def: AnyMgTemplate): MgTemplateInfo {
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
		// M2 (S11:ATP-001/ANA-001): additive.
		...(isAnimeTemplate(def) ? { renderer: 'anime' as const } : {}),
		...(def.description ? { description: def.description } : {}),
		defaultDurationSeconds: def.defaultDurationSeconds,
	};
}

/**
 * Template version upgrade (S11:ATP-009, FIX-005). Definitions carry `upgrades: [{fromVersion, migrate}]` (params
 * of `id@fromVersion` → params of that definition's version). From `fromVersion` the walk repeatedly takes the
 * step to the highest version reachable in one step (not above `toVersion` when given), validating the migrated
 * params with the target's schema (defaults filled in). Null when no step applies, a migration throws or yields
 * invalid params, or `toVersion` is not reached exactly.
 */
export function upgradeParams(
	defs: readonly AnyMgTemplate[],
	id: string,
	fromVersion: number,
	params: Record<string, unknown>,
	toVersion?: number,
): MgTemplateUpgrade | null {
	let version = fromVersion;
	let current = params;
	for (;;) {
		let best: {
			def: AnyMgTemplate;
			migrate: (p: Record<string, unknown>) => Record<string, unknown>;
		} | null = null;
		for (const d of defs) {
			if (d.id !== id || d.version <= version) continue;
			if (toVersion !== undefined && d.version > toVersion) continue;
			const step = d.upgrades?.find((u) => u.fromVersion === version);
			if (step && (!best || d.version > best.def.version)) best = { def: d, migrate: step.migrate };
		}
		if (!best) break;
		let migrated: unknown;
		try {
			migrated = best.migrate({ ...current });
		} catch {
			return null;
		}
		const parsed = best.def.paramsSchema.safeParse(migrated);
		if (!parsed.success) return null;
		current = parsed.data as Record<string, unknown>;
		version = best.def.version;
	}
	if (version === fromVersion) return null;
	if (toVersion !== undefined && version !== toVersion) return null;
	return { version, params: current };
}

/** Implements @jasper/project's MgTemplateRegistry over TS template definitions. */
export function createMgRegistry(defs: readonly AnyMgTemplate[]): MgRegistry {
	const map = new Map<string, AnyMgTemplate>();
	for (const d of defs) {
		const k = key(d.id, d.version);
		if (map.has(k)) throw new Error(`Duplicate motion-graphic template ${k}`);
		const check = d.paramsSchema.safeParse(d.defaults);
		if (!check.success) throw new Error(`Defaults of ${k} do not match its params schema`);
		map.set(k, d);
	}
	return {
		get: (id, version) => {
			const d = map.get(key(id, version));
			return d ? toTemplateInfo(d) : undefined;
		},
		list: () => [...map.values()].map(toTemplateInfo),
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
				paramsSchema: z.toJSONSchema(d.paramsSchema, { unrepresentable: 'any', io: 'input' }) as Record<
					string,
					unknown
				>,
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
