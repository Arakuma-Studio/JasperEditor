// Engine round trips of Essential Sound and Remix (audio-fx): Loudness Auto-Match (measure the clips' own signal on
// the engine, then one `essentialSound.autoMatch`), Ducking (audio-mix's `autoDuck` with the Essential Sound
// triggers), Remix (`POST /api/audio/remix-plan`, then one `clip.remix`) and Duration ▸ Stretch.
// Music to picture (spec 12 P6-E11; wp-note "Phase 6 → WP-E7"): the music's analysis (`POST /api/audio/beats`: tempo,
// bar lines, drops, key), Land the Drop (an anchored remix plan, then one `clip.remix`) and End on Bar.
import {
	type AudioClassifyResult,
	type BeatsResult,
	MAX_REMIX_SOURCE_SECONDS,
	type RemixPlanRequest,
	type RemixPlanResult,
} from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	AUDIO_TYPE_LABELS,
	type AudioClip,
	type AudioType,
	duckTriggerClips,
	type EssentialSound,
	endOnBarPlan,
	FLICKS_PER_SECOND,
	frameAtContent,
	type MediaAsset,
	type ProjectDocument,
	type Rational,
	readEssentialSound,
	readRemixAnchors,
	remixCommandOf,
	remixPiecesOf,
	remixSourceRange,
	remixStartFrame,
	type Sequence,
	soundCuesOf,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { analyzeAudio, autoDuck } from '../audio/engine-ops.ts';
import { exportEnvelope } from '../export/settings.ts';
import { t } from '../i18n/runtime.ts';
import { mediaKeyOf } from '../import/assets.ts';

/** What an Auto Tag did: the clips tagged, those kept (a type the user set, low confidence), silent and failed ones. */
export type AutoTagOutcome = {
	tagged: { clipId: string; audioType: AudioType; confidence: number; from: AudioType | null }[];
	skipped: { clipId: string; code: string; reason: string }[];
	silent: string[];
	failed: { clipId: string; message: string }[];
	/** Tagged with a confidence under the classifier's "low" line (0.6): the user should confirm them. */
	low: string[];
};

/**
 * Essential Sound ▸ Auto Tag (Premiere's "Auto Tag Audio Types"): the engine listens to each clip (`POST
 * /api/audio/classify`, an `audio-classify` job the Jobs panel shows) and ONE user transaction "Auto Tag Audio Types"
 * gives them the types, marked auto until confirmed. Types the user set are kept unless `force`.
 */
export async function autoTagClips(
	session: EditorSession,
	engine: EngineClient,
	sequenceId: string,
	clipIds: string[],
	opts: {
		force?: boolean;
		signal?: AbortSignal;
		/** Waited for after the engine answered, before the transaction (the editor's gesture ending). */
		beforeApply?: () => Promise<void>;
		/** Clips still to tag when the answer arrives (default all): the others are dropped from the transaction. */
		keep?: (doc: ProjectDocument, clipId: string) => boolean;
	} = {},
): Promise<AutoTagOutcome> {
	const out: AutoTagOutcome = { tagged: [], skipped: [], silent: [], failed: [], low: [] };
	if (!clipIds.length) return out;
	const doc = session.getCommitted();
	const job = await engine.classifyAudio(
		{
			envelope: exportEnvelope(doc, session.revision),
			...(doc.projectId ? { projectId: doc.projectId } : {}),
			sequenceId,
			clipIds,
		},
		{ wait: true, ...(opts.signal ? { signal: opts.signal } : {}) },
	);
	if (job.state !== 'succeeded') throw new Error(job.error?.message ?? `Auto Tag ${job.state}`);
	const res = job.result as AudioClassifyResult;
	const results: Record<
		string,
		{ category: AudioType; confidence: number; scores: Record<string, number>; reasons: string[] }
	> = {};
	for (const it of res.items) {
		if (!it.clipId) continue;
		if (it.error) out.failed.push({ clipId: it.clipId, message: it.error.message });
		else if (!it.result || it.result.silent || !it.result.category) out.silent.push(it.clipId);
		else
			results[it.clipId] = {
				category: it.result.category,
				confidence: it.result.confidence,
				scores: it.result.scores,
				reasons: it.result.reasons.slice(0, 6),
			};
	}
	if (!Object.keys(results).length) return out;
	await opts.beforeApply?.();
	if (opts.keep) {
		const now = session.getCommitted();
		for (const id of Object.keys(results)) if (!opts.keep(now, id)) delete results[id];
		if (!Object.keys(results).length) return out;
	}
	const r = session.apply({
		label: 'Auto Tag Audio Types',
		origin: 'user',
		commands: [{ type: 'essentialSound.autoTag', results, ...(opts.force ? { force: true } : {}) }],
	});
	fail(r, 'Auto Tag');
	const done = r.ok ? (r.results[0] as Pick<AutoTagOutcome, 'tagged' | 'skipped'> | undefined) : undefined;
	out.tagged = done?.tagged ?? [];
	out.skipped = done?.skipped ?? [];
	out.low = out.tagged.filter((t) => t.confidence < res.lowConfidence).map((t) => t.clipId);
	return out;
}

/** The toast of an Auto Tag: what was tagged, kept, silent or failed (and how many are low-confidence). */
export function autoTagMessage(o: AutoTagOutcome): string {
	const parts: string[] = [];
	if (o.tagged.length) {
		const by = new Map<AudioType, number>();
		for (const x of o.tagged) by.set(x.audioType, (by.get(x.audioType) ?? 0) + 1);
		parts.push(t('Tagged {0}', [...by].map(([ty, k]) => `${k} ${t(AUDIO_TYPE_LABELS[ty])}`).join(', ')));
	} else parts.push(t('Nothing was tagged'));
	if (o.low.length)
		parts.push(
			o.low.length === 1
				? t('1 with low confidence: confirm it')
				: t('{0} with low confidence: confirm them', o.low.length),
		);
	const kept = o.skipped.filter((x) => x.code === 'USER_TYPE').length;
	if (kept) parts.push(kept === 1 ? t('1 kept the type you set') : t('{0} kept the types you set', kept));
	if (o.silent.length) parts.push(o.silent.length === 1 ? t('1 silent') : t('{0} silent', o.silent.length));
	if (o.failed.length)
		parts.push(
			o.failed.length === 1 ? t('1 could not be analysed') : t('{0} could not be analysed', o.failed.length),
		);
	return parts.join(' · ');
}

/**
 * The audio clips of each Essential Sound type in a sequence, in timeline order (Premiere: Essential Sound lists the
 * tags found; clicking one selects all clips of that category). Auto-tagged clips count with their type.
 */
export function audioTypeClips(seq: Sequence): Record<AudioType, string[]> {
	const out: Record<AudioType, string[]> = { dialogue: [], music: [], sfx: [], ambience: [] };
	const list = Object.values(seq.clips)
		.filter((c): c is AudioClip => c.kind === 'audio')
		.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
	for (const c of list) {
		const type = readEssentialSound(c.essential)?.type;
		if (type) out[type].push(c.id);
	}
	return out;
}

/** Selects every audio clip of `type` in the active sequence (only those clips: no linked video). Returns the count. */
export function selectAudioType(session: EditorSession, type: AudioType): number {
	const s = session.getState();
	const seq = s.activeSequenceId
		? (s.document.sequences[s.activeSequenceId] as Sequence | undefined)
		: undefined;
	if (!seq) return 0;
	const ids = audioTypeClips(seq)[type];
	session.select('timeline', ids, 'replace', { linked: false, groups: false });
	return ids.length;
}

/** Audio clips of the selection (in the active sequence). */
export function selectedAudioClips(session: EditorSession): { seq: Sequence | null; clips: AudioClip[] } {
	const s = session.getState();
	const seq = s.activeSequenceId
		? ((s.document.sequences[s.activeSequenceId] as Sequence | undefined) ?? null)
		: null;
	if (!seq) return { seq: null, clips: [] };
	const clips = s.selection.timeline.clips
		.map((id) => seq.clips[id])
		.filter((c): c is AudioClip => !!c && c.kind === 'audio');
	return { seq, clips };
}

function fail(r: { ok: boolean; errors?: { message: string }[] }, what: string): void {
	if (!r.ok) throw new Error(r.errors?.[0]?.message ?? `${what} failed`);
}

/** What `essentialSound.autoMatch` did per clip: the match gain, or why the clip was skipped. */
export type AutoMatchOutcome = Record<string, { gainDb: number } | { skipped: string }>;

/**
 * The message of an Auto-Match: how many clips were matched, and why the others were left as they are (silent, or
 * shorter than one 400 ms BS.1770 gating block, where integrated loudness is undefined).
 */
export function autoMatchMessage(out: AutoMatchOutcome, targetLufs: number | undefined): string {
	const results = Object.values(out);
	const matched = results.filter((r) => 'gainDb' in r).length;
	const reasons = [...new Set(results.flatMap((r) => ('skipped' in r ? [r.skipped] : [])))];
	const skipped = results.length - matched;
	const why = (reason: string) =>
		reason.startsWith('shorter than 400 ms')
			? 'shorter than 400 ms, too short to measure'
			: reason === 'silent'
				? 'silent'
				: reason;
	if (matched === 0) {
		if (reasons.length === 1)
			return `${skipped === 1 ? 'The clip is' : 'The clips are'} ${why(reasons[0]!)}: nothing was matched`;
		return `Nothing was matched: ${reasons.map(why).join(', ')}`;
	}
	const to = targetLufs !== undefined ? `${targetLufs} LUFS` : 'the target';
	const head = `Matched ${matched === 1 ? '1 clip' : `${matched} clips`} to ${to}`;
	return skipped ? `${head}; ${skipped} left as they are (${reasons.map(why).join(', ')})` : head;
}

/**
 * Loudness ▸ Auto-Match: integrated loudness (BS.1770) of each clip's own signal — its effects, without its gain,
 * Volume, fades or pan (`levels: 'source'`) — then the match gain to `targetLufs`. Returns what the command did per
 * clip (`autoMatchMessage` words it).
 */
export async function autoMatchLoudness(
	session: EditorSession,
	engine: EngineClient,
	sequenceId: string,
	clipIds: string[],
	targetLufs?: number,
): Promise<AutoMatchOutcome> {
	const r = await analyzeAudio(session, engine, {
		sequenceId,
		scope: { type: 'clips', clipIds },
		levels: 'source',
	});
	const measured: Record<string, number | null> = {};
	for (const id of clipIds) measured[id] = r.clips?.[id]?.integratedLufs ?? null;
	const res = session.apply({
		label: 'Auto-Match Loudness',
		origin: 'user',
		commands: [
			{
				type: 'essentialSound.autoMatch',
				measuredLufs: measured,
				...(targetLufs !== undefined ? { targetLufs } : {}),
			},
		],
	});
	fail(res, 'Auto-Match');
	const out = res.ok ? (res.results[0] as { clips?: AutoMatchOutcome } | undefined)?.clips : undefined;
	if (out) return out;
	return Object.fromEntries(
		Object.entries(measured).map(([id, v]) => [id, v === null ? { skipped: 'silent' } : { gainDb: 0 }]),
	);
}

/** Ducking ▸ Generate Keyframes: Volume keyframes on `clipIds` under their trigger clips (audio-mix autoDuck). */
export async function generateDucking(
	session: EditorSession,
	engine: EngineClient,
	sequenceId: string,
	clipIds: string[],
): Promise<number> {
	const seq = session.getCommitted().sequences[sequenceId] as Sequence;
	const first = seq.clips[clipIds[0]!] as AudioClip | undefined;
	const s = first ? readEssentialSound(first.essential) : null;
	if (!s) throw new Error('Set the clips to Music or Ambience first');
	const triggers = duckTriggerClips(seq, clipIds, s);
	if (triggers.length === 0) throw new Error('No clips of the "Duck against" types in the sequence');
	const r = await autoDuck(session, engine, {
		sequenceId,
		targetClipIds: clipIds,
		triggers: { clipIds: triggers },
		sensitivity: s.ducking.sensitivity,
		amountDb: -s.ducking.reduceDb,
		fadeMs: s.ducking.fadeSeconds * 1000,
	});
	return r.regions.length;
}

/** Remix a music clip to `targetSeconds` (beat-tracked plan from the engine, then `clip.remix`, one undo step). */
/** Why a music clip is too long to remix (the beat analysis is capped at `MAX_REMIX_SOURCE_SECONDS`). */
export function remixTooLong(durSec: number): string {
	const min = (s: number) => Math.round(s / 60);
	return `The music is ${min(durSec)} min long; Remix analyses at most ${min(MAX_REMIX_SOURCE_SECONDS)} min. Trim the clip first.`;
}

/**
 * The one music clip a selection names: a single clip, or every piece of one remix (selecting a piece selects its
 * group) — then its first piece. Null otherwise.
 */
export function singleMusicClip(clips: readonly AudioClip[]): AudioClip | null {
	if (clips.length === 1) return clips[0]!;
	const id = clips[0]?.remix?.id;
	if (!id || !clips.every((c) => c.remix?.id === id)) return null;
	return [...clips].sort((a, b) => a.start - b.start)[0]!;
}

/** The remix length of a music clip now (a remix's target, else its duration; frames). */
const remixLengthOf = (clip: AudioClip) => (clip.remix ? clip.remix.targetFrames : clip.duration);

/** Frames free on the clip's track from where its remix starts (the next other clip), or Infinity. */
function roomOf(seq: Sequence, clip: AudioClip): number {
	const start = remixStartFrame(clip);
	const own = new Set(remixPiecesOf(seq, clip).map((c) => c.id));
	let next = Number.POSITIVE_INFINITY;
	for (const c of Object.values(seq.clips))
		if (c.trackId === clip.trackId && !own.has(c.id) && c.start >= start) next = Math.min(next, c.start);
	return next - start;
}

/** The engine request base of a music clip's remix (its original content range). */
function remixBase(
	doc: ProjectDocument,
	seq: Sequence,
	clip: AudioClip,
	targetSeconds: number,
): RemixPlanRequest {
	const key = mediaKeyOf(doc.media[clip.mediaId] as MediaAsset | undefined);
	if (!key) throw new Error(t('The music is not on the engine'));
	const { startSec, durSec } = remixSourceRange(clip, seq.settings.frameRate as Rational);
	if (durSec > MAX_REMIX_SOURCE_SECONDS) throw new Error(remixTooLong(durSec));
	return {
		mediaKey: key,
		...(clip.channels.streamIndex !== undefined ? { streamIndex: clip.channels.streamIndex } : {}),
		startSeconds: startSec,
		durationSeconds: durSec,
		targetSeconds,
	};
}

export async function remixClip(
	session: EditorSession,
	engine: EngineClient,
	sequenceId: string,
	clipId: string,
	targetSeconds: number,
	opts: { segments?: number; variations?: number } = {},
): Promise<{ pieces: number; bpm: number; lengthSeconds: number; keptDrop: boolean | null }> {
	const doc = session.getCommitted();
	const seq = doc.sequences[sequenceId] as Sequence;
	const clip = seq.clips[clipId] as AudioClip | undefined;
	if (clip?.kind !== 'audio') throw new Error(t('Select a music clip'));
	const rate = seq.settings.frameRate as Rational;
	const fps = rate.num / rate.den;
	const base: RemixPlanRequest = {
		...remixBase(doc, seq, clip, targetSeconds),
		...(opts.segments !== undefined ? { segments: opts.segments } : {}),
		...(opts.variations !== undefined ? { variations: opts.variations } : {}),
	};
	// P6-E11: a drop the clip landed earlier lands again when it still fits
	const start = remixStartFrame(clip);
	const kept = readRemixAnchors(clip.remix).filter((a) => (a.frame - start) / fps < targetSeconds);
	let plan: RemixPlanResult | null = null;
	if (kept.length) {
		const room = roomOf(seq, clip);
		plan = await engine
			.remixPlan({
				...base,
				anchors: kept.map((a) => ({
					sourceSeconds: a.sourceSeconds,
					outputSeconds: (a.frame - start) / fps,
				})),
				fit: 'nearest',
				...(Number.isFinite(room) ? { maxTargetSeconds: room / fps } : {}),
			})
			.catch(() => null);
	}
	const keptDrop = kept.length ? plan !== null : null;
	plan ??= await engine.remixPlan(base);
	const res = session.apply({
		label: 'Remix',
		origin: 'user',
		commands: [
			remixCommandOf(clip, plan, rate, {
				...opts,
				...(kept.length && Number.isFinite(roomOf(seq, clip)) ? { maxFrames: roomOf(seq, clip) } : {}),
			}) as never,
		],
	});
	fail(res, 'Remix');
	return { pieces: plan.pieces.length, bpm: plan.bpm, lengthSeconds: plan.lengthSeconds, keptDrop };
}

/** The music's analysis over the clip's (original) content range: tempo, bar lines, drops and key (cached). */
export async function musicAnalysis(
	session: EditorSession,
	engine: EngineClient,
	sequenceId: string,
	clipId: string,
): Promise<BeatsResult> {
	const doc = session.getCommitted();
	const seq = doc.sequences[sequenceId] as Sequence;
	const clip = seq.clips[clipId] as AudioClip | undefined;
	if (clip?.kind !== 'audio') throw new Error(t('Select a music clip'));
	const first = remixPiecesOf(seq, clip)[0]!;
	const base = remixBase(doc, seq, first, 1);
	return engine.audioBeats({
		mediaKey: base.mediaKey,
		...(base.streamIndex !== undefined ? { streamIndex: base.streamIndex } : {}),
		startSeconds: base.startSeconds,
		durationSeconds: base.durationSeconds,
	});
}

/** Where a media second of a music clip (or its remix) plays now (frame), or null when it is not heard. */
export function frameOfMusicSec(seq: Sequence, clip: AudioClip, sec: number): number | null {
	const rate = seq.settings.frameRate as Rational;
	for (const p of remixPiecesOf(seq, clip)) {
		const f = frameAtContent(p, sec * FLICKS_PER_SECOND, rate);
		if (f >= p.start && f < p.start + p.duration) return Math.round(f);
	}
	return null;
}

/** The first hero cue under a music clip (its remix span), or null. */
export function heroCueUnder(seq: Sequence, clip: AudioClip): { id: string; frame: number } | null {
	const start = remixStartFrame(clip);
	const end = start + remixLengthOf(clip);
	const hero = soundCuesOf(seq)
		.filter((c) => c.weight === 'hero' && !c.muted && c.frame >= start && c.frame < end)
		.sort((a, b) => a.frame - b.frame)[0];
	return hero ? { id: hero.id, frame: hero.frame } : null;
}

/**
 * Land the Drop (P6-E11): the music clip is re-cut at bar lines so its drop (the top candidate, or `dropSec` in media
 * seconds) plays exactly at `frame` (within 1 ms); its length moves by at most half a bar so the outro still ends it
 * (never over the next clip on the track). One undo step "Land the Drop".
 */
export async function landDrop(
	session: EditorSession,
	engine: EngineClient,
	sequenceId: string,
	clipId: string,
	frame: number,
	opts: { dropSec?: number } = {},
): Promise<{ bar: number | null; dropSec: number; errorMs: number; lengthSeconds: number; pieces: number }> {
	const doc = session.getCommitted();
	const seq = doc.sequences[sequenceId] as Sequence;
	const clip = seq.clips[clipId] as AudioClip | undefined;
	if (clip?.kind !== 'audio') throw new Error(t('Select a music clip'));
	const rate = seq.settings.frameRate as Rational;
	const fps = rate.num / rate.den;
	const start = remixStartFrame(clip);
	if (frame < start) throw new Error(t('The drop cannot land before the music starts'));
	const base = remixBase(doc, seq, clip, remixLengthOf(clip) / fps);
	let dropSource: number;
	let bar: number | null = null;
	if (opts.dropSec !== undefined) dropSource = opts.dropSec - base.startSeconds;
	else {
		const first = await engine.remixPlan(base);
		const top = first.drops?.[0];
		if (!top) throw new Error(t('No drop found in this music'));
		dropSource = top.sourceSeconds;
		bar = top.bar;
	}
	const room = roomOf(seq, clip);
	const plan = await engine.remixPlan({
		...base,
		anchors: [{ sourceSeconds: dropSource, outputSeconds: (frame - start) / fps }],
		fit: 'nearest',
		...(Number.isFinite(room) ? { maxTargetSeconds: room / fps } : {}),
	});
	const res = session.apply({
		label: 'Land the Drop',
		origin: 'user',
		commands: [remixCommandOf(clip, plan, rate, Number.isFinite(room) ? { maxFrames: room } : {}) as never],
	});
	fail(res, 'Land the Drop');
	return {
		bar,
		dropSec: base.startSeconds + dropSource,
		errorMs: plan.anchors?.[0]?.errorMs ?? 0,
		lengthSeconds: plan.lengthSeconds,
		pieces: plan.pieces.length,
	};
}

/** End on Bar (P6-E11): the music clip ends just before a bar line with a one-beat fade-out. One undo step. */
export async function endOnBar(
	session: EditorSession,
	engine: EngineClient,
	sequenceId: string,
	clipId: string,
	opts: { direction?: 'earlier' | 'nearest'; fadeSeconds?: number } = {},
): Promise<{ endFrame: number; barSeconds: number }> {
	const b = await musicAnalysis(session, engine, sequenceId, clipId);
	if (!b.downbeats?.length)
		throw new Error(
			b.reason === 'NO_BEAT' ? t('The music has no steady beat') : t('The music has no clear bar lines'),
		);
	const doc = session.getCommitted();
	const seq = doc.sequences[sequenceId] as Sequence;
	const p = endOnBarPlan(doc, seq, clipId, b.downbeats, { bpm: b.bpm, ...opts });
	if (!p.ok) throw new Error(p.message);
	const res = session.apply({ label: 'End on Bar', origin: 'user', commands: p.commands as never });
	fail(res, 'End on Bar');
	return { endFrame: p.endFrame, barSeconds: p.barSeconds };
}

const PRESET_KEY = 'jasper.essentialSound.userPresets';
export type UserSoundPreset = { name: string; settings: EssentialSound };

export function userSoundPresets(): UserSoundPreset[] {
	try {
		const raw = JSON.parse(localStorage.getItem(PRESET_KEY) ?? '[]') as unknown;
		if (!Array.isArray(raw)) return [];
		return raw
			.map((p) => ({
				name: String((p as { name?: unknown }).name ?? ''),
				settings: readEssentialSound((p as { settings?: unknown }).settings),
			}))
			.filter((p): p is UserSoundPreset => !!p.name && !!p.settings);
	} catch {
		return [];
	}
}

export function saveUserSoundPreset(name: string, s: EssentialSound): void {
	const list = userSoundPresets().filter(
		(p) => !(p.name.toLowerCase() === name.toLowerCase() && p.settings.type === s.type),
	);
	const kept: EssentialSound = {
		...s,
		preset: name,
		loudness: { ...s.loudness, measuredLufs: null, targetLufs: null, gainDb: 0 },
		volume: { on: false, levelDb: 0 },
		mute: false,
	};
	list.push({ name, settings: kept });
	localStorage.setItem(PRESET_KEY, JSON.stringify(list));
}

export function deleteUserSoundPreset(name: string, type: AudioType): void {
	localStorage.setItem(
		PRESET_KEY,
		JSON.stringify(userSoundPresets().filter((p) => !(p.name === name && p.settings.type === type))),
	);
}
