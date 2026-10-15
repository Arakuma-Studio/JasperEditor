// The `sound-index` job (spec 12 §2.1, §2.8; wp-note "WP1.2"): scans the starter kit, installed packs, enabled user
// folders and the Jasper Synth catalogue; decodes each new or changed file with ffmpeg, runs `analyzeSound` (on a worker
// thread, analysis.ts) and `judgeSound` (with the profile of the sound's first type) and writes the visual data; then commits the new index
// in one atomic write.
//
// Incremental: a file whose size and modification time match the index keeps its fingerprint without being read; a
// fingerprint whose analysis is cached (`sounds/cache/<fp>/analysis-v<n>.json`) is not decoded again. Cancellation
// (JobContext.signal) is checked between files and kills a running ffmpeg; a cancelled scan commits nothing (the
// analyses it finished stay cached for the next run). When the folder list changes during a scan, or another index
// request arrives (`requestPass`), it scans again (at most MAX_PASSES scans per job); what it commits keeps only the
// folders that are enabled, and declared the same way, at commit time; when the scan was still stale it queues a
// follow-up job (`followUp`). After a commit, cache entries of fingerprints the index no longer has and Jasper Synth
// renders it no longer uses are deleted (`pruneSoundCache`).
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
	SOUND_VISUAL_VERSION,
	type SoundEntry,
	SoundEntrySchema,
	SoundIndexRequestSchema,
	type SoundIndexResult,
	type SoundManifestPack,
	type SoundRoot,
	type SoundSource,
	type SoundSourceType,
} from '@jasper/api';
import { judgeSound, SOUND_DESCRIPTORS_VERSION, type SoundDescriptors } from '@jasper/audio-fx';
import {
	inferTypesFromName,
	isSoundTypeId,
	JASPER_LICENSE,
	licenseUrlOf,
	requiresAttribution,
	SOUND_TYPE_PROFILES,
	StoredSoundTypeSchema,
	tokenizeSoundText,
} from '@jasper/project';
import { type JobContext, JobError } from '../jobs/types.ts';
import { fingerprintFile, fingerprintHex } from '../media/fingerprint.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { atomicWriteJson, readJsonOrNull } from '../tools/fs.ts';
import type { SoundAnalyzer } from './analysis.ts';
import type { AnalysisResult } from './analysis-core.ts';
import { decodeSound, type SoundFormat } from './decode.ts';
import type { FileRecord, LibrarySnapshot, SoundLibrary } from './library.ts';
import type { SoundRootStore } from './roots.ts';
import { isSoundFileName, type LoadedManifest, loadManifest, loadPackManifest } from './starter.ts';
import { ensureSynthFile, type SynthItem, synthFileName } from './synth.ts';
import { visualCacheFile, writeVisual } from './visual.ts';

/** Engine-side analysis revision (decode settings); with SOUND_DESCRIPTORS_VERSION it versions cached analyses. */
const ENGINE_ANALYSIS_REVISION = 1;
export const ANALYSIS_VERSION = SOUND_DESCRIPTORS_VERSION * 1000 + ENGINE_ANALYSIS_REVISION;

/** Folder scans are bounded (security review §5: depth and count, no symlinked folders). */
export const MAX_SCAN_DEPTH = 12;
export const MAX_FILES_PER_ROOT = 20_000;
/** At most this many sounds in the library. */
export const MAX_LIBRARY_SOUNDS = 50_000;
/** Scans per job when the folder list changes or another request arrives during a scan (then a follow-up job). */
export const MAX_PASSES = 3;
const MAX_REPORTED_ERRORS = 100;
const MAX_TAGS = 16;
/** Words that say nothing about a sound (left out of folder tags). */
const TAG_STOPWORDS = new Set([
	'sound',
	'sounds',
	'sfx',
	'fx',
	'audio',
	'the',
	'and',
	'of',
	'a',
	'an',
	'wav',
	'mp3',
]);

export const SOURCE_PRIORITY: Record<SoundSourceType, number> = { starter: 0, pack: 1, folder: 2, synth: 3 };

type ItemMeta = {
	title: string;
	types: string[];
	tags: string[];
	author: string;
	license: string;
	licenseUrl?: string;
	sourceUrl?: string;
	attribution: string | null;
};

export type IndexItem = {
	/** Location key in the index's `files` (`starter:<file>`, `pack:<id>:<file>`, `folder:<rootId>:<relPath>`, `synth:<recipe>:<seed>`). */
	key: string;
	source: SoundSource;
	/** Absolute path, or null for a synth sound rendered on demand. */
	path: string | null;
	meta: ItemMeta;
};

type CachedAnalysis = {
	fingerprint: string;
	version: number;
	format: SoundFormat;
	descriptors: SoundDescriptors;
};

export function soundIdOf(fingerprint: string): string {
	return `snd_${fingerprintHex(fingerprint).slice(0, 16)}`;
}

export function analysisCacheFile(cacheDir: string, fingerprint: string): string {
	return join(cacheDir, fingerprintHex(fingerprint), `analysis-v${ANALYSIS_VERSION}.json`);
}

/**
 * The credit line of a sound: a folder's template with `{title}`, `{file}`, `{folder}`, `{author}`, `{license}`
 * filled in; else, when the licence requires attribution, `"<title>" by <author> (<source>), licensed under
 * <licence> (<licence URL>)`; else null.
 */
export function attributionFor(o: {
	title: string;
	author: string;
	license: string;
	licenseUrl?: string;
	sourceUrl?: string;
	template?: string;
	file?: string;
	folder?: string;
}): string | null {
	if (o.template?.trim()) {
		const vars: Record<string, string> = {
			title: o.title,
			file: o.file ?? '',
			folder: o.folder ?? '',
			author: o.author,
			license: o.license,
		};
		return o.template
			.replace(/\{(title|file|folder|author|license)\}/g, (_, k: string) => vars[k] ?? '')
			.slice(0, 4000);
	}
	if (!requiresAttribution(o.license)) return null;
	const by = o.author.trim() ? ` by ${o.author.trim()}` : '';
	const src = o.sourceUrl ? ` (${o.sourceUrl})` : '';
	const lic = o.licenseUrl ? ` (${o.licenseUrl})` : '';
	return `"${o.title}"${by}${src}, licensed under ${o.license}${lic}`.slice(0, 4000);
}

const storedTypes = (types: readonly string[]) =>
	[...new Set(types.map((t) => t.toLowerCase()))]
		.filter((t) => StoredSoundTypeSchema.safeParse(t).success)
		.slice(0, 32);

/** A readable title from a file name: extension dropped, `_` and `-` as spaces. */
export function titleFromFile(name: string): string {
	const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, '');
	const t = base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
	return (t || base || name).slice(0, 500);
}

/** Tags of a folder sound: the words of its folders and file name (no numbers, stopwords or one-letter words). */
export function tagsFromPath(relPath: string): string[] {
	const out: string[] = [];
	for (const t of tokenizeSoundText(relPath.replace(/\.[A-Za-z0-9]{1,5}$/, ''))) {
		if (t.length < 2 || /^\d+$/.test(t) || TAG_STOPWORDS.has(t) || out.includes(t)) continue;
		out.push(t.slice(0, 64));
		if (out.length >= MAX_TAGS) break;
	}
	return out;
}

function manifestItems(m: LoadedManifest, kind: 'starter' | 'pack'): IndexItem[] {
	const packs = new Map(m.packs.map((p) => [p.id, p]));
	return m.sounds.map((s) => {
		const pack = s.packId ? packs.get(s.packId) : undefined;
		const types = storedTypes(s.types.length ? s.types : inferTypesFromName(s.file));
		const licenseUrl =
			s.licenseUrl ??
			(pack?.license === s.license ? pack?.licenseUrl : undefined) ??
			licenseUrlOf(s.license) ??
			undefined;
		const source: SoundSource =
			kind === 'starter'
				? { type: 'starter', file: s.file, ...(s.packId ? { packId: s.packId } : {}) }
				: { type: 'pack', packId: s.packId!, file: s.file };
		return {
			key: kind === 'starter' ? `starter:${s.file}` : `pack:${s.packId}:${s.file}`,
			source,
			path: join(m.dir, ...s.file.split('/')),
			meta: {
				title: s.title,
				types,
				tags: s.tags.map((t) => t.toLowerCase()),
				author: s.author,
				license: s.license,
				...(licenseUrl ? { licenseUrl } : {}),
				...(s.sourceUrl ? { sourceUrl: s.sourceUrl } : {}),
				attribution:
					s.attribution ??
					attributionFor({
						title: s.title,
						author: s.author,
						license: s.license,
						...(licenseUrl ? { licenseUrl } : {}),
						...(s.sourceUrl ? { sourceUrl: s.sourceUrl } : {}),
					}),
			},
		};
	});
}

/** Walks a user folder: audio files only, hidden names and symlinks skipped, bounded depth and count. */
export async function walkRoot(
	root: SoundRoot,
	signal: AbortSignal,
	onError: (file: string, message: string) => void,
	opts: { maxFiles?: number; onLibraryFull?: () => void } = {},
): Promise<IndexItem[]> {
	const items: IndexItem[] = [];
	// The folder's own cap, or the room left in the library when that is smaller.
	const libraryRoom = opts.maxFiles ?? Number.POSITIVE_INFINITY;
	const cap = Math.max(0, Math.min(MAX_FILES_PER_ROOT, libraryRoom));
	const stack: { dir: string; rel: string; depth: number }[] = [{ dir: root.path, rel: '', depth: 0 }];
	let truncated = false;
	while (stack.length) {
		if (signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
		const { dir, rel, depth } = stack.pop()!;
		let dirents: import('node:fs').Dirent[];
		try {
			dirents = await readdir(dir, { withFileTypes: true });
		} catch (e) {
			onError(rel || '.', `the folder cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
			continue;
		}
		dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		const subdirs: { dir: string; rel: string; depth: number }[] = [];
		for (const d of dirents) {
			const name = String(d.name);
			if (name.startsWith('.') || name.includes('\\') || name.includes('/')) continue;
			const relPath = rel ? `${rel}/${name}` : name;
			if (d.isDirectory()) {
				if (depth + 1 <= MAX_SCAN_DEPTH)
					subdirs.push({ dir: join(dir, name), rel: relPath, depth: depth + 1 });
				continue;
			}
			if (!d.isFile() || !isSoundFileName(name)) continue;
			if (items.length >= cap) {
				truncated = true;
				break;
			}
			const title = titleFromFile(name);
			const licenseUrl = licenseUrlOf(root.license) ?? undefined;
			const author = root.author ?? '';
			items.push({
				key: `folder:${root.id}:${relPath}`,
				source: { type: 'folder', rootId: root.id, relPath },
				path: join(dir, name),
				meta: {
					title,
					types: storedTypes(inferTypesFromName(relPath)),
					tags: tagsFromPath(relPath),
					author,
					license: root.license,
					...(licenseUrl ? { licenseUrl } : {}),
					attribution: attributionFor({
						title,
						author,
						license: root.license,
						...(licenseUrl ? { licenseUrl } : {}),
						...(root.attributionTemplate ? { template: root.attributionTemplate } : {}),
						file: name,
						folder: root.label,
					}),
				},
			});
		}
		if (truncated) break;
		// Depth-first in name order (reverse push so the first name is scanned first).
		for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]!);
	}
	if (truncated) {
		if (cap < MAX_FILES_PER_ROOT) opts.onLibraryFull?.();
		else
			onError('.', `more than ${MAX_FILES_PER_ROOT} audio files: the rest of "${root.label}" is not indexed`);
	}
	return items;
}

function synthEntryItem(s: SynthItem): IndexItem {
	return {
		key: `synth:${s.recipe}:${s.seed}`,
		source: { type: 'synth', recipe: s.recipe, seed: s.seed },
		path: null,
		meta: {
			title: `Jasper ${s.title}`,
			types: [s.type],
			tags: ['jasper', 'synth', 'procedural'],
			author: 'JasperEditor',
			license: JASPER_LICENSE,
			attribution: null,
		},
	};
}

export type IndexDeps = {
	library: SoundLibrary;
	roots: SoundRootStore;
	ffmpeg: Ffmpeg;
	/** Runs `analyzeSound` and the visual data off the main thread when it can. */
	analyzer: SoundAnalyzer;
	starterDir: () => string;
	packsDir: string;
	synthDir: string;
	cacheDir: string;
	synthItems: () => SynthItem[];
	now?: () => string;
	/** Folders may be scanned (local mode, D-47; default true). Folder roots are skipped otherwise. */
	local?: () => boolean;
	/** At most this many sounds (default MAX_LIBRARY_SOUNDS; tests use small caps). */
	maxSounds?: number;
	/** Queue another index job once job `jobId` has finished (the scan it committed was already stale). */
	followUp?: (jobId: string, full: boolean) => void;
	log?: (m: string) => void;
};

/** Root fields whose change changes the sounds an index holds for it (licence, credits, author, path). */
export function rootDeclaration(r: SoundRoot): string {
	return JSON.stringify([r.path, r.license, r.author ?? '', r.attributionTemplate ?? '', r.label]);
}

/**
 * Deletes cache entries the committed index no longer uses: `cache/<fingerprintHex>/` folders of fingerprints it has
 * neither as a sound nor as a file record, analyses and visual data of older versions, and Jasper Synth renders of
 * sounds it does not list (older SYNTH_VERSIONs included). Never throws; returns what it removed.
 */
export async function pruneSoundCache(
	o: { cacheDir: string; synthDir: string },
	snapshot: Pick<LibrarySnapshot, 'sounds' | 'files'>,
): Promise<{ dirs: number; files: number }> {
	const keep = new Set<string>();
	const hex = (fp: string) => {
		try {
			keep.add(fingerprintHex(fp));
		} catch {
			// not a fingerprint: nothing to keep
		}
	};
	const synthKeep = new Set<string>();
	for (const e of Object.values(snapshot.sounds)) {
		hex(e.fingerprint);
		if (e.source.type === 'synth') synthKeep.add(synthFileName(e.source.recipe, e.source.seed));
	}
	for (const f of Object.values(snapshot.files)) hex(f.fingerprint);
	let dirs = 0;
	let files = 0;
	const names = await readdir(o.cacheDir, { withFileTypes: true }).catch(() => []);
	const analysisName = `analysis-v${ANALYSIS_VERSION}.json`;
	const visualName = `visual-v${SOUND_VISUAL_VERSION}.json`;
	for (const d of names) {
		const name = String(d.name);
		if (!d.isDirectory() || !/^[0-9a-f]{64}$/.test(name)) continue;
		const dir = join(o.cacheDir, name);
		if (!keep.has(name)) {
			await rm(dir, { recursive: true, force: true }).then(
				() => dirs++,
				() => undefined,
			);
			continue;
		}
		for (const f of await readdir(dir).catch(() => [] as string[])) {
			const old =
				(/^analysis-v\d+\.json$/.test(f) && f !== analysisName) ||
				(/^visual-v\d+\.json$/.test(f) && f !== visualName);
			if (old)
				await rm(join(dir, f), { force: true }).then(
					() => files++,
					() => undefined,
				);
		}
	}
	for (const f of await readdir(o.synthDir).catch(() => [] as string[])) {
		if (!/-\d+-v\d+\.wav$/.test(f) || synthKeep.has(f)) continue;
		await rm(join(o.synthDir, f), { force: true }).then(
			() => files++,
			() => undefined,
		);
	}
	return { dirs, files };
}

async function readCachedAnalysis(file: string, fingerprint: string): Promise<CachedAnalysis | null> {
	let raw: unknown;
	try {
		raw = await readJsonOrNull(file);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as CachedAnalysis;
	if (r.fingerprint !== fingerprint || r.version !== ANALYSIS_VERSION || !r.format || !r.descriptors)
		return null;
	const check = SoundEntrySchema.shape.descriptors.safeParse(r.descriptors);
	const fmt = SoundEntrySchema.shape.format.safeParse(r.format);
	return check.success && fmt.success ? { ...r, descriptors: r.descriptors, format: fmt.data } : null;
}

/** Installed packs: `<packsDir>/<id>/pack.json`. */
async function loadPacks(packsDir: string, onError: (file: string, message: string) => void) {
	const out: LoadedManifest[] = [];
	let names: string[] = [];
	try {
		names = (await readdir(packsDir, { withFileTypes: true }))
			.filter((d) => d.isDirectory() && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(d.name))
			.map((d) => d.name)
			.sort();
	} catch {
		return out;
	}
	for (const id of names) {
		const m = await loadPackManifest(join(packsDir, id), id);
		for (const e of m.errors) onError(`${id}/pack.json`, e);
		if (m.status === 'ok') out.push(m);
	}
	return out;
}

export class SoundIndexer {
	constructor(private readonly deps: IndexDeps) {}

	private now(): string {
		return this.deps.now?.() ?? new Date().toISOString();
	}

	/** An index request that arrived while a job was queued or running: one more pass (full when asked). */
	private requested: { full: boolean } | null = null;

	/** Asks the queued or running index job for another pass after its current scan (a joined request). */
	requestPass(full: boolean): void {
		this.requested = { full: (this.requested?.full ?? false) || full };
	}

	private takeRequest(): { full: boolean } | null {
		const r = this.requested;
		this.requested = null;
		return r;
	}

	/**
	 * The job runner: scans until neither the folder list changed nor another request arrived during a scan (at most
	 * MAX_PASSES scans), then commits what is still true (folders enabled and declared the same way now) and, when the
	 * last scan was stale, queues a follow-up job. Then prunes the cache.
	 */
	async run(ctx: JobContext): Promise<SoundIndexResult> {
		const input = SoundIndexRequestSchema.safeParse(ctx.input ?? {});
		let full = (input.success ? input.data.full === true : false) || this.takeRequest()?.full === true;
		let base: Pick<LibrarySnapshot, 'files'> | undefined;
		for (let pass = 1; ; pass++) {
			const rev = this.deps.roots.revision;
			const { next, result, before } = await this.scan(ctx, full, base);
			if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
			const again = this.takeRequest();
			const stale = again !== null || this.deps.roots.revision !== rev;
			if (stale && pass < MAX_PASSES) {
				// The next pass reuses this one's fingerprints and analyses (a full pass is not repeated unless asked).
				full = again?.full === true;
				base = next;
				continue;
			}
			const committed = await this.deps.library.commit(await this.current(next));
			const late = this.takeRequest();
			if (stale || late) this.deps.followUp?.(ctx.job.id, (again?.full ?? false) || (late?.full ?? false));
			await pruneSoundCache(this.deps, committed).catch((e) =>
				this.deps.log?.(`sound library: cache cleanup failed: ${(e as Error).message}`),
			);
			const after = Object.keys(committed.sounds);
			const afterSet = new Set(after);
			return {
				...result,
				sounds: after.length,
				files: Object.keys(committed.files).length,
				added: after.filter((id) => !before.has(id)).length,
				removed: [...before].filter((id) => !afterSet.has(id)).length,
				snapshotHash: committed.snapshotHash,
			};
		}
	}

	/** A scanned index reduced to what is still true: sounds and files of folders enabled, and declared the same, now. */
	private async current(
		next: Omit<LibrarySnapshot, 'snapshotHash'>,
	): Promise<Omit<LibrarySnapshot, 'snapshotHash'>> {
		const local = this.deps.local?.() ?? true;
		const now = local ? (await this.deps.roots.list()).filter((r) => r.enabled) : [];
		const nowById = new Map(now.map((r) => [r.id, rootDeclaration(r)]));
		const live = new Set(next.roots.filter((r) => nowById.get(r.id) === rootDeclaration(r)).map((r) => r.id));
		const sounds: Record<string, SoundEntry> = {};
		for (const [id, e] of Object.entries(next.sounds))
			if (e.source.type !== 'folder' || live.has(e.source.rootId)) sounds[id] = e;
		const files: Record<string, FileRecord> = {};
		for (const [k, v] of Object.entries(next.files)) {
			const m = /^folder:(root_[0-9a-f]+):/.exec(k);
			if (!k.startsWith('folder:') || (m && live.has(m[1]!))) files[k] = v;
		}
		return { ...next, roots: next.roots.filter((r) => live.has(r.id)), sounds, files };
	}

	/**
	 * One complete scan: the next index and what changed. Commits nothing. `base` (a previous pass of the same job)
	 * supplies the file records the stat shortcut trusts instead of the committed index's.
	 */
	async scan(
		ctx: Pick<JobContext, 'signal' | 'progress' | 'trackChild'>,
		full: boolean,
		base?: Pick<LibrarySnapshot, 'files'>,
	): Promise<{ next: Omit<LibrarySnapshot, 'snapshotHash'>; result: SoundIndexResult; before: Set<string> }> {
		const d = this.deps;
		const prev = await d.library.snapshot();
		const knownFiles = base?.files ?? prev.files;
		const errors: SoundIndexResult['errors'] = [];
		const err = (source: SoundSourceType, file: string, code: string, message: string) => {
			if (errors.length < MAX_REPORTED_ERRORS)
				errors.push({ source, file, code, message: message.slice(0, 500) });
		};
		const maxSounds = Math.max(0, Math.floor(d.maxSounds ?? MAX_LIBRARY_SOUNDS));
		const libraryFull = (source: SoundSourceType, what: string) =>
			err(source, what, 'LIBRARY_FULL', `the library holds at most ${maxSounds} sounds`);
		ctx.progress(null, { stage: 'Listing sounds' });
		const starter = await loadManifest(d.starterDir());
		for (const e of starter.errors) err('starter', 'manifest.json', 'MANIFEST_INVALID', e);
		const packs = await loadPacks(d.packsDir, (f, m) => err('pack', f, 'MANIFEST_INVALID', m));
		const local = d.local?.() ?? true;
		const enabled = (await d.roots.list()).filter((r) => r.enabled);
		if (!local)
			for (const r of enabled)
				err('folder', r.label, 'LOCAL_MODE_ONLY', 'user folders are only indexed by a local engine');
		const roots = local ? enabled : [];
		// Room is kept for every Jasper Synth sound; the cap is enforced while listing, before a folder is walked past it.
		const synth = d.synthItems().map(synthEntryItem);
		const synthRoom = Math.min(synth.length, maxSounds);
		const room = maxSounds - synthRoom;
		const items: IndexItem[] = [...manifestItems(starter, 'starter')];
		for (const p of packs) items.push(...manifestItems(p, 'pack'));
		if (items.length > room) {
			libraryFull(items[room]!.source.type, '.');
			items.length = room;
		}
		for (const r of roots) {
			const left = room - items.length;
			if (left <= 0) {
				libraryFull('folder', r.label);
				continue;
			}
			const rootStat = await stat(r.path).catch(() => null);
			if (!rootStat?.isDirectory()) {
				err('folder', r.label, 'ROOT_OFFLINE', `the folder ${r.path} is not available`);
				continue;
			}
			items.push(
				...(await walkRoot(r, ctx.signal, (f, m) => err('folder', `${r.label}/${f}`, 'SCAN_FAILED', m), {
					maxFiles: left,
					onLibraryFull: () => libraryFull('folder', r.label),
				})),
			);
		}
		items.push(...synth.slice(0, synthRoom));

		const files: Record<string, FileRecord> = {};
		const sounds: Record<string, SoundEntry> = {};
		const priority = new Map<string, number>();
		let count = 0;
		let analysed = 0;
		let reused = 0;
		const total = items.length;
		for (let i = 0; i < total; i++) {
			if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
			if (count >= maxSounds) {
				libraryFull(items[i]!.source.type, '.');
				break;
			}
			const item = items[i]!;
			ctx.progress(i / Math.max(1, total), { stage: `Indexing ${item.meta.title}`.slice(0, 120) });
			// Let requests through between files (analysis runs on this thread).
			await new Promise((r) => setImmediate(r));
			const label =
				item.source.type === 'folder'
					? item.source.relPath
					: item.source.type === 'synth'
						? `${item.source.recipe}#${item.source.seed}`
						: item.source.file;
			try {
				const path =
					item.source.type === 'synth'
						? await ensureSynthFile(d.synthDir, item.source.recipe, item.source.seed)
						: item.path!;
				const st = await stat(path);
				if (!st.isFile()) throw new JobError('ASSET_NOT_FOUND', 'Not a file');
				const old = Object.hasOwn(knownFiles, item.key) ? knownFiles[item.key] : undefined;
				const fingerprint =
					!full && old && old.size === st.size && old.mtimeMs === st.mtimeMs
						? old.fingerprint
						: (await fingerprintFile(path)).fingerprint;
				const id = soundIdOf(fingerprint);
				files[item.key] = { size: st.size, mtimeMs: st.mtimeMs, fingerprint };
				const p = SOURCE_PRIORITY[item.source.type];
				const have = priority.get(id);
				if (have !== undefined && have <= p) continue; // the same sound from a source that ranks first
				const cacheFile = analysisCacheFile(d.cacheDir, fingerprint);
				let analysis = full ? null : await readCachedAnalysis(cacheFile, fingerprint);
				if (analysis) reused++;
				else {
					const decoded = await decodeSound(d.ffmpeg, path, {
						signal: ctx.signal,
						onSpawn: (c) => ctx.trackChild(c),
					});
					let out: AnalysisResult;
					try {
						out = await d.analyzer.run(
							{
								kind: 'analyse',
								channels: decoded.channels,
								rate: decoded.rate,
								soundId: id,
								fingerprint,
								durationSec: decoded.format.durationSec,
							},
							ctx.signal,
						);
					} catch (e) {
						if (e instanceof JobError) throw e;
						throw new JobError('UNSUPPORTED_MEDIA', `The sound cannot be analysed: ${(e as Error).message}`);
					}
					const descriptors = out.descriptors!;
					analysis = { fingerprint, version: ANALYSIS_VERSION, format: decoded.format, descriptors };
					await atomicWriteJson(cacheFile, analysis);
					await writeVisual(visualCacheFile(d.cacheDir, fingerprintHex(fingerprint)), out.visual);
					analysed++;
				}
				const judgeType = item.meta.types.find(isSoundTypeId);
				const judged = judgeType ? judgeSound(analysis.descriptors, SOUND_TYPE_PROFILES[judgeType]) : null;
				const previous = Object.hasOwn(prev.sounds, id) ? prev.sounds[id] : undefined;
				const candidate = {
					id,
					fingerprint,
					title: item.meta.title,
					types: item.meta.types,
					tags: item.meta.tags,
					source: item.source,
					license: item.meta.license,
					...(item.meta.licenseUrl ? { licenseUrl: item.meta.licenseUrl } : {}),
					author: item.meta.author,
					...(item.meta.sourceUrl ? { sourceUrl: item.meta.sourceUrl } : {}),
					attribution: item.meta.attribution,
					format: analysis.format,
					descriptors: analysis.descriptors,
					judge: judged ? { ...judged, type: judgeType! } : null,
					indexedAt:
						previous && previous.analysisVersion === ANALYSIS_VERSION && previous.fingerprint === fingerprint
							? previous.indexedAt
							: this.now(),
					analysisVersion: ANALYSIS_VERSION,
				};
				const entry = SoundEntrySchema.safeParse(candidate);
				if (!entry.success) {
					const issue = entry.error.issues[0];
					throw new JobError('INVALID_ENTRY', `${issue?.path.join('.')}: ${issue?.message}`);
				}
				if (have === undefined) count++;
				sounds[id] = entry.data;
				priority.set(id, p);
			} catch (e) {
				const code = (e as { code?: string }).code;
				if (code === 'JOB_CANCELLED' || ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
				if (code === 'BINARY_MISSING') throw e;
				delete files[item.key];
				err(
					item.source.type,
					label,
					typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : 'INDEX_FAILED',
					(e as Error).message ?? 'failed',
				);
			}
		}
		ctx.progress(1, { stage: 'Saving the library' });
		const before = new Set(Object.keys(prev.sounds));
		const after = Object.keys(sounds);
		const packMap: Record<string, SoundManifestPack> = {};
		// Installed packs (the starter kit's source packs are in its manifest).
		for (const p of packs.flatMap((m) => m.packs)) packMap[p.id] = p;
		return {
			next: {
				indexedAt: this.now(),
				starterHash: starter.hash,
				roots,
				packs: packMap,
				sounds,
				files,
			},
			result: {
				snapshotHash: '',
				sounds: after.length,
				files: Object.keys(files).length,
				analysed,
				reused,
				added: after.filter((id) => !before.has(id)).length,
				removed: [...before].filter((id) => !Object.hasOwn(sounds, id)).length,
				errors,
			},
			before,
		};
	}
}
