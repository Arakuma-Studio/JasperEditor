// Shared by the WP3.3b review tests: a fake of the engine's sound-design plan job (`POST /api/sound-design/plan` →
// a job whose result names a proposal stored in the fake proposals engine), and a valid plan result.
import type { EngineJob, SoundDesignPlanRequest, SoundDesignPlanResult } from '@jasper/api';
import type { EditorSession } from '@jasper/session';
import type { FakeEngine } from '../../../packages/session/test/fake-proposals-engine.ts';

export function planResult(o: {
	proposalId: string | null;
	projectId: string;
	sequenceId: string;
	placed?: number;
	skipped?: { cueId: string; frame: number; reason: string }[];
}): SoundDesignPlanResult {
	const skipped = (o.skipped ?? []).map((s) => ({
		cueId: s.cueId,
		cueKey: null,
		frame: s.frame,
		timecode: `00:00:00:${String(s.frame % 30).padStart(2, '0')}`,
		kind: 'cut' as const,
		code: 'NO_SOUND' as const,
		reason: s.reason,
	}));
	return {
		proposalId: o.proposalId,
		projectId: o.projectId,
		sequenceId: o.sequenceId,
		revision: 1,
		itemCount: o.placed ?? 0,
		counts: o.proposalId ? { pending: o.placed ?? 0, accepted: 0, rejected: 0, stale: 0, invalid: 0 } : null,
		invalid: [],
		report: {
			version: 1,
			sequenceId: o.sequenceId,
			seed: 1,
			density: 'balanced',
			respectDialogue: true,
			sources: ['starter', 'pack', 'folder', 'synth'],
			cues: 'ids',
			range: null,
			snapshotHash: 'h',
			librarySize: 5,
			palette: { size: 0, used: 0 },
			events: [],
			skipped,
			counts: {
				cues: (o.placed ?? 0) + skipped.length,
				placed: o.placed ?? 0,
				newCues: 0,
				skipped: skipped.length,
				sounds: o.placed ?? 0,
				items: o.placed ?? 0,
			},
			warnings: [],
		},
	};
}

/**
 * A fake plan route: `planSoundDesign` records the request and starts a job; `getJob` runs it (one `running` poll,
 * then `succeeded` with the result `build` returns, which may store a proposal in the fake proposals engine).
 */
export function fakePlanEngine(
	session: EditorSession,
	build: (req: SoundDesignPlanRequest) => SoundDesignPlanResult | Error,
) {
	const requests: SoundDesignPlanRequest[] = [];
	const cancelled: string[] = [];
	const jobs = new Map<string, { req: SoundDesignPlanRequest; polls: number }>();
	let n = 0;
	const job = (id: string, state: EngineJob['state'], extra: Partial<EngineJob> = {}): EngineJob => ({
		id,
		kind: 'sound-design',
		title: 'Sound design plan',
		origin: { type: 'user' },
		projectId: session.projectId,
		state,
		progress: state === 'succeeded' ? 1 : 0.5,
		stage: state === 'running' ? 'Ranking sounds' : undefined,
		createdAt: '2026-10-16T10:00:00.000Z',
		priority: 'interactive',
		cpuSlots: 1,
		...extra,
	});
	return {
		requests,
		cancelled,
		async planSoundDesign(req: SoundDesignPlanRequest) {
			requests.push(req);
			const id = `job_${++n}`;
			jobs.set(id, { req, polls: 0 });
			return job(id, 'queued');
		},
		async getJob(id: string) {
			const j = jobs.get(id);
			if (!j) throw Object.assign(new Error('no job'), { code: 'JOB_NOT_FOUND' });
			j.polls++;
			if (j.polls < 2) return job(id, 'running');
			const r = build(j.req);
			if (r instanceof Error)
				return job(id, 'failed', { error: { code: 'E_PLAN', message: r.message, retryable: false } });
			return job(id, 'succeeded', { result: r });
		},
		async cancelJob(id: string) {
			cancelled.push(id);
			return job(id, 'cancelled');
		},
	};
}

/** A sound-design proposal in the fake engine with one place-like item per frame (markers stand in for sounds). */
export function storeProposal(engine: FakeEngine, sequenceId: string, title: string, frames: number[]) {
	return engine.create(
		{
			feature: 'sound-design',
			title,
			sequenceId,
			items: frames.map((f, i) => ({
				id: `sfx:${String(i + 1).padStart(3, '0')}`,
				label: `Hit at ${f}`,
				group: 'support',
				commands: [{ type: 'marker.add', frame: f, name: `hit ${f}` }],
				meta: { frame: f, kind: 'cut', role: 'support', title: `Hit ${i + 1}`, why: `Hit on the cut at ${f}` },
			})),
		},
		'user',
	);
}
