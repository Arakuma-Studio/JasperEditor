// Workstream `time` MCP tools (docs/wp-notes/time.md): Premiere's Time Remapping (speed keyframes, ramps, freeze and
// reverse segments), Time Interpolation (Frame Sampling / Frame Blending / Optical Flow) and Scene Edit Detection.
// Every edit is one transaction of document commands (also available through apply_commands).
import type { EngineJob, SceneDetectResult } from '@jasper/api';
import {
	activeRemap,
	type Clip,
	clipMediaRange,
	clipSpeedAt,
	FLICKS_PER_SECOND,
	type Rational,
	remapKeyViews,
	remapSegmentViews,
	type Sequence,
	type TimedClip,
	timeInterpolationOf,
} from '@jasper/project';
import { z } from 'zod';
import {
	applyCommands,
	DESTRUCTIVE_IDEMPOTENT,
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
	findClip,
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
import { timeArg } from './editing.ts';
import { ProjectIdArg } from './projects.ts';

/** Appended to the server instructions. */
export const TIME_GUIDE = `Time remapping, time interpolation, scene edit detection:
- Speeds are Premiere percentages: 100 = normal, 50 = half speed (twice as long), 200 = double speed; time remap segments go up to 20,000 %. get_time_remap shows a clip's speed segments (forward / reverse / hold, frames, speed, media seconds) and speed keyframes.
- Time Remapping (video and nested-sequence clips, multi-camera clips too): set_segment_speed changes the speed of the segment under a frame (it keeps its source frames, so the clip gets longer or shorter; without ripple it stops at the next clip and the rest goes into its tail, ripple moves the clips after it). add_speed_keyframe splits a segment at a frame; set_speed_transition ramps the speed change around a keyframe over N frames (ease 0 linear … 1 smooth); move_speed_keyframe moves one; add_freeze_segment holds a frame for a duration; add_reverse_segment plays backward for a duration then forward again (Premiere's palindrome reverse). remove_time_remap / set_time_remap enabled:false deletes every speed keyframe.
- Linked audio is NOT time-remapped (Premiere): it keeps playing at 100 % and drifts; set_time_remap linkedAudio:"mute" disables it, "unlink" unlinks it.
- Motion, Opacity and effect keyframes stay where they are on the timeline when the speed changes.
- set_time_interpolation: frame-sampling (repeat/drop frames), frame-blending (cross-fade neighbours), optical-flow (motion-compensated in-between frames) — used for slow motion, remaps and media whose frame rate differs from the sequence. Video clips only.
- Constant speed and Reverse Speed stay on apply_commands clip.setSpeed (Speed/Duration); a remapped clip uses reverse segments instead of Reverse Speed.
- detect_scene_edits (Premiere Scene Edit Detection) analyses the selected video clips' media in the engine and, in one undo step, cuts them (and their linked audio) at each detected shot change, and/or makes a bin of scene items (subclips: media items marked to each shot) and/or adds clip markers. Dissolves, flashes and fast pans are not cuts.
- Variable-frame-rate media (phone footage) are mapped by their real frame timestamps in the preview and every export path; no conform is needed.`;

const ClipIdArg = z.string().min(1).describe('Clip id ("clp_…") from get_timeline');
const ClipIdsArg = z.array(z.string().min(1)).min(1).describe('Clip ids ("clp_…") from get_timeline');
const SpeedArg = z.number().gt(0).max(20_000).describe('Speed in percent (100 = normal)');

/** A clip's time mapping for agents. */
function describeTimeRemap(seq: Sequence, clip: Clip) {
	const rate = seq.settings.frameRate as Rational;
	const c = clip as TimedClip;
	const round = (x: number) => Math.round(x * 1000) / 1000;
	return {
		clipId: clip.id,
		kind: clip.kind,
		start: clip.start,
		duration: clip.duration,
		timeRemapping: !!activeRemap(c),
		timeInterpolation: timeInterpolationOf(c),
		speedAtStart: round(clipSpeedAt(c, clip.start, rate) * 100),
		segments: remapSegmentViews(c, rate).map((s) => ({
			kind: s.kind,
			fromFrame: round(s.fromFrame),
			toFrame: round(s.toFrame),
			speedPercent: round(s.speed * 100),
			mediaFromSeconds: round(s.mediaFrom),
			mediaToSeconds: round(s.mediaTo),
		})),
		keyframes: remapKeyViews(c, rate).map((k) => ({
			id: k.id,
			frame: round(k.frame),
			mediaSeconds: round(k.mediaSeconds),
			transitionFrames: round(k.rampFrames * 2),
			ease: k.ease,
			visible: k.visible,
		})),
	};
}

export function registerTimeTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'get_time_remap',
		{
			title: 'Get time remapping',
			description:
				"A clip's time mapping: Time Remapping on/off, its constant-speed segments (forward / reverse / hold with sequence frames, speed % and media seconds), speed keyframes (frame, media seconds, transition length) and Time Interpolation.",
			input: { projectId: ProjectIdArg, clipId: ClipIdArg },
			annotations: READ_ONLY,
		},
		async ({ projectId, clipId }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const { seq, clip } = findClip(doc, clipId);
			return jsonResult(describeTimeRemap(seq, clip));
		},
	);

	defineTool(
		ctx,
		'set_time_remap',
		{
			title: 'Time Remapping on / off',
			description:
				'Turns Time Remapping on (timeRemap.enable; the clip keeps playing as before until speeds change) or off (every speed keyframe deleted; a slowed clip is trimmed to its media). linkedAudio (when turning on): "keep" (Premiere: the audio plays at 100 % and drifts), "mute" or "unlink".',
			input: {
				projectId: ProjectIdArg,
				clipIds: ClipIdsArg,
				enabled: z.boolean(),
				linkedAudio: z.enum(['keep', 'mute', 'unlink']).optional(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, clipIds, enabled, linkedAudio }, extra) =>
			applyCommands(
				ctx,
				projectId,
				enabled ? 'Time Remapping' : 'Remove Time Remapping',
				[{ type: 'timeRemap.enable', clipIds, enabled, ...(linkedAudio ? { linkedAudio } : {}) }],
				extra,
			),
	);

	defineTool(
		ctx,
		'set_segment_speed',
		{
			title: 'Set segment speed',
			description:
				'Time Remapping: the speed of the constant-speed segment containing sequence frame `at` (turns Time Remapping on when needed). The segment keeps its source frames, so it gets longer (slower) or shorter (faster) and everything after it moves; without ripple the clip stops at the next clip (the rest goes into its tail), with ripple later clips move.',
			input: {
				projectId: ProjectIdArg,
				clipId: ClipIdArg,
				at: timeArg('A sequence frame inside the segment'),
				speedPercent: SpeedArg,
				ripple: z.boolean().optional(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, clipId, at, speedPercent, ripple }, extra) =>
			applyCommands(
				ctx,
				projectId,
				'Change Speed',
				[
					{
						type: 'timeRemap.setSpeed',
						clipId,
						at,
						speedPercent,
						...(ripple !== undefined ? { ripple } : {}),
					},
				],
				extra,
			),
	);

	defineTool(
		ctx,
		'add_speed_keyframe',
		{
			title: 'Add speed keyframe',
			description:
				'Time Remapping: a speed keyframe at sequence frame `at` (splits a segment; the picture does not change). Returns {keyframeId}.',
			input: { projectId: ProjectIdArg, clipId: ClipIdArg, at: timeArg('Sequence frame inside the clip') },
			annotations: EDIT,
		},
		async ({ projectId, clipId, at }, extra) =>
			applyCommands(
				ctx,
				projectId,
				'Add Speed Keyframe',
				[{ type: 'timeRemap.addKeyframe', clipId, at }],
				extra,
			),
	);

	defineTool(
		ctx,
		'remove_speed_keyframes',
		{
			title: 'Remove speed keyframes',
			description:
				'Deletes speed keyframes (the neighbours keep their source frames; the merged segment gets the speed between them).',
			input: { projectId: ProjectIdArg, clipId: ClipIdArg, keyframeIds: z.array(z.string().min(1)).min(1) },
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async ({ projectId, clipId, keyframeIds }, extra) =>
			applyCommands(
				ctx,
				projectId,
				'Delete Speed Keyframes',
				[{ type: 'timeRemap.removeKeyframes', clipId, keyframeIds }],
				extra,
			),
	);

	defineTool(
		ctx,
		'move_speed_keyframe',
		{
			title: 'Move speed keyframe',
			description:
				"Moves a speed keyframe to sequence frame `to` (Premiere Alt-drag): segment speeds stay, the source frame where the speed changes moves; moving a freeze's first keyframe picks another frame to hold, its second changes how long the hold lasts.",
			input: {
				projectId: ProjectIdArg,
				clipId: ClipIdArg,
				keyframeId: z.string().min(1),
				to: timeArg('Target sequence frame'),
				ripple: z.boolean().optional(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, clipId, keyframeId, to, ripple }, extra) =>
			applyCommands(
				ctx,
				projectId,
				'Move Speed Keyframe',
				[
					{
						type: 'timeRemap.moveKeyframe',
						clipId,
						keyframeId,
						to,
						...(ripple !== undefined ? { ripple } : {}),
					},
				],
				extra,
			),
	);

	defineTool(
		ctx,
		'set_speed_transition',
		{
			title: 'Speed transition (ramp)',
			description:
				'Ramps the speed change at a keyframe over `frames` sequence frames centred on it (Premiere: drag the keyframe halves apart; 0 = instantaneous). ease 0 = linear speed change … 1 = smooth S-curve (default 1). Limited to half of each neighbouring segment.',
			input: {
				projectId: ProjectIdArg,
				clipId: ClipIdArg,
				keyframeId: z.string().min(1),
				frames: z.number().min(0),
				ease: z.number().min(0).max(1).optional(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, clipId, keyframeId, frames, ease }, extra) =>
			applyCommands(
				ctx,
				projectId,
				'Speed Transition',
				[
					{
						type: 'timeRemap.setTransition',
						clipId,
						keyframeId,
						frames,
						...(ease !== undefined ? { ease } : {}),
					},
				],
				extra,
			),
	);

	defineTool(
		ctx,
		'add_freeze_segment',
		{
			title: 'Freeze frame segment',
			description:
				'Time Remapping freeze (Premiere Ctrl+Alt-drag): the frame at sequence frame `at` holds for `duration`, then the clip plays on; what follows moves later (ripple moves later clips too).',
			input: {
				projectId: ProjectIdArg,
				clipId: ClipIdArg,
				at: timeArg('Sequence frame to hold'),
				duration: timeArg('How long the frame holds'),
				ripple: z.boolean().optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, clipId, at, duration, ripple }, extra) =>
			applyCommands(
				ctx,
				projectId,
				'Freeze Frame',
				[{ type: 'timeRemap.addFreeze', clipId, at, duration, ...(ripple !== undefined ? { ripple } : {}) }],
				extra,
			),
	);

	defineTool(
		ctx,
		'add_reverse_segment',
		{
			title: 'Reverse segment',
			description:
				"Time Remapping palindrome reverse (Premiere Ctrl-drag): from sequence frame `at` the clip plays backward for `duration` at speedPercent (default 100), then forward over the same frames back to `at`, then on. Never goes before the media's first frame.",
			input: {
				projectId: ProjectIdArg,
				clipId: ClipIdArg,
				at: timeArg('Sequence frame where the backward motion starts'),
				duration: timeArg('Length of the backward part'),
				speedPercent: SpeedArg.optional(),
				ripple: z.boolean().optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, clipId, at, duration, speedPercent, ripple }, extra) =>
			applyCommands(
				ctx,
				projectId,
				'Reverse Speed Segment',
				[
					{
						type: 'timeRemap.addReverse',
						clipId,
						at,
						duration,
						...(speedPercent !== undefined ? { speedPercent } : {}),
						...(ripple !== undefined ? { ripple } : {}),
					},
				],
				extra,
			),
	);

	defineTool(
		ctx,
		'set_time_interpolation',
		{
			title: 'Time Interpolation',
			description:
				'Clip ▸ Video Options ▸ Time Interpolation of video clips: frame-sampling (repeats or drops frames), frame-blending (cross-fades neighbouring frames), optical-flow (motion-compensated in-between frames: best slow motion, slower to render).',
			input: {
				projectId: ProjectIdArg,
				clipIds: ClipIdsArg,
				mode: z.enum(['frame-sampling', 'frame-blending', 'optical-flow']),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, clipIds, mode }, extra) =>
			applyCommands(
				ctx,
				projectId,
				'Time Interpolation',
				[{ type: 'clip.setTimeInterpolation', clipIds, mode }],
				extra,
			),
	);

	defineTool(
		ctx,
		'detect_scene_edits',
		{
			title: 'Scene Edit Detection',
			description:
				'Premiere Scene Edit Detection: the engine analyses the media each video clip shows and finds its shot changes (hard cuts; dissolves, flashes and fast pans are ignored). Then, in ONE undo step: applyCuts (default true) adds an edit at each cut (linked audio too), createSubclips makes a bin of scene items, createMarkers adds clip markers. sensitivity 0…100 (default 50), minShotFrames (default 2). dryRun: true only reports the cut times. Long clips: wait:false returns jobIds; call again with them.',
			input: {
				projectId: ProjectIdArg,
				clipIds: ClipIdsArg,
				applyCuts: z.boolean().optional(),
				createSubclips: z.boolean().optional(),
				createMarkers: z.boolean().optional(),
				sensitivity: z.number().min(0).max(100).optional(),
				minShotFrames: z.number().int().min(1).max(10_000).optional(),
				dryRun: z.boolean().optional(),
				wait: z.boolean().optional(),
				jobIds: z
					.record(z.string(), z.string())
					.optional()
					.describe('clipId → jobId from an earlier wait:false call'),
			},
			annotations: EDIT,
		},
		async (args, extra) => {
			const { projectId, clipIds } = args;
			const applyCuts = args.applyCuts ?? true;
			const createSubclips = args.createSubclips ?? false;
			const createMarkers = args.createMarkers ?? false;
			if (!args.dryRun && !applyCuts && !createSubclips && !createMarkers)
				throw new ToolError(
					'E_INVALID_PARAM',
					'Choose at least one of applyCuts, createSubclips, createMarkers',
					'Or pass dryRun: true.',
				);
			const { doc } = await loadDoc(ctx, projectId);
			const jobs: Record<string, EngineJob> = {};
			for (const clipId of clipIds) {
				const { seq, clip } = findClip(doc, clipId);
				if (clip.kind !== 'video')
					throw new ToolError(
						'E_INVALID_PARAM',
						`Clip ${clipId} is a ${clip.kind} clip`,
						'Scene Edit Detection analyses video clips.',
					);
				const prior = args.jobIds?.[clipId];
				if (prior) {
					jobs[clipId] = await ctx.engine((c) => c.getJob(prior));
					continue;
				}
				const asset = doc.media[(clip as { mediaId: string }).mediaId];
				const key = asset?.locators.find((l) => l.type === 'engine-store');
				if (key?.type !== 'engine-store')
					throw new ToolError(
						'E_NOT_FOUND',
						`Clip ${clipId} has no engine media`,
						'Import the media with import_media.',
					);
				const rate = seq.settings.frameRate as Rational;
				const r = clipMediaRange(clip as TimedClip, rate);
				const step = (rate.den / rate.num) * Math.max(1, clip.speed.rate);
				jobs[clipId] = await ctx.engine((c) =>
					c.detectScenes({
						projectId,
						mediaKey: key.key,
						startSec: Math.max(0, r.min / FLICKS_PER_SECOND),
						endSec: r.max / FLICKS_PER_SECOND + step,
						sensitivity: args.sensitivity ?? 50,
						minShotFrames: args.minShotFrames ?? 2,
					}),
				);
			}
			if (args.wait !== false)
				for (const id of Object.keys(jobs))
					if (!isTerminal(jobs[id]!)) jobs[id] = (await waitJob(ctx, jobs[id]!.id, 600_000, extra)).job;
			const pending = Object.entries(jobs).filter(([, j]) => !isTerminal(j));
			if (pending.length > 0)
				return jsonResult({
					jobIds: Object.fromEntries(Object.entries(jobs).map(([k, j]) => [k, j.id])),
					note: 'Scene Edit Detection is running. Call detect_scene_edits again with these jobIds to apply the results.',
				});
			for (const [id, j] of Object.entries(jobs))
				if (j.state !== 'succeeded')
					throw new ToolError(
						j.error?.code ?? 'SCENE_DETECT_FAILED',
						`Clip ${id}: ${j.error?.message ?? j.state}`,
					);
			const results = Object.fromEntries(
				Object.entries(jobs).map(([k, j]) => [k, j.result as SceneDetectResult]),
			);
			const report = Object.fromEntries(
				Object.entries(results).map(([k, r]) => [
					k,
					{ cutsSeconds: r.cuts.map((x) => Math.round(x * 1000) / 1000), frames: r.frames },
				]),
			);
			if (args.dryRun) return jsonResult({ dryRun: true, clips: report });
			const commands = Object.entries(results).map(([clipId, r]) => ({
				type: 'clip.applySceneEdits',
				clipId,
				cuts: r.cuts.map((s) => Math.round(s * FLICKS_PER_SECOND)),
				applyCuts,
				createSubclips,
				createMarkers,
			}));
			const res = await transact(ctx, projectId, { label: 'Scene Edit Detection', commands }, extra);
			return jsonResult({ ...txBody(res, requireOk(res)), clips: report });
		},
	);
}
