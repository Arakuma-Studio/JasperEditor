// Engine round trips of Essential Sound and Remix (audio-fx): Loudness Auto-Match (measure the clips' own signal on
// the engine, then one `essentialSound.autoMatch`), Ducking (audio-mix's `autoDuck` with the Essential Sound
// triggers), Remix (`POST /api/audio/remix-plan`, then one `clip.remix`) and Duration ▸ Stretch.
import type { EngineClient } from '@jasper/engine-client';
import {
	type AudioClip,
	type AudioType,
	duckTriggerClips,
	type EssentialSound,
	type MediaAsset,
	type Rational,
	readEssentialSound,
	remixSourceRange,
	type Sequence,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { analyzeAudio, autoDuck } from '../audio/engine-ops.ts';
import { mediaKeyOf } from '../import/assets.ts';

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

/**
 * Loudness ▸ Auto-Match: integrated loudness (BS.1770) of each clip's own signal — its effects, without its gain,
 * Volume, fades or pan (`levels: 'source'`) — then the match gain to `targetLufs`.
 */
export async function autoMatchLoudness(
	session: EditorSession,
	engine: EngineClient,
	sequenceId: string,
	clipIds: string[],
	targetLufs?: number,
): Promise<Record<string, number | null>> {
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
		] as never,
	});
	fail(res, 'Auto-Match');
	return measured;
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
		] as never,
	});
	fail(res, 'Remix');
	return { pieces: plan.pieces.length, bpm: plan.bpm, lengthSeconds: plan.lengthSeconds };
}

// ---------------------------------------------------------------- user presets (this browser)

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
