import type { EngineJob, TrackRequest, TrackResult } from '@jasper/api';
import {
	applyMat3,
	type Clip,
	type ClipTracker,
	CORNER_PIN_EFFECT_ID,
	CORNER_PIN_PARAMS,
	DEFAULT_SIMPLIFY_TOLERANCE,
	findTracker,
	invertMat3,
	layerTimeAt,
	mediaFrameRate,
	motionMapAt,
	type ProjectDocument,
	planTrack,
	plateFrameOf,
	plateMapAt,
	type Quad,
	type Rational,
	type Sequence,
	type SimplifyReport,
	samplesFromTrackResult,
	samplesSummary,
	stepOfRate,
	type TrackMode,
	trackedTargets,
	trackerGeometryAt,
	trackLayerOf,
	type Vec2,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, TIME_FORMATS, timeArg } from '../arguments.ts';
import {
	DESTRUCTIVE_IDEMPOTENT,
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
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

export const TRACKING_GUIDE = [
	'Tracking / screen replacement: put the plate (the footage with the screen or sign) on V1 and the replacement (image, video, composition) on a track above it.',
	'add_tracker (kind "planar", corners = the screen corners TL, TR, BR, BL in the plate media pixels at a frame where they are visible; corners may lie outside the frame) → track (runs the engine tracker, stores the samples; use refineEdges for screens with a visible bezel) → apply_tracking (mode "corner-pin" pins the replacement onto the screen; "position" / "position-scale-rotation" make it follow).',
	'Always check the result with render_frame at a few times (start, middle, end, fast motion); fix a frame with set_corner_pin or move the tracker corners (add_tracker again / apply_commands tracker.update) and re-track.',
	'Tracking bakes one keyframe per frame; simplify_keyframes (or apply_tracking simplifyTolerance) reduces them to the fewest keys that stay within a tolerance in pixels (default 0.1 px) at every frame — preview with dryRun, then apply.',
].join(' ');

const Vec2Arg = z.tuple([z.number(), z.number()]);
const CornersArg = z
	.array(Vec2Arg)
	.length(4)
	.describe('Four corners [x, y] in the order top-left, top-right, bottom-right, bottom-left');
const TrackerIdArg = z.string().min(1).describe('Tracker id ("tkr_…") from add_tracker or get_timeline');

function sequenceOf(doc: ProjectDocument, clipId: string): { seq: Sequence; clip: Clip } {
	for (const seq of Object.values(doc.sequences)) {
		const clip = seq.clips[clipId];
		if (clip) return { seq, clip };
	}
	throw new ToolError('E_NOT_FOUND', `Clip not found: ${clipId}`, 'Look clip ids up with get_timeline.');
}

function locateTracker(doc: ProjectDocument, trackerId: string) {
	const loc = findTracker(doc, trackerId);
	if (!loc)
		throw new ToolError(
			'E_NOT_FOUND',
			`Tracker not found: ${trackerId}`,
			'Tracker ids come from add_tracker (or the clip\'s "trackers" in get_timeline).',
		);
	return { ...loc, seq: doc.sequences[loc.sequenceId]! };
}

function mediaKeyOf(doc: ProjectDocument, mediaId: string): string {
	const asset = doc.media[mediaId];
	const key = asset?.locators.find((l) => l.type === 'engine-store');
	if (!key?.key)
		throw new ToolError(
			'E_NOT_FOUND',
			'The plate clip has no engine media',
			'Import the media with import_media.',
		);
	return key.key;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
const roundPt = (p: readonly number[]): Vec2 => [round2(p[0]!), round2(p[1]!)];

function summaryOf(tracker: ClipTracker, mediaRate: Rational | null) {
	const s = samplesSummary(tracker.samples);
	const step = mediaRate ? stepOfRate(mediaRate) : null;
	const lostFrames: number[] = [];
	if (tracker.samples && step)
		tracker.samples.confidence.forEach((c, i) => {
			if (c <= 0) lostFrames.push(Math.round(tracker.samples!.start / step) + i);
		});
	return {
		samples: s.count,
		...(step && s.start !== null && s.end !== null
			? { sourceFrames: { start: Math.round(s.start / step), end: Math.round(s.end / step) + 1 } }
			: {}),
		...(s.meanConfidence !== null
			? { meanConfidence: round2(s.meanConfidence), minConfidence: round2(s.minConfidence ?? 0) }
			: {}),
		lostFrames: lostFrames.slice(0, 200),
	};
}

export function registerTrackingTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'add_tracker',
		{
			title: 'Add tracker',
			description:
				'Places a tracker on a video clip (the plate): kind "planar" with the four corners of a flat surface (a screen, a sign) or "point" with one point, in the plate media\'s pixels (the source picture, before the clip\'s Motion) at sequence time `at`. Returns the tracker id; run `track` next.',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1).describe('The plate clip ("clp_…", a video clip)'),
				kind: z.enum(['planar', 'point']),
				at: timeArg('Sequence time of the reference frame (inside the clip)'),
				corners: CornersArg.optional().describe(
					'planar: the surface corners TL, TR, BR, BL in media pixels (may lie outside the frame)',
				),
				point: Vec2Arg.optional().describe('point: the point in media pixels'),
				patch: z.number().int().positive().optional().describe('point: template size in media pixels'),
				search: z.number().int().positive().optional().describe('point: search radius in media pixels'),
				name: z.string().min(1).optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, clipId, kind, at, corners, point, patch, search, name }, extra) => {
			const { doc } = await loadDoc(ctx, projectId);
			const { seq } = sequenceOf(doc, clipId);
			const frame = frameOf(seq, at, TIME_FORMATS);
			const cmd = {
				type: 'tracker.add',
				clipId,
				kind,
				at: { sequenceFrame: frame },
				...(corners ? { corners } : {}),
				...(point ? { point } : {}),
				...(patch ? { patch } : {}),
				...(search ? { search } : {}),
				...(name ? { name } : {}),
			};
			const res = await transact(ctx, projectId, { label: 'Add Tracker', commands: [cmd] }, extra);
			const r = requireOk(res);
			const out = r.results[0] as { trackerId: string; reference: unknown };
			return jsonResult({ ...txBody(res, r), trackerId: out.trackerId, reference: out.reference });
		},
	);

	defineTool(
		ctx,
		'track',
		{
			title: 'Track',
			description:
				'Runs the engine tracker for a tracker (from add_tracker) through its clip and stores the result (one History entry "Track"). direction: "both" (default, whole clip from the reference frame), "forward", "backward". Returns the tracked span, mean/min confidence and lost frames. With wait: false it returns the job id at once; call track again with that jobId to store the result when it has finished. Check the result with get_tracker / render_frame.',
			input: {
				projectId: ProjectIdArg,
				trackerId: TrackerIdArg,
				direction: z.enum(['forward', 'backward', 'both']).optional(),
				from: timeArg(
					'Start tracking here from the tracker\'s current geometry at this time ("track from here")',
				)
					.optional()
					.describe(
						"Sequence time: re-track from the tracker's current geometry at this time (after a correction) in `direction` (forward by default); only that span is replaced",
					),
				range: z
					.object({ start: timeArg('First sequence time'), end: timeArg('End sequence time (exclusive)') })
					.optional()
					.describe('Limit the tracked span to these sequence times (default: the whole clip)'),
				quality: z
					.enum(['fast', 'balanced', 'best'])
					.optional()
					.describe('Speed/accuracy (default balanced)'),
				refineEdges: z
					.boolean()
					.optional()
					.describe(
						'planar: snap the quad sides to the straight edges near them every frame (screen bezels)',
					),
				features: z
					.enum(['inside', 'surroundings', 'both'])
					.optional()
					.describe(
						'planar: track texture inside the quad (default) or around it (screens whose content changes)',
					),
				wait: z.boolean().optional().describe('Wait for the job (default true)'),
				jobId: z.string().optional().describe('A track job started with wait: false, to wait for and store'),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (args, extra) => {
			const { projectId, trackerId } = args;
			let loaded = await loadDoc(ctx, projectId);
			const loc = locateTracker(loaded.doc, trackerId);
			const clip = loc.clip;
			const mode: TrackMode = args.from
				? args.direction === 'backward'
					? 'from-here-backward'
					: 'from-here'
				: (args.direction ?? 'both');
			let at: number | undefined;
			if (args.from !== undefined) {
				const f = frameOf(loc.seq, args.from, TIME_FORMATS);
				at = layerTimeAt(clip, f, loc.seq.settings.frameRate);
			}
			let plan: ReturnType<typeof planTrack>;
			try {
				plan = planTrack(loaded.doc, trackerId, {
					mode,
					...(at !== undefined ? { at } : {}),
					...(args.quality ? { quality: args.quality } : {}),
				});
			} catch (e) {
				throw new ToolError('E_INVALID_PARAM', (e as Error).message);
			}
			let merge = plan.merge;
			const request = { ...plan.request };
			if (args.range) {
				const fps = loc.seq.settings.frameRate;
				const f0 = frameOf(loc.seq, args.range.start, TIME_FORMATS);
				const f1 = frameOf(loc.seq, args.range.end, TIME_FORMATS);
				const a = Math.round(layerTimeAt(clip, Math.max(clip.start, f0), fps) / plan.step);
				const b = Math.round(
					layerTimeAt(clip, Math.min(clip.start + clip.duration, f1) - 1, fps) / plan.step,
				);
				const lo = Math.min(a, b, request.reference.frame);
				const hi = Math.max(a, b, request.reference.frame) + 1;
				request.range = { startFrame: Math.max(0, lo), endFrame: hi };
				merge = loc.tracker.samples ? 'span' : 'replace';
			}
			const body: TrackRequest = {
				...request,
				mediaKey: mediaKeyOf(loaded.doc, plan.mediaId),
				projectId,
				trackerId,
				...(args.refineEdges !== undefined || args.features
					? {
							options: {
								...(args.refineEdges !== undefined ? { refineEdges: args.refineEdges } : {}),
								...(args.features ? { features: args.features } : {}),
							},
						}
					: {}),
			};
			let job: EngineJob;
			let timedOut: boolean;
			if (args.jobId) ({ job, timedOut } = await waitJob(ctx, args.jobId, 600_000, extra));
			else {
				job = await ctx.engine((c) => c.call('trackingTrack', { body }));
				timedOut = true;
				if (args.wait !== false) ({ job, timedOut } = await waitJob(ctx, job.id, 600_000, extra));
			}
			if (!isTerminal(job) || timedOut) {
				return jsonResult({
					jobId: job.id,
					state: job.state,
					note: 'Tracking is running. Call track again with this jobId (same trackerId) to store the result.',
				});
			}
			if (job.state !== 'succeeded')
				throw new ToolError(
					job.error?.code ?? 'TRACK_FAILED',
					job.error?.message ?? `The track job ${job.state}`,
					'Check the tracker corners (get_tracker) and the clip, then retry.',
				);
			const result = job.result as TrackResult;
			// Re-read: the document may have changed while the job ran.
			loaded = await loadDoc(ctx, projectId);
			const samples = samplesFromTrackResult(result, plan.step);
			const res = await transact(
				ctx,
				projectId,
				{
					label: 'Track',
					commands: [{ type: 'tracker.setSamples', trackerId, samples, method: result.method, merge }],
				},
				extra,
			);
			const r = requireOk(res);
			const after = locateTracker((await loadDoc(ctx, projectId)).doc, trackerId);
			const lost = result.lost ?? [];
			const conf = result.confidence;
			return jsonResult({
				...txBody(res, r),
				trackerId,
				jobId: job.id,
				trackedSourceFrames: { start: result.startFrame, end: result.startFrame + conf.length },
				meanConfidence: round2(conf.reduce((a, b) => a + b, 0) / Math.max(1, conf.length)),
				minConfidence: round2(Math.min(...conf, 1)),
				lostFrames: lost.slice(0, 200),
				...(result.framesPerSec ? { framesPerSec: round2(result.framesPerSec) } : {}),
				tracker: summaryOf(after.tracker, mediaFrameRate(loaded.doc.media[after.clip.mediaId])),
				next: 'Verify with get_tracker or render_frame, then apply_tracking.',
			});
		},
	);

	defineTool(
		ctx,
		'apply_tracking',
		{
			title: 'Apply tracking',
			description:
				'Bakes a tracker onto a target clip as ordinary keyframes (one History entry "Apply Tracking"). mode "corner-pin": the target gets a Corner Pin effect whose four corners follow the tracked quad (screen replacement; planar trackers). mode "position" / "position-scale-rotation": the target\'s Motion follows the tracked point / quad centre. Default range: where the plate and the target overlap. Check with render_frame afterwards.',
			input: {
				projectId: ProjectIdArg,
				trackerId: TrackerIdArg,
				targetClipId: z.string().min(1).describe('The clip that follows (on a track above the plate)'),
				mode: z.enum(['corner-pin', 'position', 'position-scale-rotation']),
				smoothing: z
					.number()
					.min(0)
					.max(60)
					.optional()
					.describe('Temporal smoothing radius in frames stored on the tracker (0 = none)'),
				range: z
					.object({ start: timeArg('First sequence time'), end: timeArg('End sequence time (exclusive)') })
					.optional(),
				simplifyTolerance: z
					.number()
					.positive()
					.max(100)
					.optional()
					.describe(
						'Also simplify the baked per-frame keyframes in the same step, keeping the result within this many sequence pixels of the track at every frame (e.g. 0.1–0.5)',
					),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, trackerId, targetClipId, mode, smoothing, range, simplifyTolerance }, extra) => {
			const { doc } = await loadDoc(ctx, projectId);
			const loc = locateTracker(doc, trackerId);
			const commands: unknown[] = [];
			if (smoothing !== undefined) commands.push({ type: 'tracker.update', trackerId, smoothing });
			commands.push({
				type: 'tracker.apply',
				trackerId,
				targetClipId,
				mode: mode === 'corner-pin' ? 'corner-pin' : 'transform',
				...(mode === 'position' ? { components: ['position'] } : {}),
				...(range
					? {
							range: {
								start: frameOf(loc.seq, range.start, TIME_FORMATS),
								end: frameOf(loc.seq, range.end, TIME_FORMATS),
							},
						}
					: {}),
				...(simplifyTolerance !== undefined ? { simplify: { tolerance: simplifyTolerance } } : {}),
			});
			const res = await transact(ctx, projectId, { label: 'Apply Tracking', commands }, extra);
			const r = requireOk(res);
			const applied = r.results.at(-1) as { frames?: number; simplified?: unknown } | undefined;
			return jsonResult({
				...txBody(res, r),
				...(applied?.frames !== undefined ? { frames: applied.frames } : {}),
				...(applied?.simplified ? { simplified: applied.simplified } : {}),
				next: 'Check the result with render_frame at a few times.',
			});
		},
	);

	defineTool(
		ctx,
		'get_tracker',
		{
			title: 'Get tracker',
			description:
				"A tracker's reference, tracked span, confidence summary and lost frames, and its geometry at the given sequence frames: corners/point in plate media pixels and in sequence (Program) pixels, with confidence.",
			input: {
				projectId: ProjectIdArg,
				trackerId: TrackerIdArg,
				frames: z
					.array(z.union([z.number().int(), z.string(), z.object({ seconds: z.number() })]))
					.max(200)
					.optional()
					.describe(
						`Sequence times to report (default: first, middle and last frame of the clip). ${TIME_FORMATS}`,
					),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, trackerId, frames }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const loc = locateTracker(doc, trackerId);
			const { seq, clip, tracker } = loc;
			const fps = seq.settings.frameRate;
			const layer = trackLayerOf(doc, seq, clip);
			const list = frames?.length
				? frames.map((f) => frameOf(seq, f, TIME_FORMATS))
				: [clip.start, clip.start + Math.floor(clip.duration / 2), clip.start + clip.duration - 1];
			const at = list.map((f) => {
				const t = layerTimeAt(layer, f, fps);
				const g = trackerGeometryAt(tracker, t);
				const P = plateMapAt(layer, t);
				return {
					frame: f,
					confidence: round2(g.confidence),
					tracked: g.tracked,
					...(g.corners
						? {
								corners: g.corners.map(roundPt),
								sequenceCorners: g.corners.map((p) => roundPt(applyMat3(P, p))),
							}
						: {}),
					...(g.point ? { point: roundPt(g.point), sequencePoint: roundPt(applyMat3(P, g.point)) } : {}),
				};
			});
			return jsonResult({
				trackerId,
				clipId: clip.id,
				name: tracker.name,
				kind: tracker.kind,
				method: tracker.method,
				...(tracker.smoothing ? { smoothing: tracker.smoothing } : {}),
				reference: {
					...tracker.reference,
					sequenceFrame: plateFrameOf(layer, tracker.reference.time, fps),
				},
				summary: summaryOf(tracker, mediaFrameRate(doc.media[clip.mediaId])),
				at,
			});
		},
	);

	defineTool(
		ctx,
		'set_corner_pin',
		{
			title: 'Set corner pin',
			description:
				"Places a clip's four corners by hand (adds a Corner Pin effect if the clip has none): corners in sequence (Program) pixels (default) or normalised to the clip's own picture (0,0 = its top-left, 1,1 = its bottom-right). With `at`, a keyframe is written at that time (the corners animate); without it the static corners are set. Use it for manual placement or to correct a tracked frame; check with render_frame.",
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1).describe('The clip to pin'),
				corners: CornersArg,
				space: z
					.enum(['sequence', 'normalized'])
					.optional()
					.describe('Units of `corners` (default sequence)'),
				at: timeArg('Keyframe time').optional(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, clipId, corners, space, at }, extra) => {
			const { doc } = await loadDoc(ctx, projectId);
			const { seq, clip } = sequenceOf(doc, clipId);
			const layer = trackLayerOf(doc, seq, clip);
			if (!layer.transform)
				throw new ToolError('E_INVALID_PARAM', `${clip.kind} clips cannot be corner pinned`);
			const frame = at !== undefined ? frameOf(seq, at, TIME_FORMATS) : clip.start;
			let norm: Quad;
			if (space === 'normalized') norm = corners.map((p) => [p[0], p[1]]) as Quad;
			else {
				const t = layerTimeAt(layer, frame, seq.settings.frameRate);
				const Mi = invertMat3(motionMapAt(layer, t));
				if (!Mi) throw new ToolError('E_INVALID_PARAM', 'The clip has a zero scale at that time');
				norm = corners.map((p) => {
					const q = applyMat3(Mi, p);
					return [q[0] / layer.box.width, q[1] / layer.box.height];
				}) as Quad;
			}
			const existing = layer.effects.find((e) => e.effectId === CORNER_PIN_EFFECT_ID);
			const commands: unknown[] = [];
			const fxRef = existing ? existing.id : '$pin';
			if (!existing)
				commands.push({
					type: 'effect.add',
					target: { clipId },
					effectId: CORNER_PIN_EFFECT_ID,
					index: 0,
					ref: '$pin',
				});
			CORNER_PIN_PARAMS.forEach((name, i) => {
				const target = ['effect', fxRef, name];
				const animated = (existing?.params[name]?.keyframes.length ?? 0) > 0;
				if (at !== undefined && !animated)
					commands.push({ type: 'param.setAnimated', target, animated: true, at: { sequenceFrame: frame } });
				commands.push({
					type: 'param.set',
					target,
					value: norm[i],
					...(at !== undefined ? { at: { sequenceFrame: frame } } : {}),
				});
			});
			const res = await transact(ctx, projectId, { label: 'Corner Pin', commands }, extra);
			const r = requireOk(res);
			return jsonResult({
				...txBody(res, r),
				normalizedCorners: norm.map((p) => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6]),
				next: 'Check with render_frame.',
			});
		},
	);
	defineTool(
		ctx,
		'simplify_keyframes',
		{
			title: 'Simplify keyframes',
			description: 'Reduce dense keyframes to the fewest that stay within `tolerance` of the original.',
			details:
				'Reduces dense keyframes (tracking output: corner pins and Motion baked one key per frame; recorded animation) to the fewest keys whose animation stays within `tolerance` of the original at EVERY frame — sequence pixels for Motion (position/scale/rotation/anchor) and corner pins (largest displacement of the drawn picture), the parameter\'s own units otherwise (e.g. % for opacity). Kept keys keep their times and values; segments become linear or fitted Bezier eases. Pick what to simplify with exactly one of: clipId (every keyframed parameter of the clip; trackedOnly = only what apply_tracking wrote), trackerId (the clips that tracker drives), targets (parameter paths) or keyframeIds (only those keys may go). Use dryRun to preview the counts and the measured maximum deviation; one History entry "Simplify Keyframes" otherwise.',
			input: {
				projectId: ProjectIdArg,
				tolerance: z
					.number()
					.positive()
					.max(10_000)
					.optional()
					.describe(
						'Maximum deviation at any frame (default 0.1): sequence px for geometry, units otherwise',
					),
				clipId: z.string().min(1).optional().describe('Simplify the keyframed parameters of this clip'),
				trackedOnly: z
					.boolean()
					.optional()
					.describe('With clipId: only the corner pin / Motion keys written by apply_tracking'),
				trackerId: TrackerIdArg.optional().describe(
					'Simplify the tracked keys of every clip this tracker drives',
				),
				targets: z
					.array(z.array(z.string().min(1)).min(2))
					.min(1)
					.optional()
					.describe(
						'Parameter paths, e.g. ["clip","clp_…","transform","position"] or ["effect","fx_…","topLeft"]',
					),
				keyframeIds: z.array(z.string().min(1)).min(1).optional().describe('Only these keys may be removed'),
				dryRun: z.boolean().optional().describe('Report what would happen without changing the project'),
			},
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async ({ projectId, tolerance, clipId, trackedOnly, trackerId, targets, keyframeIds, dryRun }, extra) => {
			const given = [clipId, trackerId, targets, keyframeIds].filter((x) => x !== undefined).length;
			if (given !== 1)
				throw new ToolError(
					'E_INVALID_PARAM',
					'Give exactly one of clipId, trackerId, targets or keyframeIds',
					'clipId is the usual choice after apply_tracking.',
				);
			let selection: Record<string, unknown>;
			if (trackerId) {
				const { doc } = await loadDoc(ctx, projectId);
				locateTracker(doc, trackerId);
				const clipIds = trackedTargets(doc, trackerId).map((t) => t.clipId);
				if (!clipIds.length)
					throw new ToolError(
						'E_INVALID_PARAM',
						'No clip follows this tracker yet',
						'Bake it first with apply_tracking.',
					);
				selection = { clipIds, trackedOnly: true };
			} else if (clipId) selection = { clipIds: [clipId], ...(trackedOnly ? { trackedOnly: true } : {}) };
			else if (targets) selection = { targets };
			else selection = { keyframeIds };
			const res = await transact(
				ctx,
				projectId,
				{
					label: 'Simplify Keyframes',
					commands: [
						{ type: 'keyframes.simplify', tolerance: tolerance ?? DEFAULT_SIMPLIFY_TOLERANCE, ...selection },
					],
					...(dryRun ? { dryRun: true } : {}),
				},
				extra,
			);
			const r = requireOk(res);
			const rep = r.results[0] as SimplifyReport;
			return jsonResult({
				...txBody(res, r, dryRun === true),
				tolerance: rep.tolerance,
				keyframesBefore: rep.before,
				keyframesAfter: rep.after,
				removed: rep.removed,
				maxDeviation: round4(rep.maxError),
				groups: rep.groups.map((g) => ({
					kind: g.kind,
					clipId: g.clipId,
					unit: g.unit,
					maxDeviation: round4(g.maxError),
					meanDeviation: round4(g.meanError),
					parameters: g.paths,
				})),
				properties: rep.properties.map((p) => ({ path: p.path, before: p.before, after: p.after })),
				...(rep.skipped.length ? { skipped: rep.skipped } : {}),
				next: dryRun
					? 'Run again without dryRun to apply.'
					: 'Check a few frames with render_frame; undo restores the dense keys.',
			});
		},
	);
}
