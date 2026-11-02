// One-click Trim Paths animations for agents (docs/wp-notes/shapes.md § 12, docs/wp-notes/expressions.md § 1.9):
// animate_trim_paths (shape.animateTrim, optionally + shape.addTrimTracer in the same transaction),
// reverse_path_direction, add_line, add_trim_tracer.
import {
	clipKeyframesQuery,
	defaultRegistries,
	type ProjectDocument,
	parseTimecode,
	type Rational,
	type Sequence,
	TRIM_ANIMATION_LIMITS,
	TRIM_ANIMATION_STYLES,
	TrackRefSchema,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg, TIME_HINT, timeArg } from '../arguments.ts';
import {
	DESTRUCTIVE,
	defineTool,
	EDIT,
	frameOf,
	loadDoc,
	requireOk,
	type ToolContext,
	transact,
	txBody,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { pickSequence } from '../format.ts';
import { CurveArg, parseCubicCurveArg } from './ease.ts';
import { applyHelper, hexToRgba } from './editing.ts';

export const TRIM_PATHS_GUIDE = `Trim Paths animations (vector shapes):
- animate_trim_paths {clipIds, style, reverse?, animateOffset?, duration?, at?, curve?, offsetDegrees?, copies?, inOutLag?, tracer?} draws strokes on / off in one undoable step. Styles: in (draws on from the path start), out (erases from the start), inOut (draws on, the tail follows inOutLag × duration later, 0 < lag ≤ 1, default 0.5), middleIn / middleOut (grow from / shrink to the middle), divideIn / divideOut (the contents split into \`copies\` parts, default 4, drawing together). reverse runs from the other end; animateOffset also turns the Offset by offsetDegrees (default 180 = half the length). duration = one segment (default 10 frames; frames, {"seconds": x} or "HH:MM:SS:FF"); at = the first key (default each clip's start). curve: a cubic preset id or "cubic-bezier(…)" replaces the default eases (draw on cubic-bezier(⅓, ⅓, ⅔, 1), wipe off cubic-bezier(⅓, 0, ⅔, ⅔)); multi-point presets are refused.
- One trim goes last in the clip's top-level contents, so it trims every path; rectangle / ellipse clips are converted to vector shapes first; other clips are skipped (W_TRIM_SKIPPED). Running it again on a clip REPLACES the earlier animation (its trim is reused, earlier divide parts merged back) — never stacks.
- Paths run in their Path Direction: reverse_path_direction {clipIds} toggles it on every path (rectangles / ellipses: convert_shape_to_vector first). add_line {orientation, length?, strokeWidth?, color?…} adds a stroked straight line clip to animate.
- tracer: true (or {tip?, orient?, name?}) adds, in the SAME transaction, a follower riding each clip's moving trim tip: a small "Tracer" dot on the track above whose Position (and Rotation with orient) is an id-addressed expression. tip auto (default) follows the end that animates most; inOut tracers follow End. add_trim_tracer {clipId, trimItemId?, pathItemId?, tip?, followerClipId?, orient?} does it for an existing trim (default: the clip's master trim) or drives an existing clip; it replaces the follower's Position / Rotation expression (W_EXPRESSION_REPLACED).
- Check with get_shape / get_clip_properties (the trim's Start / End / Offset keys and eases) and render_frames {clipId} (strokes and the tracer render in the preview and every export path).`;

const IdArg = z.string().min(1);
const REGISTRIES = defaultRegistries();

const TracerArg = z
	.union([
		z.boolean(),
		z.strictObject({
			tip: z
				.enum(['start', 'end', 'auto'])
				.optional()
				.describe('Which end of the stroke to follow (default auto: the one that animates most)'),
			orient: z.boolean().optional().describe('Also rotate the dot along the path'),
			name: z.string().min(1).max(200).optional().describe('Follower clip name (default "Tracer")'),
		}),
	])
	.describe("Also add a follower dot riding the moving tip of each clip's trim (same undo step)");

/** A length in sequence frames: frames, {frames}, {seconds} or a timecode counted from 0. */
function durationFrames(seq: Sequence, input: unknown): number {
	let frames: number;
	if (typeof input === 'string') {
		const f = parseTimecode(input, seq.settings.frameRate as Rational, {
			dropFrame: input.includes(';') || seq.settings.dropFrame,
		});
		if (f === null) throw new ToolError('E_INVALID_PARAM', `Invalid timecode: ${input}`, TIME_HINT);
		frames = f;
	} else frames = frameOf(seq, input);
	if (frames < 1)
		throw new ToolError(
			'E_INVALID_PARAM',
			'duration must be at least one frame',
			'e.g. 15, {"seconds": 0.5}.',
		);
	return frames;
}

function sequenceOfClip(doc: ProjectDocument, clipId: string | undefined, sequenceId?: string): Sequence {
	const own = clipId ? Object.values(doc.sequences).find((s) => s.clips[clipId]) : undefined;
	return own ?? pickSequence(doc, sequenceId);
}

type AnimatedClip = {
	clipId: string;
	converted: boolean;
	trimIds: string[];
	groupIds: string[];
	partIds: string[];
};
type TracerResult = { clipId: string; created: boolean; trackId: string; trimItemId: string; tip: string };

/** The master trim's Start / End / Offset keys of a clip (sequence frames, timecodes, eases). */
function trimKeys(doc: ProjectDocument, clipId: string, trimId: string) {
	try {
		return clipKeyframesQuery(
			{ doc, effects: REGISTRIES.effects },
			{ clipId, keys: [`shape.items.${trimId}`] },
		).properties.map((p) => ({ key: p.key, keyframes: p.keyframes }));
	} catch {
		return [];
	}
}

export function registerTrimPathTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'animate_trim_paths',
		{
			title: 'Animate Trim Paths',
			description:
				"One-click stroke animation of shape clips (shape.animateTrim, one undoable step): a Trim Paths last in each clip's contents keyed for `style` (in, out, inOut, middleIn, middleOut, divideIn, divideOut) over `duration` from `at`. Re-running on a clip replaces its earlier animation. tracer adds a follower dot riding the moving tip in the same transaction. Returns per clip the trim ids, its Start / End / Offset keys (frames, timecodes, eases), the parts of divide styles and the tracers; skipped clips come back as W_TRIM_SKIPPED.",
			input: {
				projectId: ProjectIdArg,
				clipIds: z
					.array(IdArg)
					.min(1)
					.max(1000)
					.describe('Shape clips (rectangles / ellipses are converted to vector shapes)'),
				style: z
					.enum(TRIM_ANIMATION_STYLES)
					.describe('in | out | inOut | middleIn | middleOut | divideIn | divideOut'),
				reverse: z
					.boolean()
					.optional()
					.describe('Run from the path end (middle styles: from / to both ends)'),
				animateOffset: z.boolean().optional().describe('Also turn the Offset over the animation'),
				duration: timeArg('Length of one draw / erase segment (default 10 frames)').optional(),
				offsetDegrees: z
					.number()
					.min(-TRIM_ANIMATION_LIMITS.offsetDegrees)
					.max(TRIM_ANIMATION_LIMITS.offsetDegrees)
					.optional()
					.describe('Offset turn with animateOffset (default 180 = half the path length)'),
				copies: z
					.number()
					.int()
					.min(TRIM_ANIMATION_LIMITS.minCopies)
					.max(TRIM_ANIMATION_LIMITS.maxCopies)
					.optional()
					.describe('divideIn / divideOut: number of parts (default 4)'),
				inOutLag: z
					.number()
					.gt(0)
					.max(1)
					.optional()
					.describe('inOut: delay of the tail as a fraction of duration, 0 < lag ≤ 1 (default 0.5)'),
				at: timeArg("Sequence time of the first key (default: each clip's start)").optional(),
				curve: CurveArg.optional().describe(
					'Replaces the default eases: a cubic preset id (list_ease_presets) or "cubic-bezier(x1, y1, x2, y2)" / {x1, y1, x2, y2}; multi-point curves are refused',
				),
				tracer: TracerArg.optional(),
				sequenceId: SequenceIdArg,
			},
			annotations: DESTRUCTIVE,
		},
		async (a, extra) => {
			const curve = a.curve !== undefined ? parseCubicCurveArg(a.curve) : undefined;
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = sequenceOfClip(doc, a.clipIds[0], a.sequenceId);
			const animate = {
				type: 'shape.animateTrim',
				clipIds: a.clipIds,
				style: a.style,
				...(a.reverse !== undefined ? { reverse: a.reverse } : {}),
				...(a.animateOffset !== undefined ? { animateOffset: a.animateOffset } : {}),
				...(a.duration !== undefined
					? {
							durationFrames: Math.min(TRIM_ANIMATION_LIMITS.durationFrames, durationFrames(seq, a.duration)),
						}
					: {}),
				...(a.offsetDegrees !== undefined ? { offsetDegrees: a.offsetDegrees } : {}),
				...(a.copies !== undefined ? { copies: a.copies } : {}),
				...(a.inOutLag !== undefined ? { inOutLag: a.inOutLag } : {}),
				...(a.at !== undefined ? { at: frameOf(seq, a.at) } : {}),
				...(curve ? { curve: curve.curve } : {}),
			};
			const commands: Record<string, unknown>[] = [animate];
			const tracer: { tip?: string; orient?: boolean; name?: string } | null =
				a.tracer === true ? {} : a.tracer || null;
			if (tracer) {
				// Which clips the animation applies to is the command's decision (skipped clips warn): dry-run it, then add a
				// tracer for each animated clip in the same transaction, so the whole thing is one History entry.
				const probe = requireOk(
					await transact(
						ctx,
						a.projectId,
						{ label: 'Trim Paths', commands: [animate], dryRun: true, sequenceId: a.sequenceId },
						extra,
					),
				);
				const animated = ((probe.results[0] as { clips?: AnimatedClip[] } | undefined)?.clips ?? []).map(
					(c) => c.clipId,
				);
				for (const clipId of animated)
					commands.push({
						type: 'shape.addTrimTracer',
						clipId,
						...(tracer.tip ? { tip: tracer.tip } : {}),
						...(tracer.orient ? { orient: true } : {}),
						...(tracer.name ? { name: tracer.name } : {}),
					});
			}
			const res = await transact(
				ctx,
				a.projectId,
				{
					label: `Trim Paths: ${a.style}${a.reverse ? ' (reverse)' : ''}${tracer ? ' + Tracer' : ''}`,
					commands,
					sequenceId: a.sequenceId,
				},
				extra,
			);
			const r = requireOk(res);
			const main = (r.results[0] ?? { clips: [], skipped: [] }) as {
				clips: AnimatedClip[];
				skipped: string[];
			};
			const tracers = r.results.slice(1) as TracerResult[];
			const after = (await loadDoc(ctx, a.projectId)).doc;
			return jsonResult({
				...txBody(res, r),
				clips: main.clips.map((c) => {
					const t = tracers.find((x) => x.trimItemId === c.trimIds[0]);
					return {
						clipId: c.clipId,
						converted: c.converted,
						trimId: c.trimIds[0],
						...(c.partIds.length ? { partIds: c.partIds, partTrimIds: c.trimIds.slice(1) } : {}),
						keys: trimKeys(after, c.clipId, c.trimIds[0]!),
						...(t ? { tracer: { clipId: t.clipId, trackId: t.trackId, tip: t.tip } } : {}),
					};
				}),
				...(main.skipped.length ? { skipped: main.skipped } : {}),
			});
		},
	);

	defineTool(
		ctx,
		'reverse_path_direction',
		{
			title: 'Reverse path direction',
			description:
				'Toggles the Path Direction (normal ↔ reversed) of every path of vector shape clips (shape.reversePathDirection, one undoable step): Trim Paths then draw from the other end. Calling it twice restores the paths. Rectangle / ellipse clips are skipped (convert_shape_to_vector first).',
			input: {
				projectId: ProjectIdArg,
				clipIds: z.array(IdArg).min(1).max(1000).describe('Vector shape clip ids'),
			},
			annotations: EDIT,
		},
		async (a, extra) =>
			applyHelper(
				ctx,
				a.projectId,
				'Reverse Path Direction',
				[{ type: 'shape.reversePathDirection', clipIds: a.clipIds }],
				extra,
			),
	);

	defineTool(
		ctx,
		'add_line',
		{
			title: 'Add line',
			description:
				"Adds a straight stroked line as a vector shape clip (shape.addLine): centred in the frame with its anchor on the line's centre, ready for animate_trim_paths. Defaults: 60 % of the frame width (horizontal) or height (vertical), 8 px white, at 0 for 5 s, on the top video track when it is free (else a new track on top).",
			input: {
				projectId: ProjectIdArg,
				orientation: z.enum(['horizontal', 'vertical']),
				length: z.number().gt(0).max(32768).optional().describe('Length in pixels'),
				strokeWidth: z.number().gt(0).max(4096).optional().describe('Stroke width in pixels (default 8)'),
				color: z.string().optional().describe('Stroke colour "#RRGGBB" or "#RRGGBBAA" (default white)'),
				at: timeArg('Start time (default 0)').optional(),
				duration: timeArg('Length (default 5 s)').optional(),
				track: TrackRefSchema.optional().describe(
					'Video track (default: the top one when free, else a new track)',
				),
				name: z.string().min(1).max(200).optional().describe('Clip name (default "Line")'),
				sequenceId: SequenceIdArg,
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const frames =
				a.duration !== undefined
					? durationFrames(
							sequenceOfClip((await loadDoc(ctx, a.projectId)).doc, undefined, a.sequenceId),
							a.duration,
						)
					: undefined;
			return applyHelper(
				ctx,
				a.projectId,
				'Line',
				[
					{
						type: 'shape.addLine',
						orientation: a.orientation,
						...(a.length !== undefined ? { length: a.length } : {}),
						...(a.strokeWidth !== undefined ? { strokeWidth: a.strokeWidth } : {}),
						...(a.color !== undefined ? { color: hexToRgba(a.color) } : {}),
						...(a.at !== undefined ? { at: a.at } : {}),
						...(frames !== undefined ? { durationFrames: frames } : {}),
						...(a.track !== undefined ? { trackId: a.track } : {}),
						...(a.name ? { name: a.name } : {}),
						...(a.sequenceId ? { sequenceId: a.sequenceId } : {}),
					},
				],
				extra,
			);
		},
	);

	defineTool(
		ctx,
		'add_trim_tracer',
		{
			title: 'Add trim tracer',
			description: 'Make a follower ride the moving tip of a Trim Paths.',
			details:
				'Makes a follower ride the moving tip of a Trim Paths (shape.addTrimTracer, one undoable step): its Position (and Rotation with orient) becomes an id-addressed expression computing the tip in sequence pixels every frame (Start / End and Offset as rendered, through the group transforms and the shape clip\'s Motion). Without followerClipId a 12 px "Tracer" dot clip is created on the track above the shape clip over the same span. trimItemId defaults to the clip\'s master trim (the one animate_trim_paths animates). An existing Position / Rotation expression on the follower is replaced (W_EXPRESSION_REPLACED).',
			input: {
				projectId: ProjectIdArg,
				clipId: IdArg.describe('Vector shape clip holding the Trim Paths'),
				trimItemId: IdArg.optional().describe(
					'Trim Paths item id ("shp_…", get_shape); default: the master trim',
				),
				pathItemId: IdArg.optional().describe(
					'Path to follow among those the trim affects (default: the first)',
				),
				tip: z.enum(['start', 'end', 'auto']).optional().describe('Which end to follow (default auto)'),
				followerClipId: IdArg.optional().describe(
					'Drive this existing visual clip of the same sequence instead of a new dot',
				),
				orient: z.boolean().optional().describe('Also rotate the follower along the path'),
				name: z.string().min(1).max(200).optional().describe('Name of the created dot (default "Tracer")'),
			},
			annotations: EDIT,
		},
		async (a, extra) =>
			applyHelper(
				ctx,
				a.projectId,
				'Trim Tracer',
				[
					{
						type: 'shape.addTrimTracer',
						clipId: a.clipId,
						...(a.trimItemId ? { trimItemId: a.trimItemId } : {}),
						...(a.pathItemId ? { pathItemId: a.pathItemId } : {}),
						...(a.tip ? { tip: a.tip } : {}),
						...(a.followerClipId ? { follower: { clipId: a.followerClipId } } : {}),
						...(a.orient ? { orient: true } : {}),
						...(a.name ? { name: a.name } : {}),
					},
				],
				extra,
			),
	);
}
