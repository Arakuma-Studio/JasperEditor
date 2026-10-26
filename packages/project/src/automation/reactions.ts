// Reactions planner (spec 15 EA-023, EA-030, EA-032): reaction pictures (the user's own images from a bin or folder)
// placed over the picture where the edit asks for one — markers naming a reaction, calls to action and exclamations of
// the transcript (editable lists per language), and optionally where face tracking finds no face on the A-roll
// ("speaker not visible", the inferred trigger of the measured videos). Measured on the user's projects (FINDINGS §3):
// shorts 6.9 /min (11–15 /min in 2025), median 2.1 s; long form 0.9 /min, median 2.6 s; 63–80 % start on a cut; S_Shake
// wobble (Amplitude 0.8, Frequency 2) on 89–96 %; a Horizontal Flip on the left slots; Motion scale 60–65 %; fixed
// slots (shorts: bottom; long form: mid height at x 0.15 / 0.5 / 0.83). Each reaction starts on a cut within
// `snapSeconds` (0.5 s) of its trigger, lasts `durationSeconds`, never overlaps another, keeps clear of subtitles on
// screen (spec 13 caption groups), and the rate never exceeds `maxPerMinute` in any minute (markers, then calls to
// action, exclamations and face-less stretches win the budget). Every item draws its slot, picture and scale from its
// own seed and offers other pictures as alternatives. Pure.
import type { ProjectDocument } from '../schema/document.ts';
import type { Sequence, Track } from '../schema/sequence.ts';
import { flicksPerFrame } from '../time.ts';
import { type FolderAsset, type PassAsset, resolveAssets } from './assets.ts';
import {
	AutomationInputError,
	adjustmentTrackFor,
	automationSequence,
	basePictureTrack,
	type FrameGeometry,
	fpsValue,
	frameGeometry,
	passTrack,
	timecodeOf,
} from './common.ts';
import {
	AUTOMATION_DEFAULTS,
	type ReactionParams,
	ReactionParamsSchema,
	type ReactionSlot,
} from './params.ts';
import { itemSeed, seededRandom, weightedIndex } from './rng.ts';
import {
	frameWords,
	hiddenSpeakerRuns,
	markerTriggers,
	nearestCut,
	normalizeTriggerWord,
	overlapsRegions,
	pictureCutList,
	type ScreenRect,
	subtitleRegions,
	wordLists,
	wordsLanguage,
	wordTriggers,
} from './signals.ts';

export const REACTIONS_PASS = 'reactions' as const;

/**
 * The measured slots (FINDINGS §3; cluster centres of the user's reaction positions, rerunnable from the research's
 * events.csv): shorts — bottom left (flipped), bottom centre, bottom right with the shares 41 / 49 / 10 %; long form —
 * y 0.523 at x 0.15 (flipped) / 0.5 / 0.83 with 32 / 41 / 27 %.
 */
export const REACTION_SLOTS: { vertical: readonly ReactionSlot[]; landscape: readonly ReactionSlot[] } = {
	vertical: [
		{ name: 'Bottom left', x: 0.39, y: 0.87, flip: true, weight: 41 },
		{ name: 'Bottom centre', x: 0.47, y: 0.83, weight: 49 },
		{ name: 'Bottom right', x: 0.63, y: 0.85, weight: 10 },
	],
	landscape: [
		{ name: 'Left', x: 0.15, y: 0.523, flip: true, weight: 32 },
		{ name: 'Centre', x: 0.5, y: 0.523, weight: 41 },
		{ name: 'Right', x: 0.83, y: 0.523, weight: 27 },
	],
};

/** The built-in slot names (model strings: the dialog shows them translated). */
export const REACTION_MODEL_STRINGS: readonly string[] = [
	...new Set([...REACTION_SLOTS.vertical, ...REACTION_SLOTS.landscape].map((s) => s.name!).filter(Boolean)),
];

/** Name hints that make a picture fit a trigger (normalised substrings of the picture's name). */
const ASSET_HINTS: Record<string, readonly string[]> = {
	cta: ['subscri', 'suscri', 'follow', 'sigue', 'like', 'cta', 'bell', 'campan'],
	exclamation: [
		'surpris',
		'wow',
		'shock',
		'omg',
		'happy',
		'feliz',
		'laugh',
		'risa',
		'xd',
		'eee',
		'lol',
		'sorpres',
	],
};

/** Why a trigger got no reaction. */
export const REACTION_SKIP_CODES = ['overlap', 'rate', 'edge', 'subtitles', 'range'] as const;

export type ReactionTrigger = {
	kind: 'marker' | 'cta' | 'exclamation' | 'hidden';
	/** Stable identity (refresh finds the trigger again by it). */
	key: string;
	frame: number;
	text: string;
	clipId?: string;
	markerId?: string;
};

export type ReactionChoice = {
	asset: PassAsset;
	/** Motion scale (%) and the on-screen rectangle at the slot. */
	scale: number;
	rect: ScreenRect;
};

export type ReactionPlacement = {
	/** Proposal item id: `react:<trigger key>`. */
	id: string;
	frame: number;
	end: number;
	timecode: string;
	seed: number;
	trigger: ReactionTrigger;
	/** The cut it starts on (snapped), or null. */
	cut: { trackId: string; frame: number } | null;
	slot: ReactionSlot & { index: number };
	/** Sequence pixels of the picture's centre. */
	position: [number, number];
	flip: boolean;
	choice: ReactionChoice;
	/** Other pictures at the same slot (Review ⇄). */
	alternatives: ReactionChoice[];
	/** The A-roll clip under its first frame (anchor). */
	clipId: string | null;
};

export type ResolvedReactionParams = {
	slots: ReactionSlot[];
	frames: number;
	snapFrames: number;
	scaleMin: number;
	scaleMax: number;
	maxHeight: number;
	wobble: { enabled: boolean; amplitude: number; frequency: number };
	triggers: { words: boolean; markers: boolean; speakerNotVisible: boolean };
	words: { language: string | null; cta?: string[]; exclamations?: string[] };
	markerMatch: string;
	notVisibleFrames: number;
	maxPerMinute: number;
	minGapFrames: number;
	alternatives: number;
	seed: number;
	track?: string;
	reactionTrack?: string;
	range?: { start: number; end: number };
};

export type ReactionSkip = { frame: number; timecode: string; code: string; reason: string };

export type ReactionPlan = {
	pass: typeof REACTIONS_PASS;
	sequenceId: string;
	seed: number;
	reactions: ReactionPlacement[];
	/** Triggers found (after the range). */
	considered: number;
	triggers: Record<ReactionTrigger['kind'], number>;
	skipped: ReactionSkip[];
	assets: PassAsset[];
	setup: import('../proposals/schema.ts').ProposalItemInput[];
	reactionTrack:
		| { trackId: string; label: string; create: false }
		| { create: true; name: string; index?: number };
	wobble: ResolvedReactionParams['wobble'];
	warnings: { code: string; message: string }[];
};

export type ReactionContext = {
	/** The folder's files (engine), when the assets name a folder. */
	folder?: readonly FolderAsset[];
};

export function resolveReactionParams(
	raw: unknown,
	geo: Pick<FrameGeometry, 'fps' | 'vertical'>,
): ResolvedReactionParams & { assets: ReactionParams['assets'] } {
	const parsed = ReactionParamsSchema.safeParse(raw ?? {});
	if (!parsed.success)
		throw new AutomationInputError(
			'E_INVALID_PARAM',
			parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; '),
		);
	const p = parsed.data;
	const fps = fpsValue(geo.fps);
	const D = AUTOMATION_DEFAULTS;
	const sec = (s: number) => Math.max(0, Math.round(s * fps));
	const lang = p.words?.language && p.words.language !== 'auto' ? p.words.language.toLowerCase() : null;
	return {
		assets: p.assets,
		slots: (p.slots ?? (geo.vertical ? REACTION_SLOTS.vertical : REACTION_SLOTS.landscape)).map((s) => ({
			...s,
		})),
		frames: Math.max(
			1,
			sec(p.durationSeconds ?? (geo.vertical ? D.reactionSecondsVertical : D.reactionSecondsLandscape)),
		),
		snapFrames: sec(p.snapSeconds ?? D.reactionSnapSeconds),
		scaleMin: p.scale?.min ?? D.reactionScaleMin,
		scaleMax: p.scale?.max ?? D.reactionScaleMax,
		maxHeight: p.maxHeight ?? D.reactionMaxHeight,
		wobble: {
			enabled: p.wobble?.enabled ?? true,
			amplitude: p.wobble?.amplitude ?? D.reactionWobbleAmplitude,
			frequency: p.wobble?.frequency ?? D.reactionWobbleFrequency,
		},
		triggers: {
			words: p.triggers?.words ?? true,
			markers: p.triggers?.markers ?? true,
			speakerNotVisible: p.triggers?.speakerNotVisible ?? false,
		},
		words: {
			language: lang,
			...(p.words?.cta ? { cta: p.words.cta } : {}),
			...(p.words?.exclamations ? { exclamations: p.words.exclamations } : {}),
		},
		markerMatch: p.markerMatch ?? D.reactionMarkerMatch,
		notVisibleFrames: Math.max(1, sec(p.notVisibleSeconds ?? D.reactionNotVisibleSeconds)),
		maxPerMinute:
			p.maxPerMinute ?? (geo.vertical ? D.reactionMaxPerMinuteVertical : D.reactionMaxPerMinuteLandscape),
		minGapFrames: sec(p.minGapSeconds ?? D.reactionMinGapSeconds),
		alternatives: p.alternatives ?? D.reactionAlternatives,
		seed: p.seed ?? D.seed,
		...(p.track !== undefined ? { track: p.track } : {}),
		...(p.reactionTrack !== undefined ? { reactionTrack: p.reactionTrack } : {}),
		...(p.range ? { range: p.range } : {}),
	};
}

const PRIORITY: Record<ReactionTrigger['kind'], number> = { marker: 0, cta: 1, exclamation: 2, hidden: 3 };

/** The triggers of the sequence (range applied), and whether face tracking exists when it was asked for. */
export function reactionTriggers(
	doc: ProjectDocument,
	seq: Sequence,
	params: ResolvedReactionParams,
	aRoll: Track | null,
	assetNames: readonly string[],
): { triggers: ReactionTrigger[]; warnings: { code: string; message: string }[] } {
	const out: ReactionTrigger[] = [];
	const warnings: { code: string; message: string }[] = [];
	if (params.triggers.markers)
		for (const m of markerTriggers(seq, params.markerMatch, assetNames))
			out.push({
				kind: 'marker',
				key: `marker:${m.markerId || m.frame}`,
				frame: m.frame,
				text: m.name,
				markerId: m.markerId,
			});
	if (params.triggers.words) {
		const words = frameWords(doc, seq);
		if (!words.length)
			warnings.push({
				code: 'W_NO_WORDS',
				message:
					'The sequence has no transcript words: calls to action and exclamations cannot trigger reactions (transcribe it first)',
			});
		const lists = wordLists(params.words.language ?? wordsLanguage(doc, seq), params.words);
		for (const w of wordTriggers(words, lists))
			out.push({
				kind: w.kind,
				key: `word:${w.clipId}:${w.index}`,
				frame: w.frame,
				text: w.text,
				clipId: w.clipId,
			});
	}
	if (params.triggers.speakerNotVisible) {
		const r = aRoll
			? hiddenSpeakerRuns(seq, aRoll, params.notVisibleFrames, params.range)
			: { runs: [], tracked: false };
		if (!r.tracked)
			warnings.push({
				code: 'W_NO_FACES',
				message:
					'No A-roll clip has face tracking: "speaker not visible" needs Track Faces on the A-roll first',
			});
		for (const h of r.runs)
			out.push({
				kind: 'hidden',
				key: `hidden:${h.clipId}:${h.frame}`,
				frame: h.frame,
				text: 'speaker not visible',
				clipId: h.clipId,
			});
	}
	const inRange = params.range
		? out.filter((t) => t.frame >= params.range!.start && t.frame < params.range!.end)
		: out;
	return { triggers: inRange, warnings };
}

/** The Motion scale of `asset` for the draw `u` ∈ [0, 1): in [min, max], capped at `maxHeight` of the frame. */
function scaleFor(asset: PassAsset, u: number, p: ResolvedReactionParams, geo: FrameGeometry): number {
	let s = p.scaleMin + (p.scaleMax - p.scaleMin) * u;
	if (asset.height && asset.height > 0) s = Math.min(s, ((p.maxHeight * geo.height) / asset.height) * 100);
	return Math.max(1, Math.round(s * 10) / 10);
}

/** The rectangle of `asset` at `slot` and `scale` (unknown size: a square of a quarter of the short side). */
function rectFor(asset: PassAsset, slot: ReactionSlot, scale: number, geo: FrameGeometry): ScreenRect {
	const side = Math.min(geo.width, geo.height) / 4;
	const w = asset.width && asset.width > 0 ? (asset.width * scale) / 100 : side;
	const h = asset.height && asset.height > 0 ? (asset.height * scale) / 100 : side;
	const cx = slot.x * geo.width;
	const cy = slot.y * geo.height;
	return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
}

/** Pictures in the order a trigger prefers them: a marker naming one, then name hints of the kind, then the others. */
function preferred(assets: readonly PassAsset[], t: ReactionTrigger, rng: () => number): PassAsset[] {
	const shuffled = assets
		.map((a) => ({ a, r: rng() }))
		.sort((x, y) => x.r - y.r)
		.map((x) => x.a);
	const name = (a: PassAsset) => normalizeTriggerWord(a.name);
	if (t.kind === 'marker') {
		const n = normalizeTriggerWord(t.text);
		const exact = shuffled.filter((a) => name(a) === n || n.includes(name(a)));
		if (exact.length) return [...exact, ...shuffled.filter((a) => !exact.includes(a))];
	}
	const hints = ASSET_HINTS[t.kind];
	if (hints) {
		const hit = shuffled.filter((a) => hints.some((h) => name(a).includes(h)));
		if (hit.length) return [...hit, ...shuffled.filter((a) => !hit.includes(a))];
	}
	return shuffled;
}

type Timing = {
	trigger: ReactionTrigger;
	start: number;
	end: number;
	cut: { trackId: string; frame: number } | null;
};

/** Whether a span keeps the rate cap with the accepted starts (every 60 s window holds at most `cap`). */
function rateOk(starts: readonly number[], start: number, cap: number, minute: number): boolean {
	if (cap <= 0) return false;
	const all = [...starts, start].sort((a, b) => a - b);
	const k = Math.floor(cap);
	if (all.length <= k) return true;
	for (let i = 0; i + k < all.length; i++) if (all[i + k]! - all[i]! < minute) return false;
	return true;
}

/** Slot, picture and scale of one reaction from its seed (`avoid`: the previous reaction's picture and slot). */
function chooseAt(
	t: Timing,
	seed: number,
	p: ResolvedReactionParams,
	geo: FrameGeometry,
	assets: readonly PassAsset[],
	regions: ReturnType<typeof subtitleRegions>,
	avoid: { asset?: string; slot?: number },
): Omit<ReactionPlacement, 'id' | 'timecode' | 'clipId'> | null {
	const rng = seededRandom(seed);
	const u = rng();
	const order = preferred(assets, t.trigger, rng);
	const pictures =
		order.length > 1 && avoid.asset
			? [...order.filter((a) => a.key !== avoid.asset), ...order.filter((a) => a.key === avoid.asset)]
			: order;
	const slotDraw = rng();
	// slots by weight, the previous reaction's slot last when another fits
	const weights = p.slots.map((s, i) => (i === avoid.slot && p.slots.length > 1 ? 0 : (s.weight ?? 1)));
	const first = weightedIndex(weights, slotDraw);
	const slotOrder = [
		...(first >= 0 ? [first] : []),
		...p.slots.map((_, i) => i).filter((i) => i !== first && i !== avoid.slot),
		...(avoid.slot !== undefined && avoid.slot !== first ? [avoid.slot] : []),
	].filter((i) => i >= 0 && i < p.slots.length);
	for (const asset of pictures.slice(0, Math.max(1, Math.min(pictures.length, 4)))) {
		const scale = scaleFor(asset, u, p, geo);
		for (const si of slotOrder) {
			const slot = p.slots[si]!;
			const rect = rectFor(asset, slot, scale, geo);
			if (overlapsRegions(regions, t.start, t.end, rect)) continue;
			const alternatives: ReactionChoice[] = [];
			for (const a of pictures) {
				if (alternatives.length >= p.alternatives) break;
				if (a.key === asset.key) continue;
				const s = scaleFor(a, u, p, geo);
				const r = rectFor(a, slot, s, geo);
				if (!overlapsRegions(regions, t.start, t.end, r)) alternatives.push({ asset: a, scale: s, rect: r });
			}
			return {
				frame: t.start,
				end: t.end,
				seed,
				trigger: t.trigger,
				cut: t.cut,
				slot: { ...slot, index: si },
				position: [Math.round(slot.x * geo.width * 100) / 100, Math.round(slot.y * geo.height * 100) / 100],
				flip: slot.flip === true,
				choice: { asset, scale, rect },
				alternatives,
			};
		}
	}
	return null;
}

function clipUnder(seq: Sequence, track: Track | null, frame: number): string | null {
	if (!track) return null;
	for (const c of Object.values(seq.clips ?? {}))
		if (c.trackId === track.id && c.start <= frame && c.start + c.duration > frame) return c.id;
	return null;
}

/** The track of the reactions: explicit, a free "Reactions" track above the A-roll, else a new one below any "FX". */
function reactionTrackOf(
	seq: Sequence,
	p: ResolvedReactionParams,
	aRoll: Track | null,
	spans: [number, number][],
) {
	const ai = aRoll ? seq.videoTracks.findIndex((t) => t.id === aRoll.id) : -1;
	const r = adjustmentTrackFor(seq, spans, {
		name: 'Reactions',
		...(p.reactionTrack !== undefined ? { ref: p.reactionTrack } : {}),
		minIndex: ai + 1,
	});
	if (!r.create) return r;
	// below the first FX track above the A-roll (cut kits then shake the reactions too, like the user's stacks)
	const fx = seq.videoTracks.findIndex((t, i) => i > ai && /^FX(?: \d+)?$/i.test((t.name ?? '').trim()));
	return fx >= 0
		? { create: true as const, name: r.name, index: fx }
		: { create: true as const, name: r.name };
}

/** Plans the reactions of a sequence (see the file comment). Throws `AutomationInputError` for an invalid request. */
export function planReactions(
	doc: ProjectDocument,
	sequenceId: string | null | undefined,
	rawParams: unknown,
	ctx: ReactionContext = {},
): ReactionPlan {
	const seq = automationSequence(doc, sequenceId);
	const geo = frameGeometry(seq);
	const p = resolveReactionParams(rawParams, geo);
	const aRoll = p.track !== undefined ? passTrack(seq, p.track) : basePictureTrack(seq);
	const res = resolveAssets(doc, p.assets, 'image', {
		...(ctx.folder ? { folder: ctx.folder } : {}),
		binName: 'Reactions',
		prefix: 'react',
	});
	const warnings = [...res.warnings];
	const cuts = pictureCutList(doc, seq, p.track);
	const cutFramesList = cuts.map((c) => c.frame);
	const regions = subtitleRegions(doc, seq);
	const tr = reactionTriggers(
		doc,
		seq,
		p,
		aRoll,
		res.assets.map((a) => a.name),
	);
	warnings.push(...tr.warnings);
	const counts: ReactionPlan['triggers'] = { marker: 0, cta: 0, exclamation: 0, hidden: 0 };
	for (const t of tr.triggers) counts[t.kind]++;
	const skipped: ReactionSkip[] = [];
	const skip = (frame: number, code: string, reason: string) =>
		skipped.push({ frame, timecode: timecodeOf(seq, frame), code, reason });
	const end = p.range ? Math.min(p.range.end, geo.duration) : geo.duration;
	const minute = Math.round(60 * fpsValue(geo.fps));
	const minLen = Math.max(1, Math.round(0.5 * fpsValue(geo.fps)));
	// 1. timing, in priority order (the rate budget goes to markers first)
	const ordered = [...tr.triggers].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.frame - b.frame);
	const accepted: Timing[] = [];
	const seenKeys = new Set<string>();
	for (const t of ordered) {
		if (seenKeys.has(t.key)) continue;
		seenKeys.add(t.key);
		const snapped = nearestCut(cutFramesList, t.frame, p.snapFrames);
		const start = Math.max(snapped ?? t.frame, p.range?.start ?? 0);
		const stop = Math.min(start + p.frames, end);
		if (stop - start < Math.min(minLen, p.frames)) {
			skip(t.frame, 'edge', 'too close to the end of the sequence or range');
			continue;
		}
		if (accepted.some((a) => start < a.end + p.minGapFrames && a.start < stop + p.minGapFrames)) {
			skip(t.frame, 'overlap', 'another reaction is on screen then');
			continue;
		}
		if (
			!rateOk(
				accepted.map((a) => a.start),
				start,
				p.maxPerMinute,
				minute,
			)
		) {
			skip(t.frame, 'rate', `over ${p.maxPerMinute} reactions in a minute`);
			continue;
		}
		const cut = snapped !== null ? (cuts.find((c) => c.frame === snapped) ?? null) : null;
		accepted.push({
			trigger: t,
			start,
			end: stop,
			cut: cut ? { trackId: cut.trackId, frame: cut.frame } : null,
		});
	}
	// 2. slot, picture and scale, in time order (no picture or slot twice in a row when another fits)
	const reactions: ReactionPlacement[] = [];
	if (!res.assets.length) {
		if (!warnings.some((w) => w.code === 'W_NO_ASSETS'))
			warnings.push({ code: 'W_NO_ASSETS', message: 'No reaction images in the chosen source' });
	} else {
		let prev: ReactionPlacement | null = null;
		for (const t of accepted.sort((a, b) => a.start - b.start)) {
			const seed = itemSeed(p.seed, REACTIONS_PASS, t.trigger.key);
			const c = chooseAt(t, seed, p, geo, res.assets, regions, {
				...(prev ? { asset: prev.choice.asset.key, slot: prev.slot.index } : {}),
			});
			if (!c) {
				skip(t.trigger.frame, 'subtitles', 'every slot is covered by subtitles then');
				continue;
			}
			const r: ReactionPlacement = {
				...c,
				id: `react:${t.trigger.key}`,
				timecode: timecodeOf(seq, t.start),
				clipId: clipUnder(seq, aRoll, t.start),
			};
			reactions.push(r);
			prev = r;
		}
	}
	const spans: [number, number][] = reactions.map((r) => [r.frame, r.end]);
	return {
		pass: REACTIONS_PASS,
		sequenceId: seq.id,
		seed: p.seed,
		reactions,
		considered: tr.triggers.length,
		triggers: counts,
		skipped: skipped.sort((a, b) => a.frame - b.frame),
		assets: res.assets,
		setup: res.setup,
		reactionTrack: reactionTrackOf(seq, p, aRoll, spans),
		wobble: p.wobble,
		warnings,
	};
}

/**
 * Re-plans single reactions (Refresh / Reroll): each target's trigger is found again by its key on the current
 * document, timed and drawn with the target's seed between the `neighbours` (the proposal's other reactions).
 */
export function replanReactions(
	doc: ProjectDocument,
	sequenceId: string | null | undefined,
	rawParams: unknown,
	targets: readonly { itemId: string; seed: number; key: string; frame: number }[],
	neighbours: readonly { start: number; end: number }[],
	ctx: ReactionContext = {},
): (
	| { itemId: string; ok: true; reaction: ReactionPlacement }
	| { itemId: string; ok: false; reason: string }
)[] {
	const seq = automationSequence(doc, sequenceId);
	const geo = frameGeometry(seq);
	const p = resolveReactionParams(rawParams, geo);
	const aRoll = p.track !== undefined ? passTrack(seq, p.track) : basePictureTrack(seq);
	const res = resolveAssets(doc, p.assets, 'image', {
		...(ctx.folder ? { folder: ctx.folder } : {}),
		binName: 'Reactions',
		prefix: 'react',
	});
	const cuts = pictureCutList(doc, seq, p.track);
	const regions = subtitleRegions(doc, seq);
	const { triggers } = reactionTriggers(
		doc,
		seq,
		{ ...p, range: undefined } as ResolvedReactionParams,
		aRoll,
		res.assets.map((a) => a.name),
	);
	const end = geo.duration;
	const placed = neighbours.map((n) => ({ ...n }));
	return targets.map((tg) => {
		let t = triggers.find((x) => x.key === tg.key);
		if (!t && tg.key.startsWith('hidden:')) {
			const clip = tg.key.split(':')[1];
			t = triggers
				.filter((x) => x.kind === 'hidden' && x.clipId === clip)
				.sort((a, b) => Math.abs(a.frame - tg.frame) - Math.abs(b.frame - tg.frame))[0];
		}
		if (!t)
			return {
				itemId: tg.itemId,
				ok: false as const,
				reason: 'its trigger (word, marker or face-less stretch) is gone',
			};
		if (!res.assets.length)
			return { itemId: tg.itemId, ok: false as const, reason: 'the reaction images are gone' };
		const snapped = nearestCut(
			cuts.map((c) => c.frame),
			t.frame,
			p.snapFrames,
		);
		const start = snapped ?? t.frame;
		const stop = Math.min(start + p.frames, end);
		if (stop <= start)
			return {
				itemId: tg.itemId,
				ok: false as const,
				reason: 'it would start after the end of the sequence',
			};
		if (placed.some((n) => start < n.end + p.minGapFrames && n.start < stop + p.minGapFrames))
			return {
				itemId: tg.itemId,
				ok: false as const,
				reason: 'another reaction of the proposal is on screen then',
			};
		const cut = snapped !== null ? (cuts.find((c) => c.frame === snapped) ?? null) : null;
		const c = chooseAt(
			{ trigger: t, start, end: stop, cut: cut ? { trackId: cut.trackId, frame: cut.frame } : null },
			tg.seed,
			p,
			geo,
			res.assets,
			regions,
			{},
		);
		if (!c)
			return { itemId: tg.itemId, ok: false as const, reason: 'every slot is covered by subtitles then' };
		placed.push({ start, end: stop });
		return {
			itemId: tg.itemId,
			ok: true as const,
			reaction: {
				...c,
				id: tg.itemId,
				timecode: timecodeOf(seq, start),
				clipId: clipUnder(seq, aRoll, start),
			},
		};
	});
}

/** Flicks of `frames` sequence frames (a still's source range for a reaction of that length). */
export function reactionSourceFlicks(seq: Sequence, frames: number): number {
	return frames * flicksPerFrame(frameGeometry(seq).fps);
}
