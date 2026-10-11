import type { EngineJob, RotoSegmentResult, RotoTraceResponse, VisionModel } from '@jasper/api';
import { EngineError } from '@jasper/engine-client';
import {
	type ClipRoto,
	contentTimeAt,
	findRoto,
	mediaFrameAt,
	type ProjectDocument,
	rotoIsStale,
	rotoMaskCommands,
	rotoResultOf,
	rotoSegmentBody,
	rotoSettingsOf,
	type Sequence,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, TIME_FORMATS, timeArg } from '../arguments.ts';
import {
	DESTRUCTIVE,
	DESTRUCTIVE_IDEMPOTENT,
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
	frameOf,
	isTerminal,
	jobBody,
	loadDoc,
	READ_ONLY,
	requireOk,
	type ToolContext,
	transact,
	txBody,
	waitJob,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';

export const ROTO_GUIDE = `Roto / object mattes (Roto Brush) and face tracking: create_roto selects an object on a video or still clip from points ({x, y, fg} in the clip's media pixels; fg false = exclude), a box [x0, y0, x1, y1] or brush strokes at a sequence time, segments that frame (SAM 2.1 when installed — list_roto_models / install_roto_model, Apache-2.0, ~155 MB — refined by graph cut, else colour graph cut alone) and, with propagate (default true), tracks it through its span (the source frames the clip shows; span to change) by optical flow + re-segmentation; then it adds an Object Matte effect that cuts the clip out (apply "matte", default), an Object Blur ("blur") or nothing ("none"). Check the result with render_frame (Object Matte view "overlay" or "boundary" shows the selection over the picture). Fix a frame with add_roto_strokes (points / strokes / box at that time: fg adds, bg removes) and propagate_roto again (frames before the correction are reused, so it is fast). get_roto reports the span, what is computed, whether it is stale and the area per frame. Exports refuse uncomputed frames (ROTO_NOT_COMPUTED) — propagate first. convert_roto_to_masks turns the matte outline into Opacity masks (still or animated). freeze_roto locks a finished roto. Faces: track_faces finds and tracks every face of a clip (MediaPipe Face Landmarker; install_roto_model "mediapipe-face-landmarker", Apache-2.0) into a faces roto; blur_faces does that and adds Object Blur (gaussian / mosaic / fill) in one step; face_to_keyframes makes a tracked face a planar tracker and bakes position / scale / rotation keyframes onto another clip (a graphic following the face). The matte effects' params (feather, contrast, shiftEdge, reduceChatter, useMotionBlur, decontaminate…, view: final | alpha | overlay | boundary | decontamination) are ordinary effect params (apply_object_matte params or set_effect_param). Keying: the Screen Keyer (Keylight-style), Refine Soft / Hard Matte, Key Cleaner and Advanced Spill Suppressor are effects (add_effect); the Screen Keyer's insideObject / outsideObject take roto ids as garbage / core mattes.`;

const RotoIdArg = z
	.string()
	.min(1)
	.describe('Roto object id ("rto_…") from create_roto / track_faces / get_timeline');
const PointArg = z.object({
	x: z.number(),
	y: z.number(),
	fg: z.boolean().optional().describe('true (default) selects, false excludes'),
	radius: z
		.number()
		.positive()
		.optional()
		.describe('Hard-constraint radius in media px (default 1 % of the picture)'),
});
const StrokeArg = z.object({
	kind: z
		.enum(['fg', 'bg', 'refine', 'refineErase'])
		.describe('fg selects, bg excludes, refine paints the Refine Edge band'),
	radius: z.number().positive().describe('Brush radius in media px'),
	points: z
		.array(z.tuple([z.number(), z.number()]))
		.min(1)
		.describe('Polyline in media px'),
});
const BoxArg = z
	.tuple([z.number(), z.number(), z.number(), z.number()])
	.describe('[x0, y0, x1, y1] in media px: the object lies inside, everything outside is background');
const SettingsArg = z
	.object({
		engine: z.enum(['model', 'classic']).optional().describe('model = SAM 2.1 when installed (default)'),
		quality: z.enum(['standard', 'best']).optional(),
		searchRadius: z
			.number()
			.min(0)
			.max(200)
			.optional()
			.describe('Propagation search radius, media px (default 15)'),
		motionThreshold: z.number().min(0).max(100).optional(),
		motionDamping: z.number().min(0).max(100).optional(),
		edgeMode: z.enum(['off', 'guided', 'closed-form']).optional().describe('Edge matting (default guided)'),
		edgeRadius: z.number().min(0).max(100).optional().describe('Automatic edge band, media px (default 3)'),
		edgeSmooth: z.number().min(0).max(100).optional(),
	})
	.optional();

function engineErr(e: unknown): never {
	if (e instanceof EngineError) {
		const code = (e.detail as { code?: string } | undefined)?.code ?? e.code;
		if (code === 'FACE_MODEL_NOT_INSTALLED')
			throw new ToolError(
				code,
				e.message,
				'Install it with install_roto_model "mediapipe-face-landmarker" (tell the user: Apache-2.0, ~5 MB), then retry.',
			);
		throw new ToolError(code, e.message);
	}
	throw e;
}

function sequenceOf(doc: ProjectDocument, clipId: string): Sequence {
	for (const seq of Object.values(doc.sequences)) if (seq.clips[clipId]) return seq;
	throw new ToolError('E_NOT_FOUND', `Clip not found: ${clipId}`, 'Look clip ids up with get_timeline.');
}

function locate(doc: ProjectDocument, rotoId: string) {
	const loc = findRoto(doc, rotoId);
	if (!loc)
		throw new ToolError(
			'E_NOT_FOUND',
			`Roto object not found: ${rotoId}`,
			'See the clip\'s "rotos" in get_timeline.',
		);
	return loc;
}

function summary(r: ClipRoto) {
	const s = rotoSettingsOf(r);
	return {
		rotoId: r.id,
		name: r.name,
		kind: r.kind,
		span: r.span,
		base: r.base,
		strokes: r.strokes.length,
		boxes: r.boxes?.length ?? 0,
		computed: r.result ? { start: r.result.start, end: r.result.end, model: r.result.model } : null,
		stale: rotoIsStale(r),
		frozen: !!r.frozen,
		faces: r.result?.faces?.map((f) => ({
			faceId: f.id,
			firstFrame: f.startFrame,
			frames: f.present.length,
			seen: f.present.filter((p) => p === 1).length,
		})),
		engine: s.engine,
	};
}

/** Runs (or waits for) a roto job and commits its result. */
async function runRoto(
	ctx: ToolContext,
	projectId: string,
	rotoId: string,
	opts: {
		direction: 'both' | 'forward' | 'backward' | 'frame';
		frame?: number;
		wait: boolean;
		jobId?: string;
		label: string;
	},
	extra: Parameters<typeof transact>[3],
) {
	let job: EngineJob;
	let timedOut = false;
	if (opts.jobId) ({ job, timedOut } = await waitJob(ctx, opts.jobId, 1_800_000, extra));
	else {
		const { doc } = await loadDoc(ctx, projectId);
		let body: ReturnType<typeof rotoSegmentBody>;
		try {
			body = rotoSegmentBody(doc, rotoId, opts.direction, opts.frame);
		} catch (e) {
			throw new ToolError('E_INVALID_PARAM', (e as Error).message);
		}
		job = (await ctx
			.engine((c) => c.call('rotoSegment', { body: { ...body, projectId } }))
			.catch(engineErr)) as EngineJob;
		if (opts.wait) ({ job, timedOut } = await waitJob(ctx, job.id, 1_800_000, extra));
	}
	if (!isTerminal(job) || timedOut)
		return {
			pending: true as const,
			body: {
				...jobBody(job, ctx.link.target?.url ?? ''),
				note: 'The roto job is running. Call propagate_roto with this jobId (and the rotoId) to store the result when it is done.',
			},
		};
	if (job.state !== 'succeeded')
		throw new ToolError(job.error?.code ?? 'ROTO_FAILED', job.error?.message ?? `The roto job ${job.state}`);
	const result = job.result as RotoSegmentResult;
	const res = await transact(
		ctx,
		projectId,
		{ label: opts.label, commands: [{ type: 'roto.setResult', rotoId, result: rotoResultOf(result) }] },
		extra,
	);
	const r = requireOk(res);
	return {
		pending: false as const,
		body: {
			...txBody(res, r),
			jobId: job.id,
			computedFrames: { start: result.start, end: result.end },
			framesComputed: result.computed,
			framesReused: result.reused,
			modelFrames: result.modelFrames,
			meanArea:
				Math.round((result.area.reduce((a, b) => a + b, 0) / Math.max(1, result.area.length)) * 1e4) / 1e4,
			...(result.framesPerSec ? { framesPerSec: result.framesPerSec } : {}),
			...(result.faces
				? {
						faces: result.faces.map((f) => ({
							faceId: f.id,
							firstFrame: f.startFrame,
							frames: f.present.length,
						})),
					}
				: {}),
		},
	};
}

export function registerRotoTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'list_roto_models',
		{
			title: 'List roto models',
			description:
				'The segmentation (SAM 2.1) and face-tracking (MediaPipe Face Landmarker) models: size, licence, attribution and whether they are installed. Without the segmentation model the Roto Brush uses colour graph cuts alone; face tracking needs its model.',
			input: {},
			annotations: READ_ONLY,
		},
		async () => jsonResult(await ctx.engine((c) => c.call('rotoModels')).catch(engineErr)),
	);

	defineTool(
		ctx,
		'install_roto_model',
		{
			title: 'Install roto model',
			description:
				'Downloads a segmentation / face model (files pinned to a Hugging Face revision, SHA-256 verified) through a model-download job. Tell the user the size and licence (Apache-2.0) first. Returns the job; follow it with wait_for_job.',
			input: { modelId: z.string().min(1).describe('Model id from list_roto_models') },
			annotations: EDIT,
		},
		async ({ modelId }) => {
			const models = (
				(await ctx.engine((c) => c.call('rotoModels')).catch(engineErr)) as { models: VisionModel[] }
			).models;
			const m = models.find((x) => x.id === modelId);
			if (!m) throw new ToolError('E_NOT_FOUND', `Unknown roto model ${modelId}`, 'Call list_roto_models.');
			const job = await ctx
				.engine((c) => c.call('rotoModelInstall', { params: { modelId } }))
				.catch(engineErr);
			return jsonResult({
				...jobBody(job as EngineJob, ctx.link.target?.url ?? ''),
				model: { id: m.id, sizeBytes: m.sizeBytes, license: m.license, attribution: m.attribution },
				next: 'Call wait_for_job with this jobId.',
			});
		},
	);

	defineTool(
		ctx,
		'remove_roto_model',
		{
			title: 'Remove roto model',
			description:
				"Deletes a downloaded segmentation / face model (computed mattes are kept). Needs the user's approval in an open JasperEditor window.",
			input: { modelId: z.string().min(1) },
			annotations: DESTRUCTIVE,
		},
		async ({ modelId }) =>
			jsonResult(
				await ctx.engine((c) => c.call('rotoModelDelete', { params: { modelId } })).catch(engineErr),
			),
	);

	defineTool(
		ctx,
		'create_roto',
		{
			title: 'Create roto (select an object)',
			description:
				'Roto Brush: selects an object on a video or still clip from points, a box or strokes (media pixels of the clip\'s source) at sequence time `at`, computes its matte (propagate: "both" through the span by default, "frame" for just this frame, "none" to only create it) and applies an effect (apply: "matte" Object Matte cut-out (default), "blur" Object Blur, "none"). One History entry per step. Check with render_frame.',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1).describe('A video or still clip'),
				at: timeArg('Sequence time of the frame the points / box / strokes are on (inside the clip)'),
				points: z.array(PointArg).optional(),
				box: BoxArg.optional(),
				strokes: z.array(StrokeArg).optional(),
				span: z
					.tuple([z.number().int().min(0), z.number().int().min(0)])
					.optional()
					.describe('Media frames to segment (inclusive); default: the source frames the clip shows'),
				settings: SettingsArg,
				name: z.string().min(1).optional(),
				propagate: z.enum(['both', 'forward', 'backward', 'frame', 'none']).optional(),
				apply: z.enum(['matte', 'blur', 'none']).optional(),
				wait: z.boolean().optional().describe('Wait for the segmentation job (default true)'),
			},
			annotations: EDIT,
		},
		async (args, extra) => {
			if (!args.points?.length && !args.box && !args.strokes?.length)
				throw new ToolError('E_INVALID_PARAM', 'Give points, a box or strokes that select the object');
			const { doc } = await loadDoc(ctx, args.projectId);
			const seq = sequenceOf(doc, args.clipId);
			const frame = frameOf(seq, args.at, TIME_FORMATS);
			const commands: unknown[] = [
				{
					type: 'roto.add',
					clipId: args.clipId,
					at: { sequenceFrame: frame },
					...(args.points ? { points: args.points } : {}),
					...(args.box ? { box: args.box } : {}),
					...(args.strokes ? { strokes: args.strokes } : {}),
					...(args.span ? { span: args.span } : {}),
					...(args.settings ? { settings: args.settings } : {}),
					...(args.name ? { name: args.name } : {}),
					ref: '$roto',
				},
			];
			const apply = args.apply ?? 'matte';
			if (apply !== 'none') commands.push({ type: 'roto.apply', rotoId: '$roto', effect: apply });
			const res = await transact(ctx, args.projectId, { label: 'Roto Brush', commands }, extra);
			const r = requireOk(res);
			const out = r.results[0] as { rotoId: string; frame: number; span: number[] };
			const effect =
				apply !== 'none' ? (r.results[1] as { effectInstanceId: string }).effectInstanceId : null;
			const prop = args.propagate ?? 'both';
			if (prop === 'none')
				return jsonResult({
					...txBody(res, r),
					rotoId: out.rotoId,
					effectInstanceId: effect,
					mediaFrame: out.frame,
					span: out.span,
				});
			const run = await runRoto(
				ctx,
				args.projectId,
				out.rotoId,
				{
					direction: prop,
					...(prop === 'frame' ? { frame: out.frame } : {}),
					wait: args.wait !== false,
					label: 'Propagate Roto',
				},
				extra,
			);
			return jsonResult({
				rotoId: out.rotoId,
				effectInstanceId: effect,
				mediaFrame: out.frame,
				span: out.span,
				...run.body,
				next: 'Check with render_frame (set the Object Matte view to "overlay" to see the selection); correct with add_roto_strokes + propagate_roto.',
			});
		},
	);

	defineTool(
		ctx,
		'add_roto_strokes',
		{
			title: 'Add roto strokes',
			description:
				'Corrects a roto object at sequence time `at`: points / strokes (fg adds to the object, bg removes, refine paints the Refine Edge band) and/or a box. The matte becomes stale: call propagate_roto next.',
			input: {
				projectId: ProjectIdArg,
				rotoId: RotoIdArg,
				at: timeArg('Sequence time of the correction'),
				points: z.array(PointArg).optional(),
				strokes: z.array(StrokeArg).optional(),
				box: BoxArg.optional(),
			},
			annotations: EDIT,
		},
		async (args, extra) => {
			const { doc } = await loadDoc(ctx, args.projectId);
			const loc = locate(doc, args.rotoId);
			const frame = frameOf(doc.sequences[loc.sequenceId]!, args.at, TIME_FORMATS);
			const commands: unknown[] = [];
			if (args.points?.length || args.strokes?.length)
				commands.push({
					type: 'roto.addStrokes',
					rotoId: args.rotoId,
					at: { sequenceFrame: frame },
					...(args.points ? { points: args.points } : {}),
					...(args.strokes ? { strokes: args.strokes } : {}),
				});
			if (args.box)
				commands.push({
					type: 'roto.setBox',
					rotoId: args.rotoId,
					at: { sequenceFrame: frame },
					rect: args.box,
				});
			if (!commands.length) throw new ToolError('E_INVALID_PARAM', 'Give points, strokes or a box');
			const res = await transact(ctx, args.projectId, { label: 'Roto Brush Stroke', commands }, extra);
			const r = requireOk(res);
			return jsonResult({ ...txBody(res, r), rotoId: args.rotoId, next: 'Call propagate_roto.' });
		},
	);

	defineTool(
		ctx,
		'propagate_roto',
		{
			title: 'Propagate roto',
			description:
				'Computes a roto object\'s mattes on the engine and stores them (History "Propagate Roto"): direction "both" (default: the whole span from the base frame), "forward", "backward", or "frame" with `at` (one frame). Frames whose inputs did not change are reused. Faces rotos are re-tracked. With wait: false it returns the job; call again with the jobId to store it.',
			input: {
				projectId: ProjectIdArg,
				rotoId: RotoIdArg,
				direction: z.enum(['both', 'forward', 'backward', 'frame']).optional(),
				at: timeArg('direction "frame": the sequence time').optional(),
				wait: z.boolean().optional(),
				jobId: z.string().optional().describe('A roto job started with wait: false, to wait for and store'),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (args, extra) => {
			const { doc } = await loadDoc(ctx, args.projectId);
			const loc = locate(doc, args.rotoId);
			let frame: number | undefined;
			if ((args.direction ?? 'both') === 'frame') {
				if (args.at === undefined) throw new ToolError('E_INVALID_PARAM', 'direction "frame" needs `at`');
				const seq = doc.sequences[loc.sequenceId]!;
				const clip = seq.clips[loc.clipId]!;
				const f = frameOf(seq, args.at, TIME_FORMATS);
				frame =
					clip.kind === 'still'
						? 0
						: mediaFrameAt(contentTimeAt(clip, f, seq.settings.frameRate), loc.roto.rate);
			}
			const run = await runRoto(
				ctx,
				args.projectId,
				args.rotoId,
				{
					direction: args.direction ?? 'both',
					...(frame !== undefined ? { frame } : {}),
					wait: args.wait !== false,
					...(args.jobId ? { jobId: args.jobId } : {}),
					label: 'Propagate Roto',
				},
				extra,
			);
			return jsonResult({ rotoId: args.rotoId, ...run.body });
		},
	);

	defineTool(
		ctx,
		'get_roto',
		{
			title: 'Get roto',
			description:
				'A roto object: kind, span, base frame, strokes, what is computed (and with which model), whether it is stale or frozen, tracked faces.',
			input: { projectId: ProjectIdArg, rotoId: RotoIdArg },
			annotations: READ_ONLY,
		},
		async ({ projectId, rotoId }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const loc = locate(doc, rotoId);
			return jsonResult({ clipId: loc.clipId, ...summary(loc.roto) });
		},
	);

	defineTool(
		ctx,
		'apply_object_matte',
		{
			title: 'Apply object matte',
			description:
				'Adds (or updates) the effect that uses a roto object on its clip: effect "matte" (Object Matte: cut out; params feather, contrast, shiftEdge, reduceChatter, useMotionBlur, shutterAngle, decontaminate, view final | alpha | overlay | boundary | decontamination, invert) or "blur" (Object Blur: method gaussian | mosaic | fill, blurriness, blockSize, fillColor, expand, feather, region inside | outside).',
			input: {
				projectId: ProjectIdArg,
				rotoId: RotoIdArg,
				effect: z.enum(['matte', 'blur']).optional(),
				params: z.record(z.string(), z.unknown()).optional(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (args, extra) => {
			const res = await transact(
				ctx,
				args.projectId,
				{
					label: 'Apply Object Matte',
					commands: [
						{
							type: 'roto.apply',
							rotoId: args.rotoId,
							...(args.effect ? { effect: args.effect } : {}),
							...(args.params ? { params: args.params } : {}),
						},
					],
				},
				extra,
			);
			const r = requireOk(res);
			return jsonResult({ ...txBody(res, r), ...(r.results[0] as object) });
		},
	);

	defineTool(
		ctx,
		'convert_roto_to_masks',
		{
			title: 'Convert roto to masks',
			description:
				'Traces the computed matte of a roto object into Opacity masks of its clip: mode "still" (default) = one Bézier mask per outline at sequence time `at` (holes subtract); "animated" = one mask following the object\'s main outline, keyed every `step` frames over the computed frames.',
			input: {
				projectId: ProjectIdArg,
				rotoId: RotoIdArg,
				mode: z.enum(['still', 'animated']).optional(),
				at: timeArg('mode "still": the sequence time (default: the base frame)').optional(),
				step: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.describe('mode "animated": keyframe every N media frames (default 1)'),
				tolerance: z
					.number()
					.min(0.1)
					.max(20)
					.optional()
					.describe('Path simplification, matte px (default 1.5)'),
				feather: z
					.number()
					.min(0)
					.optional()
					.describe('Mask feather in layer px (default the masks default)'),
			},
			annotations: EDIT,
		},
		async (args, extra) => {
			const { doc } = await loadDoc(ctx, args.projectId);
			const loc = locate(doc, args.rotoId);
			const r = loc.roto;
			if (!r.result)
				throw new ToolError('E_INVALID_PARAM', 'The roto has no computed matte: call propagate_roto first');
			const mode = args.mode ?? 'still';
			let frames: number[];
			if (mode === 'still') {
				let f = r.base ?? r.result.start;
				if (args.at !== undefined) {
					const seq = doc.sequences[loc.sequenceId]!;
					const clip = seq.clips[loc.clipId]!;
					const sf = frameOf(seq, args.at, TIME_FORMATS);
					f =
						clip.kind === 'still' ? 0 : mediaFrameAt(contentTimeAt(clip, sf, seq.settings.frameRate), r.rate);
				}
				if (f < r.result.start || f > r.result.end)
					throw new ToolError(
						'E_INVALID_PARAM',
						`Frame ${f} has no computed matte (${r.result.start}–${r.result.end})`,
					);
				frames = [f];
			} else {
				frames = [];
				for (let f = r.result.start; f <= r.result.end; f += args.step ?? 1) frames.push(f);
				if (frames[frames.length - 1] !== r.result.end) frames.push(r.result.end);
			}
			const traced = (await ctx
				.engine((c) =>
					c.call('rotoTrace', {
						body: { key: r.result!.key, frames, ...(args.tolerance ? { tolerance: args.tolerance } : {}) },
					}),
				)
				.catch(engineErr)) as RotoTraceResponse;
			const commands = rotoMaskCommands({
				clipId: loc.clipId,
				rate: r.rate,
				frames: traced.frames,
				mode,
				name: r.name,
				...(args.feather !== undefined ? { feather: args.feather } : {}),
			});
			if (!commands.length)
				throw new ToolError('E_INVALID_PARAM', 'The matte has no outline at these frames');
			const res = await transact(ctx, args.projectId, { label: 'Convert to Masks', commands }, extra);
			const t = requireOk(res);
			return jsonResult({
				...txBody(res, t),
				masks: commands.filter((c) => (c as { type: string }).type === 'mask.add').length,
				frames: frames.length,
			});
		},
	);

	defineTool(
		ctx,
		'freeze_roto',
		{
			title: 'Freeze roto',
			description:
				'Freezes (locks) a computed roto object so its strokes and settings cannot change, or unfreezes it.',
			input: {
				projectId: ProjectIdArg,
				rotoId: RotoIdArg,
				frozen: z.boolean().optional().describe('default true'),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (args, extra) => {
			const res = await transact(
				ctx,
				args.projectId,
				{
					label: 'Freeze Roto',
					commands: [{ type: 'roto.freeze', rotoId: args.rotoId, frozen: args.frozen ?? true }],
				},
				extra,
			);
			return jsonResult(txBody(res, requireOk(res)));
		},
	);

	defineTool(
		ctx,
		'remove_roto',
		{
			title: 'Remove roto',
			description: 'Deletes roto objects and the Object Matte / Object Blur effects that use them.',
			input: { projectId: ProjectIdArg, rotoIds: z.array(RotoIdArg).min(1) },
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async (args, extra) => {
			const res = await transact(
				ctx,
				args.projectId,
				{ label: 'Remove Roto', commands: [{ type: 'roto.remove', rotoIds: args.rotoIds }] },
				extra,
			);
			const r = requireOk(res);
			return jsonResult({ ...txBody(res, r), ...(r.results[0] as object) });
		},
	);

	const faceInput = {
		projectId: ProjectIdArg,
		clipId: z.string().min(1).describe('A video or still clip'),
		threshold: z.number().min(0.05).max(0.99).optional().describe('Face detection confidence (default 0.5)'),
		expand: z.number().min(-50).max(200).optional().describe('Grow the face outline by this % (default 15)'),
		shape: z
			.enum(['outline', 'ellipse'])
			.optional()
			.describe('Face matte: the face-mesh outline (default) or an ellipse'),
		span: z
			.tuple([z.number().int().min(0), z.number().int().min(0)])
			.optional()
			.describe('Media frames (default: what the clip shows)'),
		wait: z.boolean().optional(),
	};

	async function trackFaces(
		args: {
			projectId: string;
			clipId: string;
			threshold?: number;
			expand?: number;
			shape?: 'outline' | 'ellipse';
			span?: [number, number];
			wait?: boolean;
		},
		extra: Parameters<typeof transact>[3],
		apply: unknown | null,
	) {
		const models = (
			(await ctx.engine((c) => c.call('rotoModels')).catch(engineErr)) as { models: VisionModel[] }
		).models;
		const face = models.find((m) => m.task === 'face');
		if (!face?.installed)
			throw new ToolError(
				'FACE_MODEL_NOT_INSTALLED',
				'Face tracking needs the MediaPipe Face Landmarker model, which is not installed',
				`Install it with install_roto_model "${face?.id ?? 'mediapipe-face-landmarker'}" (tell the user: Apache-2.0, ~5 MB), then retry.`,
			);
		const settings = {
			...(args.threshold !== undefined ? { faceThreshold: args.threshold } : {}),
			...(args.expand !== undefined ? { faceExpand: args.expand } : {}),
			...(args.shape ? { faceShape: args.shape } : {}),
		};
		const commands: unknown[] = [
			{
				type: 'roto.add',
				clipId: args.clipId,
				kind: 'faces',
				...(args.span ? { span: args.span } : {}),
				settings,
				ref: '$faces',
			},
		];
		if (apply) commands.push(apply);
		const res = await transact(
			ctx,
			args.projectId,
			{ label: apply ? 'Blur Faces' : 'Track Faces', commands },
			extra,
		);
		const r = requireOk(res);
		const rotoId = (r.results[0] as { rotoId: string }).rotoId;
		const effect = apply ? (r.results[1] as { effectInstanceId: string }).effectInstanceId : null;
		const run = await runRoto(
			ctx,
			args.projectId,
			rotoId,
			{ direction: 'both', wait: args.wait !== false, label: 'Track Faces' },
			extra,
		);
		return { rotoId, effectInstanceId: effect, ...run.body };
	}

	defineTool(
		ctx,
		'track_faces',
		{
			title: 'Track faces',
			description:
				'Finds and tracks every face of a clip (MediaPipe Face Landmarker on the engine) into a faces roto: per-frame face mattes (outline or ellipse) and face poses. Use it with apply_object_matte / face_to_keyframes, or call blur_faces for the one-click anonymisation.',
			input: faceInput,
			annotations: EDIT,
		},
		async (args, extra) => jsonResult(await trackFaces(args, extra, null)),
	);

	defineTool(
		ctx,
		'blur_faces',
		{
			title: 'Blur faces',
			description:
				'One click: tracks every face of a clip and blurs them (Object Blur on the faces roto). method gaussian (default) | mosaic | fill; blurriness / blockSize in layer px. Check with render_frame.',
			input: {
				...faceInput,
				method: z.enum(['gaussian', 'mosaic', 'fill']).optional(),
				blurriness: z.number().min(0).optional(),
				blockSize: z.number().min(1).optional(),
			},
			annotations: EDIT,
		},
		async (args, extra) =>
			jsonResult(
				await trackFaces(args, extra, {
					type: 'roto.apply',
					rotoId: '$faces',
					effect: 'blur',
					params: {
						...(args.method ? { method: args.method } : {}),
						...(args.blurriness !== undefined ? { blurriness: args.blurriness } : {}),
						...(args.blockSize !== undefined ? { blockSize: args.blockSize } : {}),
					},
				}),
			),
	);

	defineTool(
		ctx,
		'face_to_keyframes',
		{
			title: 'Face to keyframes',
			description:
				'Turns a tracked face of a faces roto into a planar tracker of its clip and, with targetClipId, bakes position / scale / rotation keyframes onto that clip so it follows the face (e.g. a sticker or a censor graphic). faceId from get_roto / track_faces.',
			input: {
				projectId: ProjectIdArg,
				rotoId: RotoIdArg,
				faceId: z.number().int().min(0),
				targetClipId: z.string().min(1).optional(),
				components: z
					.array(z.enum(['position', 'scale', 'rotation']))
					.min(1)
					.optional(),
			},
			annotations: EDIT,
		},
		async (args, extra) => {
			const res = await transact(
				ctx,
				args.projectId,
				{
					label: 'Track Face',
					commands: [
						{
							type: 'roto.faceTracker',
							rotoId: args.rotoId,
							faceId: args.faceId,
							...(args.targetClipId ? { targetClipId: args.targetClipId } : {}),
							...(args.components ? { components: args.components } : {}),
						},
					],
				},
				extra,
			);
			const r = requireOk(res);
			return jsonResult({ ...txBody(res, r), ...(r.results[0] as object) });
		},
	);
}
