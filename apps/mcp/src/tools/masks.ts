import type { EngineJob, MaskTraceResponse, TrackRequest, TrackResult } from '@jasper/api';
import {
	type Animatable,
	type BezierPath,
	BezierPathSchema,
	type Clip,
	contentTimeAt,
	type EffectInstance,
	ellipsePath,
	evaluate,
	findMask,
	intrinsicBoxOf,
	MASK_MODES,
	MASK_TRACK_METHODS,
	type Mask,
	maskKeysFromTrack,
	type ProjectDocument,
	planMaskTrack,
	polygonPath,
	type Sequence,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, TIME_FORMATS, timeArg } from '../arguments.ts';
import {
	DESTRUCTIVE_IDEMPOTENT,
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
	findClip,
	frameOf,
	isTerminal,
	loadDoc,
	READ_ONLY,
	requireOk,
	type ToolContext,
	transact,
	txBody,
	waitJob,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';

export const MASKS_GUIDE = `Masks and track mattes (Premiere-style):
- A visual clip has Opacity masks (cut the layer out) and every video effect can have its own masks (the effect applies inside them only). Shapes: ellipse, polygon (4-point by default) or bezier (pen: any vertices with tangent handles). Properties: Mask Path, Mask Feather (px, centred on the edge, default 10), Mask Opacity (%), Mask Expansion (px, grows/shrinks), Inverted, mode (none/add/subtract/intersect/lighten/darken/difference; masks combine top to bottom).
- Paths are in layer coordinates normalised to the clip's box (0..1, [0,0] top-left); the mask tools also take units: "px" (layer pixels; list_masks reports the box size). Vertices: {p, in, out} with in/out tangent handles relative to p (zero = corner).
- list_masks {clipId}; add_mask {clipId, effectId?, shape, points?|path?, feather?, …}; edit_mask {maskId, …} (static props, path / points at a time: a keyframe when the path is animated, animate: true to start keyframing); remove_masks {maskIds}.
- track_mask {maskId, direction forward|backward, frames?, method position|position-rotation|position-scale-rotation|perspective} follows the pixels inside the mask and writes Mask Path keyframes (video clips).
- auto_trace_mask {clipId, at, channel alpha|luma, threshold, …} creates masks from the picture's outlines (holes become subtract masks).
- set_track_matte {clipId, matteTrack "V3", compositeUsing alpha|luma, reverse}: Track Matte Key — the clip shows through another video track (hide that track's output so only the result shows; a hidden track still works as a matte).
- Fine control: apply_commands with mask.add / mask.update / mask.editPath (vertex ops: insertVertex, removeVertices, convert, setVertex, transform, feather points) / mask.setPathKeys, and param.set / keyframe.* on ["mask", maskId, "path"|"feather"|"opacity"|"expansion"]. Check with render_frame.`;

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const Pt = z.tuple([z.number(), z.number()]);
const UnitsArg = z
	.enum(['normalized', 'px'])
	.optional()
	.describe('Units of points / paths: "normalized" (0..1 of the clip box, default) or "px" (layer pixels)');

function boxOf(doc: ProjectDocument, seq: Sequence, clip: Clip) {
	return intrinsicBoxOf({ clip, doc, seq });
}

/** A path from the arguments, normalised. */
function pathArg(
	args: { points?: [number, number][]; path?: BezierPath; closed?: boolean },
	units: 'normalized' | 'px' | undefined,
	box: { width: number; height: number },
): BezierPath | undefined {
	const k = units === 'px' ? [1 / box.width, 1 / box.height] : [1, 1];
	const s = (q: readonly number[]): [number, number] => [q[0]! * k[0]!, q[1]! * k[1]!];
	if (args.path)
		return {
			closed: args.path.closed,
			vertices: args.path.vertices.map((v) => ({ p: s(v.p), in: s(v.in), out: s(v.out) })),
			...(args.path.feather ? { feather: args.path.feather } : {}),
		};
	if (args.points) return polygonPath(args.points.map(s), args.closed ?? true);
	return undefined;
}

function maskSummary(m: Mask, t: number, box: { width: number; height: number }, owner: string) {
	const path = evaluate(m.path as Animatable<BezierPath>, t);
	return {
		maskId: m.id,
		name: m.name,
		owner,
		mode: m.mode,
		inverted: m.inverted,
		shape: m.shape ?? null,
		feather: r4(evaluate(m.feather, t)),
		opacity: r4(evaluate(m.opacity, t)),
		expansion: r4(evaluate(m.expansion, t)),
		featherFalloff: m.featherFalloff ?? 'smooth',
		trackMethod: m.trackMethod ?? 'position-scale-rotation',
		animated: {
			path: m.path.keyframes.length,
			feather: m.feather.keyframes.length,
			opacity: m.opacity.keyframes.length,
			expansion: m.expansion.keyframes.length,
		},
		path: {
			closed: path.closed,
			vertices: path.vertices.map((v) => ({
				p: [r4(v.p[0]), r4(v.p[1])],
				in: [r4(v.in[0]), r4(v.in[1])],
				out: [r4(v.out[0]), r4(v.out[1])],
				px: [Math.round(v.p[0] * box.width * 10) / 10, Math.round(v.p[1] * box.height * 10) / 10],
			})),
			...(path.feather?.length ? { featherPoints: path.feather } : {}),
		},
	};
}

function mediaKeyOf(doc: ProjectDocument, mediaId: string): string {
	const key = doc.media[mediaId]?.locators.find((l) => l.type === 'engine-store');
	if (!key?.key)
		throw new ToolError('E_NOT_FOUND', 'The clip has no engine media', 'Import it with import_media.');
	return key.key;
}

export function registerMaskTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'list_masks',
		{
			title: 'List masks',
			description:
				"A clip's Opacity masks and effect masks evaluated at a time (default: the clip's first frame): id, name, owner (opacity or effect id), mode, inverted, feather / opacity / expansion, keyframe counts and the path (normalised vertices with tangent handles, plus px). Also the clip's box size (px) for unit conversions and its Track Matte Keys.",
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1).describe('Clip id ("clp_…")'),
				at: timeArg('Sequence time to evaluate at').optional(),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, clipId, at }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const { seq, clip } = findClip(doc, clipId);
			const f = at !== undefined ? frameOf(seq, at, TIME_FORMATS) : clip.start;
			const t = contentTimeAt(
				clip,
				Math.min(clip.start + clip.duration - 1, Math.max(clip.start, f)),
				seq.settings.frameRate,
			);
			const box = boxOf(doc, seq, clip);
			const c = clip as { masks?: Mask[]; effects?: EffectInstance[] };
			const masks = [
				...(c.masks ?? []).map((m) => maskSummary(m, t, box, 'opacity')),
				...(c.effects ?? []).flatMap((fx) =>
					(fx.masks ?? []).map((m) => maskSummary(m, t, box, `${fx.effectId} (${fx.id})`)),
				),
			];
			const mattes = (c.effects ?? [])
				.filter((fx) => fx.effectId === 'jasper.track-matte-key')
				.map((fx) => {
					const id = evaluate(fx.params.matteTrack ?? { value: '', keyframes: [] }, t) as string;
					const idx = seq.videoTracks.findIndex((x) => x.id === id);
					return {
						effectId: fx.id,
						enabled: fx.enabled,
						matteTrack: idx >= 0 ? `V${idx + 1}` : null,
						compositeUsing: evaluate(fx.params.compositeUsing ?? { value: 'matteAlpha', keyframes: [] }, t),
						reverse: evaluate(fx.params.reverse ?? { value: false, keyframes: [] }, t),
					};
				});
			return jsonResult({ clipId, box, masks, trackMattes: mattes });
		},
	);

	defineTool(
		ctx,
		'add_mask',
		{
			title: 'Add mask',
			description:
				'Creates a mask on a clip\'s Opacity (default) or on one of its effects (effectId). shape "ellipse" / "polygon" without points = a centred default shape (Premiere\'s tools); "bezier" needs points or path (a pen path; closed by default). Defaults: feather 10 px, opacity 100 %, expansion 0, mode add. One History entry; returns the mask id.',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1).describe('Clip id ("clp_…")'),
				effectId: z.string().min(1).optional().describe('Effect instance id ("fx_…"): a per-effect mask'),
				shape: z.enum(['ellipse', 'polygon', 'bezier']),
				points: z.array(Pt).min(3).optional().describe('Corner vertices (polygon / pen) in `units`'),
				path: BezierPathSchema.optional().describe('Full path {closed, vertices: [{p, in, out}]} in `units`'),
				ellipse: z
					.object({ center: Pt, radius: Pt })
					.optional()
					.describe('An ellipse at center with radius (x, y) in `units` (shape ellipse)'),
				closed: z.boolean().optional().describe('points: closed (default true)'),
				units: UnitsArg,
				name: z.string().min(1).optional(),
				mode: z.enum(MASK_MODES).optional(),
				inverted: z.boolean().optional(),
				feather: z.number().min(0).optional().describe('px'),
				opacity: z.number().min(0).max(100).optional().describe('%'),
				expansion: z.number().optional().describe('px (negative shrinks)'),
			},
			annotations: EDIT,
		},
		async (args, extra) => {
			const { doc } = await loadDoc(ctx, args.projectId);
			const { seq, clip } = findClip(doc, args.clipId);
			const box = boxOf(doc, seq, clip);
			let path = pathArg(args, args.units, box);
			if (!path && args.ellipse) {
				const k = args.units === 'px' ? [1 / box.width, 1 / box.height] : [1, 1];
				path = ellipsePath(
					[args.ellipse.center[0] * k[0]!, args.ellipse.center[1] * k[1]!],
					[args.ellipse.radius[0] * k[0]!, args.ellipse.radius[1] * k[1]!],
				);
			}
			const cmd = {
				type: 'mask.add',
				...(args.effectId ? { effectId: args.effectId } : { clipId: args.clipId }),
				shape: args.shape,
				...(path ? { path } : {}),
				...(args.name ? { name: args.name } : {}),
				...(args.mode ? { mode: args.mode } : {}),
				...(args.inverted !== undefined ? { inverted: args.inverted } : {}),
				...(args.feather !== undefined ? { feather: args.feather } : {}),
				...(args.opacity !== undefined ? { opacity: args.opacity } : {}),
				...(args.expansion !== undefined ? { expansion: args.expansion } : {}),
				ref: '$mask',
			};
			const res = await transact(ctx, args.projectId, { label: 'Create Mask', commands: [cmd] }, extra);
			const r = requireOk(res);
			return jsonResult({
				...txBody(res, r),
				maskId: r.refs.$mask,
				next: 'Check with render_frame; edit with edit_mask.',
			});
		},
	);

	defineTool(
		ctx,
		'edit_mask',
		{
			title: 'Edit mask',
			description:
				"Changes a mask (one History entry): name, mode, inverted, featherFalloff, trackMethod, locked; feather / opacity / expansion / path or points at a time `at` (a keyframe when that property is animated; animate: true turns its stopwatch on first so the value is keyed at `at`); translate / scale / rotation move the whole path (rotation in degrees, about the vertices' centre).",
			input: {
				projectId: ProjectIdArg,
				maskId: z.string().min(1).describe('Mask id ("msk_…")'),
				at: timeArg('Sequence time of the value (keyframes)').optional(),
				animate: z
					.array(z.enum(['path', 'feather', 'opacity', 'expansion']))
					.optional()
					.describe("Turn these properties' stopwatches on (keyed at `at`) before setting values"),
				name: z.string().min(1).optional(),
				mode: z.enum(MASK_MODES).optional(),
				inverted: z.boolean().optional(),
				featherFalloff: z.enum(['smooth', 'linear']).optional(),
				trackMethod: z.enum(MASK_TRACK_METHODS).optional(),
				locked: z.boolean().optional(),
				feather: z.number().min(0).optional(),
				opacity: z.number().min(0).max(100).optional(),
				expansion: z.number().optional(),
				points: z.array(Pt).min(3).optional(),
				path: BezierPathSchema.optional(),
				units: UnitsArg,
				translate: Pt.optional().describe('Move the path by (dx, dy) in `units`'),
				scale: z.number().positive().optional().describe('Scale the path about its centre (1 = same)'),
				rotation: z.number().optional().describe('Rotate the path about its centre (degrees, clockwise)'),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (args, extra) => {
			const { doc } = await loadDoc(ctx, args.projectId);
			const loc = findMask(doc, args.maskId);
			if (!loc) throw new ToolError('E_NOT_FOUND', `Mask not found: ${args.maskId}`, 'Call list_masks.');
			const seq = doc.sequences[loc.sequenceId]!;
			const box = boxOf(doc, seq, loc.clip);
			const atP = args.at !== undefined ? { sequenceFrame: frameOf(seq, args.at, TIME_FORMATS) } : undefined;
			const commands: unknown[] = [];
			const target = (p: string) => ['mask', args.maskId, p];
			for (const p of args.animate ?? [])
				commands.push({
					type: 'param.setAnimated',
					target: target(p),
					animated: true,
					...(atP ? { at: atP } : {}),
				});
			const upd = {
				...(args.name ? { name: args.name } : {}),
				...(args.mode ? { mode: args.mode } : {}),
				...(args.inverted !== undefined ? { inverted: args.inverted } : {}),
				...(args.featherFalloff ? { featherFalloff: args.featherFalloff } : {}),
				...(args.trackMethod ? { trackMethod: args.trackMethod } : {}),
				...(args.locked !== undefined ? { locked: args.locked } : {}),
			};
			if (Object.keys(upd).length) commands.push({ type: 'mask.update', maskId: args.maskId, ...upd });
			for (const p of ['feather', 'opacity', 'expansion'] as const)
				if (args[p] !== undefined)
					commands.push({
						type: 'param.set',
						target: target(p),
						value: args[p],
						...(atP ? { at: atP } : {}),
					});
			const path = pathArg(args, args.units, box);
			const ops: unknown[] = [];
			if (path) ops.push({ op: 'set', path });
			if (args.translate || args.scale !== undefined || args.rotation !== undefined) {
				const k = args.units === 'px' ? [1 / box.width, 1 / box.height] : [1, 1];
				ops.push({
					op: 'transform',
					...(args.translate ? { translate: [args.translate[0] * k[0]!, args.translate[1] * k[1]!] } : {}),
					...(args.scale !== undefined ? { scale: args.scale } : {}),
					...(args.rotation !== undefined ? { rotation: args.rotation } : {}),
				});
			}
			if (ops.length)
				commands.push({ type: 'mask.editPath', maskId: args.maskId, ops, ...(atP ? { at: atP } : {}) });
			if (commands.length === 0) throw new ToolError('E_INVALID_PARAM', 'Nothing to change');
			const res = await transact(ctx, args.projectId, { label: 'Change Mask', commands }, extra);
			const r = requireOk(res);
			return jsonResult({ ...txBody(res, r), maskId: args.maskId });
		},
	);

	defineTool(
		ctx,
		'remove_masks',
		{
			title: 'Remove masks',
			description: 'Deletes masks (Opacity or effect masks) by id. One History entry.',
			input: { projectId: ProjectIdArg, maskIds: z.array(z.string().min(1)).min(1) },
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async ({ projectId, maskIds }, extra) => {
			const res = await transact(
				ctx,
				projectId,
				{ label: 'Delete Mask', commands: [{ type: 'mask.remove', maskIds }] },
				extra,
			);
			return jsonResult(txBody(res, requireOk(res)));
		},
	);

	defineTool(
		ctx,
		'track_mask',
		{
			title: 'Track mask',
			description:
				'Tracks a mask through its video clip from a time (default: the clip\'s first frame), like Premiere\'s Track Selected Mask: the pixels inside the mask are followed frame by frame and the mask path gets a keyframe per source frame (one History entry "Track Mask"). direction forward / backward (to the clip end/start, or `frames` frames); method position | position-rotation | position-scale-rotation (default) | perspective. Stops at the first frame where tracking is lost (reported).',
			input: {
				projectId: ProjectIdArg,
				maskId: z.string().min(1),
				from: timeArg('Sequence time to start from (the mask path there is the reference)').optional(),
				direction: z.enum(['forward', 'backward']).optional(),
				frames: z.number().int().min(1).optional().describe('Track at most this many frames'),
				method: z.enum(MASK_TRACK_METHODS).optional(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (args, extra) => {
			let loaded = await loadDoc(ctx, args.projectId);
			const loc = findMask(loaded.doc, args.maskId);
			if (!loc) throw new ToolError('E_NOT_FOUND', `Mask not found: ${args.maskId}`, 'Call list_masks.');
			const seq = loaded.doc.sequences[loc.sequenceId]!;
			const f = args.from !== undefined ? frameOf(seq, args.from, TIME_FORMATS) : loc.clip.start;
			const t = contentTimeAt(
				loc.clip,
				Math.min(loc.clip.start + loc.clip.duration - 1, Math.max(loc.clip.start, f)),
				seq.settings.frameRate,
			);
			let plan: ReturnType<typeof planMaskTrack>;
			try {
				plan = planMaskTrack(loaded.doc, args.maskId, {
					mode: args.direction ?? 'forward',
					at: t,
					...(args.method ? { method: args.method } : {}),
					...(args.frames ? { frames: args.frames } : {}),
				});
			} catch (e) {
				throw new ToolError('E_INVALID_PARAM', (e as Error).message);
			}
			const body: TrackRequest = {
				...plan.request,
				mediaKey: mediaKeyOf(loaded.doc, plan.mediaId),
				projectId: args.projectId,
			};
			let job: EngineJob = await ctx.engine((c) => c.call('trackingTrack', { body }));
			const w = await waitJob(ctx, job.id, 600_000, extra);
			job = w.job;
			if (!isTerminal(job) || w.timedOut)
				throw new ToolError(
					'E_TIMEOUT',
					'Mask tracking is still running',
					`Job ${job.id}; try fewer frames.`,
				);
			if (job.state !== 'succeeded')
				throw new ToolError(
					job.error?.code ?? 'TRACK_FAILED',
					job.error?.message ?? `The track job ${job.state}`,
				);
			const { keys, lostAt } = maskKeysFromTrack(plan, job.result as TrackResult);
			loaded = await loadDoc(ctx, args.projectId);
			const res = await transact(
				ctx,
				args.projectId,
				{
					label: 'Track Mask',
					commands: [{ type: 'mask.setPathKeys', maskId: args.maskId, keys, clearSpan: true }],
				},
				extra,
			);
			const r = requireOk(res);
			return jsonResult({
				...txBody(res, r),
				maskId: args.maskId,
				keys: keys.length,
				...(lostAt !== null
					? {
							lostAtSourceFrame: lostAt,
							note: 'Tracking was lost there; adjust the mask and track again from that time.',
						}
					: {}),
			});
		},
	);

	defineTool(
		ctx,
		'auto_trace_mask',
		{
			title: 'Auto-trace mask',
			description:
				"Creates masks from the outlines of a media clip's picture at a time (After Effects' Auto-trace): channel alpha (default) or luma (or red/green/blue), threshold 0..1, tolerance px, minArea px², cornerRoundness 0 (polygons) … 1 (smooth), invert. Outer outlines become add masks, holes subtract masks (on the Opacity, or on effectId). One History entry; returns the mask ids.",
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1),
				effectId: z.string().min(1).optional(),
				at: timeArg('Sequence time of the traced frame').optional(),
				channel: z.enum(['alpha', 'luma', 'red', 'green', 'blue']).optional(),
				threshold: z.number().min(0).max(1).optional(),
				invert: z.boolean().optional(),
				tolerance: z.number().min(0.01).max(100).optional(),
				minArea: z.number().min(0).optional(),
				cornerRoundness: z.number().min(0).max(1).optional(),
				maxPaths: z.number().int().min(1).max(100).optional(),
				feather: z.number().min(0).optional().describe('Feather of the created masks (px, default 0)'),
			},
			annotations: EDIT,
		},
		async (args, extra) => {
			const { doc } = await loadDoc(ctx, args.projectId);
			const { seq, clip } = findClip(doc, args.clipId);
			if (clip.kind !== 'video' && clip.kind !== 'still' && clip.kind !== 'animated-image')
				throw new ToolError('E_INVALID_PARAM', 'Auto-trace reads the picture of video and still clips');
			const box = boxOf(doc, seq, clip);
			const f = args.at !== undefined ? frameOf(seq, args.at, TIME_FORMATS) : clip.start;
			const t = contentTimeAt(
				clip,
				Math.min(clip.start + clip.duration - 1, Math.max(clip.start, f)),
				seq.settings.frameRate,
			);
			const vs = doc.media[clip.mediaId]?.probe.streams.find((s) => s.type === 'video');
			const rate = vs?.type === 'video' ? vs.frameRate : null;
			const frame =
				rate && clip.kind === 'video'
					? Math.max(0, Math.round((t / 705_600_000) * (rate.num / rate.den)))
					: 0;
			const traced = (await ctx.engine((c) =>
				c.call('masksTrace', {
					body: {
						mediaKey: mediaKeyOf(doc, clip.mediaId),
						frame,
						width: Math.max(1, Math.round(box.width)),
						height: Math.max(1, Math.round(box.height)),
						channel: args.channel ?? 'alpha',
						threshold: args.threshold ?? 0.5,
						invert: args.invert ?? false,
						tolerance: args.tolerance ?? 1,
						minArea: args.minArea ?? 10,
						cornerRoundness: args.cornerRoundness ?? 0.5,
						maxPaths: args.maxPaths ?? 20,
					},
				}),
			)) as MaskTraceResponse;
			if (traced.paths.length === 0)
				throw new ToolError(
					'E_INVALID_PARAM',
					'No outline found',
					'Try another channel, threshold or invert.',
				);
			const commands = traced.paths.map((p, i) => ({
				type: 'mask.add',
				...(args.effectId ? { effectId: args.effectId } : { clipId: args.clipId }),
				shape: 'bezier',
				path: p.path,
				mode: p.depth % 2 === 1 ? 'subtract' : 'add',
				feather: args.feather ?? 0,
				name: `Traced (${i + 1})`,
				ref: `$t${i}`,
			}));
			const res = await transact(ctx, args.projectId, { label: 'Auto-trace', commands }, extra);
			const r = requireOk(res);
			return jsonResult({
				...txBody(res, r),
				maskIds: traced.paths.map((_, i) => r.refs[`$t${i}`]),
				outlines: traced.total,
			});
		},
	);

	defineTool(
		ctx,
		'set_track_matte',
		{
			title: 'Set track matte',
			description:
				'Applies (or updates) a Track Matte Key on a clip: the clip shows through another video track\'s composite at the same time (matteTrack "V3"). compositeUsing alpha (default) or luma, reverse inverts. Hide the matte track\'s output (Toggle Track Output) so only the result shows — a hidden track still works as a matte. matteTrack null removes the matte. One History entry.',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1),
				matteTrack: z.string().nullable().describe('"V2", "V3"… or null to clear'),
				compositeUsing: z.enum(['alpha', 'luma']).optional(),
				reverse: z.boolean().optional(),
				hideMatteTrack: z
					.boolean()
					.optional()
					.describe("Also turn the matte track's output off (default false)"),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (args, extra) => {
			const { doc } = await loadDoc(ctx, args.projectId);
			const { seq, clip } = findClip(doc, args.clipId);
			let trackId = '';
			if (args.matteTrack) {
				const m = /^V(\d+)$/i.exec(args.matteTrack);
				const t = m
					? seq.videoTracks[Number(m[1]) - 1]
					: seq.videoTracks.find((x) => x.id === args.matteTrack);
				if (!t) throw new ToolError('E_NOT_FOUND', `No video track ${args.matteTrack}`, 'Use "V1", "V2"…');
				trackId = t.id;
			}
			const fx = (clip as { effects?: EffectInstance[] }).effects?.find(
				(e) => e.effectId === 'jasper.track-matte-key',
			);
			const commands: unknown[] = [];
			const params = {
				matteTrack: trackId,
				...(args.compositeUsing
					? { compositeUsing: args.compositeUsing === 'luma' ? 'matteLuma' : 'matteAlpha' }
					: {}),
				...(args.reverse !== undefined ? { reverse: args.reverse } : {}),
			};
			if (fx)
				for (const [k, v] of Object.entries(params))
					commands.push({ type: 'param.set', target: ['effect', fx.id, k], value: v });
			else
				commands.push({
					type: 'effect.add',
					target: { clipId: args.clipId },
					effectId: 'jasper.track-matte-key',
					params,
				});
			if (args.hideMatteTrack && trackId)
				commands.push({ type: 'track.update', trackId, patch: { output: false }, sequenceId: seq.id });
			const res = await transact(
				ctx,
				args.projectId,
				{ label: 'Track Matte', commands, sequenceId: seq.id },
				extra,
			);
			return jsonResult(txBody(res, requireOk(res)));
		},
	);
}
