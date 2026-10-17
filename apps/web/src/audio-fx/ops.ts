// Engine round trips of Essential Sound and Remix (audio-fx): Loudness Auto-Match (measure the clips' own signal on
// the engine, then one `essentialSound.autoMatch`), Ducking (audio-mix's `autoDuck` with the Essential Sound
// triggers), Remix (`POST /api/audio/remix-plan`, then one `clip.remix`) and Duration ▸ Stretch.
import { type AudioClassifyResult, MAX_REMIX_SOURCE_SECONDS } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	AUDIO_TYPE_LABELS,
	type AudioClip,
	type AudioType,
	duckTriggerClips,
	type EssentialSound,
	type MediaAsset,
	type ProjectDocument,
	type Rational,
	readEssentialSound,
	remixSourceRange,
	type Sequence,
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

export async function remixClip(
	session: EditorSession,
	engine: EngineClient,
	sequenceId: string,
	clipId: string,
	targetSeconds: number,
	opts: { segments?: number; variations?: number } = {},
): Promise<{ pieces: number; bpm: number; lengthSeconds: number }> {
	const doc = session.getCommitted();
	const seq = doc.sequences[sequenceId] as Sequence;
	const clip = seq.clips[clipId] as AudioClip | undefined;
	if (clip?.kind !== 'audio') throw new Error('Select a music clip');
	const key = mediaKeyOf(doc.media[clip.mediaId] as MediaAsset | undefined);
	if (!key) throw new Error('The music is not on the engine');
	const rate = seq.settings.frameRate as Rational;
	const { startSec, durSec } = remixSourceRange(clip, rate);
	if (durSec > MAX_REMIX_SOURCE_SECONDS) throw new Error(remixTooLong(durSec));
	const plan = await engine.remixPlan({
		mediaKey: key,
		streamIndex: clip.channels.streamIndex,
		startSeconds: startSec,
		durationSeconds: durSec,
		targetSeconds,
		...(opts.segments !== undefined ? { segments: opts.segments } : {}),
		...(opts.variations !== undefined ? { variations: opts.variations } : {}),
	});
	const targetFrames = Math.max(1, Math.round((plan.lengthSeconds * rate.num) / rate.den));
	const res = session.apply({
		label: 'Remix',
		origin: 'user',
		commands: [
			{
				type: 'clip.remix',
				clipId,
				targetFrames,
				pieces: plan.pieces,
				bpm: plan.bpm,
				...(opts.segments !== undefined ? { segments: opts.segments } : {}),
				...(opts.variations !== undefined ? { variations: opts.variations } : {}),
			},
		],
	});
	fail(res, 'Remix');
	return { pieces: plan.pieces.length, bpm: plan.bpm, lengthSeconds: plan.lengthSeconds };
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
