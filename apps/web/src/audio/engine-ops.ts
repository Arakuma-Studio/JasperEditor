// Engine round trips of the audio UI (audio-mix): loudness / peak / activity analysis of the open document, the
// loudness-normalised version of a media, and auto-ducking (analysis of the triggers + one `audio.autoDuck`).
import type {
	AudioAnalyzeRequest,
	AudioAnalyzeResult,
	EngineJob,
	LoudnessNormalizeResult,
} from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	DUCK_DEFAULTS,
	type MediaAsset,
	mixFingerprint,
	type ProjectDocument,
	type Sequence,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { exportEnvelope } from '../export/settings.ts';
import { mediaKeyOf } from '../import/assets.ts';

function resultOf<T>(job: EngineJob): T {
	if (job.state !== 'succeeded') throw new Error(job.error?.message ?? `The analysis ${job.state}`);
	return job.result as T;
}

/** Runs an audio analysis of the session's committed document and waits for it. */
export async function analyzeAudio(
	session: EditorSession,
	engine: EngineClient,
	req: Pick<AudioAnalyzeRequest, 'sequenceId' | 'scope' | 'levels' | 'activity'>,
): Promise<AudioAnalyzeResult> {
	const body = {
		...req,
		envelope: exportEnvelope(session.getCommitted(), session.revision),
		projectId: session.getCommitted().projectId,
	} as unknown as AudioAnalyzeRequest;
	const job = await engine.analyzeAudio(body, true);
	return resultOf<AudioAnalyzeResult>(job);
}

/** Analyses the sequence's mix and stores the result as the Mix's loudness analysis (one undo step). */
export async function analyzeSequenceLoudness(
	session: EditorSession,
	engine: EngineClient,
	sequenceId: string,
): Promise<AudioAnalyzeResult> {
	const r = await analyzeAudio(session, engine, { sequenceId, scope: { type: 'sequence' } });
	const l = r.loudness;
	session.apply({
		label: 'Analyze Loudness',
		origin: 'user',
		commands: [
			{
				type: 'mixer.setLoudness',
				sequenceId,
				analysis: {
					integratedLufs: l.integratedLufs,
					truePeakDbtp: l.truePeakDbtp,
					lra: l.lra,
					maxMomentaryLufs: l.maxMomentaryLufs,
					maxShortTermLufs: l.maxShortTermLufs,
					mixHash: r.mixHash,
					analyzedAt: new Date().toISOString(),
				},
			},
		] as never,
	});
	return r;
}

/** Whether the stored analysis of a sequence still matches its mix. */
export function loudnessAnalysisStale(doc: ProjectDocument, sequenceId: string): boolean {
	const a = (doc.sequences[sequenceId] as Sequence | undefined)?.master.loudness?.analysis;
	return !a || a.mixHash !== mixFingerprint(doc, sequenceId);
}

/** Source sample peaks (dBFS, without clip gain) of audio clips, for Audio Gain's normalise modes. */
export async function clipPeaks(
	session: EditorSession,
	engine: EngineClient,
	sequenceId: string,
	clipIds: string[],
): Promise<Record<string, number | null>> {
	const r = await analyzeAudio(session, engine, {
		sequenceId,
		scope: { type: 'clips', clipIds },
		levels: 'source',
	});
	const out: Record<string, number | null> = {};
	for (const id of clipIds) out[id] = r.clips?.[id]?.samplePeakDb ?? null;
	return out;
}

/**
 * Normalises a media's loudness into a new WAV version (engine job), then commits `media.derive` — the version joins
 * the project and, when `replaceInClips` is given, those audio clips switch to it (one undo step).
 */
export async function normalizeMediaLoudness(
	session: EditorSession,
	engine: EngineClient,
	mediaId: string,
	opts: { targetLufs: number; truePeakDb: number; replaceInClips?: string[] },
): Promise<LoudnessNormalizeResult> {
	const doc = session.getCommitted();
	const asset = doc.media[mediaId] as MediaAsset | undefined;
	if (!asset) throw new Error('Media not found');
	const key = mediaKeyOf(asset);
	if (!key) throw new Error('The media is not on the engine');
	const job = await engine.normalizeMediaLoudness(
		key,
		{ targetLufs: opts.targetLufs, truePeakDb: opts.truePeakDb, projectId: doc.projectId },
		true,
	);
	const r = resultOf<LoudnessNormalizeResult>(job);
	const reg = r.registered;
	const res = session.apply({
		label: 'Normalize Loudness',
		origin: 'user',
		commands: [
			{
				type: 'media.derive',
				fromMediaId: mediaId,
				recipe: { op: 'loudness-normalize', targetLufs: opts.targetLufs, truePeakDb: opts.truePeakDb },
				asset: {
					fingerprint: reg.fingerprint,
					originalName: reg.originalName,
					sizeBytes: reg.sizeBytes,
					container: reg.container,
					probe: reg.probe,
					locators: [{ type: 'engine-store', engineId: 'local', key: reg.mediaKey }],
					recipeVersion: r.recipeVersion,
					recipeHash: r.recipeHash,
				},
				...(opts.replaceInClips?.length ? { replaceInClips: opts.replaceInClips } : {}),
			},
		] as never,
	});
	if (!res.ok) throw new Error(res.errors[0]?.message ?? 'The normalised version could not be added');
	return r;
}

export type AutoDuckRequest = {
	sequenceId: string;
	/** The clips to duck (music, ambience). */
	targetClipIds: string[];
	/** What triggers the ducking: clips (e.g. Essential Sound's Dialogue clips) or whole audio tracks. */
	triggers: { clipIds: string[] } | { trackIds: string[] };
	/** 0 … 10 (Premiere Sensitivity), default 6. */
	sensitivity?: number;
	/** Reduce by (dB, positive), default 18. */
	amountDb?: number;
	/** Fade duration (ms), default 800. */
	fadeMs?: number;
};

/**
 * Auto-ducking: the engine mixes the triggers over the targets' window and finds their activity regions; then ONE
 * `audio.autoDuck` writes the duck keyframes on every target clip. This is the function the Essential Sound panel
 * calls (it resolves its roles to trigger clips first).
 */
export async function autoDuck(
	session: EditorSession,
	engine: EngineClient,
	req: AutoDuckRequest,
): Promise<{ regions: [number, number][]; keyframes: Record<string, number> }> {
	const doc = session.getCommitted();
	const seq = doc.sequences[req.sequenceId] as Sequence | undefined;
	if (!seq) throw new Error('Sequence not found');
	const targets = req.targetClipIds.map((id) => seq.clips[id]).filter((c) => !!c);
	if (targets.length === 0) throw new Error('Select the clips to duck');
	const start = Math.min(...targets.map((c) => c.start));
	const end = Math.max(...targets.map((c) => c.start + c.duration));
	const activity = {
		sensitivity: req.sensitivity ?? DUCK_DEFAULTS.sensitivity,
		startFrame: start,
		endFrame: end,
	};
	const scope =
		'clipIds' in req.triggers
			? ({ type: 'clips', clipIds: req.triggers.clipIds } as const)
			: ({ type: 'tracks', trackIds: req.triggers.trackIds } as const);
	if ((scope.type === 'clips' ? scope.clipIds : scope.trackIds).length === 0)
		throw new Error('Choose what triggers the ducking');
	const r = await analyzeAudio(session, engine, { sequenceId: req.sequenceId, scope, activity });
	const regions = r.activity?.regions ?? [];
	const res = session.apply({
		label: 'Auto Duck',
		origin: 'user',
		commands: [
			{
				type: 'audio.autoDuck',
				targetClipIds: req.targetClipIds,
				regions,
				amountDb: req.amountDb ?? DUCK_DEFAULTS.amountDb,
				fadeMs: req.fadeMs ?? DUCK_DEFAULTS.fadeMs,
			},
		] as never,
	});
	if (!res.ok) throw new Error(res.errors[0]?.message ?? 'Auto Duck failed');
	return { regions, keyframes: (res.results[0] as { keyframes: Record<string, number> }).keyframes };
}
