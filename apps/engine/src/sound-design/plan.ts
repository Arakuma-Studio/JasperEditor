// The `sound-design` plan job (spec 12 §2.8, P3-R3; wp-note "Phase 3 → WP3.2"): cues → rank → register → place →
// PROPOSAL, deterministic by seed. Nothing is applied: the result is a proposal (feature `sound-design`) the user
// reviews in the editor (or an allowed agent accepts).
//   1. cues: the sequence's unfilled stored cues (or the ids asked for) and, with `cues: 'auto'`, cues derived from the
//      edit (`deriveCues` with the engine's template registry); a new derived cue becomes a setup item (`soundCue.add`);
//   2. rank: per cue, `rankSounds` with the cue's types, visual kind and window over the allowed sources, commercial-safe
//      licences only, the palette first; `pickVariant` rotates over the top 4 so neighbours differ (seeded ±2 % speed and
//      ±1 dB gain); the next 1–3 ranked sounds are the alternatives;
//   3. register: every chosen and alternative sound is registered for the project (files copied into managed media;
//      the `media.register` commands go into setup items, nothing is committed);
//   4. place: one item per cue, `soundDesign.place` (role from the weight, align / pan / pan sweep from the cue, gain left
//      to placement's default level), alternatives as command sets, `requires` linking it to its setup items;
//   5. the proposal is created through the proposals service (validated by dry runs on the live document).
// The selection (1–2) and the draft (4) are pure and exported for tests; the job does the I/O and reports progress.
// P6-E10 (wp-note "Phase 6 → WP-E6"): the cue grammar of `@jasper/project` `sound/grammar.ts` decides with the style
// (the request's over the sequence's `soundDesign.settings.style`): ui / click cues share ONE voice (the palette sound
// or the first placed, rate 1, 0 dB jitter, one solved level), key / tick / tap rotate takes at rate 1, runs of staggered
// pops / UI / chimes / ticks climb +1 st per step, fast typing gets one key per word, cuts the music carries are
// reported (`MUSIC_CARRIES_CUT`), the personality ranks and restricts types, and sounds sharing the dominant material
// of their family's placed sounds rank higher (palette coherence).
import { appendFile } from 'node:fs/promises';
import {
	mediaRegisterCommand,
	type RegisterSoundResponse,
	SOUND_DESIGN_PLAN_LIMITS,
	SOUND_EFFECTS_BIN,
	type SoundDesignPlanEvent,
	type SoundDesignPlanReport,
	type SoundDesignPlanRequest,
	SoundDesignPlanRequestSchema,
	type SoundDesignPlanResult,
	type SoundDesignPlanSkip,
	type SoundEntry,
	type SoundSourceType,
	type TimeSignature,
} from '@jasper/api';
import {
	type AudioClip,
	BUILD_DEFAULT,
	BUILD_MIN_MUSIC_SEC,
	bindExpressions,
	type ClipSfx,
	type CUE_ALIGNS,
	type CueDensity,
	type CueDeriveSource,
	cueInputFromDerived,
	type DerivedCue,
	defaultRegistries,
	deliveryPreset,
	deriveCues,
	documentHasActiveExpressions,
	ENGINE_CUE_SOURCES,
	type ExtraCue,
	flicksPerFrame,
	isSoundTypeId,
	type MgTemplateRegistry,
	fillTypeOf,
	findRuns,
	musicCovers,
	musicTracksUnder,
	type PaletteMaterials,
	type PlacedSound,
	paletteMaterials,
	personalityDensity,
	type ProjectDocument,
	type ProposalDraft,
	type ProposalItemInput,
	pickVariant,
	type RankedSound,
	type Rational,
	type ResolvedSoundStyle,
	ROOM_BUS_NAME,
	ROOM_GLUE_DEFAULT,
	rankSounds,
	rateOfSemitones,
	readLibraryProvenance,
	resolveSoundStyle,
	runReason,
	type SoundVariation,
	type Sequence,
	type SFX_ROLES,
	SOUND_DESIGN_FEATURE,
	SOUND_DESIGN_LIMITS,
	SOUND_PROPOSAL_SETUP_GROUP,
	SOUND_TYPES,
	type SoundCue,
	type SoundDelivery,
	type SoundDesignMix,
	type SoundProposalMedia,
	type SoundProposalPlacement,
	type SoundTypeId,
	STOP_BEFORE_DEFAULT,
	sequenceDialogueRanges,
	sequenceTimecode,
	soundCuesOf,
	soundDesignSettingsOf,
	soundProposalItems,
	stopBeforeDip,
	styleCueTypes,
	typesForVisualKind,
	VISUAL_KINDS,
	type VisualKind,
	type VoiceActivity,
	variationOfType,
	voiceFor,
} from '@jasper/project';
import type { AgentService } from '../agent/service.ts';
import type { JobContext } from '../jobs/types.ts';
import { JobError } from '../jobs/types.ts';
import type { MediaRegistry } from '../media/registry.ts';
import type { ProposalService, Requester } from '../proposals/service.ts';
import type { SoundService } from '../sounds/service.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { HttpError } from '../tools/reply.ts';
import type { MeasureCache } from './bed.ts';
import type { EngineCueSource, EngineCueSources } from './engine-cues.ts';
import { matchStoredCues } from './match.ts';
import { planPreviewDocument, solvePlanGains } from './plan-levels.ts';
import { voiceServiceFor } from './voice.ts';

type CueKind = SoundCue['kind'];
type CueWeight = SoundCue['weight'];
type CueAlign = (typeof CUE_ALIGNS)[number];
type Role = (typeof SFX_ROLES)[number];

/** Sounds registered at once (each probes and may copy the file: mostly waiting for ffmpeg). */
const REGISTER_CONCURRENCY = 3;
/** Candidates ranked per cue (the rotation looks at the top 4; alternatives follow the pick). */
const RANKED_PER_CUE = 12;
/** Derived cues this close (frames) to a stored cue are left to the stored one. */
const NEAR_STORED_FRAMES = 2;
/** Layers of one placement (`soundDesign.place`). */
const MAX_LAYERS = SOUND_DESIGN_LIMITS.layers;
/** Never two heroes within this (spec 12 §2.10 SOUND_GUIDE). */
const HERO_MIN_SEC = 0.5;
/** A report larger than this drops the score parts (the proposal's report must stay under 1 MB). */
const REPORT_SOFT_BYTES = 900 * 1024;
/** Semitones of a run's climb carried by the clip's pitch (its varispeed range); the rest goes into the base rate. */
const VARISPEED_RUN_PITCH_MAX = 3;

/** A cue the plan considers. */
export type PlanCue = {
	/** The stored cue, or null for a derived one. */
	stored: SoundCue | null;
	derived: DerivedCue | null;
	frame: number;
	kind: CueKind;
	weight: CueWeight;
	types: SoundTypeId[];
	align: CueAlign | null;
	reason: string;
	windowFrames: number | null;
	/** Key of the rotation and variation hash: the cue id, or `derived:<key>`. */
	key: string;
	/** A marker cue naming several types: one layer per type. */
	layered: boolean;
};

export type PlanStyle = {
	density: CueDensity;
	respectDialogue: boolean;
	seed: number;
	sources: SoundSourceType[];
	palette: string[];
	alternatives: number;
	maxCues: number;
	/** Phase 4 (WP4.2a): room glue send level, or null for none. */
	roomGlue: { sendDb: number } | null;
	/** Phase 4: a stop-before dip for heroes with music under them. */
	stopBefore: boolean;
	/** Phase 4: a High Pass build for heroes after ≥ 2 s of music. */
	build: boolean;
	/** Phase 4: a delivery preset as a setup item (null: none). */
	delivery: SoundDelivery | null;
	/** Sources of derived cues (undefined: every source). */
	cueSources?: CueDeriveSource[];
	/** Snap derived moves, transitions, emphases and reveals to the music's beats (≤ 2 frames). */
	snapToBeats?: boolean;
	/** Metre of the music's downbeats (absent: auto, 3 or 4 detected). */
	timeSignature?: TimeSignature;
	/** P6-E10: the cue grammar and personality (the request's style over the sequence's, then the defaults). */
	grammar: ResolvedSoundStyle;
};

/** The music dip under a typing run (style `duckUnderTyping`): music clips and the dip's floor (sequence flicks). */
export type PlanDuck = { clipIds: string[]; start: number; end: number; firstFrame: number; lastFrame: number };

/** Depth and fades of the dip under typing (P6-E10: "an optional 6 dB dip"). */
export const TYPING_DUCK = { depthDb: -6, fadeMs: 80, tailSec: 0.15 } as const;

export type PlanPick = {
	cue: PlanCue;
	role: Role;
	align: CueAlign;
	/** Layer 0: the chosen sound first, then the alternatives (ranked order). */
	sounds: RankedSound<SoundEntry>[];
	rate: number;
	gainOffsetDb: number;
	/** Further layers (a marker naming several types), each with its own seeded variation. */
	extraLayers: { sound: RankedSound<SoundEntry>; rate: number; gainOffsetDb: number }[];
	notes: string[];
	/** P6-E10: the variation policy of layer 0's type. */
	variation?: SoundVariation;
	/** P6-E10: layer 0 is the one voice of its type (ui / click). */
	voice?: { type: SoundTypeId; soundId: string };
	/** P6-E10: semitones of a run's climb (|st| ≤ 3 as the layer's pitch, the rest in `rate`). */
	pitchSt?: number;
	/** P6-E10: the run step of a climbing (or flat) run. */
	run?: { group: string; index: number; of: number; st: number };
	/** P6-E10: the music dip under the typing run this cue starts (style `duckUnderTyping`). */
	duck?: PlanDuck;
};

const ALL_SOURCES: SoundSourceType[] = ['starter', 'pack', 'folder', 'synth'];

/** The style with its defaults from the request and the sequence's settings. */
export function resolveStyle(req: SoundDesignPlanRequest, seq: Sequence): PlanStyle {
	const settings = soundDesignSettingsOf(seq);
	const st = req.style ?? {};
	const palette =
		st.palette === undefined || st.palette === 'project' ? (settings.palette ?? []) : st.palette;
	const grammar = resolveSoundStyle(
		{
			...(st.personality ? { personality: st.personality } : {}),
			...(st.runs ? { runs: st.runs } : {}),
			...(st.typing ? { typing: st.typing } : {}),
			...(st.musicCarriesCuts !== undefined ? { musicCarriesCuts: st.musicCarriesCuts } : {}),
			...(st.duckUnderTyping !== undefined ? { duckUnderTyping: st.duckUnderTyping } : {}),
		},
		settings.style,
	);
	return {
		grammar,
		// a personality named by the request brings its default density (the sequence's own density otherwise)
		density: st.density ?? (st.personality ? personalityDensity(st.personality, settings.density) : settings.density),
		respectDialogue: st.respectDialogue ?? true,
		seed: st.seed ?? settings.seed,
		sources: st.sources?.length ? [...new Set(st.sources)] : ALL_SOURCES,
		palette: [...new Set(palette)],
		alternatives: st.alternatives ?? SOUND_DESIGN_PLAN_LIMITS.maxAlternatives,
		maxCues: req.maxCues ?? SOUND_DESIGN_PLAN_LIMITS.maxCues,
		roomGlue:
			st.roomGlue === undefined || st.roomGlue === false
				? null
				: { sendDb: (st.roomGlue === true ? undefined : st.roomGlue.sendDb) ?? ROOM_GLUE_DEFAULT.sendDb },
		stopBefore: st.stopBefore ?? false,
		build: st.build ?? false,
		delivery: st.delivery ?? null,
		...(st.cueSources?.length ? { cueSources: [...new Set(st.cueSources)] } : {}),
		...(st.snapToBeats ? { snapToBeats: true } : {}),
		...(st.timeSignature !== undefined && st.timeSignature !== 'auto'
			? { timeSignature: st.timeSignature }
			: {}),
	};
}

/** Item ids of the Phase 4 setup items. */
export const ROOM_ITEM_ID = 'room';
export const DELIVERY_ITEM_ID = 'delivery';

/**
 * The room glue setup item of a plan (style `roomGlue`), or null when there is none to make: the sequence already has
 * the glue at that send level. Pure.
 */
export function roomSetupItem(seq: Sequence, style: PlanStyle): ProposalItemInput | null {
	if (!style.roomGlue) return null;
	const rec = (seq.soundDesign as { mix?: SoundDesignMix } | undefined)?.mix?.room;
	if (rec && (seq.submixTracks ?? []).some((t) => t.id === rec.busId) && rec.sendDb === style.roomGlue.sendDb)
		return null;
	return {
		id: ROOM_ITEM_ID,
		label: `${ROOM_BUS_NAME}: shared reverb, sends at ${style.roomGlue.sendDb} dB`,
		group: SOUND_PROPOSAL_SETUP_GROUP,
		commands: [
			{ type: 'soundDesign.ensureBus', sequenceId: seq.id, roomGlue: { sendDb: style.roomGlue.sendDb } },
		],
		meta: {
			setup: true,
			kind: 'room',
			why: `One "${ROOM_BUS_NAME}" reverb (decay ${ROOM_GLUE_DEFAULT.decay} s, pre-delay ${ROOM_GLUE_DEFAULT.preDelayMs} ms) the sound effects share, so they sit in one space; interface sounds stay dry`,
		},
	};
}

/**
 * The Phase 4 items that act on a placed cue (style `stopBefore` / `build`, or the cue's own stored `stopBefore` /
 * `build` not yet realised): a stop-before dip for a hero with music under it, a build for a hero after ≥ 2 s of music.
 * Pure.
 */
export function cueMixItems(
	seq: Sequence,
	pick: Pick<PlanPick, 'cue' | 'role'>,
	style: Pick<PlanStyle, 'stopBefore' | 'build'>,
	itemNo: string,
	tc: string,
): {
	stop: NonNullable<SoundProposalPlacement['after']>[number] | null;
	build: NonNullable<SoundProposalPlacement['after']>[number] | null;
} {
	const rate = seq.settings.frameRate as Rational;
	const fps = fpsOf(seq);
	const frame = pick.cue.frame;
	const stored = pick.cue.stored;
	const realised = stored
		? (seq.soundDesign as { mix?: SoundDesignMix } | undefined)?.mix?.cues?.[stored.id]
		: undefined;
	let stop: ReturnType<typeof cueMixItems>['stop'] = null;
	const ownStop = stored?.stopBefore;
	if ((ownStop || (style.stopBefore && pick.role === 'hero')) && !realised?.stopBefore) {
		const spec = ownStop ?? STOP_BEFORE_DEFAULT;
		const dip = stopBeforeDip(frame, spec, rate);
		const F = flicksPerFrame(rate);
		if (dip) {
			const a = Math.max(0, Math.floor((dip.start - (dip.fadeMs * F * fps) / 1000) / F));
			const b = Math.ceil((dip.end + (dip.fadeMs * F * fps) / 1000) / F);
			if (musicTracksUnder(seq, a, b).length)
				stop = {
					id: `stop:${itemNo}`,
					label: `Stop before ${tc}: music ${spec.depthDb} dB for ${spec.seconds} s`,
					group: 'mix',
					meta: {
						feature: SOUND_DESIGN_FEATURE,
						kind: 'stopBefore',
						frame,
						timecode: tc,
						stopBefore: { seconds: spec.seconds, depthDb: spec.depthDb },
						why: `The music drops ${-spec.depthDb} dB for ${spec.seconds} s before the hit at ${tc}, so it lands in a gap`,
					},
					commands: (cueId) => [
						...(ownStop
							? []
							: [
									{
										type: 'soundCue.update',
										cueId,
										stopBefore: { seconds: spec.seconds, depthDb: spec.depthDb },
									},
								]),
						{ type: 'soundDesign.applyStopBefore', cueId },
					],
				};
		}
	}
	let build: ReturnType<typeof cueMixItems>['build'] = null;
	const ownBuild = stored?.build;
	if ((ownBuild || (style.build && pick.role === 'hero')) && !realised?.build) {
		const spec = ownBuild ?? BUILD_DEFAULT;
		const lead = Math.ceil(Math.max(BUILD_MIN_MUSIC_SEC, spec.seconds) * fps);
		if (frame - lead >= 0 && musicCovers(seq, frame - lead, frame))
			build = {
				id: `build:${itemNo}`,
				label: `Build into ${tc}: high-pass ${spec.fromHz} → ${spec.toHz} Hz over ${spec.seconds} s`,
				group: 'mix',
				meta: {
					feature: SOUND_DESIGN_FEATURE,
					kind: 'build',
					frame,
					timecode: tc,
					build: { seconds: spec.seconds, fromHz: spec.fromHz, toHz: spec.toHz },
					why: `The music thins out (high-pass ${spec.fromHz} → ${spec.toHz} Hz) over ${spec.seconds} s and comes back full on the hit at ${tc}`,
				},
				commands: (cueId) => [
					...(ownBuild
						? []
						: [
								{
									type: 'soundCue.update',
									cueId,
									build: { seconds: spec.seconds, fromHz: spec.fromHz, toHz: spec.toHz },
								},
							]),
					{ type: 'soundDesign.applyBuild', cueId },
				],
			};
	}
	return { stop, build };
}

const fpsOf = (seq: Sequence) => {
	const r = seq.settings.frameRate as Rational;
	const fps = r.num / r.den;
	return Number.isFinite(fps) && fps > 0 ? fps : 30;
};

function knownTypes(types: readonly unknown[] | undefined, kind: CueKind): SoundTypeId[] {
	const own = (types ?? []).filter(isSoundTypeId);
	if (own.length) return [...new Set(own)];
	return (VISUAL_KINDS as readonly string[]).includes(kind) ? typesForVisualKind(kind as VisualKind) : [];
}

function skip(
	seq: Sequence,
	c: PlanCue,
	code: SoundDesignPlanSkip['code'],
	reason: string,
): SoundDesignPlanSkip {
	return {
		cueId: c.stored?.id ?? null,
		cueKey: c.derived?.key ?? null,
		frame: c.frame,
		timecode: sequenceTimecode(seq, c.frame),
		kind: c.kind,
		code,
		reason,
	};
}

function fromStored(c: SoundCue): PlanCue {
	return {
		stored: c,
		derived: null,
		frame: c.frame,
		kind: c.kind,
		weight: c.weight,
		types: knownTypes(c.types, c.kind),
		align: c.align ?? null,
		reason: c.reason ?? c.label ?? `${c.kind} cue`,
		windowFrames: c.window && c.window.end > c.window.start ? c.window.end - c.window.start : null,
		key: c.id,
		layered: c.source === 'marker' && knownTypes(c.types, c.kind).length > 1,
	};
}

function fromDerived(d: DerivedCue): PlanCue {
	return {
		stored: null,
		derived: d,
		frame: d.frame,
		kind: d.kind,
		weight: d.weight,
		types: knownTypes(d.types, d.kind),
		align: d.align,
		reason: d.reason,
		windowFrames: d.window && d.window.end > d.window.start ? d.window.end - d.window.start : null,
		key: `derived:${d.key}`,
		layered: d.source === 'marker' && knownTypes(d.types, d.kind).length > 1,
	};
}

export class PlanInputError extends Error {
	constructor(
		readonly code: 'SEQUENCE_NOT_FOUND' | 'CUE_NOT_FOUND',
		message: string,
	) {
		super(message);
	}
}

/** The sequence a request names (default the first), or a typed error. */
export function planSequence(doc: ProjectDocument, sequenceId: string | undefined): Sequence {
	const id = sequenceId ?? Object.keys(doc.sequences ?? {})[0];
	const seq = id !== undefined && Object.hasOwn(doc.sequences, id) ? doc.sequences[id] : undefined;
	if (!seq)
		throw new PlanInputError(
			'SEQUENCE_NOT_FOUND',
			sequenceId ? `Sequence not found: ${sequenceId}` : 'The project has no sequence',
		);
	return seq;
}

/** Unknown cue ids of an explicit request (the route refuses them before a job starts). */
export function unknownCueIds(seq: Sequence, ids: readonly string[]): string[] {
	const have = new Set(soundCuesOf(seq).map((c) => c.id));
	return [...new Set(ids)].filter((id) => !have.has(id));
}

/**
 * The cues of a plan, frame order (stored before derived at one frame), and the cues left out with why. Pure: `doc`
 * should have its expressions bound (the route does) so derived motion is what the Program monitor shows.
 */
export function collectPlanCues(
	doc: ProjectDocument,
	seq: Sequence,
	req: SoundDesignPlanRequest,
	style: PlanStyle,
	opts: {
		mgTemplates?: MgTemplateRegistry;
		/** Cues of the engine sources (scene, beat, pixel) measured for this plan. */
		extraCues?: readonly ExtraCue[];
		/** Beat frames `style.snapToBeats` snaps to. */
		beatFrames?: readonly number[];
		/** Voice activity of the dialogue clips (`VoiceActivityService`); absent = their whole spans. */
		voice?: VoiceActivity | null;
	} = {},
): { cues: PlanCue[]; skipped: SoundDesignPlanSkip[]; warnings: { code: string; message: string }[] } {
	const range = req.range ?? null;
	const inRange = (f: number) => !range || (f >= range.start && f < range.end);
	const dialogue = style.respectDialogue
		? sequenceDialogueRanges(doc, seq, { voice: opts.voice ?? null })
		: [];
	const inDialogue = (f: number) => dialogue.some(([s, e]) => f >= s && f < e);
	const stored = soundCuesOf(seq);
	const filledBy = (c: SoundCue) => (c.placedClipIds ?? []).find((id) => Object.hasOwn(seq.clips, id));
	const explicit = Array.isArray(req.cues);
	const wanted = explicit ? new Set(req.cues as string[]) : null;
	const out: PlanCue[] = [];
	const skipped: SoundDesignPlanSkip[] = [];
	const warnings: { code: string; message: string }[] = [];
	for (const c of stored) {
		if (wanted && !wanted.has(c.id)) continue;
		const pc = fromStored(c);
		if (!inRange(c.frame)) {
			if (explicit) skipped.push(skip(seq, pc, 'OUT_OF_RANGE', 'outside the range'));
			continue;
		}
		const by = filledBy(c);
		if (by) {
			if (explicit) skipped.push(skip(seq, pc, 'FILLED', `already has a sound (${by})`));
			continue;
		}
		if (c.muted) {
			skipped.push(skip(seq, pc, 'MUTED', 'the cue is muted'));
			continue;
		}
		if (c.kind === 'silence') {
			skipped.push(skip(seq, pc, 'SILENCE', 'a silence cue asks for no sound'));
			continue;
		}
		if (style.respectDialogue && c.kind === 'cut' && inDialogue(c.frame)) {
			skipped.push(skip(seq, pc, 'DIALOGUE', 'a plain cut under spoken words gets no sound'));
			continue;
		}
		// P6-E10 personality: excluded types out (unless none would remain), boosted ones first
		pc.types = styleCueTypes(pc.types, style.grammar.personality);
		out.push(pc);
	}
	if (!explicit) {
		const derived = deriveCues(doc, seq.id, {
			...(range ? { range } : {}),
			density: style.density,
			respectDialogue: style.respectDialogue,
			...(style.cueSources ? { sources: style.cueSources } : {}),
			...(opts.mgTemplates ? { mgTemplates: opts.mgTemplates } : {}),
			...(opts.extraCues ? { extraCues: opts.extraCues } : {}),
			...(opts.voice ? { voiceActivity: opts.voice } : {}),
			...(style.snapToBeats ? { snapToBeats: true, beatFrames: opts.beatFrames ?? [] } : {}),
			typing: style.grammar.typing,
			musicCarriesCuts: style.grammar.musicCarriesCuts,
			personality: style.grammar.personality,
		});
		for (const w of derived.warnings) warnings.push({ code: w.code, message: w.message });
		// P6-E10: the cuts the music carries that the density left out, each with its reason
		for (const c of derived.carried ?? [])
			skipped.push({
				cueId: null,
				cueKey: c.key,
				frame: c.frame,
				timecode: sequenceTimecode(seq, c.frame),
				kind: 'cut',
				code: 'MUSIC_CARRIES_CUT',
				reason: `music carries the cut: its confidence is halved to ${c.confidence}, under the ${style.density} minimum ${c.minConfidence} (${c.reason})`.slice(
					0,
					1000,
				),
			});
		const matches = matchStoredCues(seq, derived.cues);
		derived.cues.forEach((d, i) => {
			const pc = fromDerived(d);
			const match = matches[i];
			if (match) {
				const c = stored.find((x) => x.id === match);
				const by = c ? filledBy(c) : undefined;
				// An unfilled stored cue is planned as itself (above); a filled one already has its sound.
				if (by)
					skipped.push(skip(seq, pc, 'STORED', `stored as ${match}, which already has a sound (${by})`));
				return;
			}
			const near = stored.find((c) => Math.abs(c.frame - d.frame) <= NEAR_STORED_FRAMES);
			if (near) {
				skipped.push(
					skip(seq, pc, 'NEAR_STORED', `within ${NEAR_STORED_FRAMES} frames of the stored cue ${near.id}`),
				);
				return;
			}
			out.push(pc);
		});
	}
	out.sort(
		(a, b) =>
			a.frame - b.frame ||
			Number(a.stored === null) - Number(b.stored === null) ||
			(a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
	);
	return { cues: out, skipped, warnings };
}

type SfxClip = AudioClip & { sfx?: ClipSfx };

/**
 * Placed library sounds of the sequence: where their aligned point plays (frames), their sound, its library types (the
 * media's provenance) and role. Frame order (then clip id).
 */
function placedSounds(
	doc: ProjectDocument,
	seq: Sequence,
): { frame: number; soundId: string | null; hero: boolean; types: string[] }[] {
	const F = flicksPerFrame(seq.settings.frameRate as Rational);
	const out: { frame: number; soundId: string | null; hero: boolean; types: string[]; id: string }[] = [];
	for (const c of Object.values(seq.clips) as SfxClip[]) {
		const sfx = c.kind === 'audio' ? c.sfx : undefined;
		if (!sfx?.placement || !(F > 0)) continue;
		const flicks =
			c.start * F +
			(sfx.placement.peakFlicks - c.sourceIn) / (c.speed?.rate || 1) -
			sfx.placement.errorFlicks;
		if (!Number.isFinite(flicks)) continue;
		const prov = readLibraryProvenance((doc.media?.[c.mediaId] as { library?: unknown } | undefined)?.library);
		out.push({
			frame: flicks / F,
			soundId: sfx.soundId ?? null,
			hero: sfx.role === 'hero',
			types: [...(prov?.types ?? [])],
			id: c.id,
		});
	}
	out.sort((a, b) => a.frame - b.frame || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return out.map(({ id: _id, ...p }) => p);
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

/**
 * The cue's types are best first (a cut wants a hit before a glitch, WP2.2): ranked sounds are ordered by the first cue
 * type they carry, keeping the ranking's order within a type — after the ranking's own tier, real recordings before
 * Jasper Synth (spec 12 §0). Stable.
 */
export function byTypeOrder<T extends RankedSound<SoundEntry>>(
	ranked: readonly T[],
	types: readonly string[],
): T[] {
	const tier = (r: T) => {
		const i = types.findIndex((t) => r.entry.types.includes(t));
		return i < 0 ? types.length : i;
	};
	return ranked
		.map((r, i) => ({ r, i, synth: r.entry.source.type === 'synth' ? 1 : 0, tier: tier(r) }))
		.sort((a, b) => a.synth - b.synth || a.tier - b.tier || a.i - b.i)
		.map((x) => x.r);
}

/**
 * Picks the sounds of each cue (frame order): ranked candidates (palette first), the rotation's pick, the alternatives,
 * the role and alignment. Cues beyond `maxCues` and cues no sound fits are skipped. Pure and deterministic for the same
 * document, pool (library snapshot) and style.
 * The cue grammar (P6-E10, `@jasper/project` `sound/grammar.ts`): the ranking carries the personality and the palette
 * materials of the placed sounds and earlier picks; a ui / click fill plays the type's one voice (the palette sound, else
 * the first placed sound of the type, else the first pick) at rate 1 and 0 dB; key / tick / tap rotate at rate 1;
 * runs of ≥ 3 staggered appear / emphasis cues filled with pop, ui, chime or tick climb +1 st per step (capped +4);
 * with `duckUnderTyping`, a typing run over music gets a 6 dB dip of that music.
 */
export function selectPlanSounds(
	doc: ProjectDocument,
	seq: Sequence,
	cues: readonly PlanCue[],
	pool: readonly SoundEntry[],
	style: PlanStyle,
	voice: VoiceActivity | null = null,
): {
	picks: PlanPick[];
	skipped: SoundDesignPlanSkip[];
	paletteMissing: number;
	/** P6-E10: what the grammar did (the report's `grammar`). */
	grammar: NonNullable<SoundDesignPlanReport['grammar']>;
} {
	const fps = fpsOf(seq);
	const dialogue = style.respectDialogue ? sequenceDialogueRanges(doc, seq, { voice }) : [];
	const inDialogue = (f: number) => dialogue.some(([s, e]) => f >= s && f < e);
	const palette = new Set(style.palette);
	const poolIds = new Set(pool.map((e) => e.id));
	const poolById = new Map(pool.map((e) => [e.id, e]));
	const paletteMissing = style.palette.filter((id) => !poolIds.has(id)).length;
	const placed = placedSounds(doc, seq);
	const used: { frame: number; soundId: string }[] = placed
		.filter((p): p is (typeof placed)[number] & { soundId: string } => !!p.soundId)
		.map((p) => ({ frame: p.frame, soundId: p.soundId }));
	const heroes: number[] = placed.filter((p) => p.hero).map((p) => p.frame);
	// P6-E10: the sounds the voice and palette rules read — the placed ones (frame order), then this plan's picks
	const placedList: PlacedSound[] = placed.map((p) => ({
		soundId: p.soundId,
		types: p.types,
		materials: p.soundId ? (poolById.get(p.soundId)?.materials ?? null) : null,
	}));
	let palMats: PaletteMaterials = paletteMaterials(placedList);
	const personality = style.grammar.personality;
	const picks: PlanPick[] = [];
	const skipped: SoundDesignPlanSkip[] = [];
	// Ranking per distinct request (types, kind, window, align, palette materials) is shared by cues that ask the same.
	const rankCache = new Map<string, RankedSound<SoundEntry>[]>();
	for (const cue of cues) {
		if (picks.length >= style.maxCues) {
			skipped.push(
				skip(seq, cue, 'LIMIT', `over the plan's limit of ${style.maxCues} cues: plan a later range for it`),
			);
			continue;
		}
		if (cue.types.length === 0) {
			skipped.push(skip(seq, cue, 'NO_TYPES', 'the cue names no sound type'));
			continue;
		}
		const visualKind = (VISUAL_KINDS as readonly string[]).includes(cue.kind)
			? (cue.kind as VisualKind)
			: undefined;
		const windowSec = cue.windowFrames ? round4(cue.windowFrames / fps) : undefined;
		// Rotation context: sounds used nearest this cue first (earlier picks of this plan and placed clips).
		const recent = [
			...new Set(
				used
					.map((u) => ({ id: u.soundId, d: Math.abs(u.frame - cue.frame) }))
					.sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
					.map((u) => u.id),
			),
		].slice(0, 16);
		/** The ranking request of these types (the personality and the palette materials as they are now). */
		const requestOf = (types: SoundTypeId[]) => ({
			types,
			...(visualKind ? { visualKind } : {}),
			...(windowSec ? { windowSec } : {}),
			...(cue.align ? { align: cue.align } : {}),
			license: 'commercial-safe' as const,
			...(personality ? { personality } : {}),
			...(Object.keys(palMats).length ? { paletteMaterials: palMats } : {}),
		});
		/** Candidates of these types, best first (palette first), re-ranked with this cue's rotation penalty. */
		const candidatesOf = (types: SoundTypeId[], recentIds: string[]) => {
			const req = requestOf(types);
			const cacheKey = `${types.join(',')}|${visualKind ?? ''}|${windowSec ?? ''}|${cue.align ?? ''}|${JSON.stringify(palMats)}`;
			let ranked = rankCache.get(cacheKey);
			if (!ranked) {
				ranked = byTypeOrder(rankSounds(pool, req), types);
				rankCache.set(cacheKey, ranked);
			}
			const top = ranked.length
				? byTypeOrder(
						rankSounds(
							ranked.slice(0, RANKED_PER_CUE * 2).map((r) => r.entry),
							req,
							{ usedNearby: recentIds },
						),
						types,
					).slice(0, RANKED_PER_CUE)
				: [];
			return [...top.filter((r) => palette.has(r.entry.id)), ...top.filter((r) => !palette.has(r.entry.id))];
		};
		// A marker naming several types ("sfx: boom+whoosh") asks for layers, one per type; other cues list
		// suitable types best first, for one sound.
		const layerTypes = cue.layered ? cue.types.slice(0, MAX_LAYERS).map((t) => [t]) : [cue.types];
		const picked: {
			candidates: RankedSound<SoundEntry>[];
			index: number;
			rate: number;
			gainDb: number;
			variation: SoundVariation;
			voice: { type: SoundTypeId; soundId: string; from: string } | null;
		}[] = [];
		const missingTypes: string[] = [];
		for (const [layer, types] of layerTypes.entries()) {
			// Layers of one cue differ from each other too.
			const recentIds = [...picked.map((p) => p.candidates[p.index]!.entry.id).reverse(), ...recent];
			let candidates = candidatesOf(types, recentIds);
			if (candidates.length === 0) {
				missingTypes.push(types.slice(0, 4).join('/'));
				continue;
			}
			const fill = fillTypeOf(candidates[0]!.entry.types, types);
			const variation = variationOfType(fill);
			if (variation === 'voice' && fill) {
				// one voice per sequence: the palette sound or the first placed (also when it ranks lower)
				const v = voiceFor(fill, {
					candidates: candidates.map((r) => ({ id: r.entry.id, types: r.entry.types })),
					palette,
					placed: placedList,
				});
				let index = v ? candidates.findIndex((r) => r.entry.id === v.soundId) : 0;
				if (v && index < 0) {
					const e = poolById.get(v.soundId);
					const r = e ? rankSounds([e], requestOf([fill]))[0] : undefined;
					if (r) {
						candidates = [r, ...candidates];
						index = 0;
					} else index = 0;
				}
				const chosen = candidates[index]!;
				picked.push({
					candidates,
					index,
					rate: 1,
					gainDb: 0,
					variation,
					voice: { type: fill, soundId: chosen.entry.id, from: v && v.soundId === chosen.entry.id ? v.from : 'first' },
				});
				continue;
			}
			const v = pickVariant(
				candidates.map((r) => r.entry.id),
				{ seed: style.seed, cueId: cue.key, sequenceId: seq.id, layer, recentSoundIds: recentIds, variation },
			);
			if (!v) missingTypes.push(types.slice(0, 4).join('/'));
			else picked.push({ candidates, index: v.index, rate: v.rate, gainDb: v.gainDb, variation, voice: null });
		}
		if (picked.length === 0 || (missingTypes.length && !cue.layered)) {
			skipped.push(
				skip(
					seq,
					cue,
					'NO_SOUND',
					`no commercial-safe sound of type ${cue.types.slice(0, 4).join('/')} in the allowed sources (${style.sources.join(', ')})`,
				),
			);
			continue;
		}
		const first = picked[0]!;
		const chosen = first.candidates[first.index]!;
		const alternatives = first.candidates.filter((r) => r !== chosen).slice(0, style.alternatives);
		const extraLayers = picked.slice(1).map((p) => ({
			sound: p.candidates[p.index]!,
			rate: p.rate,
			gainOffsetDb: p.gainDb,
		}));
		const notes: string[] = missingTypes.map(
			(t) => `no commercial-safe sound of type ${t} in the allowed sources: that layer is left out`,
		);
		if (first.voice)
			notes.push(
				`one ${first.voice.type} voice: ${chosen.entry.title || chosen.entry.id} (${
					first.voice.from === 'palette'
						? 'the palette sound'
						: first.voice.from === 'placed'
							? 'the first placed'
							: 'the first in this sequence'
				}), same level, no variation`,
			);
		else if (first.variation === 'takes') notes.push('no varispeed: keys, ticks and taps vary the take, not the pitch');
		let role: Role = cue.weight === 'hero' ? 'hero' : 'support';
		if (role === 'hero' && style.respectDialogue && inDialogue(cue.frame)) {
			role = 'support';
			notes.push('a hero under spoken words: placed as support');
		}
		if (role === 'hero') {
			const close = heroes.find((h) => Math.abs(h - cue.frame) / fps < HERO_MIN_SEC);
			if (close !== undefined) {
				role = 'support';
				notes.push(
					`another hero ${round4(Math.abs(close - cue.frame) / fps)} s away (never two heroes within ${HERO_MIN_SEC} s): placed as support`,
				);
			}
		}
		if (role === 'hero') heroes.push(cue.frame);
		const firstType = chosen.entry.types.find(isSoundTypeId);
		const align: CueAlign = cue.align ?? (firstType ? SOUND_TYPES[firstType].defaultAlign : 'peak');
		if ([chosen, ...extraLayers.map((l) => l.sound)].some((r) => r.entry.source.type === 'synth'))
			notes.push('a Jasper Synth (procedural) sound: no recording of this type fits');
		picks.push({
			cue,
			role,
			align,
			sounds: [chosen, ...alternatives],
			rate: first.rate,
			gainOffsetDb: first.gainDb,
			extraLayers,
			notes,
			variation: first.variation,
			...(first.voice ? { voice: { type: first.voice.type, soundId: chosen.entry.id } } : {}),
		});
		used.push({ frame: cue.frame, soundId: chosen.entry.id });
		for (const l of extraLayers) used.push({ frame: cue.frame, soundId: l.sound.entry.id });
		for (const r of [chosen, ...extraLayers.map((l) => l.sound)])
			placedList.push({ soundId: r.entry.id, types: r.entry.types, materials: r.entry.materials ?? null });
		palMats = paletteMaterials(placedList);
	}
	// Runs climb (P6-E10): ≥ 3 consecutive appear / emphasis cues ≤ 0.6 s apart filled with pop, ui, chime or tick.
	const mode = style.grammar.runs;
	const steps = findRuns(
		picks.map((p) => ({
			frame: p.cue.frame,
			kind: p.cue.kind,
			type: fillTypeOf(p.sounds[0]!.entry.types, p.cue.types),
			fixedPitch: typeof p.cue.stored?.pitchSt === 'number' && p.cue.stored.pitchSt !== 0,
		})),
		fps,
		mode,
	);
	let runCount = 0;
	steps.forEach((st, i) => {
		if (!st) return;
		const p = picks[i]!;
		runCount = Math.max(runCount, st.run);
		p.run = { group: `run:${st.run}`, index: st.index, of: st.of, st: st.st };
		if (mode === 'climb') {
			// the climb is the speed (varispeed, maintain pitch off): up to 3 st as the clip's pitch, the rest in its rate
			const pitch = Math.min(st.st, VARISPEED_RUN_PITCH_MAX);
			p.pitchSt = pitch;
			p.rate = rateOfSemitones(st.st - pitch);
		}
		p.notes.push(runReason(st, mode));
	});
	// Typing under music (style duckUnderTyping): one 6 dB dip of the music under each typing run (the cues of one
	// typewriter or character reveal, filled with keys, ticks or clicks).
	let typingDucks = 0;
	if (style.grammar.duckUnderTyping) {
		const F = flicksPerFrame(seq.settings.frameRate as Rational);
		const groups = new Map<string, PlanPick[]>();
		for (const p of picks) {
			const g = p.cue.derived?.group;
			const t = fillTypeOf(p.sounds[0]!.entry.types, p.cue.types);
			if (!g || !g.startsWith('text:') || !t || !['key', 'tick', 'click'].includes(t)) continue;
			const list = groups.get(g);
			if (list) list.push(p);
			else groups.set(g, [p]);
		}
		for (const list of groups.values()) {
			if (list.length < 2) continue;
			const a = Math.min(...list.map((p) => p.cue.frame));
			const z = Math.max(...list.map((p) => p.cue.frame));
			const b = z + Math.ceil(TYPING_DUCK.tailSec * fps);
			const clipIds = musicTracksUnder(seq, a, b)
				.filter((u) => !u.locked)
				.flatMap((u) => u.clipIds);
			if (!clipIds.length) continue;
			const head = list.find((p) => p.cue.frame === a)!;
			head.duck = { clipIds: [...new Set(clipIds)].sort(), start: a * F, end: b * F, firstFrame: a, lastFrame: z };
			head.notes.push(`the music dips ${-TYPING_DUCK.depthDb} dB under this typing run`);
			typingDucks++;
		}
	}
	const voices: Record<string, string> = {};
	for (const p of picks) if (p.voice && !voices[p.voice.type]) voices[p.voice.type] = p.voice.soundId;
	return {
		picks,
		skipped,
		paletteMissing,
		grammar: {
			personality: style.grammar.personality,
			runs: style.grammar.runs,
			typing: style.grammar.typing,
			musicCarriesCuts: style.grammar.musicCarriesCuts,
			duckUnderTyping: style.grammar.duckUnderTyping,
			voices,
			runCount,
			carriedCuts: 0,
			typingDucks,
			materials: { ...palMats } as Record<string, string>,
		},
	};
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

function planSound(r: RankedSound<SoundEntry>, palette: Set<string>) {
	return {
		soundId: r.entry.id,
		title: r.entry.title,
		license: r.entry.license,
		source: r.entry.source.type,
		score: round4(r.score),
		palette: palette.has(r.entry.id),
	};
}

export type PlanDraft = {
	draft: ProposalDraft | null;
	report: SoundDesignPlanReport;
	/** P6-E10: place items whose layer 0 is one voice (same type and sound): the levels make them one level. */
	voiceGroups: string[][];
};

/**
 * The proposal draft of the picks with the registered sounds (`registered` by sound id; a pick whose sounds are not all
 * there was already pruned by the caller) and the report. Pure.
 */
export function composePlanDraft(
	doc: ProjectDocument,
	seq: Sequence,
	req: SoundDesignPlanRequest,
	style: PlanStyle,
	picks: readonly PlanPick[],
	registered: ReadonlyMap<string, RegisterSoundResponse>,
	extra: {
		skipped: SoundDesignPlanSkip[];
		warnings: { code: string; message: string }[];
		considered: number;
		snapshotHash: string;
		librarySize: number;
		/** Phase 4 setup items (room glue, delivery) every place item requires. */
		mixSetup?: ProposalItemInput[];
		/** P6-E10: what the grammar did (`selectPlanSounds`). */
		grammar?: SoundDesignPlanReport['grammar'];
	},
): PlanDraft {
	const fps = fpsOf(seq);
	const palette = new Set(style.palette);
	const media: SoundProposalMedia[] = [];
	for (const [soundId, reg] of registered) {
		const entryTitle = picks
			.flatMap((p) => [...p.sounds, ...p.extraLayers.map((l) => l.sound)])
			.find((s) => s.entry.id === soundId)?.entry.title;
		const title = entryTitle || reg.library.title || reg.originalName;
		media.push({
			soundId,
			title,
			fingerprint: reg.fingerprint,
			kind: reg.kind,
			existingMediaId: reg.existingMediaId,
			library: reg.library,
			register: mediaRegisterCommand(reg, '$x', '$xi', title) as SoundProposalMedia['register'],
		});
	}
	const width = Math.max(3, String(picks.length).length);
	const placements: SoundProposalPlacement[] = [];
	const events: SoundDesignPlanEvent[] = [];
	const mixSetup = extra.mixSetup ?? [];
	let stops = 0;
	let builds = 0;
	const voiceItems = new Map<string, string[]>();
	picks.forEach((p, i) => {
		const id = `sfx:${String(i + 1).padStart(width, '0')}`;
		const [chosen, ...alts] = p.sounds;
		const tc = sequenceTimecode(seq, p.cue.frame);
		const title = chosen!.entry.title;
		const names = [title, ...p.extraLayers.map((l) => l.sound.entry.title)].join(' + ');
		const why = `${names} on ${p.cue.reason} at ${tc} · ${p.role} · ${p.align}`.slice(0, 1000);
		const layer: Record<string, unknown> = { soundId: chosen!.entry.id, role: p.role };
		if (p.rate !== 1) layer.rate = p.rate;
		if (p.pitchSt) layer.pitchSt = p.pitchSt;
		if (p.gainOffsetDb !== 0) layer.gainOffsetDb = p.gainOffsetDb;
		if (p.voice) {
			const k = `${p.voice.type}|${p.voice.soundId}`;
			voiceItems.set(k, [...(voiceItems.get(k) ?? []), id]);
		}
		// the clip's whole speed: the variation (or a run's base rate) times the pitch's varispeed
		const speed = round6(p.rate * rateOfSemitones(p.pitchSt ?? 0));
		const cueItemId = p.cue.derived ? `cue:${id}` : null;
		const meta = {
			feature: SOUND_DESIGN_FEATURE,
			frame: p.cue.frame,
			timecode: tc,
			kind: p.cue.kind,
			weight: p.cue.weight,
			role: p.role,
			align: p.align,
			cueId: p.cue.stored?.id ?? null,
			cueKey: p.cue.derived?.key ?? null,
			cueReason: p.cue.reason,
			why,
			soundId: chosen!.entry.id,
			title,
			license: chosen!.entry.license,
			score: round4(chosen!.score),
			rate: speed,
			gainOffsetDb: p.gainOffsetDb,
			...(p.extraLayers.length
				? { layers: p.extraLayers.map((l) => ({ soundId: l.sound.entry.id, title: l.sound.entry.title })) }
				: {}),
			...(p.notes.length ? { notes: p.notes } : {}),
			...(p.variation ? { variation: p.variation } : {}),
			...(p.run ? { run: p.run } : {}),
		};
		const extra = p.extraLayers.map((l) => ({
			soundId: l.sound.entry.id,
			role: 'layer',
			...(l.rate !== 1 ? { rate: l.rate } : {}),
			...(l.gainOffsetDb !== 0 ? { gainOffsetDb: l.gainOffsetDb } : {}),
		}));
		const num = String(i + 1).padStart(width, '0');
		const mixItems = cueMixItems(seq, p, style, num, tc);
		const duck = p.duck ? typingDuckItem(seq, p.duck, num) : null;
		const after = [mixItems.stop, mixItems.build, duck].filter((x): x is NonNullable<typeof x> => x !== null);
		if (mixItems.stop) stops++;
		if (mixItems.build) builds++;
		placements.push({
			id,
			...(mixSetup.length ? { requires: mixSetup.map((m) => m.id) } : {}),
			...(after.length ? { after } : {}),
			label: `${names} · ${p.cue.kind} ${tc}`.slice(0, 200),
			// a run's members share a group (the Review list groups by role; the run is in the meta)
			group: p.run ? p.run.group : p.role,
			meta,
			cue: p.cue.stored
				? { cueId: p.cue.stored.id }
				: {
						add: cueInputFromDerived(p.cue.derived!),
						label: `Cue: ${p.cue.kind} at ${tc}`,
						meta: { cueKey: p.cue.derived!.key, frame: p.cue.frame, timecode: tc, kind: p.cue.kind },
					},
			layers: [layer, ...extra],
			ring: p.sounds.map((s) => s.entry.id),
			alternatives: alts.map((a) => ({
				soundId: a.entry.id,
				label: a.entry.title || a.entry.id,
				meta: {
					soundId: a.entry.id,
					title: a.entry.title,
					license: a.entry.license,
					score: round4(a.score),
					why: `${a.entry.title} on ${p.cue.reason} at ${tc} · ${p.role} · ${p.align}`.slice(0, 1000),
				},
			})),
		});
		events.push({
			itemId: id,
			cueId: p.cue.stored?.id ?? null,
			cueKey: p.cue.derived?.key ?? null,
			cueItemId,
			frame: p.cue.frame,
			timecode: tc,
			seconds: r3(p.cue.frame / fps),
			kind: p.cue.kind,
			weight: p.cue.weight,
			role: p.role,
			align: p.align,
			cueReason: p.cue.reason,
			why,
			types: p.cue.types,
			sound: planSound(chosen!, palette),
			parts: chosen!.parts,
			rate: speed,
			gainOffsetDb: p.gainOffsetDb,
			...(p.variation ? { variation: p.variation } : {}),
			...(p.run ? { run: p.run } : {}),
			alternatives: alts.map((a) => planSound(a, palette)),
			extraLayers: p.extraLayers.map((l) => planSound(l.sound, palette)),
			notes: p.notes,
			...(mixItems.stop ? { stopBeforeItemId: mixItems.stop.id } : {}),
			...(mixItems.build ? { buildItemId: mixItems.build.id } : {}),
		});
	});
	const built = soundProposalItems(doc, seq.id, media, placements, {
		binName: SOUND_EFFECTS_BIN,
		setup: mixSetup,
	});
	const newCues = picks.filter((p) => p.cue.derived).length;
	const skippedAll = extra.skipped;
	const report: SoundDesignPlanReport = {
		version: 1,
		sequenceId: seq.id,
		seed: style.seed,
		density: style.density,
		respectDialogue: style.respectDialogue,
		sources: style.sources,
		cues: Array.isArray(req.cues) ? 'ids' : 'auto',
		range: req.range ? { start: req.range.start, end: req.range.end } : null,
		snapshotHash: extra.snapshotHash,
		librarySize: extra.librarySize,
		palette: {
			size: style.palette.length,
			used: picks.filter((p) => palette.has(p.sounds[0]!.entry.id)).length,
		},
		events,
		skipped: skippedAll.slice(0, SOUND_DESIGN_PLAN_LIMITS.maxSkippedListed),
		counts: {
			cues: extra.considered,
			placed: picks.length,
			newCues,
			skipped: skippedAll.length,
			sounds: registered.size,
			items: built.items.length,
		},
		...(mixSetup.length || stops || builds || style.roomGlue || style.delivery
			? {
					mix: {
						roomItemId: mixSetup.some((m) => m.id === ROOM_ITEM_ID) ? ROOM_ITEM_ID : null,
						deliveryItemId: mixSetup.some((m) => m.id === DELIVERY_ITEM_ID) ? DELIVERY_ITEM_ID : null,
						delivery: style.delivery,
						stopBefore: stops,
						build: builds,
					},
				}
			: {}),
		warnings: [
			...extra.warnings,
			...(skippedAll.length > SOUND_DESIGN_PLAN_LIMITS.maxSkippedListed
				? [
						{
							code: 'W_SKIPPED_TRUNCATED',
							message: `${skippedAll.length} cues were skipped; the first ${SOUND_DESIGN_PLAN_LIMITS.maxSkippedListed} are listed`,
						},
					]
				: []),
		],
	};
	if (JSON.stringify(report).length > REPORT_SOFT_BYTES) {
		for (const e of report.events) (e as { parts: unknown }).parts = { ...e.parts, text: null };
		report.warnings.push({ code: 'W_REPORT_TRIMMED', message: 'The report was trimmed to stay under 1 MB' });
	}
	const voiceGroups = [...voiceItems.values()].filter((g) => g.length > 1);
	if (built.items.length === 0 || picks.length === 0) return { draft: null, report, voiceGroups };
	// The sequence's name is its Project item's.
	const item = Object.values(doc.items ?? {}).find(
		(it) => it?.kind === 'sequence' && (it as { sequenceId?: unknown }).sequenceId === seq.id,
	);
	const name = item?.name;
	const placedWord = picks.length === 1 ? 'sound' : 'sounds';
	const draft: ProposalDraft = {
		sequenceId: seq.id,
		feature: SOUND_DESIGN_FEATURE,
		title: (req.label ?? `Sound design: ${typeof name === 'string' && name ? name : seq.id}`).slice(0, 200),
		summary:
			`${picks.length} ${placedWord} on ${picks.length} cue${picks.length === 1 ? '' : 's'}` +
			`${newCues ? ` (${newCues} new cue${newCues === 1 ? '' : 's'})` : ''}` +
			` · ${style.density} · seed ${style.seed}` +
			`${skippedAll.length ? ` · ${skippedAll.length} cue${skippedAll.length === 1 ? '' : 's'} skipped` : ''}`,
		items: built.items,
		report,
	};
	return { draft, report, voiceGroups };
}

/**
 * The music dip under a typing run (P6-E10 style `duckUnderTyping`): an `audio.volumeDip` of 6 dB on the music clips
 * under the run (80 ms fades), an item after the run's first placement. Pure.
 */
export function typingDuckItem(
	seq: Sequence,
	duck: PlanDuck,
	itemNo: string,
): NonNullable<SoundProposalPlacement['after']>[number] {
	const a = sequenceTimecode(seq, duck.firstFrame);
	const b = sequenceTimecode(seq, duck.lastFrame);
	return {
		id: `duck:${itemNo}`,
		label: `Duck the music ${-TYPING_DUCK.depthDb} dB under typing ${a}–${b}`,
		group: 'mix',
		meta: {
			feature: SOUND_DESIGN_FEATURE,
			kind: 'duckUnderTyping',
			frame: duck.firstFrame,
			timecode: a,
			clipIds: duck.clipIds,
			why: `The music dips ${-TYPING_DUCK.depthDb} dB under the typing from ${a} to ${b}, so the keys stay readable`,
		},
		commands: () => [
			{
				type: 'audio.volumeDip',
				clipIds: duck.clipIds,
				dips: [
					{
						start: Math.round(duck.start),
						end: Math.round(duck.end),
						depthDb: TYPING_DUCK.depthDb,
						fadeMs: TYPING_DUCK.fadeMs,
					},
				],
			},
		],
	};
}

/** Parsed job input (the route validated it; a journaled input is checked again). */
export type PlanJobInput = { request: SoundDesignPlanRequest; who: Requester };

function parseInput(raw: unknown): PlanJobInput {
	const r = raw as { request?: unknown; who?: { editor?: unknown; agent?: unknown } } | null;
	const parsed = SoundDesignPlanRequestSchema.safeParse(r?.request);
	if (!parsed.success) throw new JobError('VALIDATION_FAILED', 'The plan request is invalid', false);
	const who: Requester = {
		editor: r?.who?.editor === true,
		agent: typeof r?.who?.agent === 'string' ? r.who.agent.slice(0, 64) : 'An agent',
	};
	return { request: parsed.data, who };
}

export type PlanDeps = {
	agent: () => AgentService | undefined;
	/** P6: the engine cue sources (scene, beat, pixel), run inside the job when the style asks for them. */
	engineCues?: () => EngineCueSources | undefined;
	sounds: () => SoundService | undefined;
	proposals: () => ProposalService | undefined;
	mgTemplates?: MgTemplateRegistry;
	/** Phase 4: renders the bed and the sounds for the masking solver (without them the default levels apply). */
	ffmpeg?: Ffmpeg;
	registry?: Pick<MediaRegistry, 'get' | 'resolvePath'>;
	measureCache?: MeasureCache;
	/**
	 * Phase 4: measures a delivery preset for the plan's `style.delivery` setup item (`delivery.ts` `planDelivery`, given
	 * by the route: delivery.ts imports this module).
	 */
	planDelivery?: (
		doc: ProjectDocument,
		seq: Sequence,
		opts: { delivery: SoundDelivery; rebalance: false; measure: false },
		deps: {
			ff: Ffmpeg;
			registry: Pick<MediaRegistry, 'get' | 'resolvePath'>;
			registries: ReturnType<typeof defaultRegistries>;
			cache?: MeasureCache;
			signal?: AbortSignal;
			onSpawn?(child: import('node:child_process').ChildProcess): void;
			onProgress?(fraction: number, stage: string): void;
			timing?: Record<string, number>;
		},
	) => Promise<{
		command: Record<string, unknown>;
		report: { warnings: { code: string; message: string }[] };
	}>;
	/**
	 * Phase 4: the Mix's loudness analysis of a document (`delivery.ts` `mixAnalysis`): the plan's delivery item stores
	 * the analysis of the mix WITH the plan's sounds at their solved gains, so the preview normalises right after the
	 * accept.
	 */
	mixAnalysis?: (
		doc: ProjectDocument,
		seqId: string,
		deps: {
			ff: Ffmpeg;
			registry: Pick<MediaRegistry, 'get' | 'resolvePath'>;
			cache?: MeasureCache;
			signal?: AbortSignal;
			onSpawn?(child: import('node:child_process').ChildProcess): void;
		},
	) => Promise<Record<string, unknown> | null>;
};

/** The live document of a project (the open editor's when one holds it, else the saved one) and its revision. */
export async function liveDocument(
	agent: AgentService,
	projectId: string,
): Promise<{ doc: ProjectDocument; revision: number | null }> {
	const r = await agent.query({ projectId, query: 'doc.get', args: {} });
	const d = r.result as ProjectDocument | undefined;
	if (!d || typeof d !== 'object' || !d.sequences || typeof d.sequences !== 'object')
		throw new HttpError(422, 'VALIDATION_FAILED', 'The project has no readable document');
	return { doc: d, revision: typeof r.revision === 'number' ? r.revision : null };
}

const asJobError = (e: unknown): unknown => {
	if (e instanceof HttpError)
		return new JobError(e.code, e.message, e.status === 503 || e.code === 'PROPOSAL_LIMIT', e.detail);
	if (e instanceof PlanInputError) return new JobError(e.code, e.message, false);
	return e;
};

/** The `sound-design` job runner. */
export async function runSoundDesignPlan(ctx: JobContext, deps: PlanDeps): Promise<SoundDesignPlanResult> {
	try {
		return await runPlan(ctx, deps);
	} catch (e) {
		throw asJobError(e);
	}
}

async function runPlan(ctx: JobContext, deps: PlanDeps): Promise<SoundDesignPlanResult> {
	const { request: req, who } = parseInput(ctx.input);
	const agent = deps.agent();
	const sounds = deps.sounds();
	const proposals = deps.proposals();
	if (!agent || !sounds || !proposals)
		throw new JobError('NOT_AVAILABLE', 'The agent, sound library or proposal service is not running', true);
	const aborted = () => ctx.signal.aborted;
	const tJob = Date.now();
	const timing: Record<string, number> = {};
	let tLap = Date.now();
	const lap = (name: string) => {
		timing[name] = (timing[name] ?? 0) + (Date.now() - tLap);
		tLap = Date.now();
	};
	ctx.progress(0.02, { stage: 'Reading the edit' });
	const live = await liveDocument(agent, req.projectId);
	let doc = live.doc;
	const seq0 = planSequence(doc, req.sequenceId);
	if (Array.isArray(req.cues)) {
		const unknown = unknownCueIds(seq0, req.cues);
		if (unknown.length)
			throw new JobError('CUE_NOT_FOUND', `Sound cue not found: ${unknown.slice(0, 5).join(', ')}`, false);
	}
	// Derived motion follows what the Program monitor shows (expressions bound), like the cue route.
	if (documentHasActiveExpressions(doc)) doc = bindExpressions(doc);
	const seq = doc.sequences[seq0.id]!;
	const style = resolveStyle(req, seq);
	// P6: engine sources (shot changes, beats, picture motion) are measured inside this job (not queued: a job never
	// waits for another job's slot), on the document as saved (the renderer evaluates expressions itself).
	const engineSources = (style.cueSources ?? []).filter((x): x is EngineCueSource =>
		(ENGINE_CUE_SOURCES as readonly string[]).includes(x),
	);
	const engineWarnings: { code: string; message: string }[] = [];
	let measured: Awaited<ReturnType<EngineCueSources['collect']>> | null = null;
	if (!Array.isArray(req.cues) && (engineSources.length || style.snapToBeats)) {
		const sources = deps.engineCues?.();
		if (!sources)
			engineWarnings.push({
				code: 'W_ANALYSIS_FAILED',
				message: 'Shot, beat and picture-motion analysis is not available on this engine',
			});
		else {
			measured = await sources.collect(live.doc, live.doc.sequences[seq0.id]!, {
				sources: engineSources,
				...(style.snapToBeats ? { snapToBeats: true } : {}),
				...(style.timeSignature !== undefined ? { timeSignature: style.timeSignature } : {}),
				...(req.range ? { range: req.range } : {}),
				mode: { kind: 'inline', ctx, projectId: req.projectId, from: 0.03, to: 0.09 },
			});
			for (const w of measured.warnings) engineWarnings.push({ code: w.code, message: w.message });
		}
		if (aborted()) return cancelledResult(req, seq, style);
	}
	// where dialogue clips without a transcript speak (P6-R3: the cue route's and the solver's definition)
	let voice: VoiceActivity | null = null;
	if (style.respectDialogue && deps.ffmpeg && deps.registry) {
		ctx.progress(0.085, { stage: 'Listening for dialogue' });
		voice = (await voiceServiceFor(deps.ffmpeg, deps.registry).forSequence(doc, seq, { signal: ctx.signal }))
			.voice;
		if (aborted()) return cancelledResult(req, seq, style);
	}
	ctx.progress(0.09, { stage: 'Finding cues' });
	const collected = collectPlanCues(doc, seq, req, style, {
		...(voice ? { voice } : {}),
		...(deps.mgTemplates ? { mgTemplates: deps.mgTemplates } : {}),
		...(measured ? { extraCues: measured.extraCues } : {}),
		...(measured?.beatFrames ? { beatFrames: measured.beatFrames } : {}),
	});
	collected.warnings.push(...engineWarnings);
	if (aborted()) return cancelledResult(req, seq, style);
	ctx.progress(0.1, { stage: `Ranking sounds for ${collected.cues.length} cues` });
	const pool = await sounds.rankingPool(style.sources);
	const selected = selectPlanSounds(doc, seq, collected.cues, pool.entries, style, voice);
	const warnings = [...collected.warnings];
	if (selected.paletteMissing)
		warnings.push({
			code: 'W_PALETTE_MISSING',
			message: `${selected.paletteMissing} palette sound(s) are not in the library or the allowed sources`,
		});
	if (pool.entries.length === 0)
		warnings.push({
			code: 'W_LIBRARY_EMPTY',
			message:
				'No sound of the allowed sources is indexed: install the starter kit or rescan the sound library',
		});
	lap('cues');
	// Register every sound a pick may use (chosen and alternatives), in order of need.
	const order: string[] = [];
	for (const p of selected.picks)
		for (const s of p.sounds) if (!order.includes(s.entry.id)) order.push(s.entry.id);
	const registered = new Map<string, RegisterSoundResponse>();
	const failed = new Map<string, string>();
	{
		// a few at once (each is a probe and maybe a copy: mostly waiting for ffmpeg); results kept in order of need
		const results: ({ ok: RegisterSoundResponse } | { error: string } | null)[] = order.map(() => null);
		let next = 0;
		let doneCount = 0;
		let fatal: unknown = null;
		const worker = async () => {
			while (next < order.length && !fatal && !aborted()) {
				const i = next++;
				const id = order[i]!;
				try {
					results[i] = { ok: await sounds.register(id, req.projectId) };
				} catch (e) {
					if (e instanceof HttpError && (e.code === 'PROJECT_NOT_FOUND' || e.status === 503)) {
						fatal ??= e;
						return;
					}
					results[i] = { error: e instanceof Error ? e.message : String(e) };
				}
				doneCount++;
				ctx.progress(0.15 + (0.4 * doneCount) / Math.max(1, order.length), {
					stage: `Registering sounds (${doneCount} of ${order.length})`,
				});
			}
		};
		await Promise.all(
			Array.from({ length: Math.min(REGISTER_CONCURRENCY, Math.max(1, order.length)) }, worker),
		);
		if (fatal) throw fatal;
		if (aborted()) return cancelledResult(req, seq, style);
		order.forEach((id, i) => {
			const r = results[i];
			if (r && 'ok' in r) registered.set(id, r.ok);
			else if (r) {
				failed.set(id, r.error);
				ctx.log(`register ${id}: ${r.error}`);
			}
		});
	}
	lap('register');
	const skipped = [...collected.skipped, ...selected.skipped];
	const picks: PlanPick[] = [];
	for (const p of selected.picks) {
		const ok = p.sounds.filter((s) => registered.has(s.entry.id));
		if (ok.length === 0) {
			const why = failed.get(p.sounds[0]!.entry.id) ?? 'unknown error';
			skipped.push(
				skip(seq, p.cue, 'REGISTER_FAILED', `the sound could not be added to the project: ${why}`),
			);
			continue;
		}
		const notes = [...p.notes];
		if (ok[0] !== p.sounds[0])
			notes.push(
				`${p.sounds[0]!.entry.title} could not be added (${failed.get(p.sounds[0]!.entry.id) ?? 'error'}): ${ok[0]!.entry.title} instead`,
			);
		const extraLayers = p.extraLayers.filter((l) => {
			if (registered.has(l.sound.entry.id)) return true;
			notes.push(
				`${l.sound.entry.title} could not be added (${failed.get(l.sound.entry.id) ?? 'error'}): that layer is left out`,
			);
			return false;
		});
		picks.push({ ...p, sounds: ok, extraLayers, notes });
	}
	// Only the sounds still used are imported.
	const usedIds = new Set(
		picks.flatMap((p) => [...p.sounds, ...p.extraLayers.map((l) => l.sound)].map((s) => s.entry.id)),
	);
	for (const id of [...registered.keys()]) if (!usedIds.has(id)) registered.delete(id);
	skipped.sort(
		(a, b) => a.frame - b.frame || (a.cueKey ?? a.cueId ?? '').localeCompare(b.cueKey ?? b.cueId ?? ''),
	);
	// Phase 4 setup items: the room glue, and the delivery preset measured on the edit as it is.
	const mixSetup: ProposalItemInput[] = [];
	const room = picks.length ? roomSetupItem(seq, style) : null;
	if (room) mixSetup.push(room);
	if (style.delivery && picks.length) {
		if (!deps.planDelivery || !deps.ffmpeg || !deps.registry)
			warnings.push({
				code: 'W_DELIVERY_UNMEASURED',
				message:
					'The engine cannot measure the mix here: the delivery preset is left out (apply it with apply_delivery)',
			});
		else {
			ctx.progress(0.55, { stage: `Measuring the ${style.delivery} delivery` });
			try {
				const d = await deps.planDelivery(
					doc,
					seq,
					// the resulting mix is measured once the plan's sounds and gains are known (below)
					{ delivery: style.delivery, rebalance: false, measure: false },
					{
						ff: deps.ffmpeg,
						registry: deps.registry,
						registries: defaultRegistries(deps.mgTemplates),
						...(deps.measureCache ? { cache: deps.measureCache } : {}),
						signal: ctx.signal,
						onSpawn: ctx.trackChild,
						onProgress: (f, stage) => ctx.progress(0.55 + 0.05 * f, { stage }),
						timing,
					},
				);
				const preset = deliveryPreset(style.delivery);
				mixSetup.push({
					id: DELIVERY_ITEM_ID,
					label: `${preset.label}: loudness, Auto-Match, ducking`,
					group: SOUND_PROPOSAL_SETUP_GROUP,
					commands: [d.command],
					meta: {
						setup: true,
						kind: 'delivery',
						delivery: style.delivery,
						why: `${preset.source}; the sounds are balanced against this mix`,
					},
				});
				warnings.push(...d.report.warnings);
			} catch (e) {
				if (aborted()) return cancelledResult(req, seq, style);
				warnings.push({
					code: 'W_DELIVERY_UNMEASURED',
					message: `The ${style.delivery} delivery could not be measured (${e instanceof Error ? e.message : String(e)}): it is left out`,
				});
			}
		}
	}
	lap('delivery');
	const composed = composePlanDraft(doc, seq, req, style, picks, registered, {
		skipped,
		warnings,
		considered: collected.cues.length + collected.skipped.length,
		snapshotHash: pool.snapshotHash,
		librarySize: pool.librarySize,
		mixSetup,
		grammar: selected.grammar,
	});
	const draft = composed.draft;
	let report = composed.report;
	if (aborted()) return cancelledResult(req, seq, style);
	// Phase 4: gains solved against the bed (each place item applies them; the why-lines say what limited them).
	if (draft) {
		ctx.progress(0.6, { stage: 'Balancing levels against the bed' });
		let levels: Awaited<ReturnType<typeof solvePlanGains>>;
		try {
			levels = await solvePlanGains(
				doc,
				seq,
				draft,
				report,
				{
					...(deps.ffmpeg ? { ffmpeg: deps.ffmpeg } : {}),
					...(deps.registry ? { registry: deps.registry } : {}),
					...(deps.measureCache ? { cache: deps.measureCache } : {}),
					registries: defaultRegistries(deps.mgTemplates),
					signal: ctx.signal,
					onSpawn: ctx.trackChild,
					onProgress: (f, stage) => ctx.progress(0.6 + 0.25 * f, { stage }),
					timing,
				},
				{
					...(style.delivery && draft.items.some((it) => it.id === DELIVERY_ITEM_ID)
						? { delivery: style.delivery }
						: {}),
					// P6-E10: the one voice of a ui / click type plays at one level (the lowest solved)
					...(composed.voiceGroups.length ? { sameLevel: composed.voiceGroups } : {}),
				},
			);
		} catch (e) {
			if (aborted()) return cancelledResult(req, seq, style);
			throw e;
		}
		if (levels.ok) {
			draft.items = levels.items;
			report = levels.report;
		} else report.warnings.push(levels.warning);
		if (JSON.stringify(report).length > REPORT_SOFT_BYTES) {
			for (const e of report.events) {
				delete (e as { alternativeLevels?: unknown }).alternativeLevels;
				delete (e as { layerLevels?: unknown }).layerLevels;
			}
			report.warnings.push({
				code: 'W_REPORT_TRIMMED',
				message: 'The report was trimmed to stay under 1 MB (alternative and layer levels left out)',
			});
		}
		draft.report = report;
	}
	lap('levels');
	// The delivery's loudness analysis: the mix as accepting the plan makes it (its sounds at their solved gains, the
	// room, the dips), so the preview normalises by the right gain right after the accept.
	const deliveryItem = draft?.items.find((it) => it.id === DELIVERY_ITEM_ID);
	if (draft && deliveryItem && deps.ffmpeg && deps.registry) {
		ctx.progress(0.86, { stage: 'Measuring the mix with the planned sounds' });
		const cmd = (deliveryItem.commands as Record<string, unknown>[]).find(
			(c) => c.type === 'soundDesign.applyDelivery',
		);
		let analysis: Record<string, unknown> | null = null;
		let why: string | null = null;
		try {
			const pv = planPreviewDocument(doc, draft, defaultRegistries(deps.mgTemplates));
			if (!pv) why = 'the plan does not apply to the edit';
			else if (deps.mixAnalysis)
				analysis = await deps.mixAnalysis(pv, seq.id, {
					ff: deps.ffmpeg,
					registry: deps.registry,
					...(deps.measureCache ? { cache: deps.measureCache } : {}),
					signal: ctx.signal,
					onSpawn: ctx.trackChild,
				});
			else why = 'the engine cannot measure the mix here';
		} catch (e) {
			if (aborted()) return cancelledResult(req, seq, style);
			why = e instanceof Error ? e.message : String(e);
		}
		// null clears an older analysis: never normalise the preview by a gain measured on another mix
		if (cmd && cmd.loudness !== false) cmd.analysis = analysis;
		if (!analysis && why)
			report.warnings.push({
				code: 'W_MIX_UNMEASURED',
				message: `The mix with the planned sounds could not be measured (${why}): the preview is not loudness-normalised until the mix is analysed (exports always measure it)`,
			});
		lap('delivery.planMix');
	}
	if (aborted()) return cancelledResult(req, seq, style);
	if (!draft) {
		ctx.progress(1, { stage: 'Nothing to propose' });
		return {
			proposalId: null,
			projectId: req.projectId,
			sequenceId: seq.id,
			revision: live.revision,
			itemCount: 0,
			counts: null,
			invalid: [],
			report,
		};
	}
	ctx.progress(0.9, { stage: `Checking ${draft.items.length} proposal items` });
	const created = await proposals.create(req.projectId, draft as unknown as Record<string, unknown>, who);
	if (aborted()) {
		// Cancelled while it was being stored: a cancelled plan leaves no proposal behind.
		await proposals.delete(req.projectId, created.proposal.id).catch(() => undefined);
		return cancelledResult(req, seq, style);
	}
	lap('proposal');
	timing.total = Date.now() - tJob;
	ctx.log(`timing ${JSON.stringify(timing)}`);
	const timingOut = process.env.JASPER_SD_TIMING;
	if (timingOut === '1') console.error(`[sound-design plan] timing ${JSON.stringify(timing)}`);
	else if (timingOut?.startsWith('/'))
		await appendFile(timingOut, `${JSON.stringify({ at: new Date().toISOString(), ...timing })}\n`).catch(
			() => undefined,
		);
	const p = created.proposal;
	const counts = { pending: 0, accepted: 0, rejected: 0, stale: 0, invalid: 0 };
	for (const it of p.items) counts[it.state]++;
	ctx.progress(1, { stage: 'Proposal ready for review' });
	return {
		proposalId: p.id,
		projectId: req.projectId,
		sequenceId: seq.id,
		revision: created.revision,
		itemCount: p.items.length,
		counts,
		invalid: p.items
			.filter((it) => it.state === 'invalid')
			.map((it) => ({ itemId: it.id, reason: it.reason ?? 'does not apply' })),
		report,
	};
}

/** What a cancelled run returns (the queue records the job as cancelled and drops it). */
function cancelledResult(
	req: SoundDesignPlanRequest,
	seq: Sequence,
	style: PlanStyle,
): SoundDesignPlanResult {
	return {
		proposalId: null,
		projectId: req.projectId,
		sequenceId: seq.id,
		revision: null,
		itemCount: 0,
		counts: null,
		invalid: [],
		report: {
			version: 1,
			sequenceId: seq.id,
			seed: style.seed,
			density: style.density,
			respectDialogue: style.respectDialogue,
			sources: style.sources,
			cues: Array.isArray(req.cues) ? 'ids' : 'auto',
			range: req.range ?? null,
			snapshotHash: '',
			librarySize: 0,
			palette: { size: style.palette.length, used: 0 },
			events: [],
			skipped: [],
			counts: { cues: 0, placed: 0, newCues: 0, skipped: 0, sounds: 0, items: 0 },
			warnings: [{ code: 'W_CANCELLED', message: 'The plan was cancelled' }],
		},
	};
}
