// Live re-planning of a Clean Up review (spec 14 TC-042, TC-060 UI side; docs/wp-notes/transcript-cleanup.md "Clean
// Up UI"): every decision or settings change re-runs the pure `analyzeSequenceCleanup` on the analysed document with
// the voice analyses the engine computed — in a worker (`plan.worker.ts`), so a one-hour recording (≈ 150 ms per run)
// never blocks the editor. Without workers (tests, old browsers) it runs on the main thread after a yield. Only the
// newest request's answer is delivered; older ones resolve as superseded.
import {
	analyzeSequenceCleanup,
	type CleanupAnalysis,
	type CleanupDecisions,
	type CleanupRefusal,
	type CleanupScope,
	type CleanupSettings,
	type CleanupVoice,
	type ProjectDocument,
	type Sequence,
} from '@jasper/project';

/** What every plan of one review shares: the analysed document (the parts the detector reads) and the voices. */
export type PlanBase = {
	doc: Pick<ProjectDocument, 'transcripts' | 'media'>;
	seq: Sequence;
	/** `${mediaId}\u0000${stream}` → analysis (absent / null = word mode, as in the engine job). */
	voices: Array<[string, CleanupVoice | null]>;
};

export type PlanRequest = {
	settings: CleanupSettings;
	/** The sequence's current `cleanup` (lists, remembered rejections), read over the analysed sequence's. */
	cleanup: unknown;
	script: string | null;
	language?: string;
	decisions: CleanupDecisions;
	scope: CleanupScope;
};

export type PlanResult =
	| CleanupAnalysis
	| CleanupRefusal
	| { ok: false; code: 'E_INTERNAL'; message: string };

export const voiceKey = (mediaId: string, stream: number) => `${mediaId}\u0000${stream}`;

/** One plan (pure; the worker and the main-thread fallback both run this). */
export function runPlan(base: PlanBase, req: PlanRequest): PlanResult {
	try {
		const voices = new Map(base.voices);
		const seq = { ...base.seq, cleanup: req.cleanup } as Sequence;
		if (req.cleanup === undefined) delete (seq as { cleanup?: unknown }).cleanup;
		return analyzeSequenceCleanup({
			doc: base.doc,
			seq,
			voice: (m, s) => voices.get(voiceKey(m, s)) ?? null,
			settings: req.settings,
			script: req.script,
			...(req.language ? { language: req.language } : {}),
			decisions: req.decisions,
			scope: req.scope,
		});
	} catch (e) {
		return { ok: false, code: 'E_INTERNAL', message: e instanceof Error ? e.message : String(e) };
	}
}

export type WorkerIn = { type: 'init'; base: PlanBase } | { type: 'plan'; id: number; req: PlanRequest };
export type WorkerOut = { id: number; result: PlanResult };

export type PlanOutcome = { superseded: true } | { superseded: false; result: PlanResult; ms: number };

export class CleanupPlanner {
	private worker: Worker | null = null;
	private base: PlanBase | null = null;
	private seq = 0;
	private pending = new Map<number, { resolve(o: PlanOutcome): void; t0: number; req: PlanRequest }>();
	private disposed = false;

	constructor() {
		if (typeof Worker === 'undefined' || typeof window === 'undefined') return;
		try {
			this.worker = new Worker(new URL('./plan.worker.ts', import.meta.url), { type: 'module' });
			this.worker.onmessage = (e: MessageEvent<WorkerOut>) => this.deliver(e.data.id, e.data.result);
			this.worker.onerror = () => this.fallBack();
		} catch {
			this.worker = null;
		}
	}

	/** Whether plans run off the main thread. */
	get inWorker(): boolean {
		return this.worker !== null;
	}

	init(base: PlanBase): void {
		this.base = base;
		this.worker?.postMessage({ type: 'init', base } satisfies WorkerIn);
	}

	/** Plans with `req`; the answer of an older request that a newer one overtook resolves as superseded. */
	plan(req: PlanRequest): Promise<PlanOutcome> {
		const id = ++this.seq;
		for (const [old, p] of this.pending) {
			p.resolve({ superseded: true });
			this.pending.delete(old);
		}
		return new Promise<PlanOutcome>((resolve) => {
			if (this.disposed || !this.base) {
				resolve({
					superseded: false,
					result: { ok: false, code: 'E_INTERNAL', message: 'The review is closed' },
					ms: 0,
				});
				return;
			}
			this.pending.set(id, { resolve, t0: now(), req });
			if (this.worker) this.worker.postMessage({ type: 'plan', id, req } satisfies WorkerIn);
			else this.runHere(id, req);
		});
	}

	private runHere(id: number, req: PlanRequest): void {
		const base = this.base;
		setTimeout(() => {
			if (!this.pending.has(id) || !base) return;
			this.deliver(id, runPlan(base, req));
		}, 0);
	}

	private deliver(id: number, result: PlanResult): void {
		const p = this.pending.get(id);
		if (!p) return;
		this.pending.delete(id);
		p.resolve({ superseded: false, result, ms: Math.round(now() - p.t0) });
	}

	/** The worker died: finish on the main thread (pending requests are re-run there). */
	private fallBack(): void {
		this.worker?.terminate();
		this.worker = null;
		for (const [id, p] of this.pending) this.runHere(id, p.req);
	}

	dispose(): void {
		this.disposed = true;
		this.worker?.terminate();
		this.worker = null;
		this.base = null;
		for (const p of this.pending.values()) p.resolve({ superseded: true });
		this.pending.clear();
	}
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
