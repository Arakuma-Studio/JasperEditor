// Effects discovery (spec 19 TL-105): the catalogue the engine exports, paginated and without schemas, and the two edits
// every guide assumes: adding an effect to clips and setting one of its params.
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg, timeArg } from '../arguments.ts';
import {
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
	frameOf,
	loadDoc,
	READ_ONLY,
	requireOk,
	type ToolContext,
	transact,
	txBody,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { pickSequence } from '../format.ts';
import { engineSchema } from './editing.ts';

export const EFFECTS_GUIDE = `Video effects: list_effects {query?, category?} pages through the catalogue (id, label, category, what it does); list_effects {effectId} gives one effect's params with their types, ranges and defaults. add_effect {clipId | clipIds, effectId, params?, index?} adds it to clips in one undo step and returns the instance ids (the stack renders top to bottom). set_effect_param {effectInstanceId, param, value, at?, keyframe?} changes a param: with at and keyframe: true it animates it, a key per call. get_clip_properties lists every effect param with its value and its param.set target. Removing, reordering and bypassing: apply_commands effect.remove, effect.reorder, effect.setEnabled.`;

type EffectRow = {
	id: string;
	version: number;
	label: string;
	category: string;
	description?: string;
	appliesTo?: unknown;
	gpu?: boolean;
	params?: {
		name: string;
		label?: string;
		type: string;
		default?: unknown;
		range?: unknown;
		options?: unknown;
		unit?: string;
		animatable?: unknown;
	}[];
};

const MAX_PAGE = 100;

export function registerEffectTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'list_effects',
		{
			title: 'List effects',
			description: `The video effects add_effect takes. Rows {id, label, category, description, gpu}, ${MAX_PAGE} at most per page, no schemas; query matches words of the id, label, description or category, category filters, cursor continues. effectId returns that one effect with its params (name, type, default, range, options, unit). categories lists what exists.`,
			input: {
				query: z.string().max(200).optional().describe('Words to look for, e.g. "blur"'),
				category: z.string().max(64).optional().describe('Exact category, e.g. "Generate"'),
				effectId: z.string().min(1).max(128).optional().describe('One effect, with its params'),
				limit: z.number().int().min(1).max(MAX_PAGE).optional().describe('Rows per page (default 50)'),
				cursor: z
					.string()
					.regex(/^\d{1,6}$/, 'the nextCursor of an earlier call')
					.optional()
					.describe('nextCursor of the previous page'),
			},
			annotations: READ_ONLY,
		},
		async ({ query, category, effectId, limit, cursor }) => {
			const all = ((await engineSchema(ctx)).effects ?? []) as EffectRow[];
			if (effectId !== undefined) {
				const e = all.find((x) => x.id === effectId);
				if (!e)
					throw new ToolError(
						'E_NOT_FOUND',
						`No effect ${effectId}`,
						'list_effects {query} finds effect ids.',
						{
							effectId,
						},
					);
				return jsonResult({
					id: e.id,
					version: e.version,
					label: e.label,
					category: e.category,
					...(e.description ? { description: e.description } : {}),
					...(e.gpu ? { gpu: true } : {}),
					params: (e.params ?? []).map((p) => ({
						name: p.name,
						type: p.type,
						default: p.default,
						...(p.range ? { range: p.range } : {}),
						...(p.options ? { options: p.options } : {}),
						...(p.unit ? { unit: p.unit } : {}),
					})),
				});
			}
			const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
			const hits = all.filter((e) => {
				if (category !== undefined && e.category !== category) return false;
				const hay = `${e.id} ${e.label} ${e.category} ${e.description ?? ''}`.toLowerCase();
				return words.every((w) => hay.includes(w));
			});
			const offset = Number(cursor ?? 0);
			const size = limit ?? 50;
			const page = hits.slice(offset, offset + size);
			return jsonResult({
				total: hits.length,
				effects: page.map((e) => ({
					id: e.id,
					label: e.label,
					category: e.category,
					...(e.description ? { description: e.description.slice(0, 160) } : {}),
					...(e.gpu ? { gpu: true } : {}),
				})),
				...(offset + size < hits.length ? { nextCursor: String(offset + size) } : {}),
				categories: [...new Set(all.map((e) => e.category))].sort(),
			});
		},
	);

	defineTool(
		ctx,
		'add_effect',
		{
			title: 'Add an effect',
			description:
				'Adds a video effect to one clip or several in one undo step (effect.add). params: values by name, the rest take their defaults (list_effects {effectId} lists them). index: place in the stack, top first (default the end). Returns the instance ids for set_effect_param.',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1).max(64).optional().describe('A clip (get_timeline)'),
				clipIds: z.array(z.string().min(1).max(64)).min(1).max(1000).optional().describe('Several clips'),
				effectId: z.string().min(1).max(128).describe('Effect id (list_effects)'),
				params: z.record(z.string(), z.unknown()).optional().describe('Param values by name'),
				index: z.number().int().min(0).optional().describe('Place in the stack'),
				sequenceId: SequenceIdArg,
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			if ((a.clipId === undefined) === (a.clipIds === undefined))
				throw new ToolError('E_INVALID_PARAM', 'Give clipId or clipIds', 'get_timeline lists clip ids.');
			const ids = a.clipIds ?? [a.clipId!];
			const res = await transact(
				ctx,
				a.projectId,
				{
					label: `Add ${a.effectId}`.slice(0, 80),
					commands: ids.map((clipId) => ({
						type: 'effect.add',
						target: { clipId },
						effectId: a.effectId,
						...(a.params ? { params: a.params } : {}),
						...(a.index !== undefined ? { index: a.index } : {}),
					})),
					...(a.sequenceId ? { sequenceId: a.sequenceId } : {}),
				},
				extra,
			);
			const r = requireOk(res);
			return jsonResult({
				...txBody(res, r),
				next: 'set_effect_param {effectInstanceId, param, value} changes it.',
			});
		},
	);

	defineTool(
		ctx,
		'set_effect_param',
		{
			title: 'Set an effect param',
			description:
				'Sets one param of an effect instance in one undo step (param.set on ["effect", effectInstanceId, param]). The instance id comes from add_effect or get_clip_properties. at sets the value at that time on an animated param; with keyframe: true it starts animating the param and sets a key there. Values are checked against the param: wrong types or ranges are refused.',
			input: {
				projectId: ProjectIdArg,
				effectInstanceId: z.string().min(1).max(64).describe('Effect instance id ("fx_…")'),
				param: z.string().min(1).max(128).describe('Param name (list_effects {effectId})'),
				value: z.unknown().describe('The value'),
				at: timeArg('Keyframe time on the sequence').optional(),
				keyframe: z.boolean().optional().describe('Animate the param: a key at `at`'),
				sequenceId: SequenceIdArg,
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) => {
			if (a.keyframe && a.at === undefined)
				throw new ToolError('E_INVALID_PARAM', 'keyframe: true needs at', 'Pass at: the time of the key.');
			const target = ['effect', a.effectInstanceId, a.param];
			let at: { sequenceFrame: number } | undefined;
			if (a.at !== undefined) {
				const { doc } = await loadDoc(ctx, a.projectId);
				const own = Object.values(doc.sequences).find((s) =>
					Object.values(s.clips).some((c) =>
						(c as { effects?: { id: string }[] }).effects?.some((fx) => fx.id === a.effectInstanceId),
					),
				);
				at = { sequenceFrame: frameOf(own ?? pickSequence(doc, a.sequenceId), a.at) };
			}
			const res = await transact(
				ctx,
				a.projectId,
				{
					label: `Set ${a.param}`.slice(0, 80),
					commands: [
						...(a.keyframe ? [{ type: 'param.setAnimated', target, animated: true, at }] : []),
						{ type: 'param.set', target, value: a.value, ...(at ? { at } : {}) },
					],
					...(a.sequenceId ? { sequenceId: a.sequenceId } : {}),
				},
				extra,
			);
			return jsonResult(txBody(res, requireOk(res)));
		},
	);
}
