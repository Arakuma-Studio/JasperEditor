// The engine's cache registry and garbage collector (M3, S04 §7.5 CA-003, CA-010…CA-019) — Premiere's Media Cache for
// every regenerable file the engine writes (layout.ts lists the kinds and where they live).
//
// Entries are found by scanning the appdir (the disk is the truth); the index (store.ts) adds last access times and the
// project ref sets that exports record. Three protections decide what a pass may remove:
//   in use      — pinned by a running job (`acquire`/`pin`, released when the job ends), busy (an active job renders
//                 it: its dedupe key or id names the entry; an owner adapter says so), written or used in the last
//                 minutes (grace), or referenced by a project that is open in an editor (live lease);
//   referenced  — needed by a saved project: its media's derivatives, its composition clips' pre-renders (computed from
//                 the document, project-refs.ts) and what its last export / still / preview used (recorded ref sets);
//   unused      — everything else.
// Modes: `auto` (start-up, hourly, after renders): unused entries past their age limit, then LRU eviction of unused
// entries while a kind or the total is over budget; `unused` ("Clean Unused"): every unused entry; `all` ("Clean All
// (not in use)"): referenced entries too — they are regenerated on demand. Removal is crash-safe: the entry is renamed
// to a `.trash-*` name first (atomic; lookups miss from then on), then deleted; a crash leaves only trash and
// temporary files of interrupted writes, which the orphan sweep removes. Lookups that `acquire` an entry wait for a
// removal in progress and then miss (the producer regenerates).
import { randomBytes } from 'node:crypto';
import { lstat, rename, rm, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
	CACHE_KINDS,
	type CacheGcReport,
	type CacheKind,
	type CacheKindUsage,
	type CacheLocationCheck,
	type CacheSettings,
	type CacheUsage,
	type EngineJob,
	TERMINAL_JOB_STATES,
} from '@jasper/api';
import type { AppdirPaths } from '@jasper/config';
import type { Broadcaster } from '../events/broadcaster.ts';
import type { JobQueue } from '../jobs/queue.ts';
import { type JobContext, JobError } from '../jobs/types.ts';
import type { LeaseManager } from '../projects/leases.ts';
import type { ProjectStoreFs } from '../projects/store.ts';
import { exists, freeDiskBytes } from '../tools/fs.ts';
import { addServeHook } from '../tools/http.ts';
import {
	type EntryRef,
	entryOfPath,
	isTrashName,
	KIND_DEF,
	KIND_DEFS,
	type Orphan,
	otherUsage,
	type ScannedEntry,
	type ScanResult,
	scanAppdir,
} from './layout.ts';
import { checkLocation, finishCleanup, moveCache, physicalRoot } from './location.ts';
import { JOURNAL_COMPACT_BYTES, logsUsage, maintainLogs } from './logs.ts';
import {
	type ClipRenderKeyFn,
	type ProjectCacheRefs,
	projectCacheRefs,
	type RenderKeyFn,
} from './project-refs.ts';
import { CacheIndexStore, CacheSettingsStore } from './store.ts';

const DAY_MS = 24 * 3600 * 1000;
/** Entries written or used this recently count as in use (a producer may be about to read what it just wrote). */
export const CACHE_GRACE_MS = 2 * 60 * 1000;
/** Temporary files of writes are orphans once nothing has written to them for this long. */
export const ORPHAN_AGE_MS = 60 * 60 * 1000;
/** A pin of a job the queue does not know (pseudo job ids) expires after this long. */
const UNKNOWN_HOLDER_TTL_MS = 10 * 60 * 1000;
/** CA-003: automatic budget = min(25 GB, 15 % of the free disk at start). */
const AUTO_BUDGET_CAP = 25 * 1024 ** 3;
const AUTO_BUDGET_SHARE = 0.15;
/** Usage answers from a scan at most this old. */
const SCAN_TTL_MS = 15_000;
/** Job kinds after which an automatic pass is scheduled (they write cache entries). */
const RENDER_JOB_KINDS = new Set(['export', 'still', 'proxy', 'mg-prerender', 'layer-bake', 'process']);

export type CacheMode = 'auto' | 'unused' | 'all';

/** A cache folder that cannot be used (HTTP 422 with the check). */
export class CacheLocationError extends Error {
	constructor(
		message: string,
		readonly check: CacheLocationCheck,
	) {
		super(message);
		this.name = 'CacheLocationError';
	}
}

function emptyReport(t: number): CacheGcReport {
	return {
		at: new Date(t).toISOString(),
		mode: 'auto',
		removedEntries: 0,
		removedBytes: 0,
		removedOrphans: 0,
		keptInUse: 0,
		keptReferenced: 0,
		failed: 0,
		byKind: {},
	};
}

/** Owner hooks for a kind (e.g. the layer-bake service: its leases and its lookups that wait for a removal). */
export type CacheKindAdapter = {
	/** True while the owner uses the entry (leases, renders in flight). */
	busy?(key: string): boolean;
	/** Wraps the removal (the owner's lookups can wait for it); must call `remove` and return its result. */
	remove?(key: string, remove: () => Promise<boolean>): Promise<boolean>;
};

export type CacheServiceOptions = {
	appdir: string;
	paths: AppdirPaths;
	queue?: JobQueue | null;
	projects?: ProjectStoreFs | null;
	leases?: LeaseManager | null;
	broadcaster?: Broadcaster | null;
	/** Pre-render key of composition requests (mg-bundles `prerenderKey`); null = no composition refs. */
	renderKey?: RenderKeyFn | null;
	/** Show the cache location in usage answers (local mode). */
	exposePaths?: boolean;
	/** Automatic passes (start-up, hourly, after renders). Default on, off under vitest unless set. */
	autoTimers?: boolean;
	startupDelayMs?: number;
	intervalMs?: number;
	afterRenderDelayMs?: number;
	graceMs?: number;
	orphanAgeMs?: number;
	now?: () => number;
	log?(msg: string): void;
};

type Classified = {
	entry: ScannedEntry;
	lastAccess: number;
	/** Why it must stay, or null. */
	inUse: string | null;
	/** Saved projects that reference it. */
	projects: Set<string>;
};

type ProjectsInfo = {
	/** entry id → project ids referencing it. */
	refsOf(e: EntryRef): Set<string>;
	open: Set<string>;
	existing: Set<string>;
};

export class CacheService {
	readonly index: CacheIndexStore;
	readonly settingsStore: CacheSettingsStore;
	/** entry id → holder → count. */
	private readonly pins = new Map<string, Map<string, number>>();
	/** holder → entry ids. */
	private readonly held = new Map<string, Set<string>>();
	private serveSeq = 0;
	private offServe: (() => void) | null = null;
	/** holder → pinned at (ms). */
	private readonly holderSince = new Map<string, number>();
	private readonly releaseHooked = new Set<string>();
	private readonly removing = new Map<string, Promise<boolean>>();
	private readonly ownTrash = new Set<string>();
	private readonly adapters = new Map<CacheKind, CacheKindAdapter>();
	private readonly openProbes = new Set<(projectId: string) => boolean>();
	private readonly liveDocs = new Set<(projectId: string) => Promise<unknown | null>>();
	private fframesKey: ClipRenderKeyFn | null = null;
	private readonly projectRefsCache = new Map<string, { revision: number; refs: ProjectCacheRefs }>();
	private lastScan: ScanResult | null = null;
	private scanning: Promise<ScanResult> | null = null;
	private gcChain: Promise<unknown> = Promise.resolve();
	private autoBudget: number | null = null;
	private freeAtStart: number | null = null;
	private timers: NodeJS.Timeout[] = [];
	private afterRenderTimer: NodeJS.Timeout | null = null;
	private offEvents: (() => void) | null = null;
	private started: Promise<void> | null = null;
	private readonly now: () => number;

	constructor(private readonly o: CacheServiceOptions) {
		this.index = new CacheIndexStore(join(o.paths.engineDir, 'cache-index.json'));
		this.settingsStore = new CacheSettingsStore(join(o.paths.engineDir, 'cache.json'));
		this.now = o.now ?? (() => Date.now());
	}

	private get grace(): number {
		return this.o.graceMs ?? CACHE_GRACE_MS;
	}

	// ------------------------------------------------------------------ lifecycle

	/** Loads the index, measures the automatic budget, starts the automatic passes (CA-015). */
	start(): Promise<void> {
		this.started ??= this.doStart();
		return this.started;
	}

	private async doStart(): Promise<void> {
		await this.index.load();
		void finishCleanup(this.o.appdir).catch(() => undefined);
		// Served cache files (derivatives, renders, masters…) count as used and stay while they stream.
		this.offServe = addServeHook((file) => {
			const ref = this.ref(file);
			if (!ref) return undefined;
			const holder = `serve:${++this.serveSeq}`;
			this.pin(holder, ref);
			this.touch(ref);
			return () => this.release(holder);
		});
		this.freeAtStart = await freeDiskBytes(physicalRoot(this.o.appdir, (await this.settings()).location));
		const scan = await this.scan(true).catch(() => null);
		const cacheBytes = scan ? scan.entries.reduce((s, e) => s + e.bytes, 0) : 0;
		// "15 % of the free disk at start" counts the cache itself as reclaimable space.
		this.autoBudget =
			this.freeAtStart === null
				? AUTO_BUDGET_CAP
				: Math.max(
						1024 ** 3,
						Math.min(AUTO_BUDGET_CAP, Math.floor((this.freeAtStart + cacheBytes) * AUTO_BUDGET_SHARE)),
					);
		const timers =
			this.o.autoTimers ?? (process.env.JASPER_CACHE_AUTO_GC ?? (process.env.VITEST ? '0' : '1')) !== '0';
		if (timers) {
			const t0 = setTimeout(() => void this.autoPass('start-up'), this.o.startupDelayMs ?? 20_000);
			const t1 = setInterval(() => void this.autoPass('hourly'), this.o.intervalMs ?? 3600_000);
			t0.unref?.();
			t1.unref?.();
			this.timers.push(t0, t1);
			this.offEvents =
				this.o.broadcaster?.subscribe((e) => {
					if (e.type !== 'job.finished') return;
					const kind = (e.payload as { kind?: string } | null)?.kind;
					if (kind && RENDER_JOB_KINDS.has(kind)) this.scheduleAfterRender();
				}) ?? null;
		}
	}

	async stop(): Promise<void> {
		for (const t of this.timers) clearTimeout(t);
		this.timers = [];
		if (this.afterRenderTimer) clearTimeout(this.afterRenderTimer);
		this.afterRenderTimer = null;
		this.offEvents?.();
		this.offEvents = null;
		this.offServe?.();
		this.offServe = null;
		await this.gcChain.catch(() => undefined);
		await this.index.flush().catch(() => undefined);
	}

	private scheduleAfterRender(): void {
		if (this.afterRenderTimer) return;
		this.afterRenderTimer = setTimeout(() => {
			this.afterRenderTimer = null;
			void this.autoPass('after render');
		}, this.o.afterRenderDelayMs ?? 60_000);
		this.afterRenderTimer.unref?.();
	}

	private async autoPass(why: string): Promise<void> {
		try {
			const s = await this.settings();
			const r = await this.clean(s.autoClean ? 'auto' : 'orphans');
			await this.maintainLogs(s);
			if (r.removedEntries || r.removedOrphans)
				this.o.log?.(
					`[cache] ${why}: removed ${r.removedEntries} entries (${r.removedBytes} bytes) and ${r.removedOrphans} orphans`,
				);
		} catch (e) {
			this.o.log?.(`[cache] ${why} pass failed: ${(e as Error).message}`);
		}
	}

	/**
	 * S04:CA-020: log retention (age, then size) and the job journal compacted once it passes 2 MB. Runs with every
	 * automatic pass (and on demand). Returns what was removed.
	 */
	async maintainLogs(
		s?: CacheSettings,
	): Promise<{ removedFiles: number; removedBytes: number; prunedJobs: number }> {
		const settings = s ?? (await this.settings());
		const r = await maintainLogs(this.o.paths, settings.logs, this.now()).catch(() => ({
			removedFiles: 0,
			removedBytes: 0,
		}));
		let prunedJobs = 0;
		const journal = await stat(this.o.paths.jobsJournal).catch(() => null);
		if (this.o.queue && journal && journal.size > JOURNAL_COMPACT_BYTES) prunedJobs = this.o.queue.prune();
		return { ...r, prunedJobs };
	}

	// ------------------------------------------------------------------ location (CA-021)

	/** The location setting (null = the data folder) and the physical folder holding the cache folders. */
	async location(): Promise<{ location: string | null; root: string }> {
		const location = (await this.settings()).location;
		return { location, root: physicalRoot(this.o.appdir, location) };
	}

	async checkLocation(path: string | null, mode: 'move' | 'fresh' = 'move'): Promise<CacheLocationCheck> {
		return checkLocation(this.o.appdir, (await this.location()).location, path, mode);
	}

	/**
	 * Queues the `cache-move` job (it takes every CPU slot: it waits for running jobs and runs alone). Throws a
	 * CacheLocationError when the folder is not usable.
	 */
	async startMove(req: {
		path: string | null;
		mode: 'move' | 'fresh';
		keepOld?: boolean;
	}): Promise<EngineJob> {
		const check = await this.checkLocation(req.path, req.mode);
		if (!check.ok) throw new CacheLocationError(check.message ?? 'The folder cannot hold the cache', check);
		const q = this.o.queue;
		if (!q) throw new CacheLocationError('No job queue', check);
		return q.submit({
			kind: 'cache-move',
			title: req.mode === 'move' ? `Move media cache to ${check.path}` : `New media cache in ${check.path}`,
			priority: 'interactive',
			cpuSlots: q.totalSlots,
			minSlots: q.totalSlots,
			origin: { type: 'user' },
			dedupeKey: 'cache-move',
			stage: 'Waiting for running jobs',
			input: { path: req.path === null ? null : resolve(req.path), mode: req.mode, keepOld: !!req.keepOld },
		});
	}

	/** Registers the `cache-move` runner (core services, after the queue exists). */
	registerRunners(): void {
		this.o.queue?.registerRunner('cache-move', (ctx) => this.runMove(ctx));
	}

	private async runMove(ctx: JobContext): Promise<unknown> {
		const input = ctx.input as { path: string | null; mode: 'move' | 'fresh'; keepOld: boolean };
		const from = (await this.location()).location;
		// Inside the pass chain: no cleaning pass runs during the move.
		const run = this.gcChain
			.catch(() => undefined)
			.then(async () => {
				const check = await checkLocation(this.o.appdir, from, input.path, input.mode);
				if (!check.ok) throw new JobError('CACHE_LOCATION_INVALID', check.message ?? 'Invalid folder', false);
				const others = (this.o.queue?.list({ active: true }) ?? []).filter(
					(j) => j.id !== ctx.job.id && j.state === 'running',
				);
				if (others.length)
					throw new JobError(
						'CACHE_BUSY',
						`${others.length} job(s) are still running; try again when they finish`,
						true,
					);
				const r = await moveCache({
					appdir: this.o.appdir,
					from,
					to: input.path,
					mode: input.mode,
					keepOld: input.keepOld,
					signal: ctx.signal,
					onProgress: (p, stage) => ctx.progress(p, { stage }),
				});
				this.settingsStore.invalidate();
				this.lastScan = null;
				this.projectRefsCache.clear();
				return {
					location: check.path,
					isDefault: input.path === null,
					movedBytes: r.movedBytes,
					mode: input.mode,
				};
			});
		this.gcChain = run;
		const result = await run;
		this.o.broadcaster?.publish('cache.cleaned', { ...(this.index.lastGc ?? emptyReport(this.now())) });
		return result;
	}

	/**
	 * Adds a source of "open in an editor" beyond the project lease (e.g. the agent relay: every editor window,
	 * read-only ones too, keeps a connection for its project).
	 */
	addOpenProbe(probe: (projectId: string) => boolean): () => void {
		this.openProbes.add(probe);
		return () => this.openProbes.delete(probe);
	}

	/**
	 * Adds a source of the live (possibly unsaved) document of an open project — the editor's document is ahead of
	 * the saved file between autosaves (a media imported a second ago). Open projects are referenced by the union of
	 * their saved and live documents. The source answers null when it cannot (no editor, timeout).
	 */
	addLiveDocumentSource(source: (projectId: string) => Promise<unknown | null>): () => void {
		this.liveDocs.add(source);
		return () => this.liveDocs.delete(source);
	}

	private async liveDocument(projectId: string): Promise<unknown | null> {
		for (const src of this.liveDocs) {
			const doc = await src(projectId).catch(() => null);
			if (doc && typeof doc === 'object') return doc;
		}
		return null;
	}

	private isOpen(projectId: string): boolean {
		if (this.o.leases?.get(projectId)) return true;
		for (const p of this.openProbes) {
			try {
				if (p(projectId)) return true;
			} catch {
				// a broken probe never blocks a pass
			}
		}
		return false;
	}

	/** The fframes render key of a motion-graphic clip (set by the cache routes from the M1 mg service). */
	setFframesRenderKey(fn: ClipRenderKeyFn | null): void {
		this.fframesKey = fn;
		this.projectRefsCache.clear();
	}

	registerAdapter(kind: CacheKind, adapter: CacheKindAdapter): () => void {
		this.adapters.set(kind, adapter);
		return () => {
			if (this.adapters.get(kind) === adapter) this.adapters.delete(kind);
		};
	}

	// ------------------------------------------------------------------ settings

	settings(): Promise<CacheSettings> {
		return this.settingsStore.get();
	}

	/** Saves the settings; applies at once (S04:ENG-012): a pass runs with the new limits. */
	async putSettings(next: CacheSettings): Promise<CacheSettings> {
		// The location changes only through a move (CA-021).
		const saved = await this.settingsStore.put({ ...next, location: (await this.settings()).location });
		if (saved.autoClean) void this.clean('auto').catch(() => undefined);
		return saved;
	}

	private maxAgeMs(kind: CacheKind, s: CacheSettings): number | null {
		const days = this.maxAgeDays(kind, s);
		return days === null ? null : days * DAY_MS;
	}

	private maxAgeDays(kind: CacheKind, s: CacheSettings): number | null {
		const o = s.kinds[kind]?.maxAgeDays;
		if (o !== undefined) return o;
		const d = KIND_DEF.get(kind)?.defaultMaxAgeDays;
		return d !== undefined ? d : s.maxAgeDays;
	}

	private kindBudget(kind: CacheKind, s: CacheSettings): number | null {
		return s.kinds[kind]?.maxBytes ?? null;
	}

	/** Effective total budget (the automatic one when not set). */
	totalBudget(s: CacheSettings): number | null {
		return s.maxTotalBytes ?? this.autoBudget ?? AUTO_BUDGET_CAP;
	}

	// ------------------------------------------------------------------ entries, access, pins

	/** The cache entry of a path (file or directory inside an entry), or null. */
	ref(path: string): EntryRef | null {
		return entryOfPath(this.o.appdir, path, /\.png$/i.test(path));
	}

	/** Records a use (LRU order, age limit). */
	touch(pathOrRef: string | EntryRef): void {
		const ref = typeof pathOrRef === 'string' ? this.ref(pathOrRef) : pathOrRef;
		if (!ref) return;
		this.index.access.set(ref.id, this.now());
		this.index.changed();
	}

	/** Holds an entry against every pass until `release(holder)` (synchronous: no pass can start in between). */
	pin(holder: string, pathOrRef: string | EntryRef): EntryRef | null {
		const ref = typeof pathOrRef === 'string' ? this.ref(pathOrRef) : pathOrRef;
		if (!ref) return null;
		let m = this.pins.get(ref.id);
		if (!m) {
			m = new Map();
			this.pins.set(ref.id, m);
		}
		m.set(holder, (m.get(holder) ?? 0) + 1);
		let h = this.held.get(holder);
		if (!h) this.held.set(holder, (h = new Set()));
		h.add(ref.id);
		if (!this.holderSince.has(holder)) this.holderSince.set(holder, this.now());
		this.hookJobRelease(holder);
		return ref;
	}

	/** Drops every pin of a holder. */
	release(holder: string): void {
		this.holderSince.delete(holder);
		this.releaseHooked.delete(holder);
		for (const id of this.held.get(holder) ?? []) {
			const m = this.pins.get(id);
			if (m?.delete(holder) && m.size === 0) this.pins.delete(id);
		}
		this.held.delete(holder);
	}

	/** Entry ids a holder pins. */
	holderEntries(holder: string): string[] {
		return [...(this.held.get(holder) ?? [])];
	}

	/**
	 * Pins a path for `holder`, waits for a removal of its entry in progress, and tells whether it exists — the safe
	 * replacement of `exists(path)` for producers that reuse a cached file (CA-016). Paths outside the cache are only
	 * checked for existence.
	 */
	async acquire(holder: string, path: string): Promise<boolean> {
		const ref = this.pin(holder, path);
		if (ref) {
			const pending = this.removing.get(ref.id);
			if (pending) await pending.catch(() => false);
			this.touch(ref);
		}
		return exists(path);
	}

	/** `acquire` for job `jobId` (holder `job:<id>`, released when the job ends). */
	acquireForJob(jobId: string, path: string): Promise<boolean> {
		return this.acquire(`job:${jobId}`, path);
	}

	/** Holders `job:<id>` are released when the queue reports the job finished. */
	private hookJobRelease(holder: string): void {
		if (!holder.startsWith('job:') || this.releaseHooked.has(holder) || !this.o.queue) return;
		const id = holder.slice(4);
		const q = this.o.queue;
		if (!q.get(id)) return; // pseudo ids expire (validateHolders)
		this.releaseHooked.add(holder);
		void q
			.wait(id)
			.catch(() => undefined)
			.then(() => {
				// Let the job's own completion code (ref commits) run first.
				setTimeout(() => this.release(holder), 0);
			});
	}

	/** Drops pins of holders that are gone (finished jobs; unknown jobs after a while). */
	private validateHolders(): void {
		const q = this.o.queue;
		const t = this.now();
		for (const [holder, since] of [...this.holderSince]) {
			if (holder.startsWith('serve:')) {
				// A response whose close event never came (should not happen): the pin expires.
				if (t - since > UNKNOWN_HOLDER_TTL_MS) this.release(holder);
				continue;
			}
			if (!holder.startsWith('job:')) continue;
			const job = q?.get(holder.slice(4));
			const gone = job ? TERMINAL_JOB_STATES.has(job.state) : t - since > UNKNOWN_HOLDER_TTL_MS;
			if (gone) this.release(holder);
		}
	}

	// ------------------------------------------------------------------ project references

	/**
	 * Replaces the ref set of a scope (`export:<projectId>:<sequenceId>`, `still:…`, `preview:…`): the entries a
	 * saved project needs beyond what its document tells (CA-012). Persisted (they survive restarts).
	 */
	setRefs(scope: string, projectId: string, entries: readonly (string | EntryRef)[]): void {
		const ids = new Set<string>();
		for (const e of entries) {
			if (typeof e !== 'string') ids.add(e.id);
			else if (CACHE_KINDS.includes(e.slice(0, e.indexOf(':')) as CacheKind)) ids.add(e);
			else {
				const ref = this.ref(e);
				if (ref) ids.add(ref.id);
			}
		}
		this.index.refs.set(scope, { projectId, entries: [...ids].sort(), updatedAt: this.now() });
		this.index.changed();
	}

	/** Records what a holder (an export/still job) pins as the scope's ref set. */
	commitHolderRefs(holder: string, scope: string, projectId: string): void {
		this.setRefs(scope, projectId, this.holderEntries(holder));
	}

	private async projectsInfo(): Promise<ProjectsInfo> {
		const existing = new Set<string>();
		const open = new Set<string>();
		const computed = new Map<string, ProjectCacheRefs>();
		const store = this.o.projects;
		if (store) {
			for (const p of await store.list().catch(() => [])) {
				if (typeof p.revision !== 'number') continue; // not a readable project file
				existing.add(p.projectId);
				if (this.isOpen(p.projectId)) open.add(p.projectId);
				let c = this.projectRefsCache.get(p.projectId);
				if (!c || c.revision !== p.revision) {
					const doc = await store
						.get(p.projectId)
						.then((g) => (g.envelope as { document?: unknown }).document)
						.catch(() => null);
					c = {
						revision: p.revision,
						refs: projectCacheRefs(doc, this.o.renderKey ?? null, this.fframesKey),
					};
					this.projectRefsCache.set(p.projectId, c);
				}
				computed.set(p.projectId, c.refs);
			}
			for (const pid of [...this.projectRefsCache.keys()])
				if (!existing.has(pid)) this.projectRefsCache.delete(pid);
			// Open projects: what their editors show right now counts too (not saved yet, CA-012/CA-014).
			await Promise.all(
				[...open].map(async (pid) => {
					const doc = await this.liveDocument(pid);
					if (!doc) return;
					const live = projectCacheRefs(doc, this.o.renderKey ?? null, this.fframesKey);
					const saved = computed.get(pid);
					computed.set(
						pid,
						saved
							? {
									fingerprints: new Set([...saved.fingerprints, ...live.fingerprints]),
									mgRenderKeys: new Set([...saved.mgRenderKeys, ...live.mgRenderKeys]),
									bundleHashes: new Set([...saved.bundleHashes, ...live.bundleHashes]),
								}
							: live,
					);
				}),
			);
		}
		const recorded = new Map<string, Set<string>>();
		for (const set of this.index.refs.values()) {
			if (!existing.has(set.projectId)) continue;
			for (const id of set.entries) {
				let s = recorded.get(id);
				if (!s) recorded.set(id, (s = new Set()));
				s.add(set.projectId);
			}
		}
		const refsOf = (e: EntryRef): Set<string> => {
			const out = new Set(recorded.get(e.id) ?? []);
			for (const [pid, r] of computed) {
				if (e.kind === 'media-cache' || e.kind === 'proxies') {
					if (r.fingerprints.has(e.key.slice(0, 64))) out.add(pid);
				} else if (e.kind === 'mg-renders') {
					if (r.mgRenderKeys.has(e.key)) out.add(pid);
				} else if (e.kind === 'mg-posters') {
					if (r.bundleHashes.has(e.key)) out.add(pid);
				}
			}
			return out;
		};
		return { refsOf, open, existing };
	}

	// ------------------------------------------------------------------ scanning, classification

	/** A fresh (or recent) scan of the appdir. */
	async scan(force = false): Promise<ScanResult> {
		if (!force && this.lastScan && this.now() - this.lastScan.scannedAt < SCAN_TTL_MS) return this.lastScan;
		// A walk in flight answers this call too (a pass only removes what it found; ENOENT is fine).
		this.scanning ??= scanAppdir(this.o.appdir)
			.then((r) => {
				this.lastScan = r;
				return r;
			})
			.finally(() => {
				this.scanning = null;
			});
		return this.scanning;
	}

	/** Active job ids and the dedupe keys of active jobs (renders in flight name their entries there). */
	private activeJobs(): { ids: Set<string>; dedupe: string[] } {
		const ids = new Set<string>();
		const dedupe: string[] = [];
		for (const j of this.o.queue?.list({ active: true }) ?? []) {
			ids.add(j.id);
			if (j.dedupeKey) dedupe.push(j.dedupeKey);
		}
		return { ids, dedupe };
	}

	private classify(
		entries: readonly ScannedEntry[],
		info: ProjectsInfo,
		active: { ids: Set<string>; dedupe: string[] },
	): Classified[] {
		this.validateHolders();
		return entries.map((entry) => {
			const lastAccess = Math.max(this.index.access.get(entry.id) ?? 0, entry.mtimeMs, entry.usedMs ?? 0);
			const projects = info.refsOf(entry);
			return {
				entry,
				lastAccess,
				projects,
				inUse: this.inUseReason(entry, lastAccess, projects, info, active),
			};
		});
	}

	/** Why an entry must stay right now (null = it may go). Synchronous. */
	private inUseReason(
		e: ScannedEntry,
		lastAccess: number,
		projects: Set<string>,
		info: ProjectsInfo,
		active: { ids: Set<string>; dedupe: string[] },
		ignoreRecent = false,
	): string | null {
		if (this.pins.get(e.id)?.size) return 'pinned';
		if (this.adapters.get(e.kind)?.busy?.(e.key)) return 'busy';
		const token = e.kind === 'media-cache' || e.kind === 'proxies' ? e.key.slice(0, 64) : e.key;
		if (e.kind === 'exports' || e.kind === 'stills' ? active.ids.has(e.key) : false) return 'job';
		if (active.dedupe.some((k) => k.includes(token))) return 'rendering';
		if (e.kind === 'bundles' && this.isCurrentBundle(e)) return 'current';
		if (!ignoreRecent && this.now() - lastAccess < this.grace) return 'recent';
		for (const pid of projects) if (info.open.has(pid)) return 'open project';
		return null;
	}

	/** The newest Remotion bundle is the one the engine renders with (older ones are leftovers). */
	private isCurrentBundle(e: ScannedEntry): boolean {
		if (!e.key.startsWith('remotion/')) return false;
		const all = (this.lastScan?.entries ?? []).filter(
			(x) => x.kind === 'bundles' && x.key.startsWith('remotion/'),
		);
		const newest = all.reduce<ScannedEntry | null>((a, b) => (!a || b.mtimeMs > a.mtimeMs ? b : a), null);
		return newest?.id === e.id;
	}

	// ------------------------------------------------------------------ usage (CA-013)

	async usage(): Promise<CacheUsage> {
		const [scan, settings, info] = await Promise.all([this.scan(true), this.settings(), this.projectsInfo()]);
		const classified = this.classify(scan.entries, info, this.activeJobs());
		const kinds: CacheKindUsage[] = KIND_DEFS.map((d) => {
			const mine = classified.filter((c) => c.entry.kind === d.kind);
			const sum = (f: (c: Classified) => boolean) => mine.filter(f).reduce((s, c) => s + c.entry.bytes, 0);
			const oldest = mine.reduce((m, c) => Math.min(m, c.lastAccess), Number.POSITIVE_INFINITY);
			return {
				kind: d.kind,
				label: d.label,
				description: d.description,
				entries: mine.length,
				bytes: sum(() => true),
				inUseBytes: sum((c) => c.inUse !== null),
				referencedBytes: sum((c) => c.inUse === null && c.projects.size > 0),
				unusedBytes: sum((c) => c.inUse === null && c.projects.size === 0),
				maxBytes: this.kindBudget(d.kind, settings),
				maxAgeDays: this.maxAgeDays(d.kind, settings),
				defaultMaxAgeDays: d.defaultMaxAgeDays !== undefined ? d.defaultMaxAgeDays : settings.maxAgeDays,
				oldestAccess: Number.isFinite(oldest) && oldest > 0 ? new Date(oldest).toISOString() : null,
			};
		});
		const total = (k: keyof CacheKindUsage) => kinds.reduce((s, x) => s + (x[k] as number), 0);
		return {
			location: this.o.exposePaths ? physicalRoot(this.o.appdir, settings.location) : null,
			locationIsDefault: settings.location === null,
			logs: await logsUsage(this.o.paths),
			totalBytes: total('bytes'),
			inUseBytes: total('inUseBytes'),
			referencedBytes: total('referencedBytes'),
			unusedBytes: total('unusedBytes'),
			maxTotalBytes: this.totalBudget(settings),
			automaticBudget: settings.maxTotalBytes === null,
			freeDiskBytes: await freeDiskBytes(physicalRoot(this.o.appdir, settings.location)),
			kinds,
			other: await otherUsage(this.o.appdir),
			settings,
			lastGc: this.index.lastGc,
			scannedAt: new Date(scan.scannedAt).toISOString(),
		};
	}

	// ------------------------------------------------------------------ cleaning (CA-014…CA-018)

	/**
	 * One cleaning pass (serialised with other passes). `orphans` only sweeps temporary files. `kinds` limits what is
	 * removed (the orphan sweep always runs).
	 */
	clean(mode: CacheMode | 'orphans', kinds?: readonly CacheKind[]): Promise<CacheGcReport> {
		const run = this.gcChain.catch(() => undefined).then(() => this.runPass(mode, kinds));
		this.gcChain = run;
		return run;
	}

	private async runPass(mode: CacheMode | 'orphans', kinds?: readonly CacheKind[]): Promise<CacheGcReport> {
		const t = this.now();
		const settings = await this.settings();
		const scan = await this.scan(true);
		const info = await this.projectsInfo();
		const active = this.activeJobs();
		const report: CacheGcReport = {
			at: new Date(t).toISOString(),
			mode: mode === 'orphans' ? 'auto' : mode,
			removedEntries: 0,
			removedBytes: 0,
			removedOrphans: await this.sweepOrphans(scan.orphans, active.ids),
			keptInUse: 0,
			keptReferenced: 0,
			failed: 0,
			byKind: {},
		};
		// Ref sets of deleted projects go away (CA-012).
		for (const [scope, set] of [...this.index.refs])
			if (!info.existing.has(set.projectId)) {
				this.index.refs.delete(scope);
				this.index.changed();
			}
		if (mode !== 'orphans') {
			const only = kinds ? new Set(kinds) : null;
			const classified = this.classify(scan.entries, info, active);
			const victims = this.select(mode, classified, only, settings, report);
			for (const c of victims) {
				const r = await this.removeEntry(c, info, mode);
				if (r === 'removed') {
					report.removedEntries++;
					report.removedBytes += c.entry.bytes;
					const k = (report.byKind[c.entry.kind] ??= { entries: 0, bytes: 0 });
					k.entries++;
					k.bytes += c.entry.bytes;
				} else if (r === 'failed') report.failed++;
				else report.keptInUse++;
			}
			// Forget access times and refs of entries that are gone (pinned ids stay: they may be written soon).
			const present = new Set(scan.entries.map((e) => e.id));
			for (const c of victims) present.delete(c.entry.id);
			for (const id of [...this.index.access.keys()])
				if (!present.has(id) && !this.pins.has(id)) this.index.access.delete(id);
			for (const [scope, set] of this.index.refs) {
				const kept = set.entries.filter((id) => present.has(id) || this.pins.has(id));
				if (kept.length !== set.entries.length) this.index.refs.set(scope, { ...set, entries: kept });
			}
			this.index.lastGc = report;
			this.index.changed();
		}
		this.lastScan = null;
		await this.index.flush().catch(() => undefined);
		if (mode !== 'orphans' && (report.removedEntries || mode !== 'auto'))
			this.o.broadcaster?.publish('cache.cleaned', report);
		return report;
	}

	/** Which entries a pass removes (in order). Counts what is kept. */
	private select(
		mode: CacheMode,
		all: readonly Classified[],
		only: ReadonlySet<CacheKind> | null,
		s: CacheSettings,
		report: CacheGcReport,
	): Classified[] {
		const t = this.now();
		const inScope = (c: Classified) => !only || only.has(c.entry.kind);
		const candidates: Classified[] = [];
		for (const c of all) {
			if (!inScope(c)) continue;
			if (c.inUse) report.keptInUse++;
			else if (c.projects.size > 0 && mode !== 'all') report.keptReferenced++;
			else candidates.push(c);
		}
		if (mode !== 'auto') return candidates;
		const out = new Set<Classified>();
		// 1. Age (per kind).
		for (const c of candidates) {
			const max = this.maxAgeMs(c.entry.kind, s);
			if (max !== null && t - c.lastAccess > max) out.add(c);
		}
		// 2. Kind budgets, then 3. the total budget: least recently used unused entries first.
		const lru = candidates.filter((c) => !out.has(c)).sort((a, b) => a.lastAccess - b.lastAccess);
		const bytesOf = (f: (c: Classified) => boolean) =>
			all.filter((c) => f(c) && !out.has(c)).reduce((sum, c) => sum + c.entry.bytes, 0);
		for (const kind of CACHE_KINDS) {
			const max = this.kindBudget(kind, s);
			if (max === null) continue;
			let size = bytesOf((c) => c.entry.kind === kind);
			for (const c of lru) {
				if (size <= max) break;
				if (c.entry.kind !== kind || out.has(c)) continue;
				out.add(c);
				size -= c.entry.bytes;
			}
		}
		const total = this.totalBudget(s);
		if (total !== null) {
			let size = bytesOf(() => true);
			for (const c of lru) {
				if (size <= total) break;
				if (out.has(c)) continue;
				out.add(c);
				size -= c.entry.bytes;
			}
		}
		return [...out].sort((a, b) => a.lastAccess - b.lastAccess);
	}

	/**
	 * Removes one entry if nothing protects it at this moment. The checks and the start of the removal happen in one
	 * synchronous step, so a pin taken by `acquire` either comes first (the entry stays) or waits for the removal.
	 */
	private async removeEntry(
		c: Classified,
		info: ProjectsInfo,
		mode: CacheMode | 'discard',
	): Promise<'removed' | 'kept' | 'failed'> {
		const e = c.entry;
		if (this.removing.has(e.id)) return 'kept';
		const lastAccess = Math.max(c.lastAccess, this.index.access.get(e.id) ?? 0);
		const projects = c.projects;
		if (this.inUseReason(e, lastAccess, projects, info, this.activeJobs(), mode === 'discard')) return 'kept';
		if (mode !== 'all' && mode !== 'discard' && projects.size > 0) return 'kept';
		const doRemove = () => this.removePaths(e.paths);
		const adapter = this.adapters.get(e.kind);
		const p = (adapter?.remove ? adapter.remove(e.key, doRemove) : doRemove()).finally(() =>
			this.removing.delete(e.id),
		);
		this.removing.set(e.id, p);
		try {
			const ok = await p;
			if (ok) this.index.access.delete(e.id);
			// A media's `cache/<fingerprint>/` folder goes with its last entry.
			if (ok && (e.kind === 'media-cache' || e.kind === 'proxies'))
				await rmdir(dirname(e.paths[0]!)).catch(() => undefined);
			return ok ? 'removed' : 'failed';
		} catch {
			return 'failed';
		}
	}

	/**
	 * Removes the media cache files and proxies of one content fingerprint (`cache/<hex>/`) — a media being discarded
	 * (wp-m3-inpoint `MediaService.discard`: no stored project uses it). Same protections as a pass except the grace
	 * window (they were just made for it): entries pinned (a job reading, a response streaming), rendered by an active
	 * job, or shown by an open project are waited for up to `waitMs` (default 10 s; cancelled jobs end within ~5 s),
	 * then left in place — the next pass removes them once unused. Crash-safe removal; access times dropped.
	 */
	async removeFingerprint(
		fingerprintHex: string,
		opts: { waitMs?: number } = {},
	): Promise<{ removed: number; removedBytes: number; kept: number }> {
		if (!/^[0-9a-f]{64}$/.test(fingerprintHex)) throw new Error(`Invalid fingerprint ${fingerprintHex}`);
		const deadline = this.now() + (opts.waitMs ?? 10_000);
		let removed = 0;
		let removedBytes = 0;
		for (;;) {
			const scan = await this.scan(true);
			const mine = scan.entries.filter(
				(e) => (e.kind === 'media-cache' || e.kind === 'proxies') && e.key.startsWith(`${fingerprintHex}/`),
			);
			const info = await this.projectsInfo();
			const classified = this.classify(mine, info, this.activeJobs());
			let kept = 0;
			for (const c of classified) {
				const r = await this.removeEntry(c, info, 'discard');
				if (r === 'removed') {
					removed++;
					removedBytes += c.entry.bytes;
				} else kept++;
			}
			if (kept === 0 || this.now() >= deadline) {
				this.lastScan = null;
				this.index.changed();
				// The fingerprint folder itself once it is empty (temporary files of a cancelled job are its own).
				if (kept === 0) await rmdir(join(this.o.appdir, 'cache', fingerprintHex)).catch(() => undefined);
				return { removed, removedBytes, kept };
			}
			await new Promise((r) => setTimeout(r, 250));
		}
	}

	/**
	 * Crash-safe removal: every path is first renamed to `.trash-<rand>-<name>` (atomic; files first, so a derivative's
	 * marker file disappears before its directory), then deleted. A rename that fails (file busy on Windows) aborts:
	 * the entry stays for the next pass. Trash that cannot be deleted is swept later.
	 */
	private async removePaths(paths: readonly string[]): Promise<boolean> {
		const kinds = await Promise.all(
			paths.map(async (p) => ({
				p,
				dir: await lstat(p)
					.then((s) => s.isDirectory())
					.catch(() => null),
			})),
		);
		const ordered = kinds.filter((k) => k.dir !== null).sort((a, b) => Number(a.dir) - Number(b.dir));
		const moved: { from: string; to: string }[] = [];
		for (const { p } of ordered) {
			const to = join(dirname(p), `.trash-${randomBytes(4).toString('hex')}-${basename(p)}`);
			try {
				this.ownTrash.add(to);
				await rename(p, to);
				moved.push({ from: p, to });
			} catch (err) {
				this.ownTrash.delete(to);
				if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
				// Put back what was already moved: the entry stays whole for the next pass.
				for (const m of moved.reverse()) {
					await rename(m.to, m.from).catch(() => undefined);
					this.ownTrash.delete(m.to);
				}
				return false;
			}
		}
		const trash = moved.map((m) => m.to);
		for (const t of trash) {
			await rm(t, { recursive: true, force: true }).catch(() => undefined);
			this.ownTrash.delete(t);
		}
		return true;
	}

	/** Removes stale temporary files (crashed writes), trash and scratch of jobs that are gone (CA-017). */
	private async sweepOrphans(orphans: readonly Orphan[], activeJobs: ReadonlySet<string>): Promise<number> {
		const t = this.now();
		const maxAge = this.o.orphanAgeMs ?? ORPHAN_AGE_MS;
		let n = 0;
		for (const o of orphans) {
			const name = basename(o.path);
			if (this.ownTrash.has(o.path)) continue;
			if (/^job_[0-9a-f]{16}$/.test(name) && activeJobs.has(name)) continue;
			if (!isTrashName(name) && t - o.mtimeMs <= maxAge) continue;
			try {
				await rm(o.path, { recursive: true, force: true });
				n++;
			} catch {
				// busy: next pass
			}
		}
		return n;
	}
}
