// Browser-side jobs (S04:JB-045): uploads use the same EngineJob shape in a client-side store and appear in
// the Jobs panel next to engine jobs. They are lost on reload (resumable uploads are IN-012, M2).
import { type EngineJob, TERMINAL_JOB_STATES } from '@jasper/api';
import { useSyncExternalStore } from 'react';

export type ClientJob = EngineJob & { client: true; loadedBytes?: number; totalBytes?: number };

type Listener = () => void;

export class ClientJobStore {
	private jobs: ClientJob[] = [];
	private readonly listeners = new Set<Listener>();
	private seq = 0;
	private readonly cancelers = new Map<string, () => void>();

	getAll = (): ClientJob[] => this.jobs;
	subscribe = (l: Listener): (() => void) => {
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	};
	private emit() {
		for (const l of [...this.listeners]) l();
	}

	add(init: Pick<EngineJob, 'kind' | 'title'> & Partial<ClientJob> & { onCancel?: () => void }): string {
		const id = `cj_${++this.seq}_${Math.random().toString(36).slice(2, 7)}`;
		const { onCancel, ...rest } = init;
		const job: ClientJob = {
			id,
			origin: { type: 'user' },
			state: 'running',
			progress: 0,
			createdAt: new Date().toISOString(),
			startedAt: new Date().toISOString(),
			priority: 'interactive',
			cpuSlots: 0,
			...rest,
			client: true,
		};
		if (onCancel) this.cancelers.set(id, onCancel);
		this.jobs = [...this.jobs, job];
		this.emit();
		return id;
	}

	update(id: string, patch: Partial<ClientJob>): void {
		let changed = false;
		this.jobs = this.jobs.map((j) => {
			if (j.id !== id) return j;
			changed = true;
			const next = { ...j, ...patch };
			if (TERMINAL_JOB_STATES.has(next.state) && !next.finishedAt) next.finishedAt = new Date().toISOString();
			return next;
		});
		if (TERMINAL_JOB_STATES.has(patch.state ?? 'running')) this.cancelers.delete(id);
		if (changed) this.emit();
	}

	cancel(id: string): void {
		const c = this.cancelers.get(id);
		if (!c) return;
		this.update(id, { state: 'cancelling' });
		c();
	}
	canCancel(id: string): boolean {
		return this.cancelers.has(id);
	}

	remove(id: string): void {
		this.jobs = this.jobs.filter((j) => j.id !== id);
		this.cancelers.delete(id);
		this.emit();
	}
	clearFinished(): void {
		this.jobs = this.jobs.filter((j) => !TERMINAL_JOB_STATES.has(j.state));
		this.emit();
	}
}

/** The app-wide client job store. */
export const clientJobs = new ClientJobStore();

export function useClientJobs(store: ClientJobStore = clientJobs): ClientJob[] {
	return useSyncExternalStore(store.subscribe, store.getAll, store.getAll);
}
