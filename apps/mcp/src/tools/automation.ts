// Editing automation tools (spec 15 EA-020…EA-022, EA-041): decorate_cuts, add_punch_ins, add_ken_burns. Each runs
// one pass of the engine (`POST /api/projects/:projectId/automation/:pass`): `mode: 'dryRun'` says what it would do
// (counts, coverage, skips with reasons, kit families, export cost, whether it fits one proposal, the sounds it would
// use); `mode: 'propose'` (default) stores a proposal of feature `edit-automation` for the user's review (apply with
// accept_proposal where the project allows agents to; nothing changes until then). Guide: AUTOMATION_GUIDE.
import {
	type AutomationPassId,
	type AutomationPassResult,
	AutomationPassResultSchema,
	type EngineJob,
} from '@jasper/api';
import { TimeInputSchema } from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg } from '../arguments.ts';
import {
	cancelIfAborted,
	defineTool,
	EDIT,
	type Extra,
	frameOf,
	loadDoc,
	type ToolContext,
	waitJob,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { pickSequence } from '../format.ts';

export const AUTOMATION_GUIDE = `Editing automation (spec 15): passes that decorate the edit the way the user's videos are cut, each as ONE proposal (feature "edit-automation", Review groups Cut kits / Punch-ins / Ken Burns) the user reviews in the Review panel (timeline ghosts, ✓ / ✕ per item, ⇄ alternatives, ↻ Refresh proposal after edits, Reroll per item) and applies as one undo step.
- decorate_cuts: a cut kit at every picture cut (the cut map, list_cuts): an adjustment clip on an "FX" track above the picture (created when needed), centred on the cut exactly — vertical sequences get the shorts kit (S_Shake 10 + 10 frames, Amplitude 0.5, Frequency 6, Motion Blur), others the long-form pack (Jolt 49 %, Whip 17 %, Zoom blur 17 %, Zoom through 9 %, Spin 8 %, few repeats: P(same as previous) 0.23) — with 2-key eased curves; kits never overlap (close cuts take a shorter family or are skipped, reported), plus a whoosh exactly as long as the kit with its peak on the cut, placed through sound design (a cue anchored to the edit + soundDesign.place; a library sound of type sfx.type, default whoosh, from the starter kit / packs / your folders). Kits render through the Remotion export path (their shader effects have no native route): the dry run says so.
- add_punch_ins: Motion zooms on the A-roll clips ≥ 1.5 s (density 0.7 of them, "!" / "?" phrases first): from the clip's midpoint (or nearest word start), 7 frames linear 100 → 180 %, held to the cut; target centre, a point, or the subject (face tracking / saliency); method "motion" (default, Motion keys: native export) or "adjustment" (a Transform clip on a ZOOM track right above the A-roll); optional whoosh.
- add_ken_burns: slow zooms over 15 % of the remaining A-roll clips, keys on the first and last frame, 100 ↔ 118 % (vertical) / 130 %, zoom-in : zoom-out 2 : 1. Native export.
- Workflow: run the cleanup and subtitle passes first when the project uses them; then for each pass call it with mode "dryRun" (read the counts, skips and cost), adjust parameters, call it again in mode "propose", and ASK THE USER to review the proposal (wait_for_proposal). Only accept_proposal yourself when the user asked you to apply it and the project allows it (Project Settings ▸ Agent Proposals, on by default). Reroll an item with refresh_proposal {itemIds: [...], reroll: true}; after the user edits, refresh_proposal re-plans stale items. Run punch-ins before Ken Burns (Ken Burns skips clips whose Motion is keyed) or pass excludeClipIds. Every pass is deterministic for its seed; the parameters are plain data (style recipes reuse them). A pass too big for one proposal fails with E_TOO_LARGE and a suggestedRange: run it on that range, then on the rest.`;

const RangeArg = z
	.object({ start: TimeInputSchema, end: TimeInputSchema })
	.optional()
	.describe('Only this part of the sequence [start, end): frames, {"seconds": x} or "HH:MM:SS:FF"');
const ModeArg = z
	.enum(['propose', 'dryRun'])
	.optional()
	.describe('"propose" (default): store a proposal for review; "dryRun": only say what the pass would do');
const SeedArg = z
	.number()
	.int()
	.min(0)
	.max(0xffff_ffff)
	.optional()
	.describe('Seed of the random choices (default 1); the same seed and edit give the same plan');
const TrackArg = (what: string) => z.string().min(1).max(128).optional().describe(what);
const SfxArg = z
	.object({
		enabled: z.boolean().optional().describe('Place a sound per decoration (default true)'),
		type: z
			.string()
			.regex(/^[a-z][a-z0-9-]{0,31}$/)
			.optional()
			.describe('Sound type of the library sounds (asset role; default "whoosh")'),
		sources: z
			.array(z.enum(['starter', 'pack', 'folder', 'synth']))
			.min(1)
			.max(4)
			.optional()
			.describe('Library sources allowed (default all; synth only when nothing else fits)'),
		packId: z.string().min(1).max(64).optional().describe('Only sounds of this installed pack (list_sound_packs)'),
		rootId: z.string().min(1).max(64).optional().describe('Only sounds of this sound folder (sound_library_status)'),
		gainDb: z.number().min(-60).max(12).optional().describe('Clip gain in dB (default: sound design’s support level)'),
		variety: z.number().int().min(1).max(16).optional().describe('Sounds the rotation cycles through (default 12)'),
	})
	.optional();
const TimeoutArg = z
	.number()
	.int()
	.min(1)
	.max(900)
	.optional()
	.describe('Wait for the proposal (default 300 s)');
const ExcludeArg = z
	.array(z.string().min(1).max(128))
	.max(10_000)
	.optional()
	.describe('Clip ids the pass must leave alone (another pass decorates them)');

type Args = {
	projectId: string;
	sequenceId?: string;
	mode?: 'propose' | 'dryRun';
	range?: { start: unknown; end: unknown };
	timeoutSeconds?: number;
} & Record<string, unknown>;

function compact(r: AutomationPassResult) {
	const s = r.summary;
	return {
		pass: r.pass,
		mode: r.mode,
		sequenceId: r.sequenceId,
		count: s.count,
		considered: s.considered,
		coverage: s.coverage,
		...(s.families ? { families: s.families } : {}),
		skipped: {
			count: s.skipped.count,
			byCode: s.skipped.byCode,
			first: s.skipped.first.slice(0, 25).map((x) => ({ timecode: x.timecode, code: x.code, reason: x.reason })),
		},
		export: {
			cost: s.cost.class,
			frames: s.cost.frames,
			...(s.cost.effects.length ? { effects: s.cost.effects } : {}),
			note:
				s.cost.class === 'native'
					? 'Motion keys: the native ffmpeg export draws them.'
					: 'Adjustment clips with GPU effects: the export renders through the Remotion path (slower than native; see docs/wp-notes/edit-automation.md for the measured cost).',
		},
		...(s.track ? { track: s.track } : {}),
		sfx: r.sfx,
		budget: r.budget,
		proposalId: r.proposalId,
		itemCount: r.itemCount,
		...(r.invalid.length ? { invalid: r.invalid.slice(0, 50) } : {}),
		warnings: r.warnings,
	};
}

async function runPass(
	ctx: ToolContext,
	pass: AutomationPassId,
	a: Args,
	params: Record<string, unknown>,
	extra: Extra,
) {
	const { doc } = await loadDoc(ctx, a.projectId);
	const seq = pickSequence(doc, a.sequenceId);
	if (a.range) {
		const range = { start: frameOf(seq, a.range.start), end: frameOf(seq, a.range.end) };
		if (range.end <= range.start)
			throw new ToolError('E_INVALID_PARAM', `range.end (${range.end}) must be after range.start (${range.start})`);
		params.range = range;
	}
	const body = { sequenceId: seq.id, mode: a.mode ?? 'propose', params };
	const out = await ctx.engine((c) => c.automationPass(a.projectId, pass, body, extra.signal));
	if (body.mode === 'dryRun') {
		const r = AutomationPassResultSchema.parse(out);
		return jsonResult({
			...compact(r),
			next: r.budget.fits
				? `Nothing changed. Call ${pass === 'decorate-cuts' ? 'decorate_cuts' : pass === 'punch-ins' ? 'add_punch_ins' : 'add_ken_burns'} with mode "propose" to store it for review.`
				: `Too big for one proposal: run it on range ${JSON.stringify(r.budget.suggestedRange)} first, then on the rest.`,
		});
	}
	const job = out as EngineJob;
	await cancelIfAborted(ctx, extra, job.id);
	const { job: done, timedOut } = await waitJob(ctx, job.id, (a.timeoutSeconds ?? 300) * 1000, extra);
	if (timedOut)
		return jsonResult({
			jobId: done.id,
			state: done.state,
			progress: done.progress,
			next: `The pass is still running: wait_for_job {jobId: "${done.id}"}; its result names the proposal.`,
		});
	if (done.state !== 'succeeded')
		throw new ToolError(
			done.error?.code === 'PROPOSAL_TOO_LARGE' ? 'E_TOO_LARGE' : (done.error?.code ?? 'JOB_FAILED'),
			done.error?.message ?? `The pass ${done.state}`,
			done.error?.code === 'PROPOSAL_TOO_LARGE'
				? 'Run the pass on the suggested range (details.suggestedRange), then on the rest.'
				: 'Check the arguments and the project (get_timeline), then run the pass again.',
			(done.error as { detail?: Record<string, unknown> } | undefined)?.detail,
		);
	const r = AutomationPassResultSchema.parse(done.result);
	return jsonResult({
		...compact(r),
		next: r.proposalId
			? `Proposal ${r.proposalId} is ready: ask the user to review it in the editor's Review panel and call wait_for_proposal; accept_proposal only if the user asked you to apply it.`
			: 'Nothing to propose (see skipped and warnings).',
	});
}

/** Copies the defined keys of `a` named in `keys` into a params object. */
function pick(a: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of keys) if (a[k] !== undefined) out[k] = a[k];
	return out;
}

export function registerAutomationTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'decorate_cuts',
		{
			title: 'Decorate cuts with kits (propose)',
			description:
				'Spec 15 Decorate Cuts: a cut kit centred on every picture cut (adjustment clips with eased effect keys on an "FX" track above the picture) plus a whoosh of the kit\'s length with its peak on the cut (sound design cue + placement), as a PROPOSAL for review — nothing changes until it is accepted. Vertical sequences default to the shorts shake kit (S_Shake 10 + 10 frames), others to the long-form pack (Jolt / Whip / Zoom blur / Zoom through / Spin with their measured shares and a repeat penalty). Kits never overlap: a cut too close to the previous kit takes a shorter family or is skipped (listed with its reason). mode "dryRun" returns the counts, coverage, families, skips, export cost (kits render through the Remotion path) and the sounds available without storing anything. Each item keeps its seed: refresh_proposal {reroll: true} draws another kit for it.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				mode: ModeArg,
				pack: z
					.enum(['shorts-shake', 'long-pack'])
					.optional()
					.describe('Kit pack (default by aspect: vertical → shorts-shake, otherwise long-pack)'),
				families: z
					.record(z.string(), z.number().min(0).max(1e6))
					.optional()
					.describe('Family weights over the pack’s (jolt, whip, zoom-blur, zoom-through, spin; 0 turns one off)'),
				repeatPenalty: z
					.number()
					.min(0)
					.max(1)
					.optional()
					.describe('Weight factor of the previous kit’s family (pack default 0.54: P(same) = 0.23; 1 = independent)'),
				track: TrackArg('Only cuts on this video track (the A-roll, e.g. "V1"); default every picture cut'),
				range: RangeArg,
				includeInsertEdges: z
					.boolean()
					.optional()
					.describe('Also decorate where an overlay (B-roll insert) enters or leaves (default false)'),
				includeJumpCuts: z.boolean().optional().describe('Decorate jump cuts (default true)'),
				minSpacingFrames: z
					.number()
					.int()
					.min(0)
					.max(100_000)
					.optional()
					.describe('At least this many frames between decorated cuts (default 0)'),
				coverage: z
					.number()
					.min(0)
					.max(1)
					.optional()
					.describe('Share of the cuts that get a kit (default 1)'),
				skipDecorated: z
					.boolean()
					.optional()
					.describe('Skip cuts an adjustment clip already covers (default true)'),
				fxTrack: TrackArg('Video track for the kits (default: a free "FX" track above the picture, else a new one)'),
				sfx: SfxArg,
				seed: SeedArg,
				timeoutSeconds: TimeoutArg,
			},
			annotations: EDIT,
		},
		async (a, extra) =>
			runPass(
				ctx,
				'decorate-cuts',
				a as Args,
				pick(a, [
					'pack',
					'families',
					'repeatPenalty',
					'track',
					'includeInsertEdges',
					'includeJumpCuts',
					'minSpacingFrames',
					'coverage',
					'skipDecorated',
					'fxTrack',
					'sfx',
					'seed',
				]),
				extra,
			),
	);

	defineTool(
		ctx,
		'add_punch_ins',
		{
			title: 'Add punch-in zooms (propose)',
			description:
				'Spec 15 punch-ins: on the A-roll clips of at least minClipSeconds (1.5 s) whose Motion is not keyed, density (0.7) of them get a zoom — clips whose phrases end in "!" or "?" first — from the clip midpoint (or the nearest word start with start "word"), rampFrames (7) linear from 100 % to scale (180 %) of the clip\'s own scale, held to the cut, toward the centre, a point {x, y} (0…1 of the frame) or the subject (a faces roto on the clip, else the engine\'s face / saliency analysis). method "motion" (default) writes Motion keys on the clip (native export); "adjustment" puts a Transform adjustment clip on a ZOOM track right above the A-roll. Optional whoosh at the zoom (sfx). As a PROPOSAL (mode "propose") or a dry run.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				mode: ModeArg,
				track: TrackArg('The A-roll video track (default: the track carrying most of the picture)'),
				range: RangeArg,
				minClipSeconds: z.number().min(0).max(3600).optional().describe('Shortest clip that gets one (default 1.5)'),
				density: z.number().min(0).max(1).optional().describe('Share of the candidate clips (default 0.7)'),
				scale: z.number().min(101).max(1000).optional().describe('Final scale in % (default 180)'),
				rampFrames: z.number().int().min(1).max(600).optional().describe('Frames of the linear ramp (default 7)'),
				start: z
					.enum(['midpoint', 'word'])
					.optional()
					.describe('"midpoint" (default) or "word": the transcript word start nearest the midpoint'),
				target: z
					.union([
						z.literal('center'),
						z.literal('subject'),
						z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
					])
					.optional()
					.describe('"center" (default), "subject" or a point {x, y} (0…1 of the frame)'),
				method: z
					.enum(['motion', 'adjustment'])
					.optional()
					.describe('"motion" (default: Motion keys, native export) or "adjustment" (Transform adjustment clip)'),
				sfx: SfxArg,
				excludeClipIds: ExcludeArg,
				seed: SeedArg,
				timeoutSeconds: TimeoutArg,
			},
			annotations: EDIT,
		},
		async (a, extra) =>
			runPass(
				ctx,
				'punch-ins',
				a as Args,
				pick(a, [
					'track',
					'minClipSeconds',
					'density',
					'scale',
					'rampFrames',
					'start',
					'target',
					'method',
					'sfx',
					'excludeClipIds',
					'seed',
				]),
				extra,
			),
	);

	defineTool(
		ctx,
		'add_ken_burns',
		{
			title: 'Add Ken Burns moves (propose)',
			description:
				'Spec 15 Ken Burns: share (0.15) of the A-roll clips whose Motion is not keyed get a slow zoom over the whole clip — keys on its first and last frame, linear, 100 → scale (default 118 % vertical, 130 % landscape) about the frame centre, zoom-in : zoom-out = inOutRatio (2) : 1 by each clip\'s seed. Motion keys: native export. As a PROPOSAL (mode "propose") or a dry run. Run add_punch_ins first (keyed clips are skipped) or pass excludeClipIds.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				mode: ModeArg,
				track: TrackArg('The A-roll video track (default: the track carrying most of the picture)'),
				range: RangeArg,
				share: z.number().min(0).max(1).optional().describe('Share of the candidate clips (default 0.15)'),
				scale: z.number().min(101).max(400).optional().describe('End scale in % (default by aspect)'),
				inOutRatio: z.number().min(0).max(100).optional().describe('Zoom-ins per zoom-out (default 2)'),
				minClipSeconds: z.number().min(0).max(3600).optional().describe('Shortest clip that gets one (default 1)'),
				excludeClipIds: ExcludeArg,
				seed: SeedArg,
				timeoutSeconds: TimeoutArg,
			},
			annotations: EDIT,
		},
		async (a, extra) =>
			runPass(
				ctx,
				'ken-burns',
				a as Args,
				pick(a, ['track', 'share', 'scale', 'inOutRatio', 'minClipSeconds', 'excludeClipIds', 'seed']),
				extra,
			),
	);
}
