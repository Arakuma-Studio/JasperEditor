// Editing automation tools (spec 15 EA-020…EA-026, EA-041): decorate_cuts, add_punch_ins, add_ken_burns,
// place_reactions, slide_overlays, lay_music_bed, add_stingers. Each runs
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

export const AUTOMATION_GUIDE = `Editing automation (spec 15): passes that decorate the edit the way the user's videos are cut, each as ONE proposal (feature "edit-automation", Review groups Cut kits / Punch-ins / Ken Burns / Reactions / Overlay slides / Music beds / Stingers) the user reviews in the Review panel (timeline ghosts, ✓ / ✕ per item, ⇄ alternatives, ↻ Refresh proposal after edits, Reroll per item) and applies as one undo step.
- decorate_cuts: a cut kit at every picture cut (the cut map, list_cuts): an adjustment clip on an "FX" track above the picture (created when needed), centred on the cut exactly — vertical sequences get the shorts kit (S_Shake 10 + 10 frames, Amplitude 0.5, Frequency 6, Motion Blur), others the long-form pack (Jolt 49 %, Whip 17 %, Zoom blur 17 %, Zoom through 9 %, Spin 8 %, few repeats: P(same as previous) 0.23) — with 2-key eased curves; kits never overlap (close cuts take a shorter family or are skipped, reported), plus a whoosh exactly as long as the kit with its peak on the cut, placed through sound design (a cue anchored to the edit + soundDesign.place; a library sound of type sfx.type, default whoosh, from the starter kit / packs / your folders). Kits render through the Remotion export path (their shader effects have no native route): the dry run says so.
- add_punch_ins: Motion zooms on the A-roll clips ≥ 1.5 s (density 0.7 of them, "!" / "?" phrases first): from the clip's midpoint (or nearest word start), 7 frames linear 100 → 180 %, held to the cut; target centre, a point, or the subject (face tracking / saliency); method "motion" (default, Motion keys: native export) or "adjustment" (a Transform clip on a ZOOM track right above the A-roll); optional whoosh.
- add_ken_burns: slow zooms over 15 % of the remaining A-roll clips, keys on the first and last frame, 100 ↔ 118 % (vertical) / 130 %, zoom-in : zoom-out 2 : 1. Native export.
- place_reactions: the user's reaction pictures (assets: {bin} name or id, {folder} absolute path, or {mediaIds}; nothing is shipped — ask the user which bin or folder holds them) on a "Reactions" track (below an FX track so kits shake them too) where the edit asks for one: markers whose name contains "reaction" or names a picture, calls to action and exclamations of the transcript (built-in Spanish / English lists, editable: words.cta, words.exclamations; any word with "!"), and optionally where face tracking finds no face on the A-roll (triggers.speakerNotVisible; run track_faces first). Each starts on a cut within 0.5 s, lasts 2.1 s (vertical) / 2.6 s, at a measured slot (shorts: bottom left / centre / right; long form: mid height at 15 / 50 / 83 %), flipped on the left slots, 60–65 % Motion scale (capped at 45 % of the frame height), S_Shake wobble (Amplitude 0.8, Frequency 2), never over subtitles, at most maxPerMinute (12 vertical, 1 landscape); 3 other pictures per item (⇄). Exports natively with the wobbled pictures baked (hybrid).
- slide_overlays: one-sided Smooth Slide transitions (30 frames) at free heads (53 % of them) and tails (18 %) of overlay clips (pictures on the tracks above the A-roll), directions down 47 / up 33 / left 13 / right 8 %, ease in-out quad / cubic, motion blur high. A head or tail is free when no clip of its track touches it and it has no transition (transition.add {clipId, edge} at a free edge makes a one-sided transition). Exports natively with the slide spans baked (hybrid).
- lay_music_bed: a playlist (assets as above: the user's songs) on a "Music" track at −33 dB clip gain; beds switch at the first cut at least bedSeconds (52; vertical: one bed per song) after they start; vertical sequences start at −25 dB until the first cut (intro); duck.enabled ducks the beds under dialogue (Essential Sound ducking: 18 dB, 800 ms fades). Native export.
- add_stingers (off unless asked; assistive): 29 frames of generated TV static (a grey colour matte under Noise 100 %, never a file) on a "Stingers" track at the top plus generated static noise at −18 dB (Jasper Synth, through sound design), after shouted punchlines: a momentary-loudness peak ≥ 6 LU over the local median (measured when proposing) and / or a "!" phrase (match: both by default, either, loudness, exclamation); at most 1 per minute, 10 s apart. Exports natively with the noise baked (hybrid).
- Style recipes combine these passes (with the cleanup and the subtitles) into one proposal: apply_style, then style_check (see "Style recipes" below). Recommended workflow for a whole video: fix the transcript from the script (attach_script → fix_transcript, reviewed and accepted: the cleanup, subtitles and reactions then read the right words) → cleanup → subtitles → apply_style (dry run, then propose) → the user reviews → accept → style_check.
- Workflow for one pass: run the cleanup and subtitle passes first when the project uses them (reactions keep clear of subtitles); then for each pass call it with mode "dryRun" (read the counts, skips and cost), adjust parameters, call it again in mode "propose", and ASK THE USER to review the proposal (wait_for_proposal). Only accept_proposal yourself when the user asked you to apply it and the project allows it (Project Settings ▸ Agent Proposals, on by default). Reroll an item with refresh_proposal {itemIds: [...], reroll: true}; after the user edits, refresh_proposal re-plans stale items. Run punch-ins before Ken Burns (Ken Burns skips clips whose Motion is keyed) or pass excludeClipIds. Every pass is deterministic for its seed; the parameters are plain data (style recipes reuse them). A pass too big for one proposal fails with E_TOO_LARGE and a suggestedRange: run it on that range, then on the rest.`;

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
		packId: z
			.string()
			.min(1)
			.max(64)
			.optional()
			.describe('Only sounds of this installed pack (list_sound_packs)'),
		rootId: z
			.string()
			.min(1)
			.max(64)
			.optional()
			.describe('Only sounds of this sound folder (sound_library_status)'),
		gainDb: z
			.number()
			.min(-60)
			.max(12)
			.optional()
			.describe('Clip gain in dB (default: sound design’s support level)'),
		variety: z
			.number()
			.int()
			.min(1)
			.max(16)
			.optional()
			.describe('Sounds the rotation cycles through (default 12)'),
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

/** The tool of each pass (the dry run's next step). */
const TOOL_OF: Record<AutomationPassId, string> = {
	'decorate-cuts': 'decorate_cuts',
	'punch-ins': 'add_punch_ins',
	'ken-burns': 'add_ken_burns',
	reactions: 'place_reactions',
	slides: 'slide_overlays',
	music: 'lay_music_bed',
	stingers: 'add_stingers',
};

const AssetsArg = (what: string) =>
	z
		.object({
			bin: z.string().min(1).max(256).optional().describe('A project bin (its name or id) holding them'),
			folder: z
				.string()
				.min(1)
				.max(4096)
				.optional()
				.describe(
					'An absolute folder path on the engine computer (its files are added to the project when proposing)',
				),
			mediaIds: z.array(z.string().min(1).max(128)).min(1).max(256).optional().describe('Project media ids'),
		})
		.describe(`${what}: the user's own files — a bin, a folder and / or media (at least one)`);

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
			first: s.skipped.first
				.slice(0, 25)
				.map((x) => ({ timecode: x.timecode, code: x.code, reason: x.reason })),
		},
		...(s.detail ? { detail: s.detail } : {}),
		...(s.assets ? { assets: s.assets } : {}),
		export: {
			cost: s.cost.class,
			frames: s.cost.frames,
			...(s.cost.effects.length ? { effects: s.cost.effects } : {}),
			note:
				s.cost.class === 'native'
					? 'Native: the ffmpeg export draws it (Motion keys, clips, audio).'
					: s.cost.class === 'hybrid'
						? 'Hybrid: the export stays native; the decorated layers or transition spans are pre-rendered by the layer bake (Remotion), or the whole export takes the Remotion path when the layer bake is unavailable.'
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
			throw new ToolError(
				'E_INVALID_PARAM',
				`range.end (${range.end}) must be after range.start (${range.start})`,
			);
		params.range = range;
	}
	const body = { sequenceId: seq.id, mode: a.mode ?? 'propose', params };
	const out = await ctx.engine((c) => c.automationPass(a.projectId, pass, body, extra.signal));
	if (body.mode === 'dryRun') {
		const r = AutomationPassResultSchema.parse(out);
		return jsonResult({
			...compact(r),
			next: r.budget.fits
				? `Nothing changed. Call ${TOOL_OF[pass]} with mode "propose" to store it for review.`
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
					.describe(
						'Family weights over the pack’s (jolt, whip, zoom-blur, zoom-through, spin; 0 turns one off)',
					),
				repeatPenalty: z
					.number()
					.min(0)
					.max(1)
					.optional()
					.describe(
						'Weight factor of the previous kit’s family (pack default 0.54: P(same) = 0.23; 1 = independent)',
					),
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
				fxTrack: TrackArg(
					'Video track for the kits (default: a free "FX" track above the picture, else a new one)',
				),
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
				minClipSeconds: z
					.number()
					.min(0)
					.max(3600)
					.optional()
					.describe('Shortest clip that gets one (default 1.5)'),
				density: z.number().min(0).max(1).optional().describe('Share of the candidate clips (default 0.7)'),
				scale: z.number().min(101).max(1000).optional().describe('Final scale in % (default 180)'),
				rampFrames: z
					.number()
					.int()
					.min(1)
					.max(600)
					.optional()
					.describe('Frames of the linear ramp (default 7)'),
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
					.describe(
						'"motion" (default: Motion keys, native export) or "adjustment" (Transform adjustment clip)',
					),
				sfx: SfxArg,
				skipReframed: z
					.boolean()
					.optional()
					.describe('Leave clips with a static scale / position of their own alone (default true)'),
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
					'skipReframed',
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
				'Spec 15 Ken Burns: share (0.15) of the A-roll clips (counted over all of them, chosen among those whose Motion is not keyed) get a slow zoom over the whole clip — keys on its first and last frame, linear, 100 → scale (default 118 % vertical, 130 % landscape) about the frame centre, zoom-in : zoom-out = inOutRatio (2) : 1 by each clip\'s seed. Motion keys: native export. As a PROPOSAL (mode "propose") or a dry run. Run add_punch_ins first (keyed clips are skipped) or pass excludeClipIds.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				mode: ModeArg,
				track: TrackArg('The A-roll video track (default: the track carrying most of the picture)'),
				range: RangeArg,
				share: z
					.number()
					.min(0)
					.max(1)
					.optional()
					.describe(
						'Share of the A-roll clips that get one (default 0.15; chosen among the undecorated clips)',
					),
				scale: z.number().min(101).max(400).optional().describe('End scale in % (default by aspect)'),
				inOutRatio: z.number().min(0).max(100).optional().describe('Zoom-ins per zoom-out (default 2)'),
				minClipSeconds: z
					.number()
					.min(0)
					.max(3600)
					.optional()
					.describe('Shortest clip that gets one (default 1)'),
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

	defineTool(
		ctx,
		'place_reactions',
		{
			title: 'Place reaction pictures (propose)',
			description:
				'Spec 15 reactions: the user\'s reaction pictures (images from a bin, a folder or media — ask the user which; nothing is shipped) over the picture where the edit asks for one: markers whose name contains markerMatch ("reaction") or names a picture, calls to action and exclamations in the transcript (built-in Spanish / English lists, editable; words with "!"), and optionally stretches where face tracking sees no face on the A-roll. Each starts on a cut within snapSeconds (0.5) of its trigger, lasts durationSeconds (2.1 vertical / 2.6 landscape), sits at a slot (default the measured ones; left slots flipped), Motion scale 60–65 % capped at maxHeight (0.45) of the frame, S_Shake wobble (Amplitude 0.8, Frequency 2), never over subtitles, never overlapping another, at most maxPerMinute (12 vertical / 1 landscape; markers first, then calls to action, exclamations, hidden speaker). Up to 3 other pictures per item (⇄). As a PROPOSAL (mode "propose") or a dry run.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				mode: ModeArg,
				assets: AssetsArg('The reaction pictures'),
				track: TrackArg(
					'The A-roll video track (cuts to snap to, faces); default the track carrying most picture',
				),
				range: RangeArg,
				reactionTrack: TrackArg(
					'Video track for the reactions (default a "Reactions" track, created when needed)',
				),
				slots: z
					.array(
						z.object({
							x: z.number().min(0).max(1),
							y: z.number().min(0).max(1),
							flip: z.boolean().optional(),
							weight: z.number().min(0).max(1e6).optional(),
							name: z.string().min(1).max(40).optional(),
						}),
					)
					.min(1)
					.max(12)
					.optional()
					.describe(
						'Where pictures sit: centre points (0…1 of the frame), flipped, weights (default the measured slots)',
					),
				durationSeconds: z.number().min(0.2).max(60).optional().describe('How long each stays'),
				snapSeconds: z.number().min(0).max(5).optional().describe('Start on a cut this close (default 0.5)'),
				scale: z
					.object({ min: z.number().min(1).max(1000), max: z.number().min(1).max(1000) })
					.optional()
					.describe('Motion scale range in % of the picture (default 60…65)'),
				maxHeight: z
					.number()
					.min(0.02)
					.max(1)
					.optional()
					.describe('At most this share of the frame height (0.45)'),
				wobble: z
					.object({
						enabled: z.boolean().optional(),
						amplitude: z.number().min(0).max(5).optional(),
						frequency: z.number().min(0).max(30).optional(),
					})
					.optional()
					.describe('S_Shake wobble (default on, 0.8 / 2)'),
				triggers: z
					.object({
						words: z.boolean().optional(),
						markers: z.boolean().optional(),
						speakerNotVisible: z.boolean().optional(),
					})
					.optional()
					.describe('Trigger kinds (default words and markers on, speaker not visible off)'),
				words: z
					.object({
						language: z.string().min(2).max(16).optional(),
						cta: z.array(z.string().min(1).max(80)).max(500).optional(),
						exclamations: z.array(z.string().min(1).max(80)).max(500).optional(),
					})
					.optional()
					.describe("Trigger word lists (default the transcript language's built-in lists)"),
				markerMatch: z
					.string()
					.min(1)
					.max(80)
					.optional()
					.describe('Markers whose name contains this trigger'),
				notVisibleSeconds: z
					.number()
					.min(0.2)
					.max(60)
					.optional()
					.describe('Shortest face-less stretch (1.5 s)'),
				maxPerMinute: z.number().min(0).max(120).optional().describe('Rate cap per minute'),
				minGapSeconds: z.number().min(0).max(600).optional().describe('Gap between reactions (0.5 s)'),
				alternatives: z.number().int().min(0).max(3).optional().describe('Other pictures per item (3)'),
				seed: SeedArg,
				timeoutSeconds: TimeoutArg,
			},
			annotations: EDIT,
		},
		async (a, extra) =>
			runPass(
				ctx,
				'reactions',
				a as Args,
				pick(a, [
					'assets',
					'track',
					'reactionTrack',
					'slots',
					'durationSeconds',
					'snapSeconds',
					'scale',
					'maxHeight',
					'wobble',
					'triggers',
					'words',
					'markerMatch',
					'notVisibleSeconds',
					'maxPerMinute',
					'minGapSeconds',
					'alternatives',
					'seed',
				]),
				extra,
			),
	);

	defineTool(
		ctx,
		'slide_overlays',
		{
			title: 'Slide overlays in and out (propose)',
			description:
				'Spec 15 overlay slides: one-sided Smooth Slide transitions (frames, default 30) at the free heads (share heads, 0.53) and tails (tails, 0.18) of overlay clips — pictures on the video tracks above the A-roll (or overlayTracks). An edge is free when no clip of its track touches it and it has no transition. Directions (weights, default down 47 / up 33 / left 13 / right 8) and easings (easeInOutQuad 68 / easeInOutCubic 32) drawn per edge from its seed; motion blur high over a 360° shutter. Each edge offers the other directions (⇄). As a PROPOSAL (mode "propose") or a dry run.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				mode: ModeArg,
				track: TrackArg('The A-roll track (overlays are on the tracks above it)'),
				range: RangeArg,
				overlayTracks: z
					.array(z.string().min(1).max(128))
					.min(1)
					.max(64)
					.optional()
					.describe('Only these overlay tracks'),
				frames: z.number().int().min(2).max(600).optional().describe('Slide length in frames (30)'),
				heads: z.number().min(0).max(1).optional().describe('Share of free heads that slide in (0.53)'),
				tails: z.number().min(0).max(1).optional().describe('Share of free tails that slide out (0.18)'),
				directions: z
					.object({
						down: z.number().min(0).max(1e6).optional(),
						up: z.number().min(0).max(1e6).optional(),
						left: z.number().min(0).max(1e6).optional(),
						right: z.number().min(0).max(1e6).optional(),
					})
					.optional()
					.describe('Direction weights (absent ones count 0 when any is given)'),
				easings: z
					.object({
						easeInOutQuad: z.number().min(0).max(1e6).optional(),
						easeInOutCubic: z.number().min(0).max(1e6).optional(),
					})
					.optional()
					.describe('Easing weights'),
				motionBlur: z
					.enum(['off', 'low', 'medium', 'high'])
					.optional()
					.describe('Smooth Slide motion blur (high)'),
				shutterAngle: z.number().min(90).max(720).optional().describe('Motion blur shutter (360°)'),
				seed: SeedArg,
				timeoutSeconds: TimeoutArg,
			},
			annotations: EDIT,
		},
		async (a, extra) =>
			runPass(
				ctx,
				'slides',
				a as Args,
				pick(a, [
					'track',
					'overlayTracks',
					'frames',
					'heads',
					'tails',
					'directions',
					'easings',
					'motionBlur',
					'shutterAngle',
					'seed',
				]),
				extra,
			),
	);

	defineTool(
		ctx,
		'lay_music_bed',
		{
			title: 'Lay a music bed from a playlist (propose)',
			description:
				'Spec 15 music bed: the user\'s songs (a bin, a folder or media — ask the user which; nothing is shipped) laid end to end on a "Music" audio track at gainDb (−33) clip gain; a bed switches at the first picture cut at least bedSeconds (52; vertical sequences: null = one bed per song) after it starts, waiting at most maxSwitchDelaySeconds (15) for a cut; a song that ends earlier hands over at its last cut. Vertical sequences start at intro.gainDb (−25) until the first cut. duck.enabled ducks the beds under dialogue with the Essential Sound ducking (18 dB, 800 ms fades). order "playlist" or "shuffle". Each bed offers 3 other songs (⇄). As a PROPOSAL (mode "propose") or a dry run.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				mode: ModeArg,
				assets: AssetsArg('The songs'),
				range: RangeArg,
				order: z.enum(['playlist', 'shuffle']).optional().describe('Song order (playlist)'),
				bedSeconds: z
					.number()
					.min(5)
					.max(3600)
					.nullable()
					.optional()
					.describe('Bed length before switching (null: one bed per song)'),
				maxSwitchDelaySeconds: z
					.number()
					.min(0)
					.max(600)
					.optional()
					.describe('Longest wait for a cut (15 s)'),
				track: TrackArg('The A-roll track whose cuts the beds switch on (default every picture cut)'),
				gainDb: z.number().min(-60).max(12).optional().describe('Clip gain of the beds (−33 dB)'),
				intro: z
					.object({ enabled: z.boolean().optional(), gainDb: z.number().min(-60).max(12).optional() })
					.optional()
					.describe('Intro step until the first cut (default on for vertical, −25 dB)'),
				duck: z
					.object({
						enabled: z.boolean().optional(),
						amountDb: z.number().min(0).max(48).optional(),
						fadeMs: z.number().min(0).max(10_000).optional(),
					})
					.optional()
					.describe('Duck under dialogue (default off)'),
				musicTrack: TrackArg('Audio track for the beds (default a "Music" track, created when needed)'),
				seed: SeedArg,
				timeoutSeconds: TimeoutArg,
			},
			annotations: EDIT,
		},
		async (a, extra) =>
			runPass(
				ctx,
				'music',
				a as Args,
				pick(a, [
					'assets',
					'order',
					'bedSeconds',
					'maxSwitchDelaySeconds',
					'track',
					'gainDb',
					'intro',
					'duck',
					'musicTrack',
					'seed',
				]),
				extra,
			),
	);

	defineTool(
		ctx,
		'add_stingers',
		{
			title: 'Add TV-static stingers after punchlines (propose)',
			description:
				'Spec 15 stingers (assistive; only when the user asks): frames (29) of generated TV static — a grey colour matte under Noise 100 % monochrome, never a file — on a "Stingers" track at the top, with generated static noise at gainDb (−18 dB; sound "generated" = Jasper Synth TV static, "library" = library sounds of sfx.type, "none"), after shouted punchlines: a peak of the dialogue\'s momentary loudness at least thresholdLu (6) over the median of medianWindowSeconds (10), and / or a "!" phrase in the transcript or subtitles (match "both" default, "either", "loudness", "exclamation"). A stinger starts on a cut within snapSeconds (0.5) after the punchline; at most maxPerMinute (1), minGapSeconds (10) apart, loudest first. Loudness is measured when proposing (the dry run counts "!" phrases unless a measurement of the same mix exists). As a PROPOSAL (mode "propose") or a dry run.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				mode: ModeArg,
				track: TrackArg('The A-roll track (cuts to snap to)'),
				range: RangeArg,
				match: z
					.enum(['both', 'either', 'loudness', 'exclamation'])
					.optional()
					.describe('What marks a punchline (both)'),
				thresholdLu: z.number().min(1).max(40).optional().describe('LU over the local median (6)'),
				medianWindowSeconds: z.number().min(1).max(120).optional().describe('Local median window (10 s)'),
				frames: z.number().int().min(1).max(600).optional().describe('Stinger length in frames (29)'),
				snapSeconds: z.number().min(0).max(5).optional().describe('Start on a cut this close after (0.5 s)'),
				maxPerMinute: z.number().min(0).max(60).optional().describe('Rate cap per minute (1)'),
				minGapSeconds: z.number().min(0).max(600).optional().describe('Gap between stingers (10 s)'),
				gainDb: z.number().min(-60).max(12).optional().describe('Noise sound clip gain (−18 dB)'),
				sound: z.enum(['generated', 'library', 'none']).optional().describe('Noise sound source (generated)'),
				sfx: SfxArg,
				stingerTrack: TrackArg('Video track for the stingers (default a "Stingers" track at the top)'),
				seed: SeedArg,
				timeoutSeconds: TimeoutArg,
			},
			annotations: EDIT,
		},
		async (a, extra) =>
			runPass(
				ctx,
				'stingers',
				a as Args,
				pick(a, [
					'track',
					'match',
					'thresholdLu',
					'medianWindowSeconds',
					'frames',
					'snapSeconds',
					'maxPerMinute',
					'minGapSeconds',
					'gainDb',
					'sound',
					'sfx',
					'stingerTrack',
					'seed',
				]),
				extra,
			),
	);
}
