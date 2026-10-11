import {
	ANIMATOR_MENU_IDS,
	type Clip,
	evaluate,
	type ProjectDocument,
	RANGE_SELECTOR_FIELDS,
	TEXT_ANIMATOR_PRESETS,
	type TextAnimatorGroup,
	WIGGLY_SELECTOR_FIELDS,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg } from '../arguments.ts';
import {
	DESTRUCTIVE_IDEMPOTENT,
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
	loadDoc,
	READ_ONLY,
	type ToolContext,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { applyHelper } from './editing.ts';

export const TEXT_ANIMATORS_GUIDE = `Text animators (After Effects "Animate Text"):
- A text clip can carry animators. Each animator offsets properties (position, anchor, scale, skew, rotation incl. per-character 3D X/Y, opacity, fill/stroke colour RGB/hue/saturation/brightness/opacity, stroke width, tracking, line anchor, line spacing, character offset/value, blur, variable font axes) by how much each character is selected. Selectors combine top to bottom by mode (add, subtract, intersect, min, max, difference): Range (start/end/offset in % or index, based on characters / characters excluding spaces / words / lines, shape square/rampUp/rampDown/triangle/round/smooth, smoothness, ease high/low, amount, randomize order + seed), Wiggly (max/min amount, wiggles per second, correlation, temporal/spatial phase, lock dimensions, seed) and Expression (an expression per character with textIndex, textTotal, selectorValue; its result replaces the selection). No selector = every character fully.
- Fastest: list_text_animator_presets, then apply_text_animator_preset {clipIds, preset} (typewriter, fade-in-by-word, slide-up-in, pop-in, bounce-in-words, scramble, decoder, tracking-in, blur-in, flip-in-3d, wave, jitter, …; "-out" twins end the clip, loops repeat). durationFrames / durationSeconds stretch it.
- Custom: add_text_animator {clipId, properties: ["position", "opacity"], values: {position: [0, 40], opacity: 0}, range: {start: 0, end: 100, shape: "rampUp", basedOn: "words"}, keys: {"range.offset": [[0, -100], [1.5, 100]]}} — keys are [seconds from the clip start, value]. add_text_selector adds Wiggly / Expression / more Range selectors. get_text_animators lists them with ids and property keys.
- Fine control with apply_commands: textAnimator.* / textSelector.* commands and param.set / param.setAnimated / keyframe.* / expression.set on ["clip", clipId, "textAnimators", animatorId, "properties", prop] and [..., "selectors", selectorId, field]. More Options: ["clip", clipId, "textMore", "anchorPointGrouping" | "groupingAlignment" | "fillAndStroke" | "interCharacterBlending"].
- Text on a path: set_text_path {clipId, points or path (normalised 0..1 of the text box, or units "px"), reversePath, perpendicularToPath, forceAlignment, firstMargin, lastMargin} creates a guide mask (mode none) and puts the characters on it (AE Path Options); maskId reuses an existing mask; null removes.
- Typography (Character / Paragraph): param.set on ["clip", id, "text", "kerning" | "kerningAmount" | "baselineShiftPx" | "tsume" | "fauxBold" | "fauxItalic" | "smallCaps" | "script" | "ligatures" | "discretionaryLigatures" | "stylisticSets" | "fractions" | "figureStyle" | "fontVariations" | "justifyLast" | "indentLeftPx" | "indentFirstLinePx" | "spaceBeforePx" | …], or clip.update content.style / content.runs (per-character styles) / content.paragraphs (per-paragraph). Source Text hold keys: param.setAnimated / param.set with "at" on ["clip", id, "text", "sourceText"] (value = {text, style, runs?}).
- Fonts: apply_commands font.add {family, ref} registers a bundled family ("Inter Variable" has wght 100–900 and opsz 14–32 axes for fontVariations and the axes.* animator properties), then clip.update content.style.fontId.
- In/Out text animations (set_text_animation) and animators are separate; convert_text_animation turns a clip's In/Out presets into animators. Preview and export draw animators identically; check with render_frames.`;

const KeyList = z
	.array(z.tuple([z.number().min(-3600).max(3600), z.unknown()]))
	.min(1)
	.max(500)
	.describe('[[seconds from the clip start, value], …]');

const SELECTOR_SETTINGS = z
	.record(z.string(), z.unknown())
	.describe(
		`Selector fields. Range: ${RANGE_SELECTOR_FIELDS.map((f) => f.key).join(', ')}. Wiggly: ${WIGGLY_SELECTOR_FIELDS.map((f) => f.key).join(', ')}. Expression: basedOn, amount.`,
	);

function textClipOf(
	doc: ProjectDocument,
	clipId: string,
): { seqId: string; clip: Clip & { animators?: TextAnimatorGroup[] } } {
	for (const [seqId, seq] of Object.entries(doc.sequences)) {
		const c = seq.clips[clipId];
		if (c) {
			if (c.kind !== 'text')
				throw new ToolError(
					'E_INVALID_PARAM',
					`${clipId} is a ${c.kind} clip`,
					'Text animators apply to text clips.',
				);
			return { seqId, clip: c as Clip & { animators?: TextAnimatorGroup[] } };
		}
	}
	throw new ToolError('E_NOT_FOUND', `Clip not found: ${clipId}`, 'Use get_timeline for clip ids.');
}

/** param.set / keyframe commands for `values` and `keys` on a target path (keys at clip-relative seconds). */
function valueCommands(
	target: string[],
	value: unknown,
	keys: [number, unknown][] | undefined,
	fps: number,
): unknown[] {
	const out: unknown[] = [];
	if (keys?.length) {
		const sorted = [...keys].sort((a, b) => a[0] - b[0]);
		out.push({ type: 'param.set', target, value: sorted[0]![1] });
		out.push({
			type: 'param.setAnimated',
			target,
			animated: true,
			at: { frames: Math.round(sorted[0]![0] * fps) },
		});
		for (const [t, v] of sorted)
			out.push({ type: 'param.set', target, value: v, at: { frames: Math.round(t * fps) } });
	} else if (value !== undefined) out.push({ type: 'param.set', target, value });
	return out;
}

export function registerTextAnimatorTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'list_text_animator_presets',
		{
			title: 'List text animator presets',
			description:
				'Every text animator preset (id, name, category, phase in / out / loop, nominal seconds, description). In presets start at the clip start, Out presets end on its last frame, loops repeat over the clip.',
			input: {},
			annotations: READ_ONLY,
		},
		async () =>
			jsonResult({
				presets: TEXT_ANIMATOR_PRESETS.map((p) => ({
					id: p.id,
					name: p.name,
					category: p.category,
					phase: p.phase,
					seconds: p.duration,
					...(p.perCharacter3d ? { perCharacter3d: true } : {}),
					...(p.legacy ? { reexpresses: p.legacy } : {}),
					description: p.description,
				})),
			}),
	);

	defineTool(
		ctx,
		'apply_text_animator_preset',
		{
			title: 'Apply text animator preset',
			description:
				"Adds a preset's animators to text clips (one undo step). Optional length (durationFrames or durationSeconds, default the preset's), start (atFrames from the clip start; Out presets default to ending on the last frame) and replace (drop the clips' animators first).",
			input: {
				projectId: ProjectIdArg,
				clipIds: z
					.union([z.array(z.string()).min(1).max(500), z.literal('$selection')])
					.describe('Text clip ids or "$selection"'),
				preset: z.string().min(1).describe('Preset id or name (list_text_animator_presets)'),
				durationFrames: z.number().int().min(1).max(100000).optional(),
				durationSeconds: z.number().positive().max(3600).optional(),
				atFrames: z.number().int().optional().describe('Start, in frames from the clip start'),
				replace: z.boolean().optional(),
				sequenceId: z.string().optional(),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			let durationFrames = a.durationFrames;
			if (durationFrames === undefined && a.durationSeconds !== undefined) {
				const { doc } = await loadDoc(ctx, a.projectId);
				const firstId = Array.isArray(a.clipIds) ? a.clipIds[0]! : undefined;
				const seq = firstId
					? Object.values(doc.sequences).find((s) => s.clips[firstId])
					: Object.values(doc.sequences)[0];
				const r = seq!.settings.frameRate;
				durationFrames = Math.max(1, Math.round((a.durationSeconds * r.num) / r.den));
			}
			return applyHelper(
				ctx,
				a.projectId,
				`Apply Text Animator Preset ${a.preset}`,
				[
					{
						type: 'textAnimator.applyPreset',
						clipIds: a.clipIds,
						preset: a.preset,
						...(durationFrames !== undefined ? { durationFrames } : {}),
						...(a.atFrames !== undefined ? { at: { frames: a.atFrames } } : {}),
						...(a.replace ? { replace: true } : {}),
					},
				],
				extra,
				{ sequenceId: a.sequenceId },
			);
		},
	);

	defineTool(
		ctx,
		'add_text_animator',
		{
			title: 'Add text animator',
			description:
				'Adds an animator to a text clip with properties (AE "Animate ▸" entries; companions are added like AE), their values and keys, and a Range selector with settings and keys (or none). One undo step.',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1),
				properties: z
					.array(z.enum(ANIMATOR_MENU_IDS as [string, ...string[]]))
					.max(30)
					.optional(),
				axes: z
					.array(z.string().regex(/^[\x20-\x7e]{4}$/))
					.max(8)
					.optional()
					.describe('Variable font axes to offset, e.g. ["wght"]'),
				name: z.string().min(1).max(200).optional(),
				values: z
					.record(z.string(), z.unknown())
					.optional()
					.describe(
						'Property values by key (position [x, y], scale [x, y] %, opacity %, fillColor [r,g,b,a] 0..1, tracking 1/1000 em, blur [x, y] px, axes.wght …)',
					),
				keys: z
					.record(z.string(), KeyList)
					.optional()
					.describe(
						'Keyframes by property key, or "range.<field>" for the Range selector (e.g. "range.offset")',
					),
				range: SELECTOR_SETTINGS.nullable()
					.optional()
					.describe('Range selector settings; null = no selector (every character fully)'),
				sequenceId: z.string().optional(),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const { seqId } = textClipOf(doc, a.clipId);
			const r = doc.sequences[seqId]!.settings.frameRate;
			const fps = r.num / r.den;
			const commands: unknown[] = [
				{
					type: 'textAnimator.add',
					clipId: a.clipId,
					...(a.properties ? { properties: a.properties } : {}),
					...(a.axes ? { axes: a.axes } : {}),
					...(a.name ? { name: a.name } : {}),
					selector: false,
					ref: '$anim',
				},
			];
			if (a.range !== null)
				commands.push({
					type: 'textSelector.add',
					clipId: a.clipId,
					animatorId: '$anim',
					kind: 'range',
					ref: '$range',
				});
			const prop = (k: string) => ['clip', a.clipId, 'textAnimators', '$anim', 'properties', ...k.split('.')];
			const sel = (k: string) => ['clip', a.clipId, 'textAnimators', '$anim', 'selectors', '$range', k];
			const keys = a.keys ?? {};
			for (const [k, v] of Object.entries(a.values ?? {}))
				commands.push(...valueCommands(prop(k), v, keys[k] as never, fps));
			for (const [k, list] of Object.entries(keys))
				if (!k.startsWith('range.') && !(a.values && k in a.values))
					commands.push(...valueCommands(prop(k), undefined, list as never, fps));
			for (const [k, v] of Object.entries(a.range ?? {}))
				commands.push(...valueCommands(sel(k), v, keys[`range.${k}`] as never, fps));
			for (const [k, list] of Object.entries(keys))
				if (k.startsWith('range.') && !(a.range && k.slice(6) in a.range))
					commands.push(...valueCommands(sel(k.slice(6)), undefined, list as never, fps));
			return applyHelper(ctx, a.projectId, 'Add Text Animator', commands, extra, {
				sequenceId: a.sequenceId ?? seqId,
			});
		},
	);

	defineTool(
		ctx,
		'add_text_selector',
		{
			title: 'Add text selector',
			description:
				'Adds a Range, Wiggly or Expression selector to an animator (selectors combine top to bottom by their mode). Expression: `expression` is evaluated per unit with textIndex (1-based), textTotal and selectorValue (percent, [x, y, z]); its result in percent replaces the selection (default "selectorValue * textIndex / textTotal").',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1),
				animatorId: z.string().min(1),
				kind: z.enum(['range', 'wiggly', 'expression']),
				settings: SELECTOR_SETTINGS.optional(),
				expression: z.string().max(20000).optional().describe('Expression Selector: the Amount expression'),
				sequenceId: z.string().optional(),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const sel = (k: string) => ['clip', a.clipId, 'textAnimators', a.animatorId, 'selectors', '$sel', k];
			const commands: unknown[] = [
				{ type: 'textSelector.add', clipId: a.clipId, animatorId: a.animatorId, kind: a.kind, ref: '$sel' },
				...Object.entries(a.settings ?? {}).map(([k, v]) => ({
					type: 'param.set',
					target: sel(k),
					value: v,
				})),
			];
			if (a.expression !== undefined) {
				if (a.kind !== 'expression')
					throw new ToolError(
						'E_INVALID_PARAM',
						'expression is only for kind "expression"',
						'Use kind: "expression".',
					);
				commands.push({ type: 'expression.set', target: sel('amount'), text: a.expression });
			}
			return applyHelper(ctx, a.projectId, 'Add Text Selector', commands, extra, {
				sequenceId: a.sequenceId,
			});
		},
	);

	defineTool(
		ctx,
		'get_text_animators',
		{
			title: 'Get text animators',
			description:
				'The animators of a text clip: ids, names, enabled, property keys with their values at the clip start (and keyframe counts), selectors with their settings; Path Options, More Options and per-character 3D.',
			input: { projectId: ProjectIdArg, clipId: z.string().min(1) },
			annotations: READ_ONLY,
		},
		async (a) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const { clip } = textClipOf(doc, a.clipId);
			const t = clip.sourceIn;
			const show = (v: unknown): unknown => {
				if (v && typeof v === 'object' && 'keyframes' in (v as object)) {
					const anim = v as { keyframes: unknown[]; expression?: unknown };
					return {
						value: evaluate(v as never, t),
						...(anim.keyframes.length ? { keyframes: anim.keyframes.length } : {}),
						...(anim.expression ? { expression: anim.expression } : {}),
					};
				}
				if (v && typeof v === 'object' && !Array.isArray(v))
					return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, show(x)]));
				return v;
			};
			const c = clip as Clip & { pathOptions?: unknown; moreOptions?: unknown; perCharacter3d?: boolean };
			return jsonResult({
				clipId: a.clipId,
				perCharacter3d: !!c.perCharacter3d,
				pathOptions: c.pathOptions ? show(c.pathOptions) : null,
				moreOptions: c.moreOptions ? show(c.moreOptions) : null,
				animators: (clip.animators ?? []).map((an) => ({
					id: an.id,
					name: an.name,
					enabled: an.enabled,
					properties: show(an.properties),
					selectors: an.selectors.map((s) => ({ ...(show(s) as object) })),
					keyPrefix: `["clip", "${a.clipId}", "textAnimators", "${an.id}", …]`,
				})),
			});
		},
	);

	defineTool(
		ctx,
		'remove_text_animators',
		{
			title: 'Remove text animators',
			description: 'Removes animators from a text clip (all of them without animatorIds).',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1),
				animatorIds: z.array(z.string().min(1)).min(1).max(100).optional(),
			},
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const { clip } = textClipOf(doc, a.clipId);
			const ids = a.animatorIds ?? (clip.animators ?? []).map((x) => x.id);
			if (!ids.length) return jsonResult({ ok: true, removed: [] });
			return applyHelper(
				ctx,
				a.projectId,
				'Remove Text Animators',
				[{ type: 'textAnimator.remove', clipId: a.clipId, animatorIds: ids }],
				extra,
			);
		},
	);

	defineTool(
		ctx,
		'set_text_path',
		{
			title: 'Set text path',
			description:
				'Puts the characters of a text clip on a path (AE Path Options): an existing mask of the clip (maskId) or a new guide mask (mode none) from `points` (corner vertices) or a Bezier `path` ({closed, vertices: [{p, in, out}]}) — normalised to the text box (0..1) unless units "px". maskId null removes the path (the mask stays).',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1),
				maskId: z.string().min(1).nullable().optional(),
				points: z
					.array(z.tuple([z.number(), z.number()]))
					.min(2)
					.max(500)
					.optional(),
				path: z
					.object({
						closed: z.boolean(),
						vertices: z
							.array(
								z.object({
									p: z.tuple([z.number(), z.number()]),
									in: z.tuple([z.number(), z.number()]),
									out: z.tuple([z.number(), z.number()]),
								}),
							)
							.min(2)
							.max(500),
					})
					.optional(),
				closed: z.boolean().optional().describe('With points: a closed path (default false)'),
				units: z.enum(['normalized', 'px']).optional(),
				reversePath: z.boolean().optional(),
				perpendicularToPath: z.boolean().optional(),
				forceAlignment: z.boolean().optional(),
				firstMargin: z.number().optional(),
				lastMargin: z.number().optional(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) => {
			const options = {
				...(a.reversePath !== undefined ? { reversePath: a.reversePath } : {}),
				...(a.perpendicularToPath !== undefined ? { perpendicularToPath: a.perpendicularToPath } : {}),
				...(a.forceAlignment !== undefined ? { forceAlignment: a.forceAlignment } : {}),
				...(a.firstMargin !== undefined ? { firstMargin: a.firstMargin } : {}),
				...(a.lastMargin !== undefined ? { lastMargin: a.lastMargin } : {}),
			};
			if (a.maskId === null)
				return applyHelper(
					ctx,
					a.projectId,
					'Text Path Options',
					[{ type: 'text.setPathOptions', clipIds: [a.clipId], maskId: null }],
					extra,
				);
			const commands: unknown[] = [];
			let maskId: string | undefined = a.maskId ?? undefined;
			if (a.points || a.path) {
				const { doc } = await loadDoc(ctx, a.projectId);
				const { clip } = textClipOf(doc, a.clipId);
				const box = (clip as { box: { width: number; height: number } }).box;
				const norm = (q: [number, number]): [number, number] =>
					a.units === 'px' ? [q[0] / Math.max(1, box.width), q[1] / Math.max(1, box.height)] : q;
				const scaleH = (h: [number, number]): [number, number] =>
					a.units === 'px' ? [h[0] / Math.max(1, box.width), h[1] / Math.max(1, box.height)] : h;
				const path = a.path
					? {
							closed: a.path.closed,
							vertices: a.path.vertices.map((v) => ({ p: norm(v.p), in: scaleH(v.in), out: scaleH(v.out) })),
						}
					: { closed: !!a.closed, vertices: a.points!.map((q) => ({ p: norm(q), in: [0, 0], out: [0, 0] })) };
				commands.push({
					type: 'mask.add',
					clipId: a.clipId,
					shape: 'bezier',
					path,
					mode: 'none',
					name: 'Text Path',
					ref: '$path',
				});
				maskId = '$path';
			}
			if (!maskId && Object.keys(options).length === 0)
				throw new ToolError(
					'E_INVALID_PARAM',
					'Give maskId, points or path (or options to change)',
					'See the tool description.',
				);
			commands.push({
				type: 'text.setPathOptions',
				clipIds: [a.clipId],
				...(maskId ? { maskId } : {}),
				...options,
			});
			return applyHelper(ctx, a.projectId, 'Text Path Options', commands, extra);
		},
	);

	defineTool(
		ctx,
		'convert_text_animation',
		{
			title: 'Convert text animation to animators',
			description:
				'Turns the In/Out text animations (set_text_animation presets) of text clips into the equivalent animator presets with the same windows (Out ending on the clip end) and removes them.',
			input: {
				projectId: ProjectIdArg,
				clipIds: z.union([z.array(z.string()).min(1).max(500), z.literal('$selection')]),
			},
			annotations: EDIT,
		},
		async (a, extra) =>
			applyHelper(
				ctx,
				a.projectId,
				'Convert Text Animation to Animators',
				[{ type: 'textAnimator.convertLegacy', clipIds: a.clipIds }],
				extra,
			),
	);
}
