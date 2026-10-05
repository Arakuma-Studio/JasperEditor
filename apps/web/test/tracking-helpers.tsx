// Test helpers for the tracking UI (wp-m2-track): a session with a 1920×1080 30 fps plate on V1 and a solid on V2,
// and a fake engine client that records `trackingTrack` calls and serves jobs.
import type { EngineJob, TrackResult } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { mgRegistry } from '@jasper/mg-templates';
import {
	type Command,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	FLICKS_PER_SECOND,
	type Quad,
} from '@jasper/project';
import { EditorSession } from '@jasper/session';

const F30 = FLICKS_PER_SECOND / 30;

export function trackingSession() {
	const ids = createCounterIdSource(7);
	const document = createEmptyProject({ ids, name: 'Tracking test', preset: 'hd-1080p-30' });
	const session = new EditorSession({
		projectId: document.projectId,
		document,
		ctx: { ids, now: () => '2026-10-01T10:00:00.000Z', registries: defaultRegistries(mgRegistry) },
		coalesceWindowMs: 0,
	});
	const plateFrames = 60;
	const reg = session.apply({
		label: 'setup',
		origin: 'system',
		commands: [
			{
				type: 'media.register',
				asset: {
					kind: 'video',
					fingerprint: `q1:${'a'.repeat(64)}`,
					originalName: 'plate.mp4',
					sizeBytes: 1000,
					container: 'mov,mp4',
					probe: {
						durationFlicks: 4 * FLICKS_PER_SECOND,
						startTimecode: null,
						streams: [
							{
								index: 0,
								type: 'video',
								codec: 'h264',
								width: 1920,
								height: 1080,
								pixelAspect: { num: 1, den: 1 },
								frameRate: { num: 30, den: 1 },
								pixelFormat: 'yuv420p',
								bitDepth: 8,
								color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
								browserDecodable: true,
							},
						],
						rotationDegrees: 0,
						hasAlpha: false,
						variableFrameRate: false,
					},
					locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_plate' }],
					derivation: null,
					importedAt: '2026-10-01T10:00:00.000Z',
				},
			} as Command,
		],
	});
	if (!reg.ok) throw new Error(JSON.stringify(reg.errors));
	const mediaId = (reg.results[0] as { mediaId: string }).mediaId;
	const r = session.apply({
		label: 'setup',
		origin: 'system',
		commands: [
			{
				type: 'clip.place',
				source: { mediaId },
				at: 0,
				sourceRange: { in: { flicks: 0 }, out: { flicks: plateFrames * F30 } },
			} as Command,
			{
				type: 'clip.addSolid',
				at: 0,
				duration: 30,
				track: 'V2',
				color: [0, 1, 0, 1],
			} as Command,
		],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const seqId = session.getState().activeSequenceId!;
	const clips = Object.values(session.getState().document.sequences[seqId]!.clips);
	const plate = clips.find((c) => c.kind === 'video')!.id;
	const target = clips.find((c) => c.kind === 'solid')!.id;
	return { session, seqId, plate, target, mediaId };
}

export function seqOf(session: EditorSession) {
	const s = session.getState();
	return s.document.sequences[s.activeSequenceId!]!;
}

export function labels(session: EditorSession): string[] {
	const h = session.getState().history;
	return h.entries.slice(0, h.index + 1).map((e) => e.label);
}

/** A planar track result over source frames [start, start+n): the quad drifts 2 px right per frame. */
export function planarResult(start: number, n: number, base: Quad, trackerId?: string): TrackResult {
	const data: number[] = [];
	for (let i = 0; i < n; i++) for (const p of base) data.push(p[0] + 2 * (start + i), p[1]);
	return {
		startFrame: start,
		fps: { num: 30, den: 1 },
		stride: 8,
		data,
		confidence: new Array(n).fill(0.9),
		method: 'klt-homography@1',
		lost: [],
		...(trackerId ? { trackerId } : {}),
	};
}

export type FakeEngine = EngineClient & {
	calls: { name: string; body: Record<string, unknown> }[];
	cancelled: string[];
	jobs: Map<string, EngineJob>;
	/** What the next `trackingTrack` call does. */
	next: 'queue' | 'not-implemented';
	finish(jobId: string, result: unknown, state?: EngineJob['state']): EngineJob;
};

let jobSeq = 0;

export function fakeEngine(): FakeEngine {
	const jobs = new Map<string, EngineJob>();
	const job = (id: string, state: EngineJob['state'], result?: unknown): EngineJob => ({
		id,
		kind: 'track',
		title: 'Track',
		origin: { type: 'user' },
		state,
		progress: null,
		createdAt: '2026-10-01T10:00:00.000Z',
		priority: 'interactive',
		cpuSlots: 1,
		...(result !== undefined ? { result } : {}),
	});
	const fake = {
		calls: [] as { name: string; body: Record<string, unknown> }[],
		cancelled: [] as string[],
		jobs,
		next: 'queue' as 'queue' | 'not-implemented',
		async call(name: string, opts: { body?: Record<string, unknown> } = {}) {
			fake.calls.push({ name, body: opts.body ?? {} });
			if (fake.next === 'not-implemented')
				throw Object.assign(new Error('Not implemented'), { code: 'NOT_IMPLEMENTED' });
			const id = `job_${++jobSeq}`;
			const j = job(id, 'queued');
			jobs.set(id, j);
			return j;
		},
		async getJob(id: string) {
			const j = jobs.get(id);
			if (!j) throw new Error('not found');
			return j;
		},
		async cancelJob(id: string) {
			fake.cancelled.push(id);
			const j = { ...jobs.get(id)!, state: 'cancelled' as const };
			jobs.set(id, j);
			return j;
		},
		async health() {
			return { ok: true, version: 'test' };
		},
		async capabilities() {
			throw Object.assign(new Error('no caps'), { code: 'NOT_IMPLEMENTED' });
		},
		async listFonts() {
			return { families: [] };
		},
		openEvents(_q: unknown, h: { onStateChange?(s: string): void }) {
			h.onStateChange?.('open');
			return { close: () => {} };
		},
		finish(id: string, result: unknown, state: EngineJob['state'] = 'succeeded') {
			const j = job(id, state, result);
			if (state === 'failed') j.error = { code: 'E_TRACK', message: 'Lost the surface', retryable: false };
			jobs.set(id, j);
			return j;
		},
	};
	return fake as unknown as FakeEngine;
}
