// ImportService implementation (S01:LIFE-010, S04 §5, ARCHITECTURE §9.2):
// 1. acquire: web → chunked upload with progress in a client-side job (S04:IN-005, JB-045);
//             desktop → paths from the preload bridge → POST /api/media/register (S04:IN-003);
// 2. dedupe against the project (S04:IN-007) with one prompt per batch;
// 3. clip-mismatch prompt for the first visual clip into an empty sequence (S01:SEQ-005 / S04:IN-008);
// 4. commit ONE "Import N files" transaction (media.register + clip.place for timeline/program drops);
// 5. per-file failure summary; beforeunload guard while uploads run (S04:IN-013).
import type { RegisteredMedia } from '@jasper/api';
import { type EngineClient, EngineError } from '@jasper/engine-client';
import {
	formatTimecode,
	type ProjectDocument,
	parseSourceSidecar,
	type SourceSidecarInfo,
	sidecarCandidates,
	type TransactionResult,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import {
	type DragPayload,
	type ImportProgress,
	type ImportResult,
	type ImportService,
	type ImportTarget,
	PROJECT_ITEMS_MIME,
	type ProjectItemsDragPayload,
} from '../state/services.ts';
import {
	buildMediaAsset,
	displayBox,
	formatRate,
	LOCAL_ENGINE_ID,
	mismatchPatch,
	type SequenceSettingsPatch,
} from './assets.ts';
import { type ClientJobStore, clientJobs } from './client-jobs.ts';
import { baseName, type DesktopBridge, getDesktopBridge } from './desktop.ts';
import { type ImportFailure, type ImportPrompts, importPrompts } from './prompts.ts';
import {
	buildImportTransaction,
	buildPlaceItemsTransaction,
	type DuplicateChoice,
	findExistingMedia,
	type ImportPlacementContext,
	type PreparedMedia,
} from './transaction.ts';
import { type UnloadGuard, uploadUnloadGuard } from './unload-guard.ts';

type ImportServiceDeps = {
	engine: EngineClient;
	session: EditorSession;
	prompts?: ImportPrompts;
	jobs?: ClientJobStore;
	desktop?: DesktopBridge | null;
	unloadGuard?: UnloadGuard;
};

type Acquired = {
	reg: RegisteredMedia;
	name: string;
	path: string | null;
	/** M3 (S07:PRC-019): source-range sidecar of the file. */
	hint?: SourceSidecarInfo | null;
};

const isJson = (f: File) => f.name.toLowerCase().endsWith('.json');

/**
 * Source-range sidecars among dropped/picked files (M3, S07:PRC-019): `.json` files that parse as one, keyed by
 * lower-case file name. Other JSON files are left in the batch (they fail as unsupported media, as before).
 */
async function splitSidecars(
	files: File[],
): Promise<{ media: File[]; sidecars: Map<string, SourceSidecarInfo> }> {
	const sidecars = new Map<string, SourceSidecarInfo>();
	const media: File[] = [];
	for (const f of files) {
		if (!isJson(f)) {
			media.push(f);
			continue;
		}
		let info: SourceSidecarInfo | null = null;
		try {
			info = parseSourceSidecar(JSON.parse(await f.text()), f.name);
		} catch {
			info = null;
		}
		if (info) sidecars.set(f.name.toLowerCase(), info);
		else media.push(f);
	}
	return { media, sidecars };
}

function sidecarFor(fileName: string, sidecars: Map<string, SourceSidecarInfo>): SourceSidecarInfo | null {
	for (const n of sidecarCandidates(fileName)) {
		const hit = sidecars.get(n.toLowerCase());
		if (hit) return hit;
	}
	return null;
}

const errorInfo = (e: unknown): { code: string; message: string } =>
	e instanceof EngineError
		? { code: e.code, message: e.message }
		: {
				code: (e as { name?: string })?.name === 'AbortError' ? 'CANCELLED' : 'ERROR',
				message: e instanceof Error ? e.message : String(e),
			};

async function mapLimit<T>(
	items: T[],
	limit: number,
	fn: (item: T, i: number) => Promise<void>,
): Promise<void> {
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			await fn(items[i]!, i);
		}
	});
	await Promise.all(workers);
}

export class EngineImportService implements ImportService {
	private readonly engine: EngineClient;
	private readonly session: EditorSession;
	private readonly prompts: ImportPrompts;
	private readonly jobs: ClientJobStore;
	private readonly desktop: DesktopBridge | null;
	private readonly guard: UnloadGuard;

	constructor(deps: ImportServiceDeps) {
		this.engine = deps.engine;
		this.session = deps.session;
		this.prompts = deps.prompts ?? importPrompts;
		this.jobs = deps.jobs ?? clientJobs;
		this.desktop = deps.desktop === undefined ? getDesktopBridge() : deps.desktop;
		this.guard = deps.unloadGuard ?? uploadUnloadGuard;
	}

	get isDesktop(): boolean {
		return this.desktop !== null;
	}

	/** File ▸ Import (Ctrl+I): native dialog on desktop, returns paths; null = use the browser picker. */
	async pickDesktopPaths(): Promise<string[] | null> {
		return this.desktop ? this.desktop.pickMedia() : null;
	}

	async importFiles(
		input: { files?: File[]; paths?: string[]; names?: (string | undefined)[] },
		target: ImportTarget,
		onProgress?: (p: ImportProgress) => void,
	): Promise<ImportResult> {
		const failed: ImportFailure[] = [];
		const acquired: Acquired[] = [];
		const projectId = this.session.projectId;
		if (this.session.getState().readOnly) {
			// Nothing can be committed: do not upload bytes for nothing.
			const names = [...(input.files ?? []).map((f) => f.name), ...(input.paths ?? []).map(baseName)];
			for (const name of names)
				failed.push({ name, code: 'E_NOT_OWNER', message: 'The project is read-only' });
			if (failed.length) this.prompts.failures({ failed, committed: 0 });
			return { mediaIds: [], clipIds: [], failed, registered: [] };
		}

		// 1a. desktop paths → register in place
		const paths = input.paths ?? [];
		if (paths.length) {
			const jobId = this.jobs.add({
				kind: 'probe',
				title: `Registering ${paths.length} ${paths.length === 1 ? 'file' : 'files'}`,
				projectId,
				progress: null,
			});
			for (const p of paths)
				onProgress?.({ fileName: baseName(p), phase: 'registering', loaded: 0, total: 1 });
			try {
				const r = await this.engine.registerMedia({ projectId, paths });
				const remaining = [...paths];
				for (const reg of r.items) {
					const byLocator = reg.locators.find((l) => l.type === 'path');
					const path =
						(byLocator && byLocator.type === 'path' && remaining.includes(byLocator.path)
							? byLocator.path
							: null) ??
						remaining.find((p) => baseName(p) === reg.originalName) ??
						null;
					if (path) remaining.splice(remaining.indexOf(path), 1);
					acquired.push({ reg, name: reg.originalName, path, hint: reg.sourceHint ?? null });
					onProgress?.({ fileName: reg.originalName, phase: 'done', loaded: 1, total: 1 });
				}
				for (const e of r.errors) {
					failed.push({ name: baseName(e.path), code: e.code, message: e.message });
					onProgress?.({
						fileName: baseName(e.path),
						phase: 'failed',
						loaded: 0,
						total: 1,
						error: e.message,
					});
				}
				this.jobs.update(jobId, {
					state: r.items.length || !r.errors.length ? 'succeeded' : 'failed',
					progress: 1,
				});
			} catch (e) {
				const info = errorInfo(e);
				for (const p of paths) failed.push({ name: baseName(p), ...info });
				this.jobs.update(jobId, { state: 'failed', error: { ...info, retryable: false } });
			}
		}

		// 1b. web files → chunked uploads (client-side jobs), bounded parallelism; source-range sidecars picked
		// with them are read here, not uploaded (M3, S07:PRC-019).
		const picked = input.files ?? [];
		// (Only awaited when JSON files are present: the unload guard below must start synchronously otherwise.)
		const { media: files, sidecars } = picked.some(isJson)
			? await splitSidecars(picked)
			: { media: picked, sidecars: new Map<string, SourceSidecarInfo>() };
		if (files.length) {
			const release = this.guard.begin();
			try {
				const results: (Acquired | null)[] = new Array(files.length).fill(null);
				await mapLimit(files, 3, async (file, i) => {
					const controller = new AbortController();
					const jobId = this.jobs.add({
						kind: 'upload',
						title: `Upload – ${file.name}`,
						projectId,
						stage: 'Uploading',
						totalBytes: file.size,
						loadedBytes: 0,
						onCancel: () => controller.abort(),
					});
					const started = Date.now();
					try {
						const reg = await this.engine.uploadFile(file, {
							projectId,
							fileName: file.name,
							signal: controller.signal,
							onProgress: ({ loaded, total }) => {
								const elapsed = (Date.now() - started) / 1000;
								const rate = elapsed > 0.5 ? loaded / elapsed : 0;
								this.jobs.update(jobId, {
									progress: total > 0 ? loaded / total : 1,
									loadedBytes: loaded,
									...(rate > 0 ? { etaSec: Math.max(0, (total - loaded) / rate) } : {}),
								});
								onProgress?.({ fileName: file.name, phase: 'uploading', loaded, total });
							},
						});
						this.jobs.update(jobId, { state: 'succeeded', progress: 1, stage: 'Uploaded' });
						onProgress?.({ fileName: file.name, phase: 'done', loaded: file.size, total: file.size });
						results[i] = {
							reg,
							name: input.names?.[(input.files ?? []).indexOf(file)] || file.name,
							path: null,
							hint: sidecarFor(file.name, sidecars),
						};
					} catch (e) {
						const info = errorInfo(e);
						const cancelled = controller.signal.aborted;
						this.jobs.update(jobId, {
							state: cancelled ? 'cancelled' : 'failed',
							error: { ...info, retryable: !cancelled },
						});
						failed.push({ name: file.name, ...info });
						onProgress?.({
							fileName: file.name,
							phase: 'failed',
							loaded: 0,
							total: file.size,
							error: info.message,
						});
					}
				});
				for (const r of results) if (r) acquired.push(r);
			} finally {
				release();
			}
		}

		if (!acquired.length) {
			if (failed.length) this.prompts.failures({ failed, committed: 0 });
			return { mediaIds: [], clipIds: [], failed, registered: [] };
		}
		return this.commit(acquired, target, failed);
	}

	private async commit(
		acquired: Acquired[],
		target: ImportTarget,
		failed: ImportFailure[],
	): Promise<ImportResult> {
		const doc = this.session.getCommitted();
		const now = new Date().toISOString();
		const prepared: PreparedMedia[] = acquired.map((a) => ({
			name: a.name,
			asset: buildMediaAsset(a.reg, {
				id: this.session.ctx.ids.next('med'),
				engineId: LOCAL_ENGINE_ID,
				now,
				path: a.path,
			}),
			existingMediaId: findExistingMedia(doc, a.reg.fingerprint),
			...(a.hint ? { sourceHint: a.hint } : {}),
		}));

		// 2. duplicates: one prompt per batch (S04:IN-007)
		let duplicateChoice: DuplicateChoice = 'import-again';
		const dups = prepared.filter((p) => p.existingMediaId);
		if (dups.length) duplicateChoice = await this.prompts.duplicates({ names: dups.map((d) => d.name) });

		// 3. clip mismatch (first visual clip into an empty sequence)
		const placement = this.placementContext(target);
		const matchSettings =
			target.kind === 'timeline' || target.kind === 'program'
				? await this.askMismatch(
						doc,
						target.sequenceId,
						prepared.map((p) => ({ asset: p.asset, name: p.name })),
					)
				: null;

		// 4. one transaction
		const current = this.session.getCommitted();
		const built = buildImportTransaction({
			doc: current,
			prepared,
			target,
			duplicateChoice,
			matchSettings,
			placement,
		});
		const mediaIds: string[] = [];
		const clipIds: string[] = [];
		if (built.tx) {
			const result = this.session.apply(built.tx);
			if (!result.ok) {
				const err = result.errors[0];
				for (const p of prepared)
					failed.push({
						name: p.name,
						code: err?.code ?? 'E_REJECTED',
						message: err?.message ?? 'Import was rejected',
					});
				this.prompts.failures({ failed, committed: 0 });
				return { mediaIds: [], clipIds: [], failed, registered: [] };
			}
			collectIds(result, built.registerIndex, built.placeIndex, mediaIds, clipIds);
		}
		prepared.forEach((p, i) => {
			if (built.registerIndex[i] === null && p.existingMediaId) mediaIds.push(p.existingMediaId);
		});
		this.selectImported(mediaIds, clipIds);
		if (failed.length) this.prompts.failures({ failed, committed: prepared.length });
		return { mediaIds: [...new Set(mediaIds)], clipIds, failed, registered: acquired.map((a) => a.reg) };
	}

	private placementContext(target: ImportTarget): ImportPlacementContext | undefined {
		if (target.kind !== 'program') return undefined;
		const view = this.session.getState().views[target.sequenceId];
		const seq = this.session.getCommitted().sequences[target.sequenceId];
		return {
			playheadFrame: this.session.transport.getState().frame,
			targetTracks: {
				video: view?.targeting.video[0] ?? seq?.videoTracks[0]?.id ?? null,
				audio: view?.targeting.audio[0] ?? seq?.audioTracks[0]?.id ?? null,
			},
		};
	}

	private async askMismatch(
		doc: ProjectDocument,
		sequenceId: string,
		sources: { asset: PreparedMedia['asset']; name: string }[],
	): Promise<SequenceSettingsPatch | null> {
		const seq = doc.sequences[sequenceId];
		if (!seq || Object.keys(seq.clips).length > 0) return null;
		const first = sources.find(
			(s) => s.asset.kind === 'video' || s.asset.kind === 'image' || s.asset.kind === 'animated-image',
		);
		if (!first) return null;
		const patch = mismatchPatch(seq, first.asset);
		if (!patch) return null;
		const box = displayBox(first.asset)!;
		const vs = first.asset.probe.streams.find((s) => s.type === 'video');
		const seqName =
			Object.values(doc.items).find((it) => it.kind === 'sequence' && it.sequenceId === seq.id)?.name ??
			'Sequence';
		const answer = await this.prompts.clipMismatch({
			clipName: first.name,
			clip: {
				width: box.width,
				height: box.height,
				fps:
					vs && vs.type === 'video' && first.asset.kind === 'video'
						? formatRate(vs.frameRate)
						: formatRate(seq.settings.frameRate),
			},
			sequence: {
				name: seqName,
				width: seq.settings.width,
				height: seq.settings.height,
				fps: formatRate(seq.settings.frameRate),
			},
		});
		return answer === 'change' ? patch : null;
	}

	private selectImported(mediaIds: string[], clipIds: string[]) {
		const doc = this.session.getCommitted();
		const itemIds = Object.values(doc.items)
			.filter((it) => it.kind === 'media' && mediaIds.includes(it.mediaId))
			.map((it) => it.id);
		if (clipIds.length) this.session.select('timeline', clipIds, 'replace', { linked: false });
		else if (itemIds.length) this.session.select('project', itemIds.slice(-mediaIds.length), 'replace');
	}

	async placeItems(
		payload: ProjectItemsDragPayload,
		target: Extract<ImportTarget, { kind: 'timeline' | 'program' }>,
	): Promise<{ clipIds: string[] }> {
		const doc = this.session.getCommitted();
		const sources = payload.itemIds.flatMap((id) => {
			const it = doc.items[id];
			const asset = it?.kind === 'media' ? doc.media[it.mediaId] : undefined;
			return asset ? [{ asset, name: it!.name }] : [];
		});
		const matchSettings = await this.askMismatch(doc, target.sequenceId, sources);
		const built = buildPlaceItemsTransaction({
			doc: this.session.getCommitted(),
			itemIds: payload.itemIds,
			target,
			matchSettings,
			placement: this.placementContext(target),
		});
		if (!built.tx) return { clipIds: [] };
		const result = this.session.apply(built.tx);
		if (!result.ok) throw new Error(result.errors[0]?.message ?? 'Placement was rejected');
		const clipIds: string[] = [];
		collectIds(result, [], built.placeIndex, [], clipIds);
		if (clipIds.length) this.session.select('timeline', clipIds, 'replace', { linked: false });
		return { clipIds };
	}

	readDataTransfer(dt: DataTransfer): DragPayload | null {
		return readDataTransfer(dt);
	}

	/** Human summary for toasts, e.g. "Imported 2 files at 00;00;05;00". */
	describe(result: ImportResult, target: ImportTarget): string {
		const n = result.mediaIds.length;
		if (target.kind !== 'timeline') return `Imported ${n} ${n === 1 ? 'file' : 'files'}`;
		const seq = this.session.getCommitted().sequences[target.sequenceId];
		const tc = seq
			? formatTimecode(target.at, seq.settings.frameRate, { dropFrame: seq.settings.dropFrame })
			: '';
		return `Imported ${n} ${n === 1 ? 'file' : 'files'}${tc ? ` at ${tc}` : ''}`;
	}
}

function collectIds(
	result: Extract<TransactionResult, { ok: true }>,
	registerIndex: (number | null)[],
	placeIndex: (number | null)[],
	mediaIds: string[],
	clipIds: string[],
) {
	for (const i of registerIndex) {
		if (i === null) continue;
		const r = result.results[i] as { mediaId?: string } | undefined;
		if (r?.mediaId) mediaIds.push(r.mediaId);
	}
	for (const i of placeIndex) {
		if (i === null) continue;
		const r = result.results[i] as { clipIds?: string[] } | undefined;
		if (r?.clipIds) clipIds.push(...r.clipIds);
	}
}

/** DataTransfer → typed payload: in-app project items first, then OS files (S05:PRJ-007). */
export function readDataTransfer(dt: DataTransfer): DragPayload | null {
	const types = Array.from(dt.types ?? []);
	if (types.includes(PROJECT_ITEMS_MIME)) {
		try {
			const raw = JSON.parse(dt.getData(PROJECT_ITEMS_MIME)) as { itemIds?: unknown };
			const itemIds = Array.isArray(raw.itemIds)
				? raw.itemIds.filter((x): x is string => typeof x === 'string')
				: [];
			if (itemIds.length) return { type: 'jasper/project-items', itemIds };
		} catch {
			// fall through to files
		}
	}
	const files = Array.from(dt.files ?? []);
	if (files.length) return { type: 'os-files', files };
	return null;
}

/** Writes the in-app drag payload (Project panel → Timeline/Program/Source). */
export function writeProjectItemsDrag(dt: DataTransfer, itemIds: string[]): void {
	const payload: ProjectItemsDragPayload = { type: 'jasper/project-items', itemIds };
	dt.setData(PROJECT_ITEMS_MIME, JSON.stringify(payload));
	dt.setData('text/plain', itemIds.join(','));
	dt.effectAllowed = 'copyMove';
}
