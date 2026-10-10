// Effect presets for agents (S03:FX-030, AGT-002 `presets.apply`, AGT-020): the same library and JSON format as
// the editor's Effects ▸ Presets bin. The user library lives on the engine (shared with every editor window and
// project); built-ins ship with @jasper/project. Applying sends `effect.applyPreset` with the preset inline, so it
// works live (one "Agent: …" undo entry) and headless alike.
import type { EffectPresetLibraryResponse } from '@jasper/api';
import {
	BUILTIN_EFFECT_PRESETS,
	buildEffectPreset,
	defaultEffectRegistry,
	EFFECT_PRESET_TYPES,
	type EffectPreset,
	type EffectPresetFolder,
	PresetBuildError,
	parseEffectPreset,
	presetMatches,
	presetSummary,
} from '@jasper/project';
import { z } from 'zod';
import {
	DESTRUCTIVE_IDEMPOTENT,
	defineTool,
	EDIT,
	loadDoc,
	READ_ONLY,
	type ToolContext,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { applyHelper } from './editing.ts';
import { ProjectIdArg } from './projects.ts';

/** Appended to the server instructions. */
export const PRESETS_GUIDE = `Effect presets (Effects ▸ Presets, Premiere's "Save Preset…"):
- list_effect_presets shows the built-in presets (read-only: Blurs, Fades, Slides, Zooms, Picture-in-Picture) and the user's own (shared with the editor and every project), with what each holds and its type. get_effect_preset returns the full JSON.
- apply_effect_preset {projectId, clipIds, presetId | preset} applies one to clips as one undo step: intrinsic properties (Motion, Opacity, Crop, Volume, Panner) are overwritten, effects are appended with new ids. Key times follow the type: "scale" stretches them to each clip's length, "anchor-in" keeps their distance from the clip's start, "anchor-out" from its end.
- save_effect_preset stores a preset in the user's library, either from a clip's effects ({projectId, clipId, sections: {motion, opacity, crop, volume, panner, effectIds}}) or from preset JSON you author: {format: "jasper-effect-preset", version: 1, id, name, type, source: {duration: frames, frameRate: {num, den}}, intrinsic?: {motion?: {position?, scale?, rotation?, …}, opacity?, blendMode?, crop?: {params}, volume?, pan?}, effects?: [{effectId, params: {name: {value, keyframes?: [{time, value, interpolation?}]}}}]}. Key "time" values are flicks (705600000 per second) from the clip's first frame; values use the same units as the document. delete_effect_preset removes a user preset (only when the user asks).`;

const TypeArg = z
	.enum(EFFECT_PRESET_TYPES)
	.describe('How key times map onto clips of other lengths: scale | anchor-in | anchor-out');

type Library = { presets: EffectPreset[]; folders: EffectPresetFolder[] };

async function library(ctx: ToolContext): Promise<Library> {
	const lib: EffectPresetLibraryResponse = await ctx.engine((c) => c.call('effectPresetsList'));
	return { presets: [...BUILTIN_EFFECT_PRESETS, ...(lib.presets as EffectPreset[])], folders: lib.folders };
}

async function findPreset(ctx: ToolContext, presetId: string): Promise<EffectPreset> {
	const p = (await library(ctx)).presets.find((x) => x.id === presetId);
	if (!p)
		throw new ToolError(
			'E_NOT_FOUND',
			`Effect preset not found: ${presetId}`,
			'Use list_effect_presets for preset ids.',
		);
	return p;
}

function folderPath(folders: readonly EffectPresetFolder[], id: string | null | undefined): string | null {
	const names: string[] = [];
	for (let cur = id ?? null; cur; ) {
		const f = folders.find((x) => x.id === cur);
		if (!f) break;
		names.unshift(f.name);
		cur = f.parentId ?? null;
	}
	return names.length ? names.join(' / ') : null;
}

function summary(p: EffectPreset, folders: readonly EffectPresetFolder[]) {
	const s = presetSummary(p, defaultEffectRegistry);
	return {
		id: s.id,
		name: s.name,
		type: s.type,
		...(s.description ? { description: s.description } : {}),
		builtIn: s.builtIn,
		bin: s.builtIn ? s.category : folderPath(folders, s.folderId),
		intrinsic: s.intrinsic,
		effects: s.effects.map((e) => e.label),
		...(s.unknownEffects.length ? { unknownEffects: s.unknownEffects } : {}),
		media: s.media,
		keyframed: s.keyframed,
	};
}

export function registerPresetTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'list_effect_presets',
		{
			title: 'List effect presets',
			description:
				'Built-in and user effect presets (Effects ▸ Presets): id, name, type (scale / anchor-in / anchor-out), bin, the intrinsic properties and effects each holds. query filters by name, description and effect names.',
			input: {
				query: z.string().optional().describe('Search words (all must match)'),
				builtIn: z.boolean().optional().describe('true: only built-ins; false: only the user library'),
			},
			annotations: READ_ONLY,
		},
		async ({ query, builtIn }) => {
			const lib = await library(ctx);
			const presets = lib.presets
				.filter((p) => builtIn === undefined || (p.builtIn === true) === builtIn)
				.filter((p) => !query || presetMatches(presetSummary(p, defaultEffectRegistry), query))
				.map((p) => summary(p, lib.folders));
			return jsonResult({
				presets,
				bins: lib.folders.map((f) => ({ id: f.id, path: folderPath(lib.folders, f.id) })),
			});
		},
	);

	defineTool(
		ctx,
		'get_effect_preset',
		{
			title: 'Get effect preset',
			description: 'The full JSON of an effect preset (to inspect it, or as a starting point for your own).',
			input: { presetId: z.string().min(1).describe('Preset id from list_effect_presets') },
			annotations: READ_ONLY,
		},
		async ({ presetId }) => jsonResult({ preset: await findPreset(ctx, presetId) }),
	);

	defineTool(
		ctx,
		'apply_effect_preset',
		{
			title: 'Apply effect preset',
			description:
				'Applies an effect preset (by id, or inline JSON) to clips of one sequence as one undo step: intrinsic properties are overwritten, effects appended (or inserted at index) with new ids; key times map per the preset type.',
			input: {
				projectId: ProjectIdArg,
				clipIds: z.array(z.string().min(1)).min(1).describe('Clip ids ("clp_…") from get_timeline'),
				presetId: z.string().optional().describe('Preset id from list_effect_presets'),
				preset: z
					.record(z.string(), z.unknown())
					.optional()
					.describe('Inline preset JSON instead of presetId'),
				index: z.number().int().min(0).optional().describe("Position of the preset's effects in each stack"),
			},
			annotations: EDIT,
		},
		async ({ projectId, clipIds, presetId, preset, index }, extra) => {
			if (!presetId === !preset)
				throw new ToolError(
					'E_INVALID_PARAM',
					'Give exactly one of presetId or preset',
					'Use list_effect_presets for ids.',
				);
			const p = preset ?? (await findPreset(ctx, presetId!));
			const name = typeof p.name === 'string' ? p.name : 'Preset';
			return applyHelper(
				ctx,
				projectId,
				`Apply Preset ${name}`,
				[{ type: 'effect.applyPreset', preset: p, clipIds, ...(index !== undefined ? { index } : {}) }],
				extra,
			);
		},
	);

	defineTool(
		ctx,
		'save_effect_preset',
		{
			title: 'Save effect preset',
			description:
				"Saves a preset to the user's library (shared with the editor and every project): from a clip's effect headers (projectId + clipId + sections) or from preset JSON (preset). Answers the stored preset's id.",
			input: {
				name: z.string().trim().min(1).max(120).optional().describe('Preset name (required with clipId)'),
				type: TypeArg.optional(),
				description: z.string().max(2000).optional(),
				binId: z
					.string()
					.optional()
					.describe('User bin id from list_effect_presets (default: the Presets root)'),
				projectId: ProjectIdArg.optional(),
				clipId: z.string().optional().describe('Clip whose effects to save'),
				sections: z
					.object({
						motion: z.boolean().optional(),
						opacity: z.boolean().optional(),
						crop: z.boolean().optional(),
						volume: z.boolean().optional(),
						panner: z.boolean().optional(),
						effectIds: z.array(z.string()).optional().describe('Effect instance ids ("fx_…") of the clip'),
					})
					.optional()
					.describe('What to save from the clip (default: every applied effect)'),
				preset: z
					.record(z.string(), z.unknown())
					.optional()
					.describe('Preset JSON (format "jasper-effect-preset")'),
			},
			annotations: EDIT,
		},
		async (a) => {
			let raw: Record<string, unknown>;
			if (a.clipId) {
				if (!a.projectId) throw new ToolError('E_INVALID_PARAM', 'projectId is required with clipId');
				if (!a.name) throw new ToolError('E_INVALID_PARAM', 'name is required with clipId');
				const { doc } = await loadDoc(ctx, a.projectId);
				const clip = Object.values(doc.sequences)
					.map((s) => s.clips[a.clipId!])
					.find(Boolean);
				const all = ((clip as { effects?: { id: string; effectId: string }[] } | undefined)?.effects ?? [])
					.filter((fx) => fx.effectId !== 'jasper.crop')
					.map((fx) => fx.id);
				try {
					raw = buildEffectPreset(doc, a.clipId, {
						name: a.name,
						type: a.type ?? 'scale',
						description: a.description,
						sections: a.sections ?? { effectIds: all },
					}) as unknown as Record<string, unknown>;
				} catch (e) {
					if (e instanceof PresetBuildError)
						throw new ToolError(
							e.code,
							e.message,
							'Look up effect instance ids with get_project or the document resource.',
						);
					throw e;
				}
			} else if (a.preset) {
				raw = {
					...a.preset,
					id: typeof a.preset.id === 'string' ? a.preset.id : 'new',
					...(a.name ? { name: a.name } : {}),
					...(a.type ? { type: a.type } : {}),
					...(a.description !== undefined ? { description: a.description } : {}),
				};
				const check = parseEffectPreset(raw);
				if (!check.ok)
					throw new ToolError(
						check.code,
						check.message,
						'Compare with get_effect_preset of a built-in preset.',
					);
			} else throw new ToolError('E_INVALID_PARAM', 'Give clipId (with projectId) or preset');
			const saved = (await ctx.engine((c) =>
				c.call('effectPresetCreate', { body: { preset: raw, ...(a.binId ? { folderId: a.binId } : {}) } }),
			)) as EffectPreset;
			const { folders } = await library(ctx);
			return jsonResult({ saved: summary(saved, folders) });
		},
	);

	defineTool(
		ctx,
		'delete_effect_preset',
		{
			title: 'Delete effect preset',
			description:
				"Removes a preset from the user's library (built-ins cannot be deleted; not undoable). Only when the user asks: it needs their approval in an open JasperEditor window (E_APPROVAL_DENIED without one).",
			input: { presetId: z.string().min(1) },
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async ({ presetId }) => {
			if (presetId.startsWith('builtin.'))
				throw new ToolError(
					'E_INVALID_PARAM',
					'Built-in presets are read-only',
					'Only user presets can be deleted.',
				);
			const r = await ctx.engine((c) => c.call('effectPresetDelete', { params: { presetId } }));
			return jsonResult({ ok: true, removed: r.removedPresets });
		},
	);
}
