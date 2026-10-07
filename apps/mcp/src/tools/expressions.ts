// Expressions for agents (wave expressions, docs/wp-notes/expressions.md): set / clear / enable an After
// Effects-style expression on any animatable property, test one without storing it, read evaluated values over time
// (with `expressionError`), list presets and expression-capable properties, and add Expression Controls.
import {
	EXPRESSION_PRESETS,
	evaluateExpressionText,
	expressionPresetsFor,
	loadExpressionEngine,
	type PropKind,
	pickWhipExpression,
	propertyStatusAt,
	storedTimeAtFrame,
	worldOfDocument,
} from '@jasper/expressions';
import {
	type ExpressionRef,
	MAX_EXPRESSION_LENGTH,
	type ProjectDocument,
	paramPathToExpressionRef,
	propertyKeyToParamPath,
	type Sequence,
	sequenceTimecode,
} from '@jasper/project';
import { z } from 'zod';
import { defineTool, EDIT, frameOf, loadDoc, READ_ONLY, type ToolContext } from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { applyHelper } from './editing.ts';
import { ProjectIdArg } from './projects.ts';

/** Appended to the server instructions (FULL_GUIDE). The language reference is the jasper://guide resource. */
export const EXPRESSIONS_GUIDE = `Expressions (After Effects-style JavaScript on any animatable property):
- set_expression {clipId, property, text} (property = a property key: "transform.position", "transform.rotation", "opacity", "effects.<fxId>.<param>", "masks.<maskId>.feather", "shape.size", "volumeDb", "text.content" for a text clip's Source Text; transitionId + param for transition params). The reply evaluates it at a few frames and gives value / expressionError. clear_expression and enable_expression {enabled} switch it off; test_expression tries a text without storing it.
- get_property_values {clipId, property, from?, to?, step?} reads what renders (value), the keyframed value and expressionError per frame. A failing expression renders the keyframed value — always check expressionError.
- The object model: time (sequence seconds), value (keyframed value), thisComp = the sequence, thisLayer = the clip (thisComp.layer(index | "name"), index 1 = topmost), thisProperty, effect("Name")("Param"), transform.position…, comp("Sequence name"), marker, inPoint/outPoint, key(n)/numKeys/nearestKey, valueAtTime/velocityAtTime/speedAtTime, wiggle, loopIn/loopOut ("cycle" | "pingpong" | "offset" | "continue"), linear/ease/easeIn/easeOut, random/gaussRandom/seedRandom/noise (deterministic), clamp/length/normalize/add/sub/mul/div/dot/cross, degreesToRadians, timeToFrames/framesToTime/timeToTimecode, posterizeTime, hexToRgb/rgbToHsl/hslToRgb, toComp/fromComp, text.sourceText, sampleImage (solid clips). + - * / work on arrays. Colours are [r, g, b, a] in 0…1, checkboxes 1/0, menus 1-based indexes.
- add_expression_control {clipId, control: slider | angle | checkbox | color | point | point3d | layer | dropdown, name?, value?, items?} adds an Expression Control (draws nothing) that expressions read: effect("Speed")("Slider"). list_expression_properties {clipId} lists every property with its current expression and the reference text to read it from another expression.
- list_expression_presets gives ready-made expressions (wiggle, loops, bounce, counters, timecode…). The full language reference is in the jasper://guide resource.`;

const CONTROLS = {
	slider: { effectId: 'jasper.slider-control', param: 'slider' },
	angle: { effectId: 'jasper.angle-control', param: 'angle' },
	checkbox: { effectId: 'jasper.checkbox-control', param: 'checkbox' },
	color: { effectId: 'jasper.color-control', param: 'color' },
	point: { effectId: 'jasper.point-control', param: 'point' },
	point3d: { effectId: 'jasper.point3d-control', param: 'point' },
	layer: { effectId: 'jasper.layer-control', param: 'layer' },
	dropdown: { effectId: 'jasper.dropdown-control', param: 'menu' },
} as const;

const TargetArgs = {
	clipId: z.string().min(1).optional().describe('Clip owning the property'),
	property: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Property key on the clip: "transform.position", "transform.anchor", "transform.scale", "transform.scaleWidth", "transform.rotation", "opacity", "effects.<fxId>.<param>", "masks.<maskId>.feather|opacity|expansion", "shape.size|fill|cornerRadius", "shape.stroke.color|width", "volumeDb", "pan", "text.content" (Source Text)',
		),
	transitionId: z.string().min(1).optional().describe('Transition owning the param (instead of clipId)'),
	param: z.string().min(1).optional().describe('Transition param name (with transitionId)'),
};

type TargetInput = { clipId?: string; property?: string; transitionId?: string; param?: string };

function paramPathOf(a: TargetInput): string[] {
	if (a.transitionId) {
		if (!a.param) throw new ToolError('E_INVALID_PARAM', 'transitionId needs param');
		return ['transition', a.transitionId, a.param];
	}
	if (!a.clipId || !a.property)
		throw new ToolError(
			'E_INVALID_PARAM',
			'Give clipId + property (or transitionId + param)',
			'See list_expression_properties.',
		);
	return propertyKeyToParamPath({ clipId: a.clipId }, a.property);
}

function refOf(doc: ProjectDocument, a: TargetInput): { ref: ExpressionRef; path: string[]; seq: Sequence } {
	const path = paramPathOf(a);
	const ref = paramPathToExpressionRef(doc, path);
	const seq = ref ? doc.sequences[ref.seq] : undefined;
	if (!ref || !seq || !worldOfDocument(doc).prop(ref))
		throw new ToolError(
			'E_NOT_FOUND',
			`No property ${JSON.stringify(path)}`,
			'Call list_expression_properties {clipId}.',
		);
	return { ref, path, seq };
}

const round = (v: unknown): unknown =>
	typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : Array.isArray(v) ? v.map(round) : v;

/** Frames to sample: [from, to) every `step` (defaults: the owner clip, at most 12 evenly spaced samples). */
function framesFor(ref: ExpressionRef, seq: Sequence, from?: unknown, to?: unknown, step?: number) {
	const clip = seq.clips[ref.owner];
	const f0 = from !== undefined ? frameOf(seq, from) : (clip?.start ?? 0);
	const f1 = to !== undefined ? frameOf(seq, to) : clip ? clip.start + clip.duration : f0 + 30;
	const span = Math.max(1, f1 - f0);
	const s = step ?? Math.max(1, Math.ceil(span / 12));
	const out: number[] = [];
	for (let f = f0; f < f1 && out.length < 500; f += s) out.push(f);
	return out.length ? out : [f0];
}

function samples(doc: ProjectDocument, ref: ExpressionRef, seq: Sequence, frames: number[]) {
	return frames.map((frame) => {
		const st = propertyStatusAt(doc, ref, storedTimeAtFrame(doc, ref, frame))!;
		return {
			frame,
			timecode: sequenceTimecode(seq, frame),
			value: round(st.value),
			keyframedValue: round(st.keyframedValue),
			...(st.expressionError ? { expressionError: st.expressionError } : {}),
		};
	});
}

export function registerExpressionTools(ctx: ToolContext): void {
	const load = async (projectId: string) => {
		await loadExpressionEngine();
		return loadDoc(ctx, projectId);
	};

	defineTool(
		ctx,
		'set_expression',
		{
			title: 'Set expression',
			description:
				'Sets (or replaces) the After Effects-style expression of a property — one undoable step — and returns the evaluated value at a few frames with any expressionError (the property then renders its keyframed value). Empty text removes the expression. The language reference is the jasper://guide resource.',
			input: {
				projectId: ProjectIdArg,
				...TargetArgs,
				text: z.string().max(MAX_EXPRESSION_LENGTH).describe('JavaScript; the last statement is the value'),
				enabled: z.boolean().optional().describe('Default true'),
			},
			annotations: EDIT,
		},
		async (args, extra) => {
			const { doc } = await load(args.projectId);
			const { path, ref } = refOf(doc, args);
			await applyHelper(
				ctx,
				args.projectId,
				'Set Expression',
				[
					{
						type: 'expression.set',
						target: path,
						text: args.text,
						...(args.enabled === undefined ? {} : { enabled: args.enabled }),
					},
				],
				extra,
				{ sequenceId: ref.seq },
			);
			const after = (await load(args.projectId)).doc;
			const seq = after.sequences[ref.seq]!;
			return jsonResult({
				ok: true,
				target: path,
				expression: args.text.trim() ? { text: args.text, enabled: args.enabled ?? true } : null,
				samples: samples(after, ref, seq, framesFor(ref, seq)),
			});
		},
	);

	defineTool(
		ctx,
		'clear_expression',
		{
			title: 'Clear expression',
			description:
				'Removes the expression of a property (it renders its keyframed value again). One undoable step.',
			input: { projectId: ProjectIdArg, ...TargetArgs },
			annotations: EDIT,
		},
		async (args, extra) => {
			const { doc } = await load(args.projectId);
			const { path, ref } = refOf(doc, args);
			return applyHelper(
				ctx,
				args.projectId,
				'Clear Expression',
				[{ type: 'expression.clear', target: path }],
				extra,
				{
					sequenceId: ref.seq,
				},
			);
		},
	);

	defineTool(
		ctx,
		'enable_expression',
		{
			title: 'Enable or disable expression',
			description:
				"AE's Enable Expression switch: a disabled expression keeps its text and the property renders its keyframed value. One undoable step.",
			input: { projectId: ProjectIdArg, ...TargetArgs, enabled: z.boolean() },
			annotations: EDIT,
		},
		async (args, extra) => {
			const { doc } = await load(args.projectId);
			const { path, ref } = refOf(doc, args);
			return applyHelper(
				ctx,
				args.projectId,
				args.enabled ? 'Enable Expression' : 'Disable Expression',
				[{ type: 'expression.setEnabled', target: path, enabled: args.enabled }],
				extra,
				{ sequenceId: ref.seq },
			);
		},
	);

	defineTool(
		ctx,
		'test_expression',
		{
			title: 'Test expression',
			description:
				'Evaluates an expression text as if it were on the property, without storing it: the value (or the error) at each requested frame. Use it to iterate on an expression before set_expression.',
			input: {
				projectId: ProjectIdArg,
				...TargetArgs,
				text: z.string().max(MAX_EXPRESSION_LENGTH),
				frames: z
					.array(z.unknown())
					.max(200)
					.optional()
					.describe('Frames (numbers, {"seconds": x} or timecode); default: across the clip'),
			},
			annotations: READ_ONLY,
		},
		async (args) => {
			const { doc } = await load(args.projectId);
			const { ref, seq } = refOf(doc, args);
			const frames = args.frames?.length ? args.frames.map((f) => frameOf(seq, f)) : framesFor(ref, seq);
			return jsonResult({
				samples: frames.map((frame) => {
					const r = evaluateExpressionText(doc, ref, args.text, storedTimeAtFrame(doc, ref, frame));
					return {
						frame,
						timecode: sequenceTimecode(seq, frame),
						value: round(r.value),
						...(r.error ? { expressionError: r.error } : {}),
					};
				}),
			});
		},
	);

	defineTool(
		ctx,
		'get_property_values',
		{
			title: 'Get property values',
			description:
				'Evaluated values of a property over time, exactly what preview and export render: per frame the value (post-expression), the keyframed value and expressionError when its expression fails; plus the stored expression. Default: about 12 samples across the clip.',
			input: {
				projectId: ProjectIdArg,
				...TargetArgs,
				from: z.unknown().optional().describe('First frame (frames, {"seconds": x} or timecode)'),
				to: z.unknown().optional().describe('End frame (exclusive)'),
				step: z.number().int().min(1).optional().describe('Frames between samples (max 500 samples)'),
			},
			annotations: READ_ONLY,
		},
		async (args) => {
			const { doc } = await load(args.projectId);
			const { ref, path, seq } = refOf(doc, args);
			const p = worldOfDocument(doc).prop(ref)!;
			return jsonResult({
				target: path,
				name: p.name,
				kind: p.kind,
				expression: p.expression ? { text: p.expression.text, enabled: p.expression.enabled } : null,
				samples: samples(doc, ref, seq, framesFor(ref, seq, args.from, args.to, args.step)),
			});
		},
	);

	defineTool(
		ctx,
		'list_expression_properties',
		{
			title: 'List expression properties',
			description:
				'Every property of a clip that can take an expression: key (for set_expression), name, kind, current expression and the reference text that reads it from another expression (the pick-whip text).',
			input: { projectId: ProjectIdArg, clipId: z.string().min(1) },
			annotations: READ_ONLY,
		},
		async ({ projectId, clipId }) => {
			const { doc } = await load(projectId);
			const seqId = Object.keys(doc.sequences).find((id) => doc.sequences[id]!.clips[clipId]);
			if (!seqId)
				throw new ToolError('E_NOT_FOUND', `Clip not found: ${clipId}`, 'Call get_timeline for clip ids.');
			const world = worldOfDocument(doc);
			const other = { seq: seqId, owner: '\u0000other', path: '' };
			return jsonResult({
				clipId,
				properties: world
					.listProps(seqId, clipId)
					.filter((p) => p.kind !== 'other' && !p.ref.path.startsWith('params.'))
					.map((p) => ({
						property: p.ref.path,
						name: p.name,
						kind: p.kind,
						expression: p.expression ? { text: p.expression.text, enabled: p.expression.enabled } : null,
						reference: pickWhipExpression(doc, other, p.ref),
					})),
			});
		},
	);

	defineTool(
		ctx,
		'list_expression_presets',
		{
			title: 'List expression presets',
			description:
				'Ready-made expressions (wiggle, loops, inertial bounce, counters, timecode, links to controls…), optionally for one value kind.',
			input: {
				kind: z
					.enum(['number', 'vec2', 'vec3', 'color', 'boolean', 'enum', 'string'])
					.optional()
					.describe('Only presets for this property kind'),
			},
			annotations: READ_ONLY,
		},
		async ({ kind }) =>
			jsonResult({
				presets: (kind ? expressionPresetsFor(kind as PropKind) : EXPRESSION_PRESETS).map((p) => ({
					id: p.id,
					label: p.label,
					category: p.category,
					description: p.description,
					text: p.text,
					kinds: p.kinds,
				})),
			}),
	);

	defineTool(
		ctx,
		'add_expression_control',
		{
			title: 'Add expression control',
			description:
				'Adds an Expression Control effect to a clip (Slider, Angle, Checkbox, Color, Point, 3D Point, Layer or Dropdown Menu Control). It draws nothing; expressions read it with effect("<name>")("<param>"). Returns its effectInstanceId and the reference text.',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1),
				control: z.enum(['slider', 'angle', 'checkbox', 'color', 'point', 'point3d', 'layer', 'dropdown']),
				name: z.string().min(1).max(256).optional().describe('Instance name (default: the control name)'),
				value: z
					.unknown()
					.optional()
					.describe(
						'Initial value: number (slider/angle), boolean, [r,g,b,a], [x,y], [x,y,z], a clip id (layer), a 1-based index (dropdown)',
					),
				items: z.array(z.string().min(1)).min(1).max(1000).optional().describe('Dropdown menu items'),
			},
			annotations: EDIT,
		},
		async (args, extra) => {
			const c = CONTROLS[args.control];
			const params: Record<string, unknown> = {};
			if (args.value !== undefined) params[c.param] = args.value;
			if (args.items) params.items = args.items.join('\n');
			const commands: unknown[] = [
				{ type: 'effect.add', target: { clipId: args.clipId }, effectId: c.effectId, params, ref: '$ctl' },
				...(args.name ? [{ type: 'effect.rename', effectInstanceId: '$ctl', name: args.name }] : []),
			];
			const res = await applyHelper(ctx, args.projectId, 'Add Expression Control', commands, extra);
			return res;
		},
	);
}
