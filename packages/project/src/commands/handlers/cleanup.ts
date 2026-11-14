// Transcript cleanup commands (spec 14 TC-030, TC-031): `cleanup.apply` cuts any number of ranges as one edit (one
// undo step) and `cleanup.configure` edits the sequence's persisted cleanup state. docs/wp-notes/transcript-cleanup.md
// "Commands".

import type { Draft } from 'immer';
import { type SeqWord, transcriptForMedia } from '../../captions/sequence-transcript.ts';
import type { CleanupVoice } from '../../cleanup/detector.ts';
import { planMediaCuts } from '../../cleanup/plan.ts';
import {
	CLEANUP_MAX_REJECTED,
	type CleanupLists,
	type CleanupOverrides,
	FAST_SETTINGS,
	mergeCleanupSettings,
	readSequenceCleanup,
	type SequenceCleanup,
	sequenceCleanupIssue,
} from '../../cleanup/schema.ts';
import { keptToFrames } from '../../cleanup/sequence.ts';
import { decodeVoiceAnalysis } from '../../cleanup/voice-analysis.ts';
import { contentTimeAt } from '../../derive/index.ts';
import { evaluate } from '../../keyframes.ts';
import type { Animatable } from '../../schema/common.ts';
import type { Clip } from '../../schema/sequence.ts';
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational } from '../../time.ts';
import { isRemapped } from '../../time-remap/model.ts';
import { base64Bytes } from '../base64.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import { cutRanges } from '../multi-range.ts';
import { end, findTrackIn } from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import { newKeyframe } from './param.ts';
import type { HandlerMap } from './util.ts';

export const CLEANUP_OWNER = 'transcript-cleanup';

/** Level of a muted range (dB): the Volume minimum, silence for every renderer (`dbToGain`). */
const MUTE_DB = -96;
/** Shortest mute ramp (ms) when `fadeMs` is 0: a step in level clicks. */
const MUTE_MIN_FADE_MS = 1;

type RangeResult = { index: number; start: number; end: number; applied: boolean; reason?: string };

/** Sorted, merged ranges (touching ones join). */
function mergeFrameRanges(list: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
	const s = [...list].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const out: Array<[number, number]> = [];
	for (const [a, b] of s) {
		const l = out[out.length - 1];
		if (l && a <= l[1]) l[1] = Math.max(l[1], b);
		else out.push([a, b]);
	}
	return out;
}

/** The clips a cleanup edit cuts: the speech clips with their linked partners and clip-group members. */
function targetClips(seq: DSeq, speech: ReadonlySet<string>): Set<string> {
	const out = new Set(speech);
	for (const id of speech) {
		const c = seq.clips[id];
		if (!c) continue;
		if (c.linkId) for (const m of seq.links[c.linkId]?.members ?? []) if (seq.clips[m]) out.add(m);
		if (c.groupId) for (const m of seq.groups[c.groupId]?.members ?? []) if (seq.clips[m]) out.add(m);
	}
	return out;
}

function applyCleanup(doc: DDoc, cmd: CommandOf<'cleanup.apply'>, h: HandlerContext) {
	const seq = h.sequence(doc, cmd.sequenceId);
	const rate = seq.settings.frameRate as Rational;
	const F = flicksPerFrame(rate);
	const mode = cmd.mode ?? 'extract';
	// speech clips
	const speech = new Set<string>();
	for (const id of cmd.clipIds ?? []) {
		if (!seq.clips[id]) h.fail('E_NOT_FOUND', `Clip ${id} is not in sequence ${seq.id}`);
		speech.add(id);
	}
	const results: RangeResult[] = [];
	const frames: Array<[number, number]> = [];
	const retimed: string[] = [];
	for (const [index, r] of cmd.ranges.entries()) {
		if (r.end <= r.start)
			h.fail('E_INVALID_PARAM', `Range ${index} is empty (end ${r.end} <= start ${r.start})`);
		if ('clipId' in r) {
			const c = seq.clips[r.clipId];
			if (!c) return h.fail('E_NOT_FOUND', `Clip ${r.clipId} (range ${index}) is not in sequence ${seq.id}`);
			if (c.speed.reverse || c.speed.rate !== 1 || isRemapped(c as Clip)) {
				retimed.push(c.id);
				continue;
			}
			speech.add(c.id);
			const a = Math.max(c.start, Math.round(c.start + (r.start - c.sourceIn) / F));
			const b = Math.min(end(c), Math.round(c.start + (r.end - c.sourceIn) / F));
			if (b <= a) {
				results.push({ index, start: a, end: Math.max(a, b), applied: false, reason: 'outside the clip' });
				continue;
			}
			frames.push([a, b]);
			results.push({ index, start: a, end: b, applied: true });
		} else {
			frames.push([r.start, r.end]);
			results.push({ index, start: r.start, end: r.end, applied: true });
		}
	}
	if (retimed.length)
		h.fail(
			'E_UNSUPPORTED',
			`Source ranges need clips at 100 % speed, not reversed or time-remapped: ${[...new Set(retimed)].join(', ')}`,
			{ blocking: [...new Set(retimed)] },
		);
	if (!speech.size) {
		// every transcribed audio clip
		const audioTracks = new Set(seq.audioTracks.map((t) => t.id));
		for (const c of Object.values(seq.clips))
			if (c.kind === 'audio' && c.enabled && audioTracks.has(c.trackId) && transcriptForMedia(doc, c.mediaId))
				speech.add(c.id);
	}
	if (!speech.size)
		h.fail('E_INVALID_PARAM', 'No speech clip: pass clipIds (no transcribed audio clip found)');
	const ranges = mergeFrameRanges(frames);
	const targets = targetClips(seq, speech);
	const trackIds = new Set<string>();
	const lockedBy: string[] = [];
	for (const id of targets) {
		const c = seq.clips[id]!;
		const t = findTrackIn(seq, c.trackId)?.track;
		if (!t) continue;
		if (t.locked) lockedBy.push(id);
		else trackIds.add(t.id);
	}
	if (lockedBy.length)
		h.fail('E_TRACK_LOCKED', 'A speech clip or a clip linked or grouped with it is on a locked track', {
			blocking: lockedBy,
		});
	const base = {
		mode,
		ranges: results,
		merged: ranges.length,
		clipIds: [...speech],
	};
	if (!ranges.length) {
		if (cmd.pieceRefs && (mode === 'extract' || mode === 'lift'))
			definePieceRefs(seq, [...trackIds], new Map(), cmd.pieceRefs, h);
		return { ...base, frames: 0, joins: 0, tracks: [], fades: 0 };
	}
	if (mode === 'extract' || mode === 'lift') {
		const r = cutRanges(doc, seq, h, {
			ranges,
			trackIds,
			ripple: mode === 'extract',
			fadeMs: cmd.fadeMs ?? 0,
			jlFrames: cmd.jlFrames ?? 0,
		});
		if (cmd.pieceRefs) definePieceRefs(seq, r.tracks, r.origins, cmd.pieceRefs, h);
		return { ...base, frames: r.frames, joins: r.joins, tracks: r.tracks, fades: r.fades, jl: r.jl };
	}
	if (mode === 'markers') {
		for (const [a, b] of ranges)
			seq.markers.push({
				id: h.ids.next('mrk'),
				frame: a,
				duration: b - a,
				name: cmd.markerName ?? 'Clean Up',
				comment: '',
				color: 'rose',
				type: 'comment',
				author: h.agentAuthor(),
			});
		seq.markers.sort((x, y) => x.frame - y.frame);
		return { ...base, frames: 0, joins: 0, tracks: [], fades: 0, markers: ranges.length };
	}
	// mute: Volume keys on the audio clips of the target tracks
	const audioTracks = new Set(seq.audioTracks.map((t) => t.id));
	const fadeS = Math.max(MUTE_MIN_FADE_MS, cmd.fadeMs ?? 0) / 1000;
	let muted = 0;
	const unsupported: string[] = [];
	for (const c of Object.values(seq.clips)) {
		if (c.kind !== 'audio' || !trackIds.has(c.trackId) || !audioTracks.has(c.trackId)) continue;
		const hits = ranges.filter(([a, b]) => a < end(c) && b > c.start);
		if (!hits.length) continue;
		if (c.speed.reverse || isRemapped(c as Clip)) {
			unsupported.push(c.id);
			continue;
		}
		muteClip(c, hits, rate, fadeS, h);
		muted++;
	}
	if (unsupported.length)
		h.fail(
			'E_UNSUPPORTED',
			`Mute needs forward clips that are not time-remapped: ${unsupported.join(', ')}`,
			{
				blocking: unsupported,
			},
		);
	return { ...base, frames: 0, joins: 0, tracks: [...trackIds], fades: 0, mutedClips: muted };
}

/**
 * `<prefix>_<clipId>_<k>` for the k-th piece (time order) of every clip left on the edited tracks after the cut (see
 * the command's `pieceRefs`): later commands of the transaction address the cleaned-up timeline by these names.
 */
function definePieceRefs(
	seq: DSeq,
	trackIds: readonly string[],
	origins: ReadonlyMap<string, string>,
	prefix: string,
	h: HandlerContext,
) {
	const tracks = new Set(trackIds);
	const byOrigin = new Map<string, DClip[]>();
	for (const c of Object.values(seq.clips)) {
		if (!tracks.has(c.trackId)) continue;
		const o = origins.get(c.id) ?? c.id;
		const list = byOrigin.get(o);
		if (list) list.push(c);
		else byOrigin.set(o, [c]);
	}
	for (const [origin, pieces] of byOrigin) {
		pieces.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
		for (const [k, c] of pieces.entries()) h.defineRef(`${prefix}_${origin}_${k}`, c.id);
	}
}

/** Volume keys holding −96 dB over each range, ramping over `fadeS` (content seconds × speed) on both sides. */
function muteClip(
	c: DClip,
	hits: ReadonlyArray<readonly [number, number]>,
	rate: Rational,
	fadeS: number,
	h: HandlerContext,
) {
	const vol = (c as unknown as { volumeDb: Draft<Animatable<number>> }).volumeDb;
	const orig: Animatable<number> = {
		value: vol.value,
		keyframes: vol.keyframes.map((k) => ({ ...k })) as never,
	};
	const c0 = c.sourceIn;
	const c1 = contentTimeAt(c, end(c), rate);
	const fadeC = fadeS * FLICKS_PER_SECOND * c.speed.rate;
	type Iv = { a: number; b: number };
	const ivs: Iv[] = hits.map(([a, b]) => ({
		a: contentTimeAt(c, Math.max(a, c.start), rate),
		b: contentTimeAt(c, Math.min(b, end(c)), rate),
	}));
	const keys: Array<{ t: number; v: number }> = [];
	for (let i = 0; i < ivs.length; i++) {
		const { a, b } = ivs[i]!;
		const prevB = i > 0 ? ivs[i - 1]!.b : Number.NEGATIVE_INFINITY;
		const nextA = i + 1 < ivs.length ? ivs[i + 1]!.a : Number.POSITIVE_INFINITY;
		const down = Math.min(fadeC, (a - prevB) / 2, a - c0);
		const up = Math.min(fadeC, (nextA - b) / 2, c1 - b);
		if (down > 0) keys.push({ t: Math.round(a - down), v: evaluate(orig, Math.round(a - down)) });
		keys.push({ t: Math.round(a), v: MUTE_DB });
		keys.push({ t: Math.round(b), v: MUTE_DB });
		if (up > 0) keys.push({ t: Math.round(b + up), v: evaluate(orig, Math.round(b + up)) });
	}
	// drop the clip's own keys inside each muted span (ramps included); keep the rest
	const inside = (t: number) => {
		for (let i = 0; i < ivs.length; i++) {
			const lo = Math.round(ivs[i]!.a - Math.min(fadeC, ivs[i]!.a - c0));
			const hi = Math.round(ivs[i]!.b + Math.min(fadeC, c1 - ivs[i]!.b));
			if (t >= lo && t <= hi) return true;
		}
		return false;
	};
	// a static level becomes keys at its value around the ranges
	const kept = vol.keyframes.filter((k) => !inside(k.time));
	const merged = [...kept.map((k) => ({ t: k.time, k }))];
	for (const k of keys) {
		if (merged.some((m) => m.t === k.t)) continue;
		merged.push({ t: k.t, k: newKeyframe(h, k.t, k.v, false) as never });
	}
	merged.sort((x, y) => x.t - y.t);
	vol.keyframes = merged.map((m) => m.k) as never;
}

function configureCleanup(doc: DDoc, cmd: CommandOf<'cleanup.configure'>, h: HandlerContext) {
	const seq = h.sequence(doc, cmd.sequenceId);
	const cur = readSequenceCleanup(seq as { cleanup?: unknown });
	const next: SequenceCleanup = JSON.parse(JSON.stringify(cur));
	if (cmd.settings === null) delete next.settings;
	else if (cmd.settings) {
		const s: NonNullable<SequenceCleanup['settings']> = {};
		const pid = cmd.settings.presetId ?? (cmd.mergeOverrides ? next.settings?.presetId : undefined);
		if (pid) s.presetId = pid;
		let ov: CleanupOverrides | undefined = cmd.settings.overrides;
		if (cmd.mergeOverrides && next.settings?.overrides) {
			const o = next.settings.overrides;
			const n = cmd.settings.overrides ?? {};
			ov = {} as CleanupOverrides;
			for (const g of ['rules', 'thresholds', 'edges', 'gaps', 'guards', 'joins'] as const) {
				const merged = { ...(o[g] ?? {}), ...(n[g] ?? {}) };
				if (Object.keys(merged).length) (ov as Record<string, unknown>)[g] = merged;
			}
		}
		if (ov && Object.keys(ov).length) s.overrides = ov;
		if (Object.keys(s).length) next.settings = s;
		else delete next.settings;
	}
	if (cmd.script === null) delete next.script;
	else if (cmd.script) next.script = { name: cmd.script.name, text: cmd.script.text };
	if (cmd.lists) {
		const lists: Record<string, CleanupLists> = { ...(next.lists ?? {}) };
		for (const [lang, l] of Object.entries(cmd.lists)) {
			if (l === null) delete lists[lang];
			else lists[lang] = { ...(lists[lang] ?? {}), ...l };
		}
		if (Object.keys(lists).length) next.lists = lists;
		else delete next.lists;
	}
	if (cmd.clearRejected || cmd.reject || cmd.unreject) {
		const rej = new Set(cmd.clearRejected ? [] : (next.rejected ?? []));
		for (const f of cmd.unreject ?? []) rej.delete(f);
		for (const f of cmd.reject ?? []) rej.add(f);
		if (rej.size > CLEANUP_MAX_REJECTED)
			h.fail('E_LIMIT', `At most ${CLEANUP_MAX_REJECTED} rejected findings per sequence (${rej.size} given)`);
		if (rej.size) next.rejected = [...rej];
		else delete next.rejected;
	}
	const bad = sequenceCleanupIssue(next);
	if (bad) h.fail('E_INVALID_PARAM', `Cleanup settings: ${bad}`);
	const r = seq as unknown as { cleanup?: SequenceCleanup };
	if (Object.keys(next).length) r.cleanup = next;
	else delete r.cleanup;
	return {
		presetId: next.settings?.presetId ?? 'builtin.fast',
		script: next.script ? { name: next.script.name, characters: next.script.text.length } : null,
		rejected: next.rejected?.length ?? 0,
		lists: Object.keys(next.lists ?? {}),
	};
}

export const cleanupHandlers = {
	'cleanup.apply': applyCleanup,
	'cleanup.configure': configureCleanup,
} satisfies HandlerMap;

// ---------------------------------------------------------------------------------------------------------------
// transcript.removePauses `mode: 'level'` (spec 14 TC-032)

/** Decoded voice analyses of a `voice` argument, by media id (refused when one does not decode). */
export function voiceArgument(
	list: ReadonlyArray<{ mediaId: string; analysis: string }> | undefined,
	h: HandlerContext,
): Map<string, CleanupVoice> {
	const out = new Map<string, CleanupVoice>();
	for (const v of list ?? []) {
		const bytes = base64Bytes(v.analysis);
		if (!bytes) h.fail('E_INVALID_PARAM', `voice analysis of ${v.mediaId} is not base64`);
		const r = decodeVoiceAnalysis(bytes);
		if (!r.ok) h.fail('E_INVALID_PARAM', `voice analysis of ${v.mediaId}: ${r.error}`);
		out.set(v.mediaId, r.analysis);
	}
	return out;
}

/**
 * Level-mode pauses (TC-032): per transcribed clip, the cleanup planner with every word kept, gaps longer than
 * `minSeconds` cut, edges placed from the voice analysis's levels (`outDb` / `inDb` above the floor) with the given
 * pads. Only time between the selected words is removed (as transcript mode does). Sequence frame ranges.
 */
export function levelPauseRanges(
	seq: DSeq,
	words: readonly SeqWord[],
	voices: ReadonlyMap<string, CleanupVoice>,
	o: { minSeconds: number; padBefore: number; padAfter: number; outDb: number; inDb: number },
	h: HandlerContext,
): Array<[number, number]> {
	const rate = seq.settings.frameRate as Rational;
	const settings = mergeCleanupSettings(FAST_SETTINGS, {
		edges: {
			mode: 'level',
			reference: 'floor',
			outDb: o.outDb,
			inDb: o.inDb,
			padBeforeS: o.padBefore,
			padAfterS: o.padAfter,
		},
		gaps: { maxGapS: o.minSeconds, keepGapS: 0, keepGapSentenceS: 0, breath: 'remove' },
		guards: { minPieceS: 0 },
	});
	const byClip = new Map<string, SeqWord[]>();
	for (const w of words) {
		const list = byClip.get(w.clipId);
		if (list) list.push(w);
		else byClip.set(w.clipId, [w]);
	}
	const out: Array<[number, number]> = [];
	const missing = new Set<string>();
	const retimed: string[] = [];
	for (const [clipId, ws] of byClip) {
		const clip = seq.clips[clipId] as DClip | undefined;
		if (clip?.kind !== 'audio') continue;
		if (clip.speed.reverse || clip.speed.rate !== 1 || isRemapped(clip as Clip)) {
			retimed.push(clipId);
			continue;
		}
		const voice = voices.get(clip.mediaId);
		if (!voice) {
			missing.add(clip.mediaId);
			continue;
		}
		const F = flicksPerFrame(rate);
		// sequence word times → media seconds (speed 1)
		const aw = ws.map((w, k) => {
			const s = (clip.sourceIn + (w.start - clip.start * F)) / FLICKS_PER_SECOND;
			const e = (clip.sourceIn + (w.end - clip.start * F)) / FLICKS_PER_SECOND;
			return { i: k, n: 'w', s, e, text: w.text, conf: w.confidence };
		});
		const plan = planMediaCuts({ words: aw, removed: aw.map(() => false), voice, settings });
		const extent: [number, number] = [clip.start, end(clip)];
		const kept = keptToFrames(clip, rate, voice, plan.kept, settings.edges.snapWindowS, extent);
		for (let i = 0; i + 1 < kept.length; i++)
			if (kept[i + 1]![0] > kept[i]![1]) out.push([kept[i]![1], kept[i + 1]![0]]);
	}
	if (retimed.length)
		h.fail(
			'E_UNSUPPORTED',
			`Level mode needs clips at 100 % speed, not reversed or remapped: ${retimed.join(', ')}`,
			{
				blocking: retimed,
			},
		);
	if (missing.size)
		h.fail(
			'E_INVALID_PARAM',
			`Level mode needs the voice analysis of ${[...missing].join(', ')} (pass voice: [{mediaId, analysis}])`,
		);
	return out;
}
