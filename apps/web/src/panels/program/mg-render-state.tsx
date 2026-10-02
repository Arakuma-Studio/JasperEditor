// Motion-graphic render state for the Program monitor (S03:KND-060 badge, WP-2G's MgRenderStateContext):
// clips whose fframes render this client requested (mg.rerender, template insert) map to their engine
// mg-render job; the provider turns live job events into `none | rendering n% | ready | failed`.
import type { EngineJob } from '@jasper/api';
import { type MgRenderState, MgRenderStateContext } from '@jasper/compositions';
import { type ReactNode, useMemo, useSyncExternalStore } from 'react';
import { useEngineOrNull, useJobs } from '../../state/engine.tsx';

const jobByClip = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

/** Remembers that `jobId` renders `clipId` (the latest request wins). */
export function trackMgRenderJob(clipId: string, jobId: string): void {
	if (jobByClip.get(clipId) === jobId) return;
	jobByClip.set(clipId, jobId);
	version++;
	for (const l of [...listeners]) l();
}

function subscribe(l: () => void): () => void {
	listeners.add(l);
	return () => listeners.delete(l);
}

function mgRenderStateOf(job: EngineJob | undefined): MgRenderState | undefined {
	if (!job) return undefined;
	switch (job.state) {
		case 'queued':
			return { status: 'rendering', progress: 0 };
		case 'running':
		case 'cancelling':
			return { status: 'rendering', progress: job.progress ?? 0 };
		case 'succeeded':
			return { status: 'ready' };
		case 'failed':
			return { status: 'failed', ...(job.error?.message ? { message: job.error.message } : {}) };
		default:
			return { status: 'none' };
	}
}

/** Provides MgRenderStateContext to the Program monitor's Player from live `mg-render` job events. */
export function MgRenderStateProvider({ children }: { children?: ReactNode }) {
	// Without an engine (standalone mounting, tests) there are no render jobs: the badge shows the preview.
	return useEngineOrNull() ? <EngineMgRenderState>{children}</EngineMgRenderState> : (children ?? null);
}

function EngineMgRenderState({ children }: { children?: ReactNode }) {
	const tracked = useSyncExternalStore(
		subscribe,
		() => version,
		() => version,
	);
	const { jobs } = useJobs();
	// Only the states of tracked clips matter; a stable key keeps the lookup identity (and the memoized
	// motion-graphic layers) unchanged when unrelated jobs update.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `tracked` changes when the clip → job map does
	const states = useMemo(() => {
		const byId = new Map(jobs.filter((j) => j.kind === 'mg-render').map((j) => [j.id, j]));
		const out: [string, MgRenderState][] = [];
		for (const [clipId, jobId] of jobByClip) {
			const s = mgRenderStateOf(byId.get(jobId));
			if (s) out.push([clipId, s]);
		}
		return out;
	}, [jobs, tracked]);
	const key = JSON.stringify(states);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the serialized states
	const lookup = useMemo(() => {
		const map = new Map(states);
		return (clipId: string) => map.get(clipId);
	}, [key]);
	return <MgRenderStateContext.Provider value={lookup}>{children}</MgRenderStateContext.Provider>;
}
