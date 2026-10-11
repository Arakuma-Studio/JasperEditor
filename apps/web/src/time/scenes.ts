// Commit all scene analyses together so cancellation leaves the project unchanged and one undo removes the edit.
import type { SceneDetectResult } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	type Clip,
	clipMediaRange,
	FLICKS_PER_SECOND,
	type Rational,
	type Sequence,
	type TimedClip,
	type TransactionResult,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { mediaKeyOf } from '../import/assets.ts';

export type SceneOptions = {
	applyCuts: boolean;
	createSubclips: boolean;
	createMarkers: boolean;
	sensitivity: number;
	minShotFrames: number;
};

export const DEFAULT_SCENE_OPTIONS: SceneOptions = {
	applyCuts: true,
	createSubclips: false,
	createMarkers: false,
	sensitivity: 50,
	minShotFrames: 2,
};

export type SceneTarget = {
	clipId: string;
	mediaKey: string;
	startSec: number;
	endSec: number;
	name: string;
};

/** The clips Scene Edit Detection analyses: selected video clips with engine media (others are skipped). */
export function sceneTargets(
	session: EditorSession,
	sequenceId: string,
	clipIds: readonly string[],
): SceneTarget[] {
	const doc = session.getCommitted();
	const seq = doc.sequences[sequenceId] as Sequence | undefined;
	if (!seq) return [];
	const rate = seq.settings.frameRate as Rational;
	const out: SceneTarget[] = [];
	for (const id of clipIds) {
		const c = seq.clips[id] as Clip | undefined;
		if (c?.kind !== 'video') continue;
		const key = mediaKeyOf(doc.media[c.mediaId]);
		if (!key) continue;
		const r = clipMediaRange(c as TimedClip, rate);
		// One media frame past the last one shown (the end is exclusive).
		const step = (rate.den / rate.num) * Math.max(1, c.speed.rate);
		out.push({
			clipId: c.id,
			mediaKey: key,
			startSec: Math.max(0, r.min / FLICKS_PER_SECOND),
			endSec: r.max / FLICKS_PER_SECOND + step,
			name: c.name,
		});
	}
	return out;
}

/** Runs the jobs (one per clip, sequentially) and reports progress 0…1. Throws when a job fails or is cancelled. */
export async function detectScenes(
	engine: EngineClient,
	projectId: string | undefined,
	targets: readonly SceneTarget[],
	o: SceneOptions,
	onProgress: (done: number, label: string) => void,
	signal?: AbortSignal,
): Promise<Map<string, SceneDetectResult>> {
	const out = new Map<string, SceneDetectResult>();
	for (const [i, t] of targets.entries()) {
		if (signal?.aborted) throw new Error('Scene Edit Detection was cancelled');
		onProgress(i / targets.length, `Analysing ${t.name}`);
		let job = await engine.detectScenes({
			...(projectId ? { projectId } : {}),
			mediaKey: t.mediaKey,
			startSec: t.startSec,
			endSec: t.endSec,
			sensitivity: o.sensitivity,
			minShotFrames: o.minShotFrames,
		});
		for (;;) {
			if (signal?.aborted) {
				await engine.cancelJob(job.id).catch(() => undefined);
				throw new Error('Scene Edit Detection was cancelled');
			}
			if (job.state === 'succeeded') break;
			if (job.state === 'failed' || job.state === 'cancelled' || job.state === 'interrupted')
				throw new Error(job.error?.message ?? `Scene Edit Detection ${job.state}`);
			onProgress((i + (job.progress ?? 0)) / targets.length, `Analysing ${t.name}`);
			await new Promise((r) => setTimeout(r, 250));
			job = await engine.getJob(job.id);
		}
		out.set(t.clipId, job.result as SceneDetectResult);
	}
	onProgress(1, 'Done');
	return out;
}

/** Applies the results in one transaction (one History entry). */
export function applySceneEdits(
	session: EditorSession,
	sequenceId: string,
	results: Map<string, SceneDetectResult>,
	o: SceneOptions,
): TransactionResult {
	const commands = [...results].map(([clipId, r]) => ({
		type: 'clip.applySceneEdits',
		clipId,
		cuts: r.cuts.map((s) => Math.round(s * FLICKS_PER_SECOND)),
		applyCuts: o.applyCuts,
		createSubclips: o.createSubclips,
		createMarkers: o.createMarkers,
	}));
	return session.apply({
		label: 'Scene Edit Detection',
		origin: 'user',
		sequenceId,
		commands: commands as never[],
	});
}
