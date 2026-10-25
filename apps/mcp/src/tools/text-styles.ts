// spec 13 AS-033: style many text clips at once (text style + effects with keys relative to each clip's In) and the
// linked project text styles (list, create, apply / detach / reset, update, delete). Every call is one transaction
// = one undoable History entry ("Agent: …") whatever the number of clips.
import {
	MAX_BATCH_CLIPS,
	type ProjectDocument,
	RelativeKeySchema,
	TextStylePatchSchema,
	textStylesOf,
	textStyleUsage,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg } from '../arguments.ts';
import {
	applyCommands,
	DESTRUCTIVE_IDEMPOTENT,
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
	loadDoc,
	READ_ONLY,
	type ToolContext,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';

export const TEXT_STYLES_GUIDE = `Styling many text clips (subtitles) and linked text styles:
- style_text changes the look of many text clips in ONE undo step: clipIds (or "$selection" — the clips selected in the open editor — or groupId, a subtitle group) + style (only the fields you name change; shadow / background / openType merge field by field: {"shadow": {"blurPx": 4}} keeps the shadow's colour, angle, distance and spread; null removes: {"shadow": null}; strokes: a whole list [{color, widthPx, position outside|center|inside}] or edits {"set": [{"index": 0, "widthPx": 12}], "remove": [1], "add": [{…}]}) + effects: [{op: "add", effectId, params, keyframes: {param: [{offset: {frames}|{seconds}, value, interpolation, easeIn, easeOut}]}, anchor: "in"|"out"}, {op: "set", effectId, occurrence, param, value | delta | keyframes | animated, at: {frames}}, {op: "remove", effectId, occurrence}]. Key offsets count from each clip's In (anchor "out": back from its last frame), so one call gives 100 subtitles the same pop-in. Clips that are not text clips are refused by id.
- Colours are [r, g, b, a] in 0…1; sizes in px of the sequence frame. A shadow is {color, angleDeg, distancePx, blurPx, spreadPx}; its opacity is the colour's alpha.
- Linked text styles: create_text_style (from a clip and/or style fields; applyTo links clips at once) → apply_text_style (action "apply" links clips: their style becomes the style; "detach" unlinks them, keeping the look; "reset" drops their own deviations, optionally only some fields) → update_text_style (style fields, fromClipId = take that clip's look, or rename): every linked clip follows in one step, and a clip's own deviations (made with style_text or any edit) are kept. list_text_styles shows each style with its number of linked clips; delete_text_style unlinks its clips (they keep their look).`;

const ClipIdsArg = z
	.union([z.array(z.string().min(1)).min(1).max(MAX_BATCH_CLIPS), z.literal('$selection')])
	.describe('Text clip ids ("clp_…"), or "$selection" for the clips selected in the open editor');
const GroupIdArg = z.string().min(1).describe('A subtitle group id (every text clip of the group)');
const StyleArg = TextStylePatchSchema.describe(
	'Text style fields to change: fontId, weight, italic, sizePx, lineHeight, trackingEm, align, direction, fill, strokes, background, shadow, allCaps and the Character / Paragraph fields',
);
const Anchor = z.enum(['in', 'out']).describe('Key offsets count from each clip\'s In (default) or back from its last frame');
const Keys = z.array(RelativeKeySchema).min(1).max(1000);
const Occurrence = z
	.number()
	.int()
	.min(0)
	.max(1000)
	.optional()
	.describe('Which instance of the effect on each clip (0 = the first in the stack)');

const EffectOp = z.discriminatedUnion('op', [
	z.strictObject({
		op: z.literal('add'),
		effectId: z.string().min(1),
		index: z.number().int().min(0).optional(),
		params: z.record(z.string(), z.unknown()).optional(),
		keyframes: z.record(z.string(), Keys).optional(),
		anchor: Anchor.optional(),
	}),
	z.strictObject({
		op: z.literal('set'),
		effectId: z.string().min(1),
		occurrence: Occurrence,
		param: z.string().min(1),
		value: z.unknown().optional(),
		delta: z.union([z.number(), z.array(z.number()).min(2).max(3)]).optional(),
		keyframes: Keys.optional(),
		animated: z.boolean().optional(),
		at: z.strictObject({ frames: z.number().int().min(0) }).optional(),
		anchor: Anchor.optional(),
	}),
	z.strictObject({ op: z.literal('remove'), effectId: z.string().min(1), occurrence: Occurrence }),
]);

function targetOf(a: { clipIds?: string[] | '$selection'; groupId?: string }) {
	if ((a.clipIds === undefined) === (a.groupId === undefined))
		throw new ToolError('E_INVALID_PARAM', 'Give clipIds or groupId', 'clipIds: ids or "$selection"; groupId: a subtitle group.');
	return a.clipIds !== undefined ? { clipIds: a.clipIds } : { groupId: a.groupId };
}

/** A style id from its id or (case-insensitive) name. */
function styleIdOf(doc: ProjectDocument, ref: { styleId?: string; name?: string }): string {
	const styles = textStylesOf(doc);
	const hit = ref.styleId
		? styles.find((s) => s.id === ref.styleId)
		: styles.find((s) => s.name.trim().toLocaleLowerCase() === ref.name?.trim().toLocaleLowerCase());
	if (!hit)
		throw new ToolError(
			'E_NOT_FOUND',
			`Text style not found: ${ref.styleId ?? ref.name}`,
			'list_text_styles shows the project text styles.',
		);
	return hit.id;
}

export function registerTextStyleTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'style_text',
		{
			title: 'Style text clips',
			description:
				'Changes the text style and/or effects of many text clips in one undo step (deep per-field style patch; effects added, set or removed on every clip with keys relative to each clip\'s In).',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				clipIds: ClipIdsArg.optional(),
				groupId: GroupIdArg.optional(),
				style: StyleArg.optional(),
				runs: z
					.enum(['keep', 'clear-overridden'])
					.optional()
					.describe('clear-overridden: styled character runs lose the fields the style sets (default keep)'),
				effects: z.array(EffectOp).min(1).max(50).optional(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) => {
			const target = targetOf(a);
			const commands: unknown[] = [];
			if (a.style)
				commands.push({ type: 'text.setStyle', ...target, patch: a.style, ...(a.runs ? { runs: a.runs } : {}) });
			if (a.effects) {
				if (!('clipIds' in target))
					throw new ToolError('E_INVALID_PARAM', 'effects need clipIds', 'Pass the clip ids (or "$selection").');
				for (const e of a.effects) {
					if (e.op === 'add') {
						const { op: _op, ...rest } = e;
						commands.push({ type: 'effect.addMany', clipIds: target.clipIds, ...rest });
					} else if (e.op === 'set') {
						const { op: _op, ...rest } = e;
						commands.push({ type: 'effect.setParamMany', clipIds: target.clipIds, ...rest });
					} else
						commands.push({
							type: 'effect.removeMany',
							clipIds: target.clipIds,
							effectId: e.effectId,
							...(e.occurrence !== undefined ? { occurrence: e.occurrence } : {}),
						});
				}
			}
			if (!commands.length)
				throw new ToolError('E_INVALID_PARAM', 'Nothing to change', 'Give style and/or effects.');
			return applyCommands(ctx, a.projectId, 'Style Text', commands, extra, a.sequenceId);
		},
	);

	defineTool(
		ctx,
		'list_text_styles',
		{
			title: 'List text styles',
			description: 'Lists the project text styles with their ids, names, number of linked clips and (full) style.',
			input: {
				projectId: ProjectIdArg,
				full: z.boolean().optional().describe('Include every style field (default: a summary)'),
			},
			annotations: READ_ONLY,
		},
		async (a) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const usage = textStyleUsage(doc);
			const styles = textStylesOf(doc).map((s) => ({
				styleId: s.id,
				name: s.name,
				linkedClips: usage.get(s.id)?.length ?? 0,
				...(a.full
					? { style: s.style }
					: {
							summary: {
								font: doc.fonts[s.style.fontId]?.family ?? s.style.fontId,
								sizePx: s.style.sizePx,
								weight: s.style.weight,
								fill: s.style.fill,
								strokes: s.style.strokes.length,
								shadow: s.style.shadow !== null,
								background: s.style.background !== null,
							},
						}),
			}));
			return jsonResult({ styles });
		},
	);

	defineTool(
		ctx,
		'create_text_style',
		{
			title: 'Create a text style',
			description:
				'Creates a named project text style from a text clip (fromClipId) and/or style fields over the defaults; applyTo links clips to it in the same step.',
			input: {
				projectId: ProjectIdArg,
				name: z.string().trim().min(1).max(120),
				fromClipId: z.string().min(1).optional(),
				style: StyleArg.optional(),
				applyTo: ClipIdsArg.optional(),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const commands: unknown[] = [
				{
					type: 'textStyle.create',
					name: a.name,
					...(a.fromClipId ? { fromClipId: a.fromClipId } : {}),
					...(a.style ? { style: a.style } : {}),
					ref: '$style',
				},
			];
			if (a.applyTo) commands.push({ type: 'textStyle.apply', styleId: '$style', clipIds: a.applyTo });
			return applyCommands(ctx, a.projectId, 'New Text Style', commands, extra);
		},
	);

	defineTool(
		ctx,
		'apply_text_style',
		{
			title: 'Apply a text style',
			description:
				'Links text clips to a project text style (action "apply", default), unlinks them keeping their look ("detach"), or drops their deviations from it ("reset", optionally only some fields).',
			input: {
				projectId: ProjectIdArg,
				styleId: z.string().min(1).optional(),
				name: z.string().min(1).optional().describe('The style by name (instead of styleId)'),
				clipIds: ClipIdsArg.optional(),
				groupId: GroupIdArg.optional(),
				action: z.enum(['apply', 'detach', 'reset']).optional(),
				fields: z
					.array(z.string().min(1).max(64))
					.min(1)
					.max(64)
					.optional()
					.describe('reset: only these style fields (e.g. ["sizePx", "fill"])'),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) => {
			const target = targetOf(a);
			const action = a.action ?? 'apply';
			if (action === 'detach')
				return applyCommands(ctx, a.projectId, 'Detach From Text Style', [{ type: 'textStyle.detach', ...target }], extra);
			if (action === 'reset')
				return applyCommands(
					ctx,
					a.projectId,
					'Reset to Text Style',
					[{ type: 'textStyle.reset', ...target, ...(a.fields ? { fields: a.fields } : {}) }],
					extra,
				);
			if (a.styleId === undefined && a.name === undefined)
				throw new ToolError('E_INVALID_PARAM', 'Give styleId or name', 'list_text_styles shows them.');
			const { doc } = await loadDoc(ctx, a.projectId);
			const styleId = styleIdOf(doc, a);
			return applyCommands(ctx, a.projectId, 'Apply Text Style', [{ type: 'textStyle.apply', styleId, ...target }], extra);
		},
	);

	defineTool(
		ctx,
		'update_text_style',
		{
			title: 'Update a text style',
			description:
				'Changes a project text style (style fields, or fromClipId = take that clip\'s look) and/or renames it; every linked clip follows in one step, keeping its own deviations.',
			input: {
				projectId: ProjectIdArg,
				styleId: z.string().min(1).optional(),
				name: z.string().min(1).optional().describe('The style by name (instead of styleId)'),
				style: StyleArg.optional(),
				fromClipId: z.string().min(1).optional(),
				rename: z.string().trim().min(1).max(120).optional(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const styleId = styleIdOf(doc, a);
			const commands: unknown[] = [];
			if (a.style || a.fromClipId)
				commands.push({
					type: 'textStyle.update',
					styleId,
					...(a.style ? { patch: a.style } : {}),
					...(a.fromClipId ? { fromClipId: a.fromClipId } : {}),
				});
			if (a.rename) commands.push({ type: 'textStyle.rename', styleId, name: a.rename });
			if (!commands.length)
				throw new ToolError('E_INVALID_PARAM', 'Nothing to change', 'Give style, fromClipId or rename.');
			return applyCommands(ctx, a.projectId, 'Update Text Style', commands, extra);
		},
	);

	defineTool(
		ctx,
		'delete_text_style',
		{
			title: 'Delete a text style',
			description: 'Deletes a project text style; its linked clips keep their look and are unlinked (undoable).',
			input: {
				projectId: ProjectIdArg,
				styleId: z.string().min(1).optional(),
				name: z.string().min(1).optional().describe('The style by name (instead of styleId)'),
			},
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const styleId = styleIdOf(doc, a);
			return applyCommands(ctx, a.projectId, 'Delete Text Style', [{ type: 'textStyle.delete', styleId }], extra);
		},
	);
}
