// Sound design cue tools (spec 12 §2.10, Phase 2: P2-R6; wp-note "WP2.3 cue route & MCP tools"): find cue points in
// the edit, store and edit cues, place library sounds on them peak-aligned (layers, alternates, a type picked with
// seeded rotation), swap a placed sound (explicitly or cycling its alternates) and re-align a clip's peak.
// Cue derivation runs on the engine (`POST /api/sound-design/cues`: it has the motion-graphic template registry),
// placement and swaps are ordinary undoable commands (`soundCue.*`, `soundDesign.place`, `soundDesign.swap`).
import type {
	RegisterSoundResponse,
	SoundCueSuggestion,
	SoundCuesResponse,
	SoundEntry,
	SoundSearchResponse,
} from '@jasper/api';
import {
	type AudioClip,
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
	SOUND_DESIGN_LIMITS,
	SOUND_LABELS,
	SOUND_TYPES,
	type SoundCue,
	type SoundTypeId,
	sequenceDialogueRanges,
	sequenceTimecode,
	soundCueFields,
	soundCuesOf,
	soundDesignSettingsOf,
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
	defineTool,
	EDIT,
	type Extra,
	frameOf,
	loadDoc,
	READ_ONLY,
	requireOk,
	type ToolContext,
	transact,
	txBody,
} from '../context.ts';
import { toolEnvelope } from '../envelope.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { pickSequence } from '../format.ts';
import { livePlayhead } from './color.ts';
import { importCommands, type Registered, resolveAudioTrack, SoundIdArg, soundCall } from './sound.ts';

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
			return `scene cut at ${a.mediaSec} s of ${name}`;
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
});
type CueAdd = z.infer<typeof CueAddArg>;

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
	defineTool(
		ctx,
		'find_sound_cues',
		{
			title: 'Find sound cues',
			description: `Derives cue suggestions — moments of the picture that may want a sound — from the edit itself (engine \`deriveCues\`): cuts (none where dialogue is heard unless respectDialogue: false), transitions (push/slide → whoosh with a pan sweep), keyframed motion (move at peak speed, land on an overshoot or abrupt stop, appear/exit on fades and scale-ups, emphasis on a pulse), text animators and typewriters (one key per typed unit, ≤ 12/s), motion-graphic intro ends and outro starts, graphics on V2+, 3D camera moves and markers named "sfx: <type>[+<type>]". Merged within 2 frames and thinned by the density budget. Each cue: frame + timecode + seconds, kind, weight (hero/support/ambient), types (suggested, best first), align (peak/start/end), pan, panSweep, confidence, reason, anchor (+ anchorText), window, from (source), storedCueId (the stored cue for the same event, or null). Also per-source stats (found, kept, merged, droppedByBudget, suppressedByDialogue), dialogue ranges and warnings. Stores nothing: pass the cues you keep to set_sound_cues {add}. Sources: ${CUE_DERIVE_SOURCE_LIST}.`,
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
			const res = await soundCall<SoundCuesResponse>(ctx, (c) =>
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
							maxCues: a.maxCues ?? 500,
						},
					},
					extra.signal,
				),
			);
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
				'Adds, edits, removes and resyncs the sound cues of a sequence in ONE transaction (one undo step). add: find_sound_cues suggestions verbatim (their informational keys are accepted; a suggestion already stored, storedCueId set, is skipped) or manual cues {at | frame, kind (default manual), weight (default support), types, align, pan, reason…} (source agent). update: [{cueId, …fields}] (null clears an optional field; a new frame moves the cue’s placed sounds unless moveClips: false). remove: {cueIds, withClips?} (withClips also deletes their placed sounds; otherwise they stay, unlinked). resync: true (or {cueIds}) moves anchored cues and their sounds to where their picture events are now. Returns the new cue ids in add order.',
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
			if (a.add) parts.push(soundText(SOUND_LABELS.cuesAdd, a.add.length));
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
						const { at, frame, types, ...rest } = u;
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
			description: `Places 1–6 layers of sound on a stored cue (cueId) or at a time (at; a cue is created there unless createCue: false) so that each layer's aligned point lands EXACTLY on the cue frame: the peak for hits, booms, lands, whooshes; the end for risers and reverses; the start for UI blips (align auto, or say peak|start|end). Each layer is a library sound (soundId), a project media (mediaId) or a pick: sound {type, query?} chooses among the best-ranked sounds of that type (palette first), rotated so neighbouring cues differ, with the seeded ±2 % speed and ±1 dB variation. ONE undo step: imports the sounds into the "Sound Effects" bin, places one clip per layer on free SFX tracks (never over audio; a new "SFX n" when none is free), tags them Essential Sound ▸ SFX, groups the layers and links them to the cue. Gain: a layer's gainDb when given; otherwise its default level — the sound's loudest 400 ms to its role's momentary target at the sequence's delivery (web: hero −16, support −22, layer −24, beds −30 LUFS) under the role's true-peak ceiling (−6/−12/−16/−20 dBTP), within −30…+12 dB, so layered inserts stay under full scale (each clip's gainDb and level are returned). alternatives (1–3 soundIds) are stored on the clip for swap_sound "next"/"previous"; reason is recorded on the cue. Returns each clip with its track, start, aligned frame, peak frame and errorFlicks (0 = sample-exact), plus warnings (a hero under dialogue or within 0.5 s of another hero).`,
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
					const warnings: { code: string; message: string }[] = [];
					const weightHere = cue?.weight ?? a.weight ?? (a.layers[0]!.role === 'hero' ? 'hero' : 'support');
					const heroHere = weightHere === 'hero' || a.layers.some((l) => l.role === 'hero');
					if (heroHere) {
						const dialogue = sequenceDialogueRanges(doc, seq);
						if (dialogue.some(([s, e]) => frame >= s && frame < e))
							warnings.push({
								code: 'W_HERO_UNDER_DIALOGUE',
								message: `A hero sound at ${sequenceTimecode(seq, frame)} plays under spoken words: make it support, or move it.`,
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
					}
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
				'Replaces the sound of a placed clip with another library sound in ONE undo step, keeping where its aligned point (peak, start or end) plays, its track, role, pan, gain, effects, group and cue link (keyframes keep their times). to: a soundId, or "next" / "previous" to cycle: first the alternates given to place_sound, then sounds of the same family most similar to the original, then the most similar sounds of any family; the cycle keeps the sound first placed as its anchor across calls (a clip placed without alternates stores it on its first swap), so next / previous progress and come back to it. A candidate that does not fit on the clip’s track is skipped (listed in skipped). Returns the old and new sound, the position in the cycle and the aligned frame.',
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
			if (tries[0]!.soundId === current)
				throw new ToolError('E_INVALID_PARAM', `The clip already plays ${current}`, 'Pick another sound.');
			// A clip without a variation ring gets [the sound it plays now] in the same transaction: later calls cycle
			// around that anchor (it would otherwise be rebuilt around each new sound and alternate between two).
			const ring =
				!clip.sfx?.alternatives?.length && current && /^snd_[0-9a-f]{16}$/.test(current) ? [current] : null;
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
	const alts = (clip.sfx?.alternatives ?? []).filter((s) => /^snd_[0-9a-f]{16}$/.test(s));
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
	};
}
