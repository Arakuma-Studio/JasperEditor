// Sound design cue tools (spec 12 §2.10, Phase 2: P2-R6; wp-note "WP2.3 cue route & MCP tools"): find cue points in
// the edit, store and edit cues, place library sounds on them peak-aligned (layers, alternates, a type picked with
// seeded rotation), swap a placed sound (explicitly or cycling its alternates) and re-align a clip's peak.
// Cue derivation runs on the engine (`POST /api/sound-design/cues`: it has the motion-graphic template registry),
// placement and swaps are ordinary undoable commands (`soundCue.*`, `soundDesign.place`, `soundDesign.swap`).
import {
	type RegisterSoundResponse,
	SfxRebalanceResultSchema,
	SOUND_EFFECTS_BIN,
	SoundCheckResultSchema,
	type SoundCueSuggestion,
	type SoundCuesResponse,
	SoundDeliveryResultSchema,
	SoundDesignPlanResultSchema,
	type SoundEntry,
	type SoundSearchResponse,
} from '@jasper/api';
import {
	type AudioClip,
	BUILD_DEFAULT,
	type ClipSfx,
	CUE_ALIGNS,
	CUE_DENSITIES,
	CUE_DERIVE_SOURCES,
	CUE_KINDS,
	CUE_SOURCES,
	CUE_WEIGHTS,
	type CueAnchor,
	CueAnchorSchema,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	isSoundTypeId,
	type LibraryProvenance,
	type ProjectDocument,
	pickVariant,
	type Rational,
	readLibraryProvenance,
	requiresAttribution,
	type Sequence,
	SFX_ROLES,
	SOUND_DELIVERIES,
	SOUND_DESIGN_FEATURE,
	SOUND_DESIGN_LIMITS,
	SOUND_LABELS,
	SOUND_REF_RE,
	SOUND_TYPES,
	type SoundCue,
	type SoundProposalMedia,
	type SoundProposalPlacement,
	type SoundTypeId,
	STOP_BEFORE_DEFAULT,
	sequenceDialogueRanges,
	sequenceTimecode,
	soundCueFields,
	soundCuesOf,
	soundDesignSettingsOf,
	soundProposalItems,
	soundText,
	synonymType,
	TimeInputSchema,
	trackLabel,
	VISUAL_KINDS,
	type VisualKind,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg, TIME_FORMATS } from '../arguments.ts';
import {
	cancelIfAborted,
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
	type Extra,
	frameOf,
	loadDoc,
	READ_ONLY,
	requireOk,
	type ToolContext,
	transact,
	txBody,
	waitJob,
} from '../context.ts';
import { toolEnvelope } from '../envelope.ts';
import { jsonResult, ToolError, TX_ERROR_HINTS } from '../errors.ts';
import { pickSequence } from '../format.ts';
import { mediaRegisterCommand } from '../media.ts';
import { livePlayhead } from './color.ts';
import { importCommands, type Registered, resolveAudioTrack, SoundIdArg, soundCall } from './sound.ts';
import { proposalCheckNext, proposalCheckSummary } from './sound-check.ts';

const CUE_DERIVE_SOURCE_LIST = CUE_DERIVE_SOURCES.join(', ');
/** swap_sound next / previous: candidates tried in the cycle's direction when one does not fit on the track. */
const MAX_CYCLE_TRIES = 4;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** `at` of a tool: a sequence time or "playhead". */
const AtArg = z.union([z.literal('playhead'), TimeInputSchema]);

/** Resolves a time argument (or "playhead") to a sequence frame. */
async function resolveAt(
	ctx: ToolContext,
	projectId: string,
	seq: Sequence,
	at: z.infer<typeof AtArg>,
): Promise<number> {
	if (at !== 'playhead') return frameOf(seq, at);
	const ph = await livePlayhead(ctx, projectId, seq.id);
	if (ph === null)
		throw new ToolError(
			'E_NO_SESSION',
			'"playhead" needs an editor window showing this sequence',
			'Call open_project_in_editor, or give a frame, {"seconds": x} or a timecode.',
		);
	return ph;
}

const clipName = (seq: Sequence, id: string) => {
	const c = seq.clips[id] as { name?: unknown; trackId?: string } | undefined;
	if (!c) return id;
	const track = c.trackId ? (trackLabel(seq, c.trackId) ?? '?') : '?';
	return `${track} '${typeof c.name === 'string' && c.name ? c.name : id}'`;
};

/** A one-line description of what a cue anchor follows (names from the document). */
export function anchorText(doc: ProjectDocument, seq: Sequence, a: CueAnchor | null | undefined): string {
	if (!a) return 'not anchored';
	switch (a.type) {
		case 'edit':
			return `cut on ${trackLabel(seq, a.trackId) ?? a.trackId}: ${clipName(seq, a.outgoingClipId)} → ${clipName(seq, a.incomingClipId)}`;
		case 'transition': {
			const t = seq.transitions[a.transitionId] as { effectId?: string; trackId?: string } | undefined;
			return t
				? `transition ${t.effectId ?? ''} on ${t.trackId ? (trackLabel(seq, t.trackId) ?? '') : ''}`.trim()
				: `transition ${a.transitionId}`;
		}
		case 'keyframe':
			return `${a.event} of ${a.property} on ${clipName(seq, a.clipId)}${a.keyframeId ? ` (key ${a.keyframeId})` : ''}`;
		case 'text':
			return `text ${a.side} animation${a.unit !== undefined ? ` unit ${a.unit + 1}` : ''} of ${clipName(seq, a.clipId)}`;
		case 'mg':
			return `motion graphic ${a.event} of ${clipName(seq, a.clipId)}`;
		case 'clip':
			return `${a.edge} of ${clipName(seq, a.clipId)}`;
		case 'marker': {
			const m = seq.markers.find((x) => x.id === a.markerId);
			return m ? `marker '${m.name || m.id}'` : `marker ${a.markerId}`;
		}
		case 'scene': {
			const name = (doc.media[a.mediaId] as { originalName?: string } | undefined)?.originalName ?? a.mediaId;
			const sec = Math.round(a.mediaSec * 1000) / 1000;
			return `${sec} s into ${name}${a.clipId && seq.clips[a.clipId] ? ` in ${clipName(seq, a.clipId)}` : ''}`;
		}
		case 'beat':
			return `beat ${a.beatIndex + 1} of ${clipName(seq, a.clipId)}`;
	}
}

/** Sequence frame (fractional) where a placed clip's aligned point plays, or null for a clip without `sfx`. */
function alignedFrameOf(clip: AudioClip & { sfx?: ClipSfx }, F: number): number | null {
	const sfx = clip.sfx;
	if (!sfx?.placement) return null;
	const flicks =
		clip.start * F +
		(sfx.placement.peakFlicks - clip.sourceIn) / (clip.speed?.rate || 1) -
		sfx.placement.errorFlicks;
	return flicks / F;
}

/** Sequence frame (fractional) where the loudest point of a placed clip's media plays (its provenance's peakSec). */
function peakFrameOf(doc: ProjectDocument, clip: AudioClip, F: number): number | null {
	const prov = readLibraryProvenance((doc.media[clip.mediaId] as { library?: unknown } | undefined)?.library);
	const peak = prov?.descriptors?.peakSec;
	if (typeof peak !== 'number' || !Number.isFinite(peak)) return null;
	return (clip.start * F + (peak * FLICKS_PER_SECOND - clip.sourceIn) / (clip.speed?.rate || 1)) / F;
}

type SfxClip = AudioClip & { sfx?: ClipSfx };
const sfxClipsOf = (seq: Sequence): SfxClip[] =>
	Object.values(seq.clips).filter((c): c is SfxClip => c.kind === 'audio' && !!(c as SfxClip).sfx);

/**
 * The cue a clip fills: its `sfx.cueId` only when that cue's `placedClipIds` lists the clip (two-way link). A
 * duplicated or pasted copy carries the original's `sfx.cueId` but fills nothing.
 */
function filledCueOf(seq: Sequence, clip: SfxClip): SoundCue | undefined {
	const id = clip.sfx?.cueId;
	if (!id) return undefined;
	const cue = soundCuesOf(seq).find((c) => c.id === id);
	return cue?.placedClipIds?.includes(clip.id) ? cue : undefined;
}

/** The cue with this id in the document (and its sequence), or a typed error. */
function findCue(doc: ProjectDocument, cueId: string, sequenceId?: string): { seq: Sequence; cue: SoundCue } {
	for (const seq of Object.values(doc.sequences)) {
		if (sequenceId && seq.id !== sequenceId) continue;
		const cue = soundCuesOf(seq).find((c) => c.id === cueId);
		if (cue) return { seq, cue };
	}
	throw new ToolError(
		'E_NOT_FOUND',
		`Sound cue not found: ${cueId}`,
		'find_sound_cues lists the stored cues (storedCueId) and suggestions; set_sound_cues adds cues.',
	);
}

/** Runs a transaction built from a fresh read of the project; rebuilds and retries once when it changed meanwhile. */
async function transactFresh<T>(
	ctx: ToolContext,
	projectId: string,
	label: string,
	build: (
		doc: ProjectDocument,
		revision: number | undefined,
	) => Promise<{ commands: unknown[]; sequenceId?: string; state: T }>,
	extra: Extra,
	expectedRevision?: number,
) {
	for (let attempt = 0; ; attempt++) {
		const { doc, revision } = await loadDoc(ctx, projectId);
		if (expectedRevision !== undefined && revision !== undefined && revision !== expectedRevision)
			throw new ToolError(
				'E_REVISION_MISMATCH',
				`The project is at revision ${revision}, not ${expectedRevision}`,
				'Somebody edited it since you read it: call find_sound_cues (or get_timeline) again and repeat the change.',
			);
		const built = await build(doc, revision);
		const res = await transact(
			ctx,
			projectId,
			{
				label,
				commands: built.commands,
				...(built.sequenceId ? { sequenceId: built.sequenceId } : {}),
				...(revision !== undefined ? { expectedRevision: revision } : {}),
			},
			extra,
		);
		if (
			!res.result.ok &&
			attempt === 0 &&
			expectedRevision === undefined &&
			res.result.errors.some((e) => e.code === 'E_REVISION_MISMATCH')
		)
			continue;
		const r = requireOk(res);
		return { res, r, state: built.state };
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Argument schemas

/** A cue to add: a find_sound_cues suggestion as returned, or a manual cue ({at, kind, weight, types…}). */
const CueAddArg = z.object({
	frame: TimeInputSchema.optional().describe(`Cue frame (a suggestion's frame). ${TIME_FORMATS}`),
	at: AtArg.optional().describe('Or where the cue is: "playhead" or a sequence time'),
	timecode: z.string().max(32).optional().describe('Informational (a suggestion carries it); frame wins'),
	seconds: z.number().optional().describe('Informational (a suggestion carries it)'),
	kind: z.enum(CUE_KINDS).optional().describe('Default manual'),
	weight: z.enum(CUE_WEIGHTS).optional().describe('Default support'),
	types: z
		.array(z.string().min(1).max(32))
		.max(SOUND_DESIGN_LIMITS.types)
		.optional()
		.describe('Suggested sound types (ids or synonyms: hit, whoosh, riser, "swoosh"…)'),
	align: soundCueFields.align,
	pan: soundCueFields.pan,
	panSweep: z.object({ from: z.number().min(-100).max(100), to: z.number().min(-100).max(100) }).optional(),
	pitchSt: soundCueFields.pitchSt,
	label: soundCueFields.label,
	anchor: CueAnchorSchema.nullable().optional().describe('What the cue follows (a suggestion carries it)'),
	also: z
		.array(CueAnchorSchema)
		.max(64)
		.optional()
		.describe('Informational: events merged into a suggestion'),
	anchorText: z.string().max(2000).optional().describe('Informational'),
	confidence: soundCueFields.confidence,
	reason: soundCueFields.reason,
	window: z.object({ start: z.number().int().min(0), end: z.number().int().min(0) }).optional(),
	source: z
		.enum([...CUE_SOURCES])
		.optional()
		.describe('Default: derived/marker for suggestions, agent otherwise'),
	from: z.enum(CUE_DERIVE_SOURCES).optional().describe('Informational (a suggestion carries it)'),
	group: z.string().max(200).optional().describe('Informational'),
	score: z.number().optional().describe('Informational'),
	key: z.string().max(400).optional().describe('Informational: the suggestion key'),
	storedCueId: z
		.string()
		.max(128)
		.nullable()
		.optional()
		.describe('A suggestion already stored as this cue is skipped (not added twice)'),
	muted: soundCueFields.muted,
	stopBefore: z
		.union([z.literal(true), soundCueFields.stopBefore.unwrap()])
		.optional()
		.describe(
			'Dip the music before the cue: {seconds, depthDb} or true (0.25 s at −24 dB); written into the mix when the cue is filled',
		),
	build: z
		.union([z.literal(true), soundCueFields.build.unwrap()])
		.optional()
		.describe(
			'High-pass build into the cue: {seconds, fromHz, toHz} or true (2 s, 150 → 2000 Hz); written when the cue is filled',
		),
});
type CueAdd = z.infer<typeof CueAddArg>;

/** `true` → the defaults (Stop Before Next: 0.25 s at −24 dB; build 2 s, 150 → 2000 Hz). */
const stopBeforeOf = (v: true | { seconds: number; depthDb: number }) =>
	v === true ? { ...STOP_BEFORE_DEFAULT } : { seconds: v.seconds, depthDb: v.depthDb };
const buildOf = (v: true | { seconds: number; fromHz: number; toHz: number }) =>
	v === true ? { ...BUILD_DEFAULT } : { seconds: v.seconds, fromHz: v.fromHz, toHz: v.toHz };

const nullable = <T extends z.ZodType>(s: T) => s.nullable().optional();
const CueUpdateArg = z.object({
	cueId: z.string().min(1).max(128),
	frame: TimeInputSchema.optional().describe('New frame: the cue’s placed sounds move with it (moveClips)'),
	at: AtArg.optional(),
	kind: z.enum(CUE_KINDS).optional(),
	weight: z.enum(CUE_WEIGHTS).optional(),
	types: nullable(z.array(z.string().min(1).max(32)).max(SOUND_DESIGN_LIMITS.types)),
	align: nullable(z.enum(CUE_ALIGNS)),
	pan: nullable(z.union([z.number().min(-100).max(100), z.literal('auto')])),
	panSweep: nullable(z.object({ from: z.number().min(-100).max(100), to: z.number().min(-100).max(100) })),
	pitchSt: nullable(z.number().min(-12).max(12)),
	label: nullable(z.string().max(SOUND_DESIGN_LIMITS.label)),
	anchor: CueAnchorSchema.nullable().optional(),
	confidence: nullable(z.number().min(0).max(1)),
	reason: nullable(z.string().max(SOUND_DESIGN_LIMITS.reason)),
	window: nullable(z.object({ start: z.number().int().min(0), end: z.number().int().min(0) })),
	muted: z.boolean().optional(),
	moveClips: z.boolean().optional().describe('A new frame moves the cue’s placed clips too (default true)'),
	stopBefore: nullable(z.union([z.literal(true), soundCueFields.stopBefore.unwrap()])).describe(
		'Dip the music before the cue ({seconds, depthDb} or true = 0.25 s at −24 dB; null removes it and its dip). A filled cue gets it in the mix at once',
	),
	build: nullable(z.union([z.literal(true), soundCueFields.build.unwrap()])).describe(
		'High-pass build into the cue ({seconds, fromHz, toHz} or true = 2 s, 150 → 2000 Hz; null removes it). A filled cue gets it at once',
	),
});

/** Sound type names (ids or synonyms) → taxonomy ids; unknown names are a typed error. */
function typeIds(names: readonly string[] | null | undefined, path: string): SoundTypeId[] | undefined {
	if (!names) return undefined;
	const out: SoundTypeId[] = [];
	for (const n of names) {
		const t = isSoundTypeId(n.toLowerCase()) ? (n.toLowerCase() as SoundTypeId) : synonymType(n);
		if (!t)
			throw new ToolError(
				'E_INVALID_PARAM',
				`Unknown sound type "${n}" (${path})`,
				`Sound types: ${Object.keys(SOUND_TYPES).join(', ')} (synonyms like "swoosh" work too).`,
			);
		if (!out.includes(t)) out.push(t);
	}
	return out;
}

const LayerArg = z.object({
	soundId: SoundIdArg.optional().describe('A library sound (search_sounds)'),
	mediaId: z.string().min(1).max(128).optional().describe('Or a media of the project (its own audio)'),
	sound: z
		.object({
			type: z.string().min(1).max(32).describe('Sound type id or synonym (hit, whoosh, riser, "swoosh"…)'),
			query: z.string().max(200).optional().describe('Words to prefer (titles, tags)'),
		})
		.optional()
		.describe(
			'Or let the tool pick: the best-ranked sounds of this type (palette first), rotated so neighbouring cues differ, with ±2 % speed and ±1 dB variation (deterministic for the sequence seed)',
		),
	track: z
		.string()
		.min(1)
		.max(200)
		.optional()
		.describe('"auto" (default: a free SFX track, else a new "SFX n"), or an audio track ("A3", id or name)'),
	align: z
		.enum(['auto', ...CUE_ALIGNS])
		.optional()
		.describe('Which point lands on the cue (default: by type)'),
	gainDb: z
		.number()
		.min(-96)
		.max(96)
		.optional()
		.describe(
			"Clip gain in dB (default: the sound's default level by its loudness and role, plus a pick's ±1 dB)",
		),
	pitchSt: z
		.number()
		.min(-12)
		.max(12)
		.optional()
		.describe('Semitones (±3 by varispeed, beyond with Pitch Shifter)'),
	pan: z
		.union([
			z.number().min(-100).max(100),
			z.object({
				keyframes: z
					.array(
						z.object({
							offset: z.number().int().min(-100_000).max(100_000),
							value: z.number().min(-100).max(100),
						}),
					)
					.min(2)
					.max(32),
			}),
		])
		.optional()
		.describe(
			'Static pan, or keyframes {offset (frames from the cue), value}; default the cue’s pan / sweep',
		),
	role: z
		.enum(SFX_ROLES)
		.optional()
		.describe('Default: hero on a hero cue’s first layer, support, layer for the others'),
});
type Layer = z.infer<typeof LayerArg>;

/** Search rows of one sound type, best first (palette sounds first among them). */
async function candidatesOfType(
	ctx: ToolContext,
	type: SoundTypeId,
	query: string | undefined,
	opts: { visualKind?: VisualKind; windowSec?: number; usedNearby: string[]; palette: string[] },
	extra: Extra,
): Promise<SoundEntry[]> {
	const res = await soundCall<SoundSearchResponse>(ctx, (c) =>
		c.searchSounds(
			{
				types: [type],
				...(query ? { q: query } : {}),
				...(opts.visualKind ? { visualKind: opts.visualKind } : {}),
				...(opts.windowSec ? { windowSec: opts.windowSec } : {}),
				...(opts.usedNearby.length ? { usedNearby: opts.usedNearby.slice(0, 16) } : {}),
				license: 'commercial-safe',
				// the clean takes of multi-hit recordings are candidates too (P6-E9): `pickVariant` rotates over a
				// recording's takes when one ranks first
				takes: true,
				limit: 12,
			},
			extra.signal,
		),
	);
	const rows = res.results.map((r) => r.sound);
	const pal = new Set(opts.palette);
	return [...rows.filter((s) => pal.has(s.id)), ...rows.filter((s) => !pal.has(s.id))];
}

/** Library sounds used by placed clips near `frame` (nearest first): the rotation's "recent" list. */
function recentSounds(seq: Sequence, frame: number, F: number): string[] {
	const near = sfxClipsOf(seq)
		.map((c) => ({ id: c.sfx!.soundId, at: alignedFrameOf(c, F) }))
		.filter((x): x is { id: string; at: number } => typeof x.id === 'string' && x.at !== null)
		.sort((a, b) => Math.abs(a.at - frame) - Math.abs(b.at - frame) || a.id.localeCompare(b.id));
	return [...new Set(near.map((x) => x.id))].slice(0, 8);
}

export function registerSoundDesignTools(ctx: ToolContext): void {
	registerPlanSoundDesign(ctx);
	registerRebalanceSfx(ctx);
	registerMixTools(ctx);
	defineTool(
		ctx,
		'find_sound_cues',
		{
			title: 'Find sound cues',
			description: `Derives cue suggestions — moments of the picture that may want a sound — from the edit itself (engine \`deriveCues\`): cuts (none where dialogue is heard unless respectDialogue: false), transitions (push/slide → whoosh with a pan sweep), keyframed motion (move at peak speed, land on an overshoot or abrupt stop, appear/exit on fades and scale-ups, emphasis on a pulse), text animators and typewriters (one key per typed unit, ≤ 12/s), motion-graphic intro ends and outro starts, graphics on V2+, 3D camera moves and markers named "sfx: <type>[+<type>]". Merged within 2 frames and thinned by the density budget. Each cue: frame + timecode + seconds, kind, weight (hero/support/ambient), types (suggested, best first), align (peak/start/end), pan, panSweep, confidence, reason, anchor (+ anchorText), window, from (source), storedCueId (the stored cue for the same event, or null). Also per-source stats (found, kept, merged, droppedByBudget, suppressedByDialogue, heroesUnderDialogue: derived heroes made support because speech is heard there), dialogue ranges (with the clips, tracks and what found them: transcript words, the measured voice activity of Essential Sound dialogue clips, or a whole dialogue clip; voice says whether every dialogue clip was measured) and warnings. Stores nothing: pass the cues you keep to set_sound_cues {add}. Sources: ${CUE_DERIVE_SOURCE_LIST}. The default is the edit's own sources; the engine sources measure media and must be asked for: "scene" (shot changes inside footage, Scene Edit Detection), "beat" (beats of Essential Sound music clips — tempo 50–210 BPM, never read at half or double speed; downbeats support, others ambient; timeSignature "auto" detects 3 or 4 beats per bar, or give it) and "pixel" (the rendered picture's motion: moves, landings and cuts in footage — what keyframes cannot tell; confidence ≤ 0.5; analyse_picture_motion shows it). Their analyses run as jobs the first time (cached after): this tool waits for them (waitForAnalysis, default true, up to timeoutSeconds) and asks again; analysis per source says ready / pending / none / failed. snapToBeats moves moves, transitions, emphases and reveals onto the nearest music beat within 2 frames (anchorOffset records it).`,
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				range: z
					.object({ start: TimeInputSchema, end: TimeInputSchema })
					.optional()
					.describe(`Only this part of the sequence [start, end). ${TIME_FORMATS}`),
				sources: z
					.array(z.enum(CUE_DERIVE_SOURCES))
					.min(1)
					.max(CUE_DERIVE_SOURCES.length)
					.optional()
					.describe('Only these sources (default all)'),
				density: z
					.enum(CUE_DENSITIES)
					.optional()
					.describe('sparse | balanced | rich (default: the sequence’s sound-design density, balanced)'),
				respectDialogue: z
					.boolean()
					.optional()
					.describe('No cut cues where dialogue is heard (default true)'),
				maxCues: z
					.number()
					.int()
					.min(1)
					.max(2000)
					.optional()
					.describe('At most this many cues (default 500)'),
				minGapFrames: z
					.number()
					.int()
					.min(0)
					.max(100_000)
					.optional()
					.describe('Smallest distance between cues'),
				snapToBeats: z
					.boolean()
					.optional()
					.describe('Snap moves, transitions, emphases and reveals to the music’s beats within 2 frames'),
				timeSignature: z
					.union([z.literal('auto'), z.number().int().min(2).max(12)])
					.optional()
					.describe(
						'Metre of the music for the beat source’s downbeats: "auto" (default: 3 or 4 beats per bar detected from the accents) or beats per bar 2…12 (3 for a waltz)',
					),
				waitForAnalysis: z
					.boolean()
					.optional()
					.describe(
						'Wait for the scene / pixel analyses the engine starts, then derive again (default true)',
					),
				timeoutSeconds: z
					.number()
					.int()
					.min(1)
					.max(900)
					.optional()
					.describe('How long to wait for the analyses (default 300)'),
			},
			annotations: READ_ONLY,
		},
		async (a, extra) => {
			const { doc, revision } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			let range: { start: number; end: number } | undefined;
			if (a.range) {
				range = { start: frameOf(seq, a.range.start), end: frameOf(seq, a.range.end) };
				if (!(range.end > range.start) || range.start < 0)
					throw new ToolError(
						'E_INVALID_PARAM',
						'range.end must be after range.start (both ≥ 0)',
						TIME_FORMATS,
					);
				if (range.end > SOUND_DESIGN_LIMITS.maxFrame)
					throw new ToolError(
						'E_INVALID_PARAM',
						`range must lie within frames 0…${SOUND_DESIGN_LIMITS.maxFrame} (got end ${range.end})`,
						TIME_FORMATS,
					);
			}
			const derive = () =>
				soundCall<SoundCuesResponse>(ctx, (c) =>
					c.soundDesignCues(
						{
							envelope: toolEnvelope(doc, revision ?? 0),
							sequenceId: seq.id,
							opts: {
								...(range ? { range } : {}),
								...(a.sources ? { sources: a.sources } : {}),
								...(a.density ? { density: a.density } : {}),
								...(a.respectDialogue !== undefined ? { respectDialogue: a.respectDialogue } : {}),
								...(a.minGapFrames !== undefined ? { minGapFrames: a.minGapFrames } : {}),
								...(a.snapToBeats ? { snapToBeats: true } : {}),
								...(a.timeSignature !== undefined ? { timeSignature: a.timeSignature } : {}),
								maxCues: a.maxCues ?? 500,
							},
						},
						extra.signal,
					),
				);
			let res = await derive();
			// Engine sources: their analyses run as jobs the first time; wait for them once and derive again.
			const pendingJobs = res.warnings
				.filter((w) => w.code === 'W_ANALYSIS_PENDING')
				.flatMap((w) => w.jobIds ?? []);
			const analysisNotes: string[] = [];
			if (pendingJobs.length && a.waitForAnalysis !== false) {
				const until = Date.now() + (a.timeoutSeconds ?? 300) * 1000;
				let timedOut = false;
				for (const id of pendingJobs) {
					const left = Math.max(1000, until - Date.now());
					const w = await waitJob(ctx, id, left, extra, { cancelJobOnAbort: false });
					if (w.timedOut) {
						timedOut = true;
						analysisNotes.push(
							`${w.job.title} is still running (job ${id}): call find_sound_cues again later`,
						);
						break;
					}
					if (w.job.state !== 'succeeded')
						analysisNotes.push(`${w.job.title} ${w.job.state}: ${w.job.error?.message ?? 'no result'}`);
				}
				if (!timedOut) res = await derive();
			}
			const tc = (f: number) => sequenceTimecode(seq, f);
			const cues = res.cues.map((c: SoundCueSuggestion) => ({
				...c,
				anchorText: anchorText(doc, seq, c.anchor),
			}));
			const bySource = Object.fromEntries(
				Object.entries(res.stats.bySource).filter(([, s]) => s.found > 0 || s.kept > 0),
			);
			return jsonResult({
				sequenceId: res.sequenceId,
				revision: revision ?? null,
				frameRate: res.frameRate,
				duration: { frames: res.durationFrames, timecode: tc(res.durationFrames) },
				density: res.density,
				respectDialogue: res.respectDialogue,
				count: cues.length,
				heroes: cues.filter((c) => c.weight === 'hero').length,
				storedCues: res.storedCues,
				cues,
				stats: { ...res.stats, bySource },
				dialogue: res.dialogue.map((d) => ({ ...d, startTimecode: tc(d.start), endTimecode: tc(d.end) })),
				...(res.voice ? { voice: res.voice } : {}),
				...(res.analysis ? { analysis: res.analysis } : {}),
				...(analysisNotes.length ? { analysisNotes } : {}),
				warnings: res.warnings,
				next:
					cues.length === 0
						? 'No cues: the edit has no cuts, transitions, keyframed motion, text animations or sfx: markers in this range (or the density dropped them; try density "rich").'
						: 'Check a few cues with render_frames around their frames, then store the ones you keep with set_sound_cues {add: [...]} and fill them with place_sound {cueId, layers, alternatives, reason}.',
			});
		},
	);

	defineTool(
		ctx,
		'set_sound_cues',
		{
			title: 'Set sound cues',
			description:
				'Adds, edits, removes and resyncs the sound cues of a sequence in ONE transaction (one undo step). add: find_sound_cues suggestions verbatim (their informational keys are accepted; a suggestion already stored, storedCueId set, is skipped) or manual cues {at | frame, kind (default manual), weight (default support), types, align, pan, reason…} (source agent). update: [{cueId, …fields}] (null clears an optional field; a new frame moves the cue’s placed sounds unless moveClips: false). remove: {cueIds, withClips?} (withClips also deletes their placed sounds; otherwise they stay, unlinked). resync: true (or {cueIds}) moves anchored cues and their sounds to where their picture events are now. stopBefore (a music dip before the hit) and build (a high-pass sweep into it) are cue fields: once the cue is filled (now, or when a sound is placed on it) they are written into the mix — the music track’s volume automation (or the music clips’ Volume when the music shares its track) and one High Pass filter per music track — and they follow the cue (moved, changed, cleared with null, muted, deleted). Returns the new cue ids in add order.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				add: z.array(CueAddArg).min(1).max(SOUND_DESIGN_LIMITS.addCues).optional(),
				update: z.array(CueUpdateArg).min(1).max(500).optional(),
				remove: z
					.object({
						cueIds: z.array(z.string().min(1).max(128)).min(1).max(SOUND_DESIGN_LIMITS.cues),
						withClips: z.boolean().optional(),
					})
					.optional(),
				resync: z
					.union([
						z.literal(true),
						z.object({ cueIds: z.array(z.string().min(1).max(128)).min(1).max(5000) }),
					])
					.optional(),
				expectedRevision: z
					.number()
					.int()
					.min(0)
					.optional()
					.describe(
						'Refuse (E_REVISION_MISMATCH) when the project changed since this revision (find_sound_cues gives it)',
					),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			if (!a.add && !a.update && !a.remove && !a.resync)
				throw new ToolError('E_INVALID_PARAM', 'Nothing to do', 'Give add, update, remove and/or resync.');
			const parts: string[] = [];
			// suggestions already stored (storedCueId) are skipped: they are not counted
			const adding = a.add?.filter((c) => !c.storedCueId).length ?? 0;
			if (adding) parts.push(soundText(SOUND_LABELS.cuesAdd, adding));
			if (a.update) parts.push(soundText(SOUND_LABELS.cuesEdit, a.update.length));
			if (a.remove) parts.push(soundText(SOUND_LABELS.cuesRemove, a.remove.cueIds.length));
			if (a.resync) parts.push(SOUND_LABELS.cuesResync);
			// The templates of @jasper/project (SOUND_LABELS): the editor shows this label translated in its History.
			const label = `${SOUND_LABELS.soundCues} (${parts.join(', ')})`;
			const { res, r, state } = await transactFresh(
				ctx,
				a.projectId,
				label,
				async (doc) => {
					const seq = pickSequence(doc, a.sequenceId);
					const commands: Record<string, unknown>[] = [];
					const skipped: { index: number; storedCueId: string; frame: number }[] = [];
					const addedAt: number[] = [];
					if (a.add) {
						const cues: Record<string, unknown>[] = [];
						for (const [i, c] of a.add.entries()) {
							if (c.storedCueId) {
								const f = typeof c.frame === 'number' ? c.frame : -1;
								skipped.push({ index: i, storedCueId: c.storedCueId, frame: f });
								continue;
							}
							cues.push(await cueCommandInput(ctx, a.projectId, seq, c, i));
							addedAt.push(i);
						}
						if (cues.length) commands.push({ type: 'soundCue.add', sequenceId: seq.id, cues });
					}
					for (const [i, u] of (a.update ?? []).entries()) {
						const { at, frame, types, stopBefore, build, ...rest } = u;
						const f =
							frame !== undefined
								? frameOf(seq, frame)
								: at !== undefined
									? await resolveAt(ctx, a.projectId, seq, at)
									: undefined;
						commands.push({
							type: 'soundCue.update',
							...rest,
							...(f !== undefined ? { frame: f } : {}),
							...(types !== undefined
								? { types: types === null ? null : typeIds(types, `update[${i}].types`) }
								: {}),
							...(stopBefore !== undefined
								? { stopBefore: stopBefore === null ? null : stopBeforeOf(stopBefore) }
								: {}),
							...(build !== undefined ? { build: build === null ? null : buildOf(build) } : {}),
						});
					}
					if (a.remove)
						commands.push({
							type: 'soundCue.remove',
							cueIds: a.remove.cueIds,
							...(a.remove.withClips ? { withClips: true } : {}),
						});
					if (a.resync)
						commands.push({
							type: 'soundCue.resync',
							sequenceId: seq.id,
							...(a.resync === true ? {} : { cueIds: a.resync.cueIds }),
						});
					if (!commands.length)
						throw new ToolError(
							'E_INVALID_PARAM',
							'Every cue to add is already stored (storedCueId)',
							'Nothing changed. Pass suggestions with storedCueId null, or edit stored cues with update.',
						);
					return { commands, sequenceId: seq.id, state: { skipped, addedAt, seqId: seq.id } };
				},
				extra,
				a.expectedRevision,
			);
			// Results per command, in order.
			const results = r.results as unknown[];
			let k = 0;
			const out: Record<string, unknown> = {};
			if (a.add && state.addedAt.length) {
				const ids = (results[k++] as { cueIds: string[] }).cueIds;
				out.added = state.addedAt.map((index, j) => ({ index, cueId: ids[j] }));
			}
			if (state.skipped.length) out.skipped = state.skipped;
			if (a.update) out.updated = a.update.map(() => results[k++]);
			if (a.remove) out.removed = results[k++];
			if (a.resync) out.resynced = results[k++];
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = doc.sequences[state.seqId];
			return jsonResult({
				...txBody(res, r),
				historyLabel: label,
				...out,
				storedCues: seq ? soundCuesOf(seq).length : null,
			});
		},
	);

	defineTool(
		ctx,
		'place_sound',
		{
			title: 'Place sound (on a cue)',
			description: `PROPOSES (mode "propose", the default) or places (mode "apply": only when the user asked you to place sounds) 1–6 layers of sound on a stored cue (cueId) or at a time (at; a cue is created there unless createCue: false) so that each layer's aligned point lands EXACTLY on the cue frame: the peak for hits, booms, lands, whooshes; the end for risers and reverses; the start for UI blips (align auto, or say peak|start|end). Each layer is a library sound (soundId), a project media (mediaId) or a pick: sound {type, query?} chooses among the best-ranked sounds of that type (palette first), rotated so neighbouring cues differ, with the seeded ±2 % speed and ±1 dB variation. ONE undo step: imports the sounds into the "Sound Effects" bin, places one clip per layer on free SFX tracks (never over audio; a new "SFX n" when none is free), tags them Essential Sound ▸ SFX, groups the layers and links them to the cue. Gain: a layer's gainDb when given; otherwise its default level — the sound's loudest 400 ms to its role's momentary target at the sequence's delivery (web: hero −16, support −22, layer −24, beds −30 LUFS) under the role's true-peak ceiling (−6/−12/−16/−20 dBTP), within −30…+12 dB, so layered inserts stay under full scale (each clip's gainDb and level are returned). alternatives (1–3 soundIds) are stored on the clip for swap_sound "next"/"previous"; reason is recorded on the cue. Apply returns each clip with its track, start, aligned frame, peak frame and errorFlicks (0 = sample-exact), plus warnings (a hero under dialogue — where speech is heard: transcript words, else the engine's measured voice activity of dialogue clips, not a muted or ducked-out stretch — or within 0.5 s of another hero). Propose stores the same edit as a proposal (feature sound-design; setup items import the sounds and add the cue, the place item carries the alternatives as switchable sets) and changes nothing: ask the user to review it in the editor's Review panel, then wait_for_proposal.`,
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				cueId: z
					.string()
					.min(1)
					.max(128)
					.optional()
					.describe('A stored cue (find_sound_cues storedCueId, set_sound_cues)'),
				at: AtArg.optional().describe(`Or where the sounds land: "playhead" or ${TIME_FORMATS}`),
				layers: z.array(LayerArg).min(1).max(SOUND_DESIGN_LIMITS.layers),
				alternatives: z
					.array(SoundIdArg)
					.min(1)
					.max(3)
					.optional()
					.describe('1–3 other sounds that would also fit (for swap_sound next/previous)'),
				reason: z.string().min(1).max(500).optional().describe('Why this sound here (kept on the cue)'),
				kind: z.enum(CUE_KINDS).optional().describe('Kind of the cue created with `at` (default manual)'),
				weight: z
					.enum(CUE_WEIGHTS)
					.optional()
					.describe('Weight of the cue created with `at` (default from the first layer’s role)'),
				createCue: z.boolean().optional().describe('With `at`: store a cue there (default true)'),
				clampStart: z
					.boolean()
					.optional()
					.describe(
						'A sound that would start before frame 0 starts at 0 with its head trimmed (default false: refused)',
					),
				mode: z
					.enum(['propose', 'apply'])
					.optional()
					.describe(
						'"propose" (default): store a proposal for the user to review in the editor; "apply": place now (one undo step) — only when the user asked you to place sounds',
					),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			if ((a.cueId === undefined) === (a.at === undefined))
				throw new ToolError('E_INVALID_PARAM', 'Give cueId or at', 'cueId of a stored cue, or at: a time.');
			for (const [i, l] of a.layers.entries()) {
				const n =
					Number(l.soundId !== undefined) + Number(l.mediaId !== undefined) + Number(l.sound !== undefined);
				if (n !== 1)
					throw new ToolError(
						'E_INVALID_PARAM',
						`layers[${i}]: give exactly one of soundId, mediaId or sound`,
						'soundId from search_sounds, mediaId of a project media, or sound {type} to let the tool pick.',
					);
			}
			const entries = new Map<string, SoundEntry>();
			const entry = async (id: string) => {
				let e = entries.get(id);
				if (!e) {
					e = await soundCall<SoundEntry>(ctx, (c) => c.getSound(id));
					entries.set(id, e);
				}
				return e;
			};
			// Picks happen against a first read; the transaction is built from the freshest read.
			const first = await loadDoc(ctx, a.projectId);
			const seq0 = a.cueId
				? findCue(first.doc, a.cueId, a.sequenceId).seq
				: pickSequence(first.doc, a.sequenceId);
			const F = flicksPerFrame(seq0.settings.frameRate as Rational);
			const cue0 = a.cueId ? findCue(first.doc, a.cueId, seq0.id).cue : null;
			const frame0 = cue0 ? cue0.frame : await resolveAt(ctx, a.projectId, seq0, a.at!);
			const settings = soundDesignSettingsOf(seq0);
			const recent = recentSounds(seq0, frame0, F);
			const picks: (null | { soundId: string; rate: number; gainDb: number; from: string[] })[] = [];
			for (const [i, l] of a.layers.entries()) {
				if (!l.sound) {
					picks.push(null);
					continue;
				}
				const type = typeIds([l.sound.type], `layers[${i}].sound.type`)![0]!;
				const visualKind =
					cue0 && (VISUAL_KINDS as readonly string[]).includes(cue0.kind)
						? (cue0.kind as VisualKind)
						: undefined;
				const windowSec = cue0?.window
					? (cue0.window.end - cue0.window.start) / (F > 0 ? FLICKS_PER_SECOND / F : 30)
					: undefined;
				const cands = await candidatesOfType(
					ctx,
					type,
					l.sound.query,
					{
						...(visualKind ? { visualKind } : {}),
						...(windowSec && windowSec > 0 ? { windowSec } : {}),
						usedNearby: recent,
						palette: settings.palette ?? [],
					},
					extra,
				);
				// Earlier picks of this call count as recent (layers of one cue differ).
				const used = [
					...picks
						.filter((p) => p)
						.map((p) => p!.soundId)
						.reverse(),
					...recent,
				];
				const v = pickVariant(
					cands.map((s) => s.id),
					{
						seed: settings.seed,
						cueId: a.cueId ?? `frame:${frame0}`,
						sequenceId: seq0.id,
						layer: i,
						recentSoundIds: used,
					},
				);
				if (!v)
					throw new ToolError(
						'E_NOT_FOUND',
						`No library sound of type "${type}"${l.sound.query ? ` matching "${l.sound.query}"` : ''}`,
						'Try another type or query (search_sounds), or check sound_library_status.',
					);
				for (const s of cands) entries.set(s.id, s);
				picks.push({
					soundId: v.soundId,
					rate: v.rate,
					gainDb: v.gainDb,
					from: cands.slice(0, 4).map((s) => s.id),
				});
			}
			const soundIds = a.layers.map((l, i) => l.soundId ?? picks[i]?.soundId ?? null);
			const libIds = [...new Set(soundIds.filter((s): s is string => !!s))];
			const registered: Registered[] = [];
			for (const id of libIds) {
				const e = await entry(id);
				const reg = await soundCall<RegisterSoundResponse>(ctx, (c) => c.registerSound(id, a.projectId));
				registered.push({ soundId: id, reg, title: e.title || reg.library.title || reg.originalName });
			}
			for (const id of a.alternatives ?? []) await entry(id);
			const title = registered[0]?.title ?? 'Sound';
			if ((a.mode ?? 'propose') === 'propose')
				return proposePlacement(ctx, a, { seq0, frame0, picks, soundIds, registered, entries, title });
			const label =
				a.layers.length > 1
					? soundText(SOUND_LABELS.placeSounds, a.layers.length)
					: soundText(SOUND_LABELS.placeSound, title);
			const { res, r, state } = await transactFresh(
				ctx,
				a.projectId,
				label,
				async (doc) => {
					const seq = a.cueId ? findCue(doc, a.cueId, seq0.id).seq : pickSequence(doc, seq0.id);
					const cue = a.cueId ? findCue(doc, a.cueId, seq.id).cue : null;
					const frame = cue ? cue.frame : frame0;
					const { commands, media } = importCommands(doc, registered);
					const mediaFor = (soundId: string) => {
						const m = media.find((x) => x.soundId === soundId)!;
						return m.mediaId ?? m.ref!;
					};
					const layerTypes: string[] = [];
					const layers = a.layers.map((l: Layer, i) => {
						const pick = picks[i];
						const sid = soundIds[i];
						let mediaId: string;
						if (sid) {
							mediaId = mediaFor(sid);
							for (const t of entries.get(sid)?.types ?? [])
								if (isSoundTypeId(t) && !layerTypes.includes(t)) layerTypes.push(t);
						} else {
							mediaId = l.mediaId!;
							if (!Object.hasOwn(doc.media, mediaId))
								throw new ToolError(
									'E_NOT_FOUND',
									`Media not found: ${mediaId}`,
									'list_media lists the project’s media.',
								);
						}
						const track =
							!l.track || l.track.toLowerCase() === 'auto' ? undefined : resolveAudioTrack(seq, l.track);
						// An explicit gain is the clip's (plus a pick's ±1 dB variation); without one the clip gets the
						// sound's default level and the variation on top of it (soundDesign.place).
						const jitter = pick?.gainDb ?? 0;
						const gain = l.gainDb !== undefined ? l.gainDb + jitter : null;
						return {
							mediaId,
							...(track ? { track } : {}),
							...(l.align ? { align: l.align } : {}),
							...(gain !== null
								? { gainDb: Math.round(gain * 100) / 100 }
								: jitter !== 0
									? { gainOffsetDb: Math.round(jitter * 100) / 100 }
									: {}),
							...(pick && pick.rate !== 1 ? { rate: pick.rate } : {}),
							...(l.pitchSt !== undefined ? { pitchSt: l.pitchSt } : {}),
							...(l.pan !== undefined ? { pan: l.pan } : {}),
							...(l.role ? { role: l.role } : {}),
							ref: `$layer${i}`,
						};
					});
					let cueRef: string | null = null;
					if (!cue && a.createCue !== false) {
						cueRef = '$cue';
						commands.push({
							type: 'soundCue.add',
							sequenceId: seq.id,
							cues: [
								{
									frame,
									kind: a.kind ?? 'manual',
									weight: a.weight ?? (a.layers[0]!.role === 'hero' ? 'hero' : 'support'),
									...(layerTypes.length ? { types: layerTypes.slice(0, SOUND_DESIGN_LIMITS.types) } : {}),
									source: 'agent',
									...(a.reason ? { reason: a.reason } : {}),
									ref: cueRef,
								},
							],
						});
					}
					const firstSound = soundIds[0];
					const ring = [...new Set([...(firstSound ? [firstSound] : []), ...(a.alternatives ?? [])])];
					commands.push({
						type: 'soundDesign.place',
						sequenceId: seq.id,
						...(cue ? { cueId: cue.id } : cueRef ? { cueId: cueRef } : { frame }),
						layers,
						...(a.alternatives?.length ? { alternatives: ring } : {}),
						...(a.clampStart ? { clampStart: true } : {}),
					});
					if (cue && a.reason) {
						const prev = cue.reason ?? '';
						const next = prev.includes(a.reason) ? prev : prev ? `${prev} · Sound: ${a.reason}` : a.reason;
						if (next !== prev)
							commands.push({
								type: 'soundCue.update',
								cueId: cue.id,
								reason: next.slice(0, SOUND_DESIGN_LIMITS.reason),
							});
					}
					// Warnings against the edit as it is now (before this placement).
					const warnings = await placementWarnings(ctx, doc, seq, cue, frame, a, extra.signal);
					return {
						commands,
						sequenceId: seq.id,
						state: {
							seqId: seq.id,
							warnings,
							placeIndex: commands.findIndex((c) => c.type === 'soundDesign.place'),
						},
					};
				},
				extra,
			);
			const placed = (r.results as unknown[])[state.placeIndex] as {
				cueId: string | null;
				frame: number;
				groupId: string | null;
				clips: {
					clipId: string;
					mediaId: string;
					soundId: string | null;
					trackId: string;
					trackCreated: boolean;
					layer: number;
					role: string;
					align: string;
					sourceInFlicks: number;
					alignFlicks: number;
					errorFlicks: number;
					rate: number;
					pitchSt: number;
					trimmedHeadSec: number;
				}[];
			};
			const after = (await loadDoc(ctx, a.projectId)).doc;
			const seq = after.sequences[state.seqId]!;
			const Fa = flicksPerFrame(seq.settings.frameRate as Rational);
			const credits: string[] = [];
			const clips = placed.clips.map((p, i) => {
				const clip = seq.clips[p.clipId] as AudioClip | undefined;
				const e = p.soundId ? entries.get(p.soundId) : undefined;
				if (e && requiresAttribution(e.license) && e.attribution) credits.push(e.attribution);
				const peak = clip ? peakFrameOf(after, clip, Fa) : null;
				const pick = picks[i];
				return {
					clipId: p.clipId,
					layer: p.layer,
					role: p.role,
					soundId: p.soundId,
					title: e?.title ?? null,
					mediaId: p.mediaId,
					track: trackLabel(seq, p.trackId) ?? p.trackId,
					trackCreated: p.trackCreated,
					align: p.align,
					alignedFrame: { frame: placed.frame, timecode: sequenceTimecode(seq, placed.frame) },
					peakFrame: peak === null ? null : r3(peak),
					start: clip ? { frame: clip.start, timecode: sequenceTimecode(seq, clip.start) } : null,
					end: clip
						? {
								frame: clip.start + clip.duration,
								timecode: sequenceTimecode(seq, clip.start + clip.duration),
							}
						: null,
					sourceInFlicks: p.sourceInFlicks,
					errorFlicks: p.errorFlicks,
					errorMs: r3((p.errorFlicks / FLICKS_PER_SECOND) * 1000),
					rate: p.rate,
					pitchSt: p.pitchSt,
					gainDb: clip?.gainDb ?? 0,
					...((clip as { sfx?: { level?: unknown } } | undefined)?.sfx?.level
						? { level: (clip as { sfx?: { level?: unknown } }).sfx!.level }
						: {}),
					...(p.trimmedHeadSec > 0 ? { trimmedHeadSec: p.trimmedHeadSec } : {}),
					...(pick
						? { picked: { from: pick.from, variationRate: pick.rate, variationGainDb: pick.gainDb } }
						: {}),
				};
			});
			const notes: string[] = [];
			if (clips.some((c) => c.soundId && entries.get(c.soundId)?.source.type === 'synth'))
				notes.push('A Jasper Synth (procedural) sound was used: a fallback; prefer a recording if one fits.');
			if (credits.length)
				notes.push('CC-BY sounds were used: list_sound_credits gives the credit lines for the user.');
			return jsonResult({
				...txBody(res, r),
				historyLabel: label,
				cueId: placed.cueId,
				frame: { frame: placed.frame, timecode: sequenceTimecode(seq, placed.frame) },
				groupId: placed.groupId,
				clips,
				...(a.alternatives ? { alternatives: a.alternatives } : {}),
				...(state.warnings.length ? { placementWarnings: state.warnings } : {}),
				...(notes.length ? { notes } : {}),
			});
		},
	);

	defineTool(
		ctx,
		'swap_sound',
		{
			title: 'Swap sound',
			description:
				'Replaces the sound of a placed clip with another library sound in ONE undo step, keeping where its aligned point (peak, start or end) plays, its track, role, pan, gain, effects, group and cue link (keyframes keep their times); the clip covers the whole new sound, its tail included. to: a soundId — the clip\'s own sound registers it again and swaps the fresh copy in (Sound Check\'s fix for a sound whose tail is cut: copies made before trailing silence was added end inside the last frame); refused when the project\'s copy is already current — or "next" / "previous" to cycle: first the alternates given to place_sound, then sounds of the same family most similar to the original, then the most similar sounds of any family; the cycle keeps the sound first placed as its anchor across calls (a clip placed without alternates stores it on its first swap), so next / previous progress and come back to it. A candidate that does not fit on the clip’s track is skipped (listed in skipped). Returns the old and new sound, the position in the cycle and the aligned frame.',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1).max(128).describe('A placed sound clip (place_sound, insert_sound)'),
				to: z.union([SoundIdArg, z.enum(['next', 'previous'])]).describe('A soundId, or "next" / "previous"'),
				align: z
					.enum(CUE_ALIGNS)
					.optional()
					.describe('Which point of the new sound lands there (default: as placed)'),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const { seq, clip } = findAudioClip(doc, a.clipId);
			const prov = readLibraryProvenance(
				(doc.media[clip.mediaId] as { library?: unknown } | undefined)?.library,
			);
			const current = clip.sfx?.soundId ?? prov?.soundId ?? null;
			// The candidates to try, in order: the explicit sound, or the next ones of the cycle in its direction (a
			// candidate that does not fit on the clip's track, E_OVERLAP, is skipped for the following one).
			let tries: { soundId: string; cycle: { index: number; of: number; from: string } | null }[];
			if (a.to === 'next' || a.to === 'previous') {
				const list = await cycleList(ctx, clip, current, prov, extra);
				let idx = current ? list.findIndex((x) => x.soundId === current) : -1;
				if (idx < 0) {
					if (current) list.unshift({ soundId: current, from: 'current' });
					idx = 0;
				}
				if (list.length < 2)
					throw new ToolError(
						'E_NOT_FOUND',
						'No other sound to cycle to',
						'Give place_sound alternatives, or swap to a soundId from search_sounds.',
					);
				const n = list.length;
				const dir = a.to === 'next' ? 1 : -1;
				tries = [];
				for (let step = 1; step < n && tries.length < MAX_CYCLE_TRIES; step++) {
					const j = (((idx + dir * step) % n) + n) % n;
					if (list[j]!.soundId === current) continue;
					tries.push({ soundId: list[j]!.soundId, cycle: { index: j + 1, of: n, from: list[j]!.from } });
				}
			} else tries = [{ soundId: a.to, cycle: null }];
			// The same sound again re-registers it: a copy made before the tail fix (no trailing silence) is replaced by the
			// current one, and the clip re-planned on it so the whole sound plays (Sound Check's fix for a cut tail). When
			// the project's copy already is the current one there is nothing to swap.
			const refresh = tries[0]!.soundId === current;
			// A clip without a variation ring gets [the sound it plays now] in the same transaction: later calls cycle
			// around that anchor (it would otherwise be rebuilt around each new sound and alternate between two).
			const ring =
				!clip.sfx?.alternatives?.length && current && SOUND_REF_RE.test(current) ? [current] : null;
			const skipped: { soundId: string; reason: string }[] = [];
			let done:
				| {
						target: string;
						cycle: { index: number; of: number; from: string } | null;
						e: SoundEntry;
						title: string;
						label: string;
						tx: Awaited<ReturnType<typeof transactFresh<{ swapIndex: number }>>>;
				  }
				| undefined;
			for (const [k, t] of tries.entries()) {
				const e = await soundCall<SoundEntry>(ctx, (c) => c.getSound(t.soundId));
				const reg = await soundCall<RegisterSoundResponse>(ctx, (c) =>
					c.registerSound(t.soundId, a.projectId),
				);
				const title = e.title || reg.library.title || reg.originalName;
				if (
					refresh &&
					importCommands(doc, [{ soundId: t.soundId, reg, title }]).media[0]!.mediaId === clip.mediaId
				)
					throw new ToolError(
						'E_INVALID_PARAM',
						`The clip already plays ${current} from its current copy`,
						'Pick another sound.',
					);
				const label = soundText(SOUND_LABELS.swapSound, title);
				try {
					const tx = await transactFresh(
						ctx,
						a.projectId,
						label,
						async (d) => {
							const { seq: s } = findAudioClip(d, a.clipId);
							const { commands, media } = importCommands(d, [{ soundId: t.soundId, reg, title }]);
							const m = media[0]!;
							commands.push({
								type: 'soundDesign.swap',
								clipId: a.clipId,
								mediaId: m.mediaId ?? m.ref!,
								...(a.align ? { align: a.align } : {}),
								...(ring ? { alternatives: ring } : {}),
							});
							return { commands, sequenceId: s.id, state: { swapIndex: commands.length - 1 } };
						},
						extra,
					);
					done = { target: t.soundId, cycle: t.cycle, e, title, label, tx };
					break;
				} catch (err) {
					if (!(t.cycle && err instanceof ToolError && err.code === 'E_OVERLAP' && k < tries.length - 1))
						throw err;
					skipped.push({ soundId: t.soundId, reason: err.message });
				}
			}
			const { target, cycle, e, title, label } = done!;
			const { res, r, state } = done!.tx;
			const out = (r.results as unknown[])[state.swapIndex] as {
				start: number;
				duration: number;
				sourceInFlicks: number;
				errorFlicks: number;
				alignedFrame: number;
				align: string;
				mediaId: string;
			};
			const after = (await loadDoc(ctx, a.projectId)).doc;
			const c2 = after.sequences[seq.id]?.clips[a.clipId] as SfxClip | undefined;
			const fromEntry = current
				? await soundCall<SoundEntry>(ctx, (c) => c.getSound(current)).catch(() => null)
				: null;
			return jsonResult({
				...txBody(res, r),
				historyLabel: label,
				clipId: a.clipId,
				from: { soundId: current, title: fromEntry?.title ?? prov?.title ?? null },
				to: { soundId: target, title, mediaId: out.mediaId, license: e.license },
				...(cycle ? { cycle } : {}),
				...(skipped.length ? { skipped } : {}),
				align: out.align,
				alignedFrame: { frame: out.alignedFrame, timecode: sequenceTimecode(seq, out.alignedFrame) },
				start: { frame: out.start, timecode: sequenceTimecode(seq, out.start) },
				errorFlicks: out.errorFlicks,
				...(c2
					? {
							kept: {
								track: trackLabel(after.sequences[seq.id]!, c2.trackId),
								role: c2.sfx?.role ?? null,
								gainDb: c2.gainDb,
								pan: c2.pan.keyframes.length ? 'keyframed' : c2.pan.value,
							},
						}
					: {}),
				...(requiresAttribution(e.license) ? { credit: e.attribution } : {}),
			});
		},
	);

	defineTool(
		ctx,
		'align_peak',
		{
			title: 'Align sound peak',
			description:
				'Moves a placed sound clip so that its aligned point (its peak for hits and whooshes, its end for risers; or align) lands EXACTLY on a frame: to = a frame / {seconds} / timecode, "playhead" (the open editor’s), or "cue" (the clip’s own cue, else the nearest stored cue). The other layers of its cue move with it (withLayers, default true), each by its own aligned point; keyframes travel with the sound. Sample-exact through the In point (library sounds carry 50 ms of lead silence). ONE undo step; refused when a clip would leave its track’s free space (E_OVERLAP) or start before frame 0.',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1).max(128),
				to: z
					.union([z.enum(['playhead', 'cue']), TimeInputSchema])
					.describe(`"cue", "playhead", or ${TIME_FORMATS}`),
				align: z
					.enum(CUE_ALIGNS)
					.optional()
					.describe('Which point of this clip lands there (default: as placed)'),
				withLayers: z.boolean().optional().describe('Also move the other layers of its cue (default true)'),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const { seq, clip } = findAudioClip(doc, a.clipId);
			const F = flicksPerFrame(seq.settings.frameRate as Rational);
			let target: number;
			let cueUsed: string | null = null;
			if (a.to === 'cue') {
				const cues = soundCuesOf(seq);
				const own = filledCueOf(seq, clip);
				const here = alignedFrameOf(clip, F) ?? clip.start;
				const pick =
					own ??
					[...cues].sort(
						(x, y) => Math.abs(x.frame - here) - Math.abs(y.frame - here) || x.frame - y.frame,
					)[0];
				if (!pick)
					throw new ToolError(
						'E_NOT_FOUND',
						'The sequence has no sound cue',
						'Give a frame, or add cues with set_sound_cues.',
					);
				target = pick.frame;
				cueUsed = pick.id;
			} else if (a.to === 'playhead') target = await resolveAt(ctx, a.projectId, seq, 'playhead');
			else target = frameOf(seq, a.to);
			const ownCue = filledCueOf(seq, clip);
			const others =
				a.withLayers !== false && ownCue
					? sfxClipsOf(seq).filter((c) => c.id !== clip.id && filledCueOf(seq, c)?.id === ownCue.id)
					: [];
			const moving = [clip, ...others];
			const label =
				moving.length > 1 ? soundText(SOUND_LABELS.alignPeaks, moving.length) : SOUND_LABELS.alignPeak;
			const { res, r } = await transactFresh(
				ctx,
				a.projectId,
				label,
				async (d) => {
					const { seq: s } = findAudioClip(d, a.clipId);
					const commands = moving.map((c, i) => ({
						type: 'soundDesign.swap',
						clipId: c.id,
						mediaId: (s.clips[c.id] as AudioClip | undefined)?.mediaId ?? c.mediaId,
						frame: target,
						...(i === 0 && a.align ? { align: a.align } : {}),
					}));
					return { commands, sequenceId: s.id, state: null };
				},
				extra,
			);
			const after = (await loadDoc(ctx, a.projectId)).doc;
			const s2 = after.sequences[seq.id]!;
			const results = r.results as {
				clipId: string;
				start: number;
				alignedFrame: number;
				align: string;
				errorFlicks: number;
				sourceInFlicks: number;
			}[];
			const linkedCue = filledCueOf(s2, clip);
			return jsonResult({
				...txBody(res, r),
				historyLabel: label,
				frame: { frame: target, timecode: sequenceTimecode(s2, target) },
				...(cueUsed ? { cueId: cueUsed } : {}),
				clips: results.map((x, i) => {
					const before = moving[i]!;
					const c = s2.clips[x.clipId] as AudioClip | undefined;
					const peak = c ? peakFrameOf(after, c, F) : null;
					return {
						clipId: x.clipId,
						align: x.align,
						alignedFrame: { frame: x.alignedFrame, timecode: sequenceTimecode(s2, x.alignedFrame) },
						peakFrame: peak === null ? null : r3(peak),
						start: { frame: x.start, timecode: sequenceTimecode(s2, x.start) },
						movedFrames: x.start - before.start,
						sourceInFlicks: x.sourceInFlicks,
						errorFlicks: x.errorFlicks,
					};
				}),
				...(linkedCue && linkedCue.frame !== target
					? {
							note: `The clip's cue ${linkedCue.id} stays at ${sequenceTimecode(s2, linkedCue.frame)}: set_sound_cues {update: [{cueId, frame}]} moves a cue together with its sounds.`,
						}
					: {}),
			});
		},
	);
}

/** The placed audio clip, or a typed error. */
function findAudioClip(doc: ProjectDocument, clipId: string): { seq: Sequence; clip: SfxClip } {
	for (const seq of Object.values(doc.sequences)) {
		const c = seq.clips[clipId];
		if (!c) continue;
		if (c.kind !== 'audio')
			throw new ToolError(
				'E_INVALID_PARAM',
				`${clipId} is not an audio clip`,
				'Give a sound clip (get_timeline).',
			);
		return { seq, clip: c as SfxClip };
	}
	throw new ToolError('E_NOT_FOUND', `Clip not found: ${clipId}`, 'Call get_timeline for clip ids.');
}

/**
 * The variation cycle of a placed clip (spec 12 §2.7 "Variation cycling"): its alternates (the placed sound first),
 * then sounds of the same family most similar to the original, then the most similar sounds of any family. The
 * original is the first alternate (place_sound stores it there), else the current sound: the list stays the same
 * while cycling.
 */
async function cycleList(
	ctx: ToolContext,
	clip: SfxClip,
	current: string | null,
	prov: LibraryProvenance | null,
	extra: Extra,
): Promise<{ soundId: string; from: string }[]> {
	const alts = (clip.sfx?.alternatives ?? []).filter((s) => SOUND_REF_RE.test(s));
	const origin = alts[0] ?? current;
	const out: { soundId: string; from: string }[] = [];
	const add = (id: string, from: string) => {
		if (!out.some((x) => x.soundId === id)) out.push({ soundId: id, from });
	};
	for (const s of alts) add(s, 'alternatives');
	if (!origin) return out;
	add(origin, 'alternatives');
	let types: string[] = prov?.types ?? [];
	try {
		types = (await soundCall<SoundEntry>(ctx, (c) => c.getSound(origin))).types;
	} catch {
		// the original left the library: its provenance's types decide the family
	}
	const t0 = types.find(isSoundTypeId);
	const family = t0 ? SOUND_TYPES[t0].family : undefined;
	if (family) {
		const fam = await soundCall<SoundSearchResponse>(ctx, (c) =>
			c.searchSounds({ family, similarTo: origin, license: 'commercial-safe', limit: 12 }, extra.signal),
		).catch(() => null);
		for (const r of fam?.results ?? []) add(r.sound.id, 'family');
	}
	const sim = await soundCall<SoundSearchResponse>(ctx, (c) =>
		c.searchSounds({ similarTo: origin, license: 'commercial-safe', limit: 12 }, extra.signal),
	).catch(() => null);
	for (const r of sim?.results ?? []) add(r.sound.id, 'similar');
	return out;
}

/** The `soundCue.add` input of a tool cue (a suggestion as returned, or a manual cue). */
async function cueCommandInput(
	ctx: ToolContext,
	projectId: string,
	seq: Sequence,
	c: CueAdd,
	i: number,
): Promise<Record<string, unknown>> {
	let frame: number;
	if (c.frame !== undefined) frame = frameOf(seq, c.frame);
	else if (c.at !== undefined) frame = await resolveAt(ctx, projectId, seq, c.at);
	else if (c.timecode !== undefined) frame = frameOf(seq, c.timecode);
	else
		throw new ToolError(
			'E_INVALID_PARAM',
			`add[${i}]: give frame or at`,
			'A suggestion carries its frame; a manual cue needs at (a time or "playhead").',
		);
	if (c.window && c.window.end < c.window.start)
		throw new ToolError(
			'E_INVALID_PARAM',
			`add[${i}].window: end (${c.window.end}) is before start (${c.window.start})`,
			'window is the event span in sequence frames {start, end} with end ≥ start (a suggestion carries it).',
		);
	const derived = c.from !== undefined || c.key !== undefined;
	const source = c.source ?? (derived ? 'derived' : 'agent');
	const types = typeIds(c.types, `add[${i}].types`);
	return {
		frame,
		kind: c.kind ?? 'manual',
		weight: c.weight ?? 'support',
		...(types?.length ? { types } : {}),
		...(c.align ? { align: c.align } : {}),
		...(c.pan !== undefined ? { pan: c.pan } : {}),
		...(c.panSweep ? { panSweep: c.panSweep } : {}),
		...(c.pitchSt !== undefined ? { pitchSt: c.pitchSt } : {}),
		...(c.label !== undefined ? { label: c.label } : {}),
		...(c.anchor !== undefined ? { anchor: c.anchor } : {}),
		source,
		...(c.confidence !== undefined ? { confidence: c.confidence } : {}),
		...(c.reason !== undefined ? { reason: c.reason } : {}),
		...(c.window ? { window: c.window } : {}),
		...(c.muted !== undefined ? { muted: c.muted } : {}),
		...(c.stopBefore !== undefined ? { stopBefore: stopBeforeOf(c.stopBefore) } : {}),
		...(c.build !== undefined ? { build: buildOf(c.build) } : {}),
	};
}

/** place_sound's arguments (what the propose path and the warnings read). */
type PlaceArgs = {
	projectId: string;
	sequenceId?: string | undefined;
	cueId?: string | undefined;
	layers: Layer[];
	alternatives?: string[] | undefined;
	reason?: string | undefined;
	kind?: SoundCue['kind'] | undefined;
	weight?: SoundCue['weight'] | undefined;
	createCue?: boolean | undefined;
	clampStart?: boolean | undefined;
};

/**
 * Where dialogue is heard in `seq` (the project's one definition, `dialogueSpans`): asked of the engine, which measures
 * the voice activity of dialogue clips without a transcript (cached per media range), so a hero in a pause of a long
 * dialogue clip is not "under dialogue"; mix gains (a muted or ducked-out stretch) count either way. When the engine
 * cannot say, the pure rule here: transcript words, else whole dialogue clips (`whole: true`).
 */
async function heardDialogue(
	ctx: ToolContext,
	doc: ProjectDocument,
	seq: Sequence,
	signal?: AbortSignal,
): Promise<{ ranges: Array<[number, number]>; whole: boolean }> {
	try {
		const res = await soundCall<SoundCuesResponse>(ctx, (c) =>
			c.soundDesignCues(
				{
					envelope: toolEnvelope(doc, 0),
					sequenceId: seq.id,
					// the dialogue spans are what is asked; the derivation is kept to one frame of one source
					opts: { sources: ['markers'], range: { start: 0, end: 1 }, maxCues: 1 },
				},
				signal,
			),
		);
		return {
			ranges: res.dialogue.map((d) => [d.start, d.end] as [number, number]),
			whole: res.voice?.state === 'partial' || res.voice?.state === 'failed',
		};
	} catch {
		return { ranges: sequenceDialogueRanges(doc, seq), whole: true };
	}
}

/** Hero warnings of a placement against the edit as it is (before it). */
async function placementWarnings(
	ctx: ToolContext,
	doc: ProjectDocument,
	seq: Sequence,
	cue: SoundCue | null,
	frame: number,
	a: PlaceArgs,
	signal?: AbortSignal,
): Promise<{ code: string; message: string }[]> {
	const warnings: { code: string; message: string }[] = [];
	const weightHere = cue?.weight ?? a.weight ?? (a.layers[0]!.role === 'hero' ? 'hero' : 'support');
	const heroHere = weightHere === 'hero' || a.layers.some((l) => l.role === 'hero');
	if (!heroHere) return warnings;
	const F = flicksPerFrame(seq.settings.frameRate as Rational);
	const dialogue = await heardDialogue(ctx, doc, seq, signal);
	if (dialogue.ranges.some(([s, e]) => frame >= s && frame < e))
		warnings.push({
			code: 'W_HERO_UNDER_DIALOGUE',
			message: `A hero sound at ${sequenceTimecode(seq, frame)} plays under spoken words${
				dialogue.whole ? ' (or a dialogue clip whose voice activity could not be measured)' : ''
			}: make it support, or move it.`,
		});
	const fps = FLICKS_PER_SECOND / F;
	for (const c of sfxClipsOf(seq)) {
		if (c.sfx!.role !== 'hero' || (cue && filledCueOf(seq, c)?.id === cue.id)) continue;
		const at = alignedFrameOf(c, F);
		if (at === null) continue;
		const dt = Math.abs(at - frame) / fps;
		if (dt < 0.5)
			warnings.push({
				code: 'W_HERO_TOO_CLOSE',
				message: `Another hero (${c.id}) is ${r3(dt)} s away: never two heroes within 0.5 s.`,
			});
		else if (dt < 2)
			warnings.push({
				code: 'W_HERO_DENSITY',
				message: `Another hero (${c.id}) is ${r3(dt)} s away: about one hero per 2 s.`,
			});
	}
	return warnings;
}

/** "E_OVERLAP: …" → E_OVERLAP (an item's reason starts with the refusal code). */
const reasonCode = (reason: string | undefined) =>
	/^(E_[A-Z_]+):/.exec(reason ?? '')?.[1] ?? 'E_INVALID_PARAM';

/**
 * place_sound {mode: 'propose'}: the same placement as a proposal (feature sound-design) for the user to review —
 * setup items import the sounds (and add the cue for `at`), the place item carries the alternatives as switchable
 * sets. Nothing in the project changes. A placement that does not apply now is refused (the proposal is removed).
 */
async function proposePlacement(
	ctx: ToolContext,
	a: PlaceArgs,
	st: {
		seq0: Sequence;
		frame0: number;
		picks: (null | { soundId: string; rate: number; gainDb: number; from: string[] })[];
		soundIds: (string | null)[];
		registered: Registered[];
		entries: Map<string, SoundEntry>;
		title: string;
	},
) {
	// The alternatives are imported too (the user may pick one).
	const registered = [...st.registered];
	for (const id of a.alternatives ?? [])
		if (!registered.some((r) => r.soundId === id)) {
			const reg = await soundCall<RegisterSoundResponse>(ctx, (c) => c.registerSound(id, a.projectId));
			const e = st.entries.get(id);
			registered.push({ soundId: id, reg, title: e?.title || reg.library.title || reg.originalName });
		}
	const { doc } = await loadDoc(ctx, a.projectId);
	const seq = a.cueId ? findCue(doc, a.cueId, st.seq0.id).seq : pickSequence(doc, st.seq0.id);
	const cue = a.cueId ? findCue(doc, a.cueId, seq.id).cue : null;
	const frame = cue ? cue.frame : st.frame0;
	const tc = sequenceTimecode(seq, frame);
	const layerTypes: string[] = [];
	const layers = a.layers.map((l: Layer, i) => {
		const pick = st.picks[i];
		const sid = st.soundIds[i];
		if (sid) {
			for (const t of st.entries.get(sid)?.types ?? [])
				if (isSoundTypeId(t) && !layerTypes.includes(t)) layerTypes.push(t);
		} else if (!Object.hasOwn(doc.media, l.mediaId!))
			throw new ToolError(
				'E_NOT_FOUND',
				`Media not found: ${l.mediaId}`,
				'list_media lists the project’s media.',
			);
		const track = !l.track || l.track.toLowerCase() === 'auto' ? undefined : resolveAudioTrack(seq, l.track);
		// As in apply mode: an explicit gain plus the pick's variation, else the default level plus the variation.
		const jitter = pick?.gainDb ?? 0;
		const gain = l.gainDb !== undefined ? l.gainDb + jitter : null;
		return {
			...(sid ? { soundId: sid } : { mediaId: l.mediaId! }),
			...(track ? { track } : {}),
			...(l.align ? { align: l.align } : {}),
			...(gain !== null
				? { gainDb: Math.round(gain * 100) / 100 }
				: jitter !== 0
					? { gainOffsetDb: Math.round(jitter * 100) / 100 }
					: {}),
			...(pick && pick.rate !== 1 ? { rate: pick.rate } : {}),
			...(l.pitchSt !== undefined ? { pitchSt: l.pitchSt } : {}),
			...(l.pan !== undefined ? { pan: l.pan } : {}),
			...(l.role ? { role: l.role } : {}),
		};
	});
	const weight = a.weight ?? (a.layers[0]!.role === 'hero' ? 'hero' : 'support');
	const kind = a.kind ?? 'manual';
	const extraCommands: Record<string, unknown>[] = [];
	if (cue && a.reason) {
		const prev = cue.reason ?? '';
		const next = prev.includes(a.reason) ? prev : prev ? `${prev} · Sound: ${a.reason}` : a.reason;
		if (next !== prev)
			extraCommands.push({
				type: 'soundCue.update',
				cueId: cue.id,
				reason: next.slice(0, SOUND_DESIGN_LIMITS.reason),
			});
	}
	const names = st.soundIds.map((s, i) =>
		s ? (st.entries.get(s)?.title ?? s) : (a.layers[i]!.mediaId ?? ''),
	);
	const role = a.layers[0]!.role ?? (i0Hero(cue, weight) ? 'hero' : 'support');
	const first = st.soundIds[0];
	const why = `${names.join(' + ')} on ${cue?.reason ?? a.reason ?? `${kind} cue`} at ${tc} · ${role}`.slice(
		0,
		1000,
	);
	const media: SoundProposalMedia[] = registered.map((r) => ({
		soundId: r.soundId,
		title: r.title,
		fingerprint: r.reg.fingerprint,
		kind: r.reg.kind,
		existingMediaId: r.reg.existingMediaId,
		library: r.reg.library,
		register: mediaRegisterCommand(r.reg, '$x', '$xi', r.title) as SoundProposalMedia['register'],
	}));
	const placement: SoundProposalPlacement = {
		id: 'place',
		label: `${names.join(' + ')} at ${tc}`.slice(0, 200),
		group: role,
		meta: {
			feature: SOUND_DESIGN_FEATURE,
			frame,
			timecode: tc,
			kind: cue?.kind ?? kind,
			role,
			...(first ? { soundId: first, title: st.entries.get(first)?.title ?? first } : {}),
			why,
			...(a.reason ? { reason: a.reason } : {}),
		},
		cue: cue
			? { cueId: cue.id }
			: a.createCue !== false
				? {
						add: {
							frame,
							kind,
							weight,
							...(layerTypes.length ? { types: layerTypes.slice(0, SOUND_DESIGN_LIMITS.types) } : {}),
							source: 'agent',
							...(a.reason ? { reason: a.reason } : {}),
						},
						label: `Cue: ${kind} at ${tc}`,
					}
				: { frame },
		layers,
		...(a.alternatives?.length ? { ring: [...new Set([...(first ? [first] : []), ...a.alternatives])] } : {}),
		...(a.alternatives?.length
			? {
					alternatives: a.alternatives.map((id) => ({
						soundId: id,
						label: st.entries.get(id)?.title ?? id,
						meta: { soundId: id, title: st.entries.get(id)?.title ?? id },
					})),
				}
			: {}),
		...(a.clampStart ? { clampStart: true } : {}),
		...(extraCommands.length ? { extraCommands } : {}),
	};
	const built = soundProposalItems(doc, seq.id, media, [placement], { binName: SOUND_EFFECTS_BIN });
	const warnings = await placementWarnings(ctx, doc, seq, cue, frame, a);
	const label =
		a.layers.length > 1
			? soundText(SOUND_LABELS.placeSounds, a.layers.length)
			: soundText(SOUND_LABELS.placeSound, st.title);
	const created = await ctx.engine((c) =>
		c.createProposal(a.projectId, {
			sequenceId: seq.id,
			feature: SOUND_DESIGN_FEATURE,
			title: label.slice(0, 200),
			summary: why,
			items: built.items as never,
		}),
	);
	const p = created.proposal;
	const place = p.items.find((i) => i.id === 'place');
	if (!place || place.state === 'invalid') {
		await ctx.engine((c) => c.deleteProposal(a.projectId, p.id)).catch(() => undefined);
		const reason = place?.reason ?? 'the placement does not apply to the project';
		throw new ToolError(
			reasonCode(reason),
			`The placement does not apply: ${reason}`,
			TX_ERROR_HINTS[reasonCode(reason)] ?? 'Check the cue, the tracks and the time (get_timeline).',
		);
	}
	const notes: string[] = [];
	if (registered.some((r) => st.entries.get(r.soundId)?.source.type === 'synth'))
		notes.push('A Jasper Synth (procedural) sound was used: a fallback; prefer a recording if one fits.');
	if (registered.some((r) => requiresAttribution(r.reg.library.license)))
		notes.push('CC-BY sounds are in it: list_sound_credits gives the credit lines once it is applied.');
	return jsonResult({
		mode: 'propose',
		proposalId: p.id,
		title: p.title,
		frame: { frame, timecode: tc },
		items: p.items.map((i) => ({
			itemId: i.id,
			label: i.label,
			group: i.group,
			state: i.state,
			...(i.requires.length ? { requires: i.requires } : {}),
			...(i.alternatives?.length ? { alternatives: i.alternatives.map((x) => x.label) } : {}),
		})),
		why,
		...(warnings.length ? { placementWarnings: warnings } : {}),
		...(notes.length ? { notes } : {}),
		next: 'Nothing was placed yet. Tell the user the proposal is waiting in the editor’s Review panel (they can hear it in context, swap the alternates and apply it as one undo step), then call wait_for_proposal {projectId, proposalId}. Use mode "apply" only when the user asked you to place sounds directly.',
	});
}

/** The first layer of a hero cue (or a hero weight for a new cue) is the hero. */
const i0Hero = (cue: SoundCue | null, weight: SoundCue['weight']) => (cue?.weight ?? weight) === 'hero';

/** plan_sound_design: the engine's `sound-design` plan job → a proposal for the user to review. */
function registerPlanSoundDesign(ctx: ToolContext): void {
	defineTool(
		ctx,
		'plan_sound_design',
		{
			title: 'Plan sound design (propose)',
			description: `Plans sound effects for a sequence and stores them as a PROPOSAL for the user to review — nothing in the project changes (spec 12 P3-R3). The engine takes the cues (cues "auto", the default: the sequence's unfilled stored cues plus cues derived from the edit — cuts, transitions, moves and lands, text animators, motion graphics, "sfx:" markers — within the density budget, never a plain cut under spoken words; or cue ids of stored cues), ranks library sounds for each (its types, visual kind and window, commercial-safe licences only, palette sounds first, real recordings before Jasper Synth), rotates among the best so neighbours differ (seeded ±2 % speed, ±1 dB), and proposes one placement per cue (peak-aligned, role from the cue weight, align / pan / sweep from the cue) with 1–3 alternatives and a why-line; a marker naming several types ("sfx: boom+whoosh") gets one layer per type. Each sound's gain is SOLVED against the bed (the masking solver of rebalance_sfx: every layer and every alternative measured in place, the alternative with the item's other chosen sounds): the why-line ends with its level and what limited it ("−16.2 dB, limited by dialogue A2"); without an engine that can render audio the placement's default level by role applies (warning W_LEVELS_UNMEASURED). style {roomGlue, stopBefore, build, delivery} adds the mixing items (room glue and the delivery preset as setup items every placement requires — the gains are solved against them, and the delivery stores the loudness of the mix WITH the planned sounds so the preview is normalised right after the accept — then one stop-before dip and one build per hero with music). Deterministic for the same edit, library and seed. Waits for the job (timeoutSeconds, default 300) and returns the proposalId, a table (item | timecode | cue | sound | role | align | alternates | gain | mix), per event the gain, target and achieved lift and limitedBy (layers: their own gains), conflicts (the earlier, safety constraint kept; clipId is the item's layer ref $sfx_<n>_<layer>, the placed clip does not exist yet), levels (how they were measured), the skipped cues with reasons and warnings (the solver's for the chosen sounds and for each alternative, naming the item and alternative). check: true also runs Sound Check on the new proposal (soundCheck: fixes · introduces, per item; sound_check {proposalId}) — do it before handing it over. Then ASK THE USER to review it in the editor's Review panel (hear in context, keep / reject, swap alternates, notes, apply as one undo step) and call wait_for_proposal; never accept it yourself unless the user asked you to apply it.`,
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				range: z
					.object({ start: TimeInputSchema, end: TimeInputSchema })
					.optional()
					.describe(`Only cues in [start, end). ${TIME_FORMATS}`),
				cues: z
					.union([z.literal('auto'), z.array(z.string().min(1).max(128)).min(1).max(2000)])
					.optional()
					.describe('"auto" (default): unfilled stored cues + cues derived from the edit; or stored cue ids'),
				style: z
					.object({
						density: z
							.enum(CUE_DENSITIES)
							.optional()
							.describe('Derived cues budget (default: the sequence’s)'),
						palette: z
							.union([z.literal('project'), z.array(SoundIdArg).max(500)])
							.optional()
							.describe('Sounds ranked first: ids, or "project" (default: the sequence palette)'),
						sources: z
							.array(z.enum(['starter', 'pack', 'folder', 'synth']))
							.min(1)
							.max(4)
							.optional()
							.describe('Library sources to pick from (default all; synth always ranks last)'),
						cueSources: z
							.array(z.enum(CUE_DERIVE_SOURCES))
							.min(1)
							.max(CUE_DERIVE_SOURCES.length)
							.optional()
							.describe(
								`Where derived cues come from with cues "auto" (default the edit's own sources, as find_sound_cues): ${CUE_DERIVE_SOURCE_LIST}. The engine sources scene (shot changes in footage), beat (music beats) and pixel (picture motion of footage) are measured inside the plan job when listed (slower the first time; cached). Stored cues are planned whatever their source`,
							),
						snapToBeats: z
							.boolean()
							.optional()
							.describe(
								'Snap derived moves, transitions, emphases and reveals to the music’s beats within 2 frames',
							),
						timeSignature: z
							.union([z.literal('auto'), z.number().int().min(2).max(12)])
							.optional()
							.describe(
								'Metre of the music’s downbeats (beat cues): "auto" (default, 3 or 4 detected) or beats per bar 2…12',
							),
						respectDialogue: z
							.boolean()
							.optional()
							.describe('No cut cues under words, no hero under words (default true)'),
						seed: z.number().int().min(0).max(0xffff_ffff).optional().describe('Default: the sequence seed'),
						alternatives: z
							.number()
							.int()
							.min(0)
							.max(3)
							.optional()
							.describe('Alternates per cue (default 3)'),
						roomGlue: z
							.union([z.boolean(), z.object({ sendDb: z.number().min(-96).max(15).optional() })])
							.optional()
							.describe(
								'Shared "SFX Room" reverb (setup item every placement requires): true (sends at −16 dB) or {sendDb}',
							),
						stopBefore: z
							.boolean()
							.optional()
							.describe(
								'A music dip (0.25 s, −24 dB) before each hero with music under it: one item per hero',
							),
						build: z
							.boolean()
							.optional()
							.describe(
								'A high-pass build (2 s, 150 → 2000 Hz) into each hero after ≥ 2 s of music: one item per hero',
							),
						delivery: z
							.enum(SOUND_DELIVERIES)
							.optional()
							.describe(
								'Delivery preset as a setup item (loudness, Auto-Match, ducking; see apply_delivery); gains are solved against it',
							),
					})
					.optional(),
				maxCues: z.number().int().min(1).max(200).optional().describe('Cues that get a sound (default 200)'),
				label: z.string().min(1).max(200).optional().describe('Proposal title'),
				check: z
					.boolean()
					.optional()
					.describe(
						'Also run Sound Check on the new proposal (sound_check {proposalId}): what it fixes and introduces, per item (default false)',
					),
				timeoutSeconds: z
					.number()
					.int()
					.min(1)
					.max(900)
					.optional()
					.describe('Wait for the plan (default 300; the check waits as long again)'),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			let range: { start: number; end: number } | undefined;
			if (a.range) {
				range = { start: frameOf(seq, a.range.start), end: frameOf(seq, a.range.end) };
				if (range.end <= range.start)
					throw new ToolError(
						'E_INVALID_PARAM',
						`range.end (${range.end}) must be after range.start (${range.start})`,
						TIME_FORMATS,
					);
			}
			const job = await ctx.engine((c) =>
				c.planSoundDesign(
					{
						projectId: a.projectId,
						sequenceId: seq.id,
						...(range ? { range } : {}),
						...(a.cues ? { cues: a.cues } : {}),
						...(a.style ? { style: a.style } : {}),
						...(a.maxCues ? { maxCues: a.maxCues } : {}),
						...(a.label ? { label: a.label } : {}),
					},
					extra.signal,
				),
			);
			await cancelIfAborted(ctx, extra, job.id);
			const { job: done, timedOut } = await waitJob(ctx, job.id, (a.timeoutSeconds ?? 300) * 1000, extra);
			if (timedOut)
				return jsonResult({
					jobId: done.id,
					state: done.state,
					progress: done.progress,
					...(done.stage ? { stage: done.stage } : {}),
					next: `The plan is still running: wait_for_job {jobId: "${done.id}"}; its result names the proposal.`,
				});
			if (done.state !== 'succeeded')
				throw new ToolError(
					done.error?.code ?? 'JOB_FAILED',
					done.error?.message ?? `The plan ${done.state}`,
					'Check the project (get_project), the sound library (sound_library_status) and the arguments, then plan again.',
				);
			const r = SoundDesignPlanResultSchema.parse(done.result);
			const rep = r.report;
			// P6-E5: the new proposal's Sound Check (nothing applied), when asked
			let soundCheck: Record<string, unknown> | null = null;
			let checkNext: string | null = null;
			if (a.check && r.proposalId) {
				const cj = await ctx.engine((c) =>
					c.soundCheck(
						{ projectId: a.projectId, sequenceId: r.sequenceId, proposalId: r.proposalId! },
						extra.signal,
					),
				);
				await cancelIfAborted(ctx, extra, cj.id);
				const w = await waitJob(ctx, cj.id, (a.timeoutSeconds ?? 300) * 1000, extra);
				const parsed = w.job.state === 'succeeded' ? SoundCheckResultSchema.safeParse(w.job.result) : null;
				if (parsed?.success && parsed.data.proposal) {
					soundCheck = proposalCheckSummary(parsed.data.proposal);
					checkNext = proposalCheckNext(parsed.data.proposal);
				} else
					soundCheck = {
						jobId: cj.id,
						state: w.job.state,
						...(w.job.error ? { error: w.job.error } : {}),
						note: w.timedOut
							? `The check is still running: wait_for_job {jobId: "${cj.id}"}, then get_proposal shows it.`
							: 'The check did not finish: run sound_check {projectId, proposalId} before asking for review.',
					};
			}
			const table = [
				'item | timecode | cue | sound | role | align | alternates | gain | mix',
				...rep.events.map(
					(e) =>
						`${e.itemId} | ${e.timecode} | ${e.kind} ${e.weight} | ${[e.sound.title, ...e.extraLayers.map((l) => l.title)].join(' + ')}${e.sound.source === 'synth' ? ' (synth)' : ''} | ${e.role} | ${e.align} | ${e.alternatives.length} | ${e.level?.reason ?? 'default level'} | ${[e.stopBeforeItemId, e.buildItemId].filter(Boolean).join(', ') || '—'}`,
				),
			].join('\n');
			return jsonResult({
				proposalId: r.proposalId,
				sequenceId: r.sequenceId,
				items: r.itemCount,
				counts: r.counts,
				...(r.invalid.length ? { invalid: r.invalid } : {}),
				placed: rep.counts.placed,
				newCues: rep.counts.newCues,
				sounds: rep.counts.sounds,
				seed: rep.seed,
				density: rep.density,
				table,
				events: rep.events.map((e) => ({
					itemId: e.itemId,
					timecode: e.timecode,
					frame: e.frame,
					kind: e.kind,
					soundId: e.sound.soundId,
					title: e.sound.title,
					license: e.sound.license,
					role: e.role,
					align: e.align,
					why: e.why,
					alternatives: e.alternatives.map((x) => ({ soundId: x.soundId, title: x.title })),
					...(e.extraLayers.length
						? {
								layers: e.extraLayers.map((x, k) => {
									const l = e.layerLevels?.[k];
									return {
										soundId: x.soundId,
										title: x.title,
										...(l ? { gainDb: l.gainDb, limitedBy: l.limitedBy } : {}),
									};
								}),
							}
						: {}),
					...(e.notes.length ? { notes: e.notes } : {}),
					...(e.level
						? {
								gainDb: e.level.gainDb,
								targetLiftDb: e.level.targetLiftDb,
								achievedLiftDb: e.level.achievedLiftDb,
								limitedBy: e.level.limitedBy,
							}
						: {}),
					...(e.stopBeforeItemId ? { stopBeforeItemId: e.stopBeforeItemId } : {}),
					...(e.buildItemId ? { buildItemId: e.buildItemId } : {}),
				})),
				...(rep.conflicts?.length ? { conflicts: rep.conflicts } : {}),
				...(rep.levels ? { levels: rep.levels } : {}),
				...(rep.mix ? { mix: rep.mix } : {}),
				skipped: rep.skipped.map((s) => ({
					timecode: s.timecode,
					kind: s.kind,
					code: s.code,
					reason: s.reason,
				})),
				...(rep.counts.skipped > rep.skipped.length ? { skippedTotal: rep.counts.skipped } : {}),
				...(rep.warnings.length ? { warnings: rep.warnings } : {}),
				...(a.check ? { soundCheck } : {}),
				next: r.proposalId
					? `Nothing was applied. ${checkNext ? `${checkNext} ` : 'Run sound_check {projectId, proposalId} on it (what it fixes and introduces, per item) before handing it over. '}Ask the user to review proposal ${r.proposalId} in the editor (Review panel: hear each sound in context, keep or reject it, swap alternates, leave notes, apply as one undo step), then call wait_for_proposal {projectId, proposalId} and read their decisions and notes. Do not accept it yourself unless the user asked you to apply it. You cannot hear: give the user the timecodes to listen to.`
					: 'No cue got a sound (see skipped and warnings): nothing was stored.',
			});
		},
	);
}

const fmtGain = (x: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(Math.round(x * 10) / 10)}`;

/** rebalance_sfx: the engine's rebalance job (masking solver against the bed) → a report, a proposal or one applied edit. */
function registerRebalanceSfx(ctx: ToolContext): void {
	defineTool(
		ctx,
		'rebalance_sfx',
		{
			title: 'Rebalance SFX levels (masking solver)',
			description: `Sets the gains of a sequence's sound effects so each clears the BED (dialogue, music, ambience: everything that is not a sound effect, plus the sound effects of a lower weight playing under it: an ambience under a support or hero, a support under a hero — never the layers of one cue or sounds of the same weight) by its role's target lift in its dominant octave band — hero +5, support +3.5, ambient +2 dB — under ordered safety constraints: the gain range −30…+12 dB, a peak over the local bed of at most +10 LU (hero) / +6 LU, a support within 0.15 s of a hero × 0.6, repeats within ±2 dB, no more than +1 dB in 1–4 kHz during speech (transcript words or voice activity of dialogue clips, where the mix lets it through: a muted or ducked-out stretch is not speech), and the delivery's true-peak ceiling — for each sound and for the sounds that overlap together (they share it: "limited by the sounds overlapping it"). The engine renders the bed only around the cues and each sound alone, measures, solves and returns a table: clip | timecode | sound | role | from → gain | target | achieved | limited by | why ("−3 dB, limited by dialogue A1"), plus conflicts (the earlier, safety constraint kept) and skipped clips. mode "propose" (default) stores a proposal with one item per changed clip for the user to review in the editor; mode "apply" applies every change as ONE undo step "Rebalance SFX Levels" (only when the user asked you to). Gains set by hand are kept unless userGains "replace" or you name the clips. Solving again without changes changes nothing (idempotent). If the mix changes while it measures or before its change lands (the user moves a fader, raises the music, adds a sound, relinks media), mode "apply" applies nothing and fails with CONFLICT (retryable): run it again. Sound effects = clips typed SFX in Essential Sound or placed by sound design. Waits for the job (timeoutSeconds, default 300).`,
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				clipIds: z
					.array(z.string().min(1).max(128))
					.min(1)
					.max(2000)
					.optional()
					.describe('Only these sound effect clips (default every sound effect of the sequence)'),
				range: z
					.object({ start: TimeInputSchema, end: TimeInputSchema })
					.optional()
					.describe(`Only sound effects overlapping [start, end). ${TIME_FORMATS}`),
				delivery: z
					.enum(SOUND_DELIVERIES)
					.optional()
					.describe('Loudness / true-peak preset (default the sequence’s: web −14 LUFS −1 dBTP…)'),
				mode: z
					.enum(['propose', 'apply'])
					.optional()
					.describe('"propose" (default): a proposal to review; "apply": one undoable edit'),
				userGains: z
					.enum(['keep', 'replace'])
					.optional()
					.describe('Gains set by hand: keep (default) or solve them too'),
				label: z.string().min(1).max(200).optional().describe('Proposal title'),
				autoGain: z
					.literal(true)
					.optional()
					.describe(
						'Essential Sound ▸ Auto gain on for clipIds (mode "apply" only): the same undo step also hands those clips back to Auto gain, also the ones the solve leaves unchanged or cannot measure',
					),
				timeoutSeconds: z
					.number()
					.int()
					.min(1)
					.max(900)
					.optional()
					.describe('Wait for the job (default 300)'),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) => {
			if (a.autoGain && (a.mode !== 'apply' || !a.clipIds?.length))
				throw new ToolError(
					'E_INVALID_PARAM',
					'autoGain needs mode "apply" and clipIds',
					'Name the clips to hand back to Auto gain and pass mode "apply" (only when the user asked you to apply).',
				);
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			let range: { start: number; end: number } | undefined;
			if (a.range) {
				range = { start: frameOf(seq, a.range.start), end: frameOf(seq, a.range.end) };
				if (range.end <= range.start)
					throw new ToolError(
						'E_INVALID_PARAM',
						`range.end (${range.end}) must be after range.start (${range.start})`,
						TIME_FORMATS,
					);
			}
			const job = await ctx.engine((c) =>
				c.rebalanceSfx(
					{
						projectId: a.projectId,
						sequenceId: seq.id,
						...(a.clipIds ? { clipIds: a.clipIds } : {}),
						...(range ? { range } : {}),
						...(a.delivery ? { delivery: a.delivery } : {}),
						mode: a.mode ?? 'propose',
						...(a.userGains ? { userGains: a.userGains } : {}),
						...(a.label ? { label: a.label } : {}),
						...(a.autoGain ? { autoGain: true as const } : {}),
					},
					extra.signal,
				),
			);
			await cancelIfAborted(ctx, extra, job.id);
			const { job: done, timedOut } = await waitJob(ctx, job.id, (a.timeoutSeconds ?? 300) * 1000, extra);
			if (timedOut)
				return jsonResult({
					jobId: done.id,
					state: done.state,
					progress: done.progress,
					...(done.stage ? { stage: done.stage } : {}),
					next: `The rebalance is still running: wait_for_job {jobId: "${done.id}"}.`,
				});
			if (done.state !== 'succeeded')
				throw new ToolError(
					done.error?.code ?? 'JOB_FAILED',
					done.error?.message ?? `The rebalance ${done.state}`,
					'Check the clip ids (get_timeline), that the media is online (list_offline_media) and the arguments, then try again.',
				);
			const r = SfxRebalanceResultSchema.parse(done.result);
			const rep = r.report;
			const table = [
				'clip | timecode | sound | role | gain dB (from → to) | target | achieved | limited by | why',
				...rep.events.map(
					(e) =>
						`${e.clipId} | ${e.timecode} | ${e.title} (${e.track}) | ${e.role ?? e.weight} | ${fmtGain(e.fromDb)} → ${fmtGain(e.gainDb)} | ${fmtGain(e.targetLiftDb)} | ${e.achievedLiftDb === null ? 'silent' : fmtGain(e.achievedLiftDb)} | ${e.limitedBy.join(', ') || '—'} | ${e.reason}`,
				),
			].join('\n');
			return jsonResult({
				mode: r.mode,
				applied: r.applied,
				proposalId: r.proposalId,
				revision: r.revision,
				counts: rep.counts,
				table,
				...(rep.skipped.length ? { skipped: rep.skipped } : {}),
				...(rep.conflicts.length ? { conflicts: rep.conflicts } : {}),
				...(rep.warnings.length ? { warnings: rep.warnings } : {}),
				...(r.autoGain ? { autoGain: r.autoGain } : {}),
				levels: rep.levels,
				next: r.proposalId
					? `Nothing was changed. Ask the user to review proposal ${r.proposalId} in the editor (Review panel), then wait_for_proposal. You cannot hear: give them the timecodes of the limited events to listen to.`
					: r.applied
						? 'Applied as one undo step "Rebalance SFX Levels". You cannot hear: give the user the timecodes of the limited events to listen to; sound_check / measure_loudness measure the mix.'
						: 'Nothing to change: every sound effect is already at its solved gain (or none was solved: see skipped).',
			});
		},
	);
}

/** apply_delivery and set_room_glue (Phase 4 WP4.2a: spec 12 §2.4 delivery presets and room glue). */
function registerMixTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'apply_delivery',
		{
			title: 'Apply a loudness delivery preset',
			description: `Mixes a sequence to a delivery preset — web −14 LUFS / −1 dBTP, podcast −16 / −1, broadcast-r128 −23 / −1, atsc-a85 −24 / −2 — with ordinary edits: the Mix's loudness normalisation at the preset (the export measures the final mix and limits the true peak), Essential Sound Auto-Match by type (dialogue at the target, music 8 LU and ambience 10 LU under it; music at the target when there is no dialogue; clips without a type and sound effects are left alone), music and ambience ducked under their "Duck against" clips (dialogue by default, with each clip's fades; a Ducking amount the user set is kept, a type default becomes the delivery's 6 dB on top of the match — music ≈ 14 LU, ambience ≈ 16 LU under the voice during speech — and is written into the clip's Ducking), stop-before dips on ducked clips written again, default sound-effect levels moved to the preset, and the sound effects solved again against the new bed (rebalance). The engine measures every clip, the speech and the resulting mix and reports how far under the voice the music and ambience are during speech (targets ≥ 8 / ≥ 10 LU) and the loudness the export will deliver. The sound effects' solve is reported like rebalance_sfx's: each gain item's why-line and limitedBy, conflicts (the earlier, safety constraint kept) and the solver's warnings (W_DIALOGUE_BAND: a sound too bright for the speech under it, naming the types here whose dominant band is outside 1–4 kHz; W_UNRESOLVED). mode "propose" (default) stores a proposal (a delivery item, then one item per sound-effect gain) for the user to review; "apply" applies everything as ONE undo step "Apply Delivery Preset" (only when the user asked you to); if the mix changes while it measures or before its change lands, nothing is applied and it fails with CONFLICT (retryable): run it again. Waits for the job (timeoutSeconds, default 300).`,
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				delivery: z.enum(SOUND_DELIVERIES).describe('web | podcast | broadcast-r128 | atsc-a85'),
				mode: z
					.enum(['propose', 'apply'])
					.optional()
					.describe('"propose" (default): a proposal to review; "apply": one undoable edit'),
				loudness: z.boolean().optional().describe('Mix loudness normalisation at the preset (default true)'),
				autoMatch: z
					.boolean()
					.optional()
					.describe('Auto-Match dialogue / music / ambience by type (default true)'),
				ducking: z.boolean().optional().describe('Duck music and ambience under dialogue (default true)'),
				rebalance: z.boolean().optional().describe('Solve the sound effects again (default true)'),
				label: z.string().min(1).max(200).optional().describe('Proposal title'),
				timeoutSeconds: z
					.number()
					.int()
					.min(1)
					.max(900)
					.optional()
					.describe('Wait for the job (default 300)'),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			const job = await ctx.engine((c) =>
				c.applyDelivery(
					{
						projectId: a.projectId,
						sequenceId: seq.id,
						delivery: a.delivery,
						mode: a.mode ?? 'propose',
						...(a.loudness !== undefined ? { loudness: a.loudness } : {}),
						...(a.autoMatch !== undefined ? { autoMatch: a.autoMatch } : {}),
						...(a.ducking !== undefined ? { ducking: a.ducking } : {}),
						...(a.rebalance !== undefined ? { rebalance: a.rebalance } : {}),
						...(a.label ? { label: a.label } : {}),
					},
					extra.signal,
				),
			);
			await cancelIfAborted(ctx, extra, job.id);
			const { job: done, timedOut } = await waitJob(ctx, job.id, (a.timeoutSeconds ?? 300) * 1000, extra);
			if (timedOut)
				return jsonResult({
					jobId: done.id,
					state: done.state,
					progress: done.progress,
					...(done.stage ? { stage: done.stage } : {}),
					next: `The delivery is still running: wait_for_job {jobId: "${done.id}"}.`,
				});
			if (done.state !== 'succeeded')
				throw new ToolError(
					done.error?.code ?? 'JOB_FAILED',
					done.error?.message ?? `The delivery ${done.state}`,
					'Check that the media is online (list_offline_media) and the clips have audio types (set_essential_sound), then try again.',
				);
			const r = SoundDeliveryResultSchema.parse(done.result);
			const rep = r.report;
			const lufs = (x: number | null) => (x === null ? '—' : `${fmtGain(x)} LUFS`);
			const table = [
				'clip | track | type | measured | target | Auto-Match gain',
				...rep.clips.map(
					(c) =>
						`${c.clipId} | ${c.track} | ${c.type} | ${lufs(c.measuredLufs)} | ${lufs(c.targetLufs)} | ${c.gainDb === null ? (c.skipped ?? '—') : `${fmtGain(c.gainDb)} dB`}`,
				),
			].join('\n');
			const m = rep.measure;
			return jsonResult({
				mode: r.mode,
				applied: r.applied,
				proposalId: r.proposalId,
				revision: r.revision,
				delivery: rep.delivery,
				preset: rep.preset,
				table,
				ducking: rep.ducking,
				...(rep.sfx ? { sfx: rep.sfx } : {}),
				...(rep.conflicts?.length ? { conflicts: rep.conflicts } : {}),
				...(m ? { measure: m } : {}),
				...(rep.warnings.length ? { warnings: rep.warnings } : {}),
				next: r.proposalId
					? `Nothing was changed. Ask the user to review proposal ${r.proposalId} in the editor (Review panel), then wait_for_proposal. You cannot hear: tell them the measured numbers, not that it "sounds right".`
					: `Applied as one undo step "Apply Delivery Preset". The export normalises to ${rep.preset.integratedLufs} LUFS and limits the true peak to ${rep.preset.truePeakDb} dBTP; measure an export (measure_loudness) to confirm, and give the user the timecodes of the ducked passages to listen to.`,
			});
		},
	);

	defineTool(
		ctx,
		'set_room_glue',
		{
			title: 'Room glue (shared SFX reverb)',
			description:
				'Puts the sound effects in one shared space (spec 12 §2.4 "Room glue"): an "SFX Room" submix with a Studio Reverb (decay 0.6 s, mix 100 %, pre-delay 8 ms) and post-fader sends at −16 dB from the sound-effect tracks. Tracks whose sound effects are all interface sounds (ui, click, key, tick) stay dry, and tracks that also play dialogue, music or ambience get no send (sends are per track) unless named in sfxTracks. Run again it updates the levels, adds missing sends and removes its own sends from tracks that no longer qualify (idempotent); sounds placed later on new SFX tracks get their send automatically. enabled: false removes its sends and the submix it made. One undo step. The room return counts as each sound effect’s own contribution when rebalance_sfx measures it.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				enabled: z.boolean().optional().describe('false removes the glue (default true)'),
				sendDb: z.number().min(-96).max(15).optional().describe('Send level, dB (default −16)'),
				decay: z.number().min(0.1).max(20).optional().describe('Reverb RT60, s (default 0.6)'),
				mix: z.number().min(0).max(100).optional().describe('Reverb mix, % (default 100)'),
				preDelayMs: z.number().min(0).max(200).optional().describe('Pre-delay, ms (default 8)'),
				sfxTracks: z
					.array(z.string().min(1).max(128))
					.max(64)
					.optional()
					.describe('Exactly these tracks ("A3" or ids) instead of the automatic choice'),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			const off = a.enabled === false;
			const roomGlue = {
				...(a.sendDb !== undefined ? { sendDb: a.sendDb } : {}),
				...(a.decay !== undefined ? { decay: a.decay } : {}),
				...(a.mix !== undefined ? { mix: a.mix } : {}),
				...(a.preDelayMs !== undefined ? { preDelayMs: a.preDelayMs } : {}),
			};
			const command = off
				? { type: 'soundDesign.removeBus', sequenceId: seq.id }
				: {
						type: 'soundDesign.ensureBus',
						sequenceId: seq.id,
						...(Object.keys(roomGlue).length ? { roomGlue } : {}),
						...(a.sfxTracks ? { sfxTracks: a.sfxTracks } : {}),
					};
			const res = await transact(
				ctx,
				a.projectId,
				{
					label: off ? 'Remove SFX Room Glue' : 'SFX Room Glue',
					commands: [command],
					sequenceId: seq.id,
				},
				extra,
			);
			const r = requireOk(res);
			return jsonResult({
				...txBody(res, r),
				...(r.results[0] as Record<string, unknown>),
				next: off
					? 'The room glue is removed (one undo step).'
					: 'Done (one undo step). Re-run rebalance_sfx: the room return now counts in each sound effect’s level.',
			});
		},
	);
}
