// M2 MCP tools for text animators (S11:ANA-002/004, ARCHITECTURE §20.7): list_text_animations (the preset
// catalogue), set_text_animation (in/out presets, durations, params; null removes; one clip.update = one
// "Agent: <label>" History entry) and render_frames (a contact sheet of Program frames to see motion).
// `add_text` animateIn/animateOut (editing.ts) reuse AnimateArg and textAnimationOf.
import {
	fpsOf,
	latestTextAnimationSpec,
	type MgCompositionInfo,
	type ProjectDocument,
	type Sequence,
	sequenceDuration,
	sequenceTimecode,
	TEXT_ANIMATION_REFERENCE_FPS,
	TEXT_ANIMATION_SIDES,
	TEXT_ANIMATION_SPECS,
	type TextAnimationSide,
	TimeInputSchema,
	toJsonSchema,
} from '@jasper/project';
import { z } from 'zod';
import {
	defineTool,
	EDIT,
	frameOf,
	loadDoc,
	progressReporter,
	READ_ONLY,
	requireOk,
	type ToolContext,
	transact,
	txBody,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { clipSummary, pickSequence } from '../format.ts';
import { composeGrid, decodePng, encodePng } from '../png.ts';
import { propsSummary } from './compositions.ts';
import { ProjectIdArg } from './projects.ts';

/** Appended to the server instructions (EDITING_GUIDE). */
export const ANIMATION_GUIDE = `Text animation:
- Text clips can have an In and an Out animator (list_text_animations: fade, slide-*, pop, blur, typewriter, tracking, mask-reveal, rotate-in, drop). Set them with add_text animateIn/animateOut or set_text_animation {clipId(s), in, out}; null removes a side, an object without preset only changes the current side's length or params.
- In plays over the clip's first visible frames, Out over its last ones (Out is the mirrored In motion), whatever the clip's trims. Lengths default to the preset's (at the sequence rate); give durationFrames or durationSeconds. When In + Out do not fit the clip with one frame left at rest both are scaled to fit (warning W_ANIMATION_COMPRESSED): lengthen the clip or shorten them.
- Params: unit (char | word | line) is the animated piece, stagger (0…1) the fraction of the window spread across units (0 = all together), order (forward, backward, center, edges, random) who starts first, ease the per-unit easing; distance/blur/scale/angle are preset-specific.
- Splitting an animated clip keeps In on the left part and Out on the right part. get_timeline shows the animators as in:<preset> out:<preset>.
- Check the motion with render_frames {clipId, count}: one contact-sheet PNG of evenly spread frames.`;

/** Every argument describing one animator side, as add_text and set_text_animation take it. */
const animatorShape = {
	preset: z.string().min(1).describe('Preset id from list_text_animations, e.g. "slide-up"'),
	durationFrames: z
		.number()
		.int()
		.min(1)
		.max(3600)
		.optional()
		.describe('Window length in sequence frames (default: the preset default at the sequence rate)'),
	durationSeconds: z
		.number()
		.positive()
		.max(120)
		.optional()
		.describe('Window length in seconds, instead of durationFrames'),
	params: z
		.record(z.string(), z.unknown())
		.optional()
		.describe(
			'Preset params (list_text_animations), e.g. {"unit": "char", "stagger": 0.5}; omitted ones use the preset defaults',
		),
};

/** add_text animateIn / animateOut: a preset id or {preset, durationFrames | durationSeconds, params}. */
export const AnimateArg = z.union([z.string().min(1), z.strictObject(animatorShape)]);

const SidePatchArg = z
	.union([
		z.string().min(1),
		z.strictObject({
			...animatorShape,
			preset: animatorShape.preset
				.optional()
				.describe(
					'Preset id (list_text_animations); replaces the side with fresh preset defaults. Omit it to only change the length/params of the current side',
				),
		}),
	])
	.nullable();

export type AnimatorArg = z.infer<typeof SidePatchArg>;
type Sides = Partial<Record<TextAnimationSide, AnimatorArg>>;
/** One side of clip.addText / clip.update `textAnimation`. */
export type AnimatorCommand = { preset?: string; durationFrames?: number; params?: Record<string, unknown> };

/** A side argument as the commands take it: a bare id → {preset}, seconds → frames at `fps` (round, ≥ 1). */
export function animatorCommand(arg: Exclude<AnimatorArg, null>, fps: number): AnimatorCommand {
	if (typeof arg === 'string') return { preset: arg };
	const { durationSeconds, ...rest } = arg;
	if (durationSeconds === undefined) return rest;
	if (rest.durationFrames !== undefined)
		throw new ToolError(
			'E_INVALID_PARAM',
			'Give durationFrames or durationSeconds, not both',
			'Use one of them per side.',
		);
	return { ...rest, durationFrames: Math.max(1, Math.round(durationSeconds * fps)) };
}

/** The sequence a clip lives in (else the given / first one), as a tool error when missing. */
export function sequenceFor(doc: ProjectDocument, opts: { sequenceId?: string; clipId?: string }): Sequence {
	const own = opts.clipId ? Object.values(doc.sequences).find((s) => s.clips[opts.clipId!]) : undefined;
	if (own) return own;
	try {
		return pickSequence(doc, opts.sequenceId);
	} catch (e) {
		throw new ToolError('E_NOT_FOUND', (e as Error).message, 'Call get_project for sequence ids.');
	}
}

/** Where a tool's transaction applies the animators: one clip, the editor selection, or a new clip. */
export type AnimationTarget = { sequenceId?: string; clipId?: string; selection?: boolean };

/**
 * The sequence whose frame rate converts durationSeconds, resolved as the transaction resolves its target:
 * clip.update finds the clip in any sequence (for "$selection" the editor's selected clips), clip.addText uses the
 * given sequence, else the project's only one — with several and no sequenceId the transaction fails, so does this.
 */
export async function targetSequence(
	ctx: ToolContext,
	projectId: string,
	doc: ProjectDocument,
	where: AnimationTarget,
): Promise<Sequence> {
	const seqOf = (id: string) => Object.values(doc.sequences).find((s) => s.clips[id]);
	if (where.clipId) {
		const own = seqOf(where.clipId);
		if (!own)
			throw new ToolError(
				'E_NOT_FOUND',
				`Clip not found: ${where.clipId}`,
				'get_timeline lists text clip ids.',
			);
		return own;
	}
	if (where.selection) {
		const sel = await ctx
			.engine((c) => c.agentQuery({ projectId, query: 'selection.get', args: {} }))
			.then(
				(r) => (r.result as { selection?: { timeline?: { clips?: unknown } } }).selection?.timeline?.clips,
			)
			.catch(() => undefined);
		const own = (Array.isArray(sel) ? sel : [])
			.map((id) => (typeof id === 'string' ? seqOf(id) : undefined))
			.find((s) => s);
		if (own) return own;
	}
	if (where.sequenceId) return sequenceFor(doc, { sequenceId: where.sequenceId });
	const all = Object.values(doc.sequences);
	if (all.length === 1) return all[0]!;
	throw new ToolError(
		'E_INVALID_PARAM',
		all.length
			? 'sequenceId is required when the project has several sequences'
			: 'The project has no sequence',
		'Call get_project for sequence ids.',
	);
}

/**
 * The `textAnimation` of a command from the tool's side arguments (undefined when none is given). The document
 * is only loaded when a side gives durationSeconds (converted at the frame rate of the sequence the transaction
 * targets, `targetSequence`).
 */
export async function textAnimationOf(
	ctx: ToolContext,
	projectId: string,
	sides: Sides,
	where: AnimationTarget,
): Promise<Partial<Record<TextAnimationSide, AnimatorCommand | null>> | undefined> {
	const given = TEXT_ANIMATION_SIDES.filter((s) => sides[s] !== undefined);
	if (!given.length) return undefined;
	const seconds = given.some((s) => {
		const a = sides[s];
		return typeof a === 'object' && a?.durationSeconds !== undefined;
	});
	const fps = seconds
		? fpsOf(
				(await targetSequence(ctx, projectId, (await loadDoc(ctx, projectId)).doc, where)).settings.frameRate,
			)
		: 0;
	const out: Partial<Record<TextAnimationSide, AnimatorCommand | null>> = {};
	for (const s of given) {
		const a = sides[s]!;
		out[s] = a === null ? null : animatorCommand(a, fps);
	}
	return out;
}

/** History label, e.g. "Text Animation: in Slide Up, out none". */
export function animationLabel(patch: Partial<Record<TextAnimationSide, AnimatorCommand | null>>): string {
	const parts = TEXT_ANIMATION_SIDES.flatMap((s) => {
		const a = patch[s];
		if (a === undefined) return [];
		if (a === null) return [`${s} none`];
		return [`${s} ${a.preset ? (latestTextAnimationSpec(a.preset)?.label ?? a.preset) : 'timing'}`];
	});
	return `Text Animation: ${parts.join(', ')}`;
}

/** The list_text_animations catalogue (pure): every preset with its default length and a params summary. */
export function textAnimationCatalogue() {
	return {
		referenceFps: TEXT_ANIMATION_REFERENCE_FPS,
		presets: TEXT_ANIMATION_SPECS.map((s) => ({
			id: s.id,
			version: s.version,
			label: s.label,
			category: s.category,
			phases: s.phases,
			description: s.description,
			defaultDurationFrames: s.defaultDurationFrames,
			defaultDurationSeconds:
				Math.round((s.defaultDurationFrames / TEXT_ANIMATION_REFERENCE_FPS) * 1000) / 1000,
			// Same compact {type, enum, minimum, maximum, description, default} view as composition props.
			params: propsSummary({
				propsSchema: toJsonSchema(s.paramsSchema),
				defaultProps: s.defaults,
			} as MgCompositionInfo),
		})),
	};
}

/** Text-animation hints for the codes whose generic hint is about something else. */
const HINTS: Record<string, string> = {
	E_UNKNOWN_EFFECT: `Text animation presets: ${TEXT_ANIMATION_SPECS.map((s) => s.id).join(', ')} (list_text_animations).`,
	E_INVALID_PARAM:
		'Check the params against list_text_animations (names, enums, ranges). A side without preset needs an existing animation on that side; text animations only apply to text clips.',
	E_NOT_FOUND: 'Look clip ids up with get_timeline.',
};

/** At most this many frames per contact sheet, and at most this many pixels per sheet side. */
export const MAX_SHEET_FRAMES = 24;
export const MAX_SHEET_SIZE = 2048;
const SHEET_GAP = 4;

/** `count` frames spread evenly over [from, to) (first and last frame included, duplicates dropped). */
export function spreadFrames(from: number, to: number, count: number): number[] {
	const last = Math.max(from, to - 1);
	if (count <= 1) return [from];
	const out = new Set<number>();
	for (let i = 0; i < count; i++) out.add(from + Math.round((i * (last - from)) / (count - 1)));
	return [...out];
}

/**
 * Cell width that keeps a `columns` × `rows` sheet of `aspect` (w/h) frames within MAX_SHEET_SIZE on both
 * sides (never above `width`, never below 64).
 */
export function sheetCellWidth(width: number, columns: number, rows: number, aspect: number): number {
	const byWidth = Math.floor((MAX_SHEET_SIZE - (columns + 1) * SHEET_GAP) / columns);
	const byHeight = Math.floor(((MAX_SHEET_SIZE - (rows + 1) * SHEET_GAP) / rows) * aspect);
	return Math.max(64, Math.min(width, byWidth, byHeight));
}

const TIMES = 'Sequence time as frames (integer), {"frames": n}, {"seconds": x} or timecode "HH:MM:SS:FF"';

export function registerAnimationTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'list_text_animations',
		{
			title: 'List text animations',
			description:
				'The text animator presets for add_text animateIn/animateOut and set_text_animation: id, version, label, category, phases (every preset works as in and out; out plays the mirrored motion), description, default length (frames at 30 fps, scaled to the sequence rate on apply, and seconds) and params with their type, allowed values or range, description and default.',
			input: {},
			annotations: READ_ONLY,
		},
		async () => jsonResult(textAnimationCatalogue()),
	);

	defineTool(
		ctx,
		'set_text_animation',
		{
			title: 'Set text animation',
			description:
				"Sets, changes or removes the In and/or Out animator of text clips in one undoable step (clip.update textAnimation). Each side: null removes it; a preset id or {preset, durationFrames | durationSeconds, params} replaces it (params start from the preset defaults); {durationFrames | durationSeconds, params} without preset changes the current side (params merged). Sides you omit stay as they are. In covers the clip's first frames, Out its last ones; when they overlap both are scaled to fit (warning W_ANIMATION_COMPRESSED). Returns the clips with their animators.",
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1).optional().describe('Text clip id ("clp_…") from get_timeline'),
				clipIds: z
					.union([z.array(z.string().min(1)).min(1).max(1000), z.literal('$selection')])
					.optional()
					.describe('Several text clip ids, or "$selection" for the clips selected in the open editor'),
				in: SidePatchArg.optional().describe(
					'In animator: a preset id, {preset?, durationFrames | durationSeconds, params}, or null to remove it',
				),
				out: SidePatchArg.optional().describe(
					'Out animator (the mirrored motion at the clip end): same forms as `in`',
				),
				sequenceId: z
					.string()
					.optional()
					.describe('Sequence id ("seq_…") for "$selection"; default: the sequence of the clips'),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			if ((a.clipId === undefined) === (a.clipIds === undefined))
				throw new ToolError('E_INVALID_PARAM', 'Give clipId or clipIds', 'get_timeline lists text clip ids.');
			const ids = a.clipIds ?? [a.clipId!];
			const first = ids === '$selection' ? undefined : ids[0];
			const patch = await textAnimationOf(
				ctx,
				a.projectId,
				{ in: a.in, out: a.out },
				{ sequenceId: a.sequenceId, clipId: first, selection: ids === '$selection' },
			);
			if (!patch)
				throw new ToolError(
					'E_INVALID_PARAM',
					'Nothing to change',
					'Pass in and/or out (null removes a side).',
				);
			const res = await transact(
				ctx,
				a.projectId,
				{
					label: animationLabel(patch),
					commands: [
						{
							type: 'clip.update',
							...(a.clipIds ? { clipIds: a.clipIds } : { clipId: a.clipId }),
							patch: { textAnimation: patch },
						},
					],
					sequenceId: a.sequenceId,
				},
				extra,
			);
			let r: ReturnType<typeof requireOk>;
			try {
				r = requireOk(res);
			} catch (e) {
				if (e instanceof ToolError && HINTS[e.code])
					throw new ToolError(e.code, e.message, HINTS[e.code], e.details);
				throw e;
			}
			const { doc } = await loadDoc(ctx, a.projectId);
			const clips = [];
			for (const seq of Object.values(doc.sequences))
				for (const id of r.changed) {
					const clip = seq.clips[id];
					if (clip?.kind === 'text')
						clips.push({ ...clipSummary(doc, seq, clip), textAnimation: clip.textAnimation ?? null });
				}
			return jsonResult({ ...txBody(res, r), clips });
		},
	);

	defineTool(
		ctx,
		'render_frames',
		{
			title: 'Render frames (contact sheet)',
			description: `Renders several Program frames (like render_frame) and returns ONE PNG contact sheet: cells left to right, top to bottom, plus a JSON list of each cell's frame and timecode. Give times (up to ${MAX_SHEET_FRAMES}) or count (default 6) frames spread evenly from \`from\` to \`to\` (default: the clip given by clipId, else the whole sequence; first and last frame included). Use it to see motion: text animations, transitions, motion graphics. Cells are \`width\` px wide (default 320; reduced so the sheet stays within ${MAX_SHEET_SIZE} px). Uses the live editor state when the project is open; each frame is a separate render, so prefer few frames.`,
			input: {
				projectId: ProjectIdArg,
				times: z
					.array(TimeInputSchema)
					.min(1)
					.max(MAX_SHEET_FRAMES)
					.optional()
					.describe(`Exact times of the frames. ${TIMES}`),
				count: z
					.number()
					.int()
					.min(1)
					.max(MAX_SHEET_FRAMES)
					.optional()
					.describe('Number of evenly spread frames (default 6), instead of times'),
				clipId: z
					.string()
					.min(1)
					.optional()
					.describe('Spread the frames over this clip (default: the whole sequence)'),
				from: TimeInputSchema.optional().describe(`Start of the range for count. ${TIMES}`),
				to: TimeInputSchema.optional().describe(`End of the range for count (exclusive). ${TIMES}`),
				width: z.number().int().min(64).max(640).optional().describe('Cell width in pixels (default 320)'),
				columns: z.number().int().min(1).max(8).optional().describe('Cells per row (default up to 4)'),
				sequenceId: z
					.string()
					.optional()
					.describe('Sequence id ("seq_…"); default: the sequence of clipId, else the first one'),
			},
			annotations: READ_ONLY,
		},
		async (a, extra) => {
			if (a.times && (a.count !== undefined || a.from !== undefined || a.to !== undefined || a.clipId))
				throw new ToolError(
					'E_INVALID_PARAM',
					'Give times, or count with an optional range (from/to or clipId), not both',
				);
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = sequenceFor(doc, { sequenceId: a.sequenceId, clipId: a.clipId });
			let frames: number[];
			if (a.times) frames = a.times.map((t) => frameOf(seq, t));
			else {
				const clip = a.clipId ? seq.clips[a.clipId] : undefined;
				if (a.clipId && !clip)
					throw new ToolError('E_NOT_FOUND', `Clip not found: ${a.clipId}`, 'get_timeline lists clip ids.');
				const from = a.from !== undefined ? frameOf(seq, a.from) : (clip?.start ?? 0);
				const to =
					a.to !== undefined
						? frameOf(seq, a.to)
						: clip
							? clip.start + clip.duration
							: Math.max(1, sequenceDuration(seq));
				if (to <= from) throw new ToolError('E_INVALID_PARAM', '`to` must be after `from`');
				frames = spreadFrames(from, to, a.count ?? 6);
			}
			const columns = Math.min(a.columns ?? 4, frames.length);
			const rows = Math.ceil(frames.length / columns);
			const width = sheetCellWidth(a.width ?? 320, columns, rows, seq.settings.width / seq.settings.height);
			const report = progressReporter(extra);
			const images = [];
			const renderedBy = new Set<string>();
			for (const [i, frame] of frames.entries()) {
				report(i, frames.length, `Rendering frame ${frame} (${i + 1}/${frames.length})`);
				const q = await ctx.engine((c) =>
					c.agentQuery({
						projectId: a.projectId,
						query: 'frame.capture',
						args: { frame, width, sequenceId: seq.id },
					}),
				);
				const r = q.result as { url?: string; renderPath?: string };
				if (!r?.url) throw new ToolError('INTERNAL', `The engine returned no image for frame ${frame}`);
				const { bytes } = await ctx.engine((c) => c.fetchBytes(r.url!));
				images.push(decodePng(bytes));
				if (r.renderPath) renderedBy.add(r.renderPath);
			}
			report(frames.length, frames.length, 'Composing the contact sheet');
			const sheet = composeGrid(images, columns, SHEET_GAP);
			return jsonResult(
				{
					sequenceId: seq.id,
					columns,
					rows: sheet.rows,
					cellWidth: sheet.cellWidth,
					cellHeight: sheet.cellHeight,
					sheet: { width: sheet.width, height: sheet.height },
					cells: frames.map((frame, i) => ({
						cell: i + 1,
						row: Math.floor(i / columns) + 1,
						column: (i % columns) + 1,
						frame,
						timecode: sequenceTimecode(seq, frame),
					})),
					...(renderedBy.size ? { renderedBy: [...renderedBy] } : {}),
				},
				[{ type: 'image', data: encodePng(sheet).toString('base64'), mimeType: 'image/png' }],
			);
		},
	);
}
