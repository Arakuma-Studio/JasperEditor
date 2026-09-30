import type { MgTemplateInfo, MgTemplateRegistry } from '@jasper/project';
import { z } from 'zod';
import type { AnyMgTemplate, MgCanvas } from './types.ts';

export type MgRegistry = MgTemplateRegistry & {
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
};

const key = (id: string, version: number) => `${id}@${version}`;
export const canvasLabel = (c: MgCanvas) => `${c.width}x${c.height}`;

export function toTemplateInfo(def: AnyMgTemplate): MgTemplateInfo {
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
	};
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
				canvases: d.canvases.map(canvasLabel),
			})),
	};
}

/**
 * Maps a clip-local frame to the template's own timeline so intro and outro keep their length when
 * the clip is longer or shorter than the template's natural duration (S01:KND-009).
 */
export function templateFrame(
	frame: number,
	clipFrames: number,
	def: Pick<AnyMgTemplate, 'introFrames' | 'outroFrames'>,
): { phase: 'intro' | 'hold' | 'outro'; t: number } {
	const intro = Math.min(def.introFrames, Math.floor(clipFrames / 2));
	const outro = Math.min(def.outroFrames, clipFrames - intro);
	if (frame < intro) return { phase: 'intro', t: intro === 0 ? 1 : frame / intro };
	if (frame >= clipFrames - outro)
		return { phase: 'outro', t: outro === 0 ? 1 : (frame - (clipFrames - outro)) / outro };
	return { phase: 'hold', t: 0 };
}
