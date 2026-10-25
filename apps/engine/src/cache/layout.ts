// Where every engine cache lives on disk (M3, S04:CA-010): the cache kinds, the mapping of a file path to its cache
// entry, and the scan that rebuilds the registry from the appdir (entries, sizes, newest mtimes, orphaned temporary
// files of crashed writes). The registry never trusts its index for what exists: a scan is the truth, the index only
// adds what the disk cannot tell (last access, project references).
//
//   kind         location (appdir-relative)                                   entry key
//   media-cache  cache/<fp64>/{keyframes,poster,sprite,peaks}-<hash>[.ext|/]  <fp64>/<name>-<hash>
//                cache/<fp64>/voice-analysis-<hash>.bin (spec 14, per stream)    <fp64>/voice-analysis-<hash>
//   proxies      cache/<fp64>/proxy-{720,540}-<hash>.{mp4,webm}              <fp64>/proxy-<tier>-<hash>
//                cache/<fp64>/playback-audio-<hash>[.json|/]  (WAV per stream) <fp64>/playback-audio-<hash>
//   luts         cache/luts/<sha256>.cube                                    <sha256>
//   warp         cache/warp/<key40>.mov                                      <key40>
//   retime       cache/retime/<key40>.mkv | frametimes-<hash32>.json         <key40> | frametimes-<hash32>
//   layers       cache/layers/<key40>/                                       <key40>
//   mg-renders   mg/<key40>/            (composition pre-renders, fframes)    <key40>
//   mg-posters   mg/posters/<bundleHash>/                                    <bundleHash>
//   exports      renders/<jobId>/       (output.mp4|webm|mov…)               <jobId>
//   stills       renders/<jobId>/       (output.png)                         <jobId>
//   bundles      remotion/bundle/<hash>/, cache/jasper-proc-bundle/           remotion/<hash> | jasper-proc
//   roto         cache/roto/sets/<key32>/ (computed object mattes),           <key32> | pool
//                cache/roto/pool/ (reusable segmentations and frames)
//   previews     cache/previews/<format16>/<hash32>.{mp4,webm,wav}           <format16>/<hash32>.<ext>
import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { CacheKind } from '@jasper/api';

type KindDef = {
	kind: CacheKind;
	label: string;
	description: string;
	/** Default age limit in days; undefined = the global `maxAgeDays`. */
	defaultMaxAgeDays?: number | null;
};

export const KIND_DEFS: readonly KindDef[] = [
	{
		kind: 'media-cache',
		label: 'Media cache files',
		description: 'Waveform peaks, poster frames, filmstrips and keyframe indexes of imported media',
	},
	{
		kind: 'proxies',
		label: 'Proxies',
		description:
			'Playback proxies (720p / 540p) of imported media, and playback audio of audio the browser cannot decode',
	},
	{
		kind: 'luts',
		label: 'Colour LUTs',
		description: '3D LUTs baked from colour grades for native exports (one per keyframed grade state)',
	},
	{
		kind: 'warp',
		label: 'Warped layers',
		description: 'Corner-pinned and keyframed-Motion layers rendered for native exports',
	},
	{
		kind: 'retime',
		label: 'Retimed layers',
		description:
			'Reversed, time-remapped, frame-blended or optical-flow layers and frame-time indexes rendered for native exports',
	},
	{
		kind: 'layers',
		label: 'Graphics bakes',
		description: 'Text, shapes and animated templates baked for exports, and graded graphics previews',
		defaultMaxAgeDays: 14,
	},
	{
		kind: 'mg-renders',
		label: 'Motion graphics renders',
		description: 'Masters and previews of composition clips and motion-graphic templates',
		defaultMaxAgeDays: 14,
	},
	{ kind: 'mg-posters', label: 'Template posters', description: 'Thumbnails of the Motion Templates panel' },
	{
		kind: 'exports',
		label: 'Export outputs',
		description: 'Finished exports kept for download from the Jobs panel',
		defaultMaxAgeDays: 7,
	},
	{
		kind: 'stills',
		label: 'Rendered frames',
		description: 'Single frames rendered for Export Frame and agents',
		defaultMaxAgeDays: 1,
	},
	{
		kind: 'roto',
		label: 'Object mattes',
		description:
			'Roto Brush and face-tracking mattes computed by propagation (projects keep the mattes of their roto objects)',
	},
	{
		kind: 'previews',
		label: 'Render previews',
		description:
			'Rendered preview files of sequence segments (Sequence ▸ Render…); projects keep the files of their current edits',
		defaultMaxAgeDays: 30,
	},
	{
		kind: 'bundles',
		label: 'Build caches',
		description: 'Remotion composition bundles and the jasper-proc bundle (the current one is kept)',
	},
];

export const KIND_DEF: ReadonlyMap<CacheKind, KindDef> = new Map(KIND_DEFS.map((d) => [d.kind, d]));

export type EntryRef = { id: string; kind: CacheKind; key: string };

function entryRef(kind: CacheKind, key: string): EntryRef {
	return { id: `${kind}:${key}`, kind, key };
}

/** A cache entry found on disk. */
export type ScannedEntry = EntryRef & {
	/** Absolute paths (files or directories) that make up the entry. */
	paths: string[];
	bytes: number;
	/** Newest mtime of anything in the entry (ms). */
	mtimeMs: number;
	/** Last use recorded by the owner (`meta.json` `lastUsedAt` of graphics bakes and composition renders). */
	usedMs?: number;
};

/** A temporary file or directory of a write that never finished (crash, kill): removed when stale. */
export type Orphan = { path: string; bytes: number; mtimeMs: number };

const HEX64 = /^[0-9a-f]{64}$/;
const KEY40 = /^[0-9a-f]{40}$/;
const DERIVATIVE =
	/^(keyframes|poster|sprite|peaks|proxy-720|proxy-540|playback-audio|voice-analysis)-([0-9a-f]{6,64})(\.[a-z0-9]+)?$/;
/** Derivatives counted as playback copies (`proxies`) rather than media cache files. */
const isPlaybackCopy = (name: string) => name.startsWith('proxy-') || name === 'playback-audio';
const JOB_ID = /^job_[0-9a-f]{16}$/;
const ROTO_KEY = /^[0-9a-f]{32}$/;
const PREVIEW_FORMAT = /^[0-9a-f]{16}$/;
const PREVIEW_FILE = /^[0-9a-f]{32}\.(mp4|webm|wav)$/;
/** Temporary names used by the engine's writers (`x.partial`, `x.<n>.partial.mp4`, `.x.<rand>.tmp`, `.tmp-<job>`…). */
const TEMP_NAME = /\.partial(\.|-|$)|\.tmp(\.|$)|\.part\.|^\.tmp-|^\.trash-|\.partial-\d+$/;

function isTempName(name: string): boolean {
	return TEMP_NAME.test(name);
}

export function isTrashName(name: string): boolean {
	return name.startsWith('.trash-');
}

/** Bytes and newest mtime of a file or directory tree (symlinks are not followed; unreadable parts count 0). */
async function measure(path: string): Promise<{ bytes: number; mtimeMs: number }> {
	let st: Awaited<ReturnType<typeof lstat>>;
	try {
		st = await lstat(path);
	} catch {
		return { bytes: 0, mtimeMs: 0 };
	}
	if (!st.isDirectory()) return { bytes: st.size, mtimeMs: st.mtimeMs };
	let bytes = 0;
	let mtimeMs = st.mtimeMs;
	let names: Dirent[];
	try {
		names = await readdir(path, { withFileTypes: true });
	} catch {
		return { bytes: 0, mtimeMs };
	}
	for (const d of names) {
		const m = await measure(join(path, d.name));
		bytes += m.bytes;
		if (m.mtimeMs > mtimeMs) mtimeMs = m.mtimeMs;
	}
	return { bytes, mtimeMs };
}

async function list(dir: string): Promise<Dirent[]> {
	try {
		return await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** Appdir-relative path segments of `abs`, or null when it is outside the appdir. */
function segments(appdir: string, abs: string): string[] | null {
	if (!isAbsolute(abs)) return null;
	const rel = relative(appdir, abs);
	if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
	return rel.split(sep).filter(Boolean);
}

/**
 * The cache entry a path belongs to (the entry itself or any file inside it), or null when the path is not a cache
 * file (or a temporary one). Pure: exports vs stills is decided by the caller's `stillHint` (default: export).
 */
export function entryOfPath(appdir: string, abs: string, stillHint?: boolean): EntryRef | null {
	const s = segments(appdir, abs);
	if (!s || s.length < 2) return null;
	const [a, b, c] = s;
	if (a === 'cache') {
		if (b === 'luts' && c) {
			const m = /^([0-9a-f]{64})\.cube$/.exec(c);
			return m ? entryRef('luts', m[1]!) : null;
		}
		if (b === 'warp' && c) {
			const m = /^([0-9a-f]{40})\.mov$/.exec(c);
			return m ? entryRef('warp', m[1]!) : null;
		}
		if (b === 'retime' && c) {
			const m = /^([0-9a-f]{40})\.mkv$/.exec(c) ?? /^(frametimes-[0-9a-f]{32})\.json$/.exec(c);
			return m ? entryRef('retime', m[1]!) : null;
		}
		if (b === 'layers' && c) return KEY40.test(c) ? entryRef('layers', c) : null;
		if (b === 'jasper-proc-bundle') return entryRef('bundles', 'jasper-proc');
		if (b === 'previews' && c && PREVIEW_FORMAT.test(c)) {
			const f = s[3];
			return f && PREVIEW_FILE.test(f) ? entryRef('previews', `${c}/${f}`) : null;
		}
		if (b === 'roto' && c) {
			if (c === 'pool') return entryRef('roto', 'pool');
			const d = s[3];
			return c === 'sets' && d && ROTO_KEY.test(d) ? entryRef('roto', d) : null;
		}
		if (b && HEX64.test(b) && c) {
			const m = DERIVATIVE.exec(c);
			if (!m) return null;
			const kind: CacheKind = isPlaybackCopy(m[1]!) ? 'proxies' : 'media-cache';
			return entryRef(kind, `${b}/${m[1]}-${m[2]}`);
		}
		return null;
	}
	if (a === 'mg' && b) {
		if (b === 'posters') return c && /^[0-9a-f]{16,64}$/.test(c) ? entryRef('mg-posters', c) : null;
		if (!KEY40.test(b)) return null;
		if (c && isTempName(c)) return null;
		return entryRef('mg-renders', b);
	}
	if (a === 'renders' && b && JOB_ID.test(b)) return entryRef(stillHint ? 'stills' : 'exports', b);
	if (a === 'remotion' && b === 'bundle' && c && !isTempName(c)) return entryRef('bundles', `remotion/${c}`);
	return null;
}

/** Scan result of an appdir. */
export type ScanResult = { entries: ScannedEntry[]; orphans: Orphan[]; scannedAt: number };

async function entryFrom(ref: EntryRef, paths: string[]): Promise<ScannedEntry> {
	let bytes = 0;
	let mtimeMs = 0;
	for (const p of paths) {
		const m = await measure(p);
		bytes += m.bytes;
		mtimeMs = Math.max(mtimeMs, m.mtimeMs);
	}
	return { ...ref, paths, bytes, mtimeMs };
}

/** `lastUsedAt` (else `createdAt`) of an entry directory's `meta.json`, in ms. */
async function metaUsed(dir: string): Promise<number | undefined> {
	try {
		const m = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as {
			lastUsedAt?: string;
			createdAt?: string;
		};
		const t = Date.parse(m.lastUsedAt ?? m.createdAt ?? '');
		return Number.isFinite(t) ? t : undefined;
	} catch {
		return undefined;
	}
}

async function withMeta(e: ScannedEntry): Promise<ScannedEntry> {
	const used = await metaUsed(e.paths[0]!);
	return used === undefined ? e : { ...e, usedMs: used };
}

async function orphanFrom(path: string): Promise<Orphan> {
	const m = await measure(path);
	return { path, bytes: m.bytes, mtimeMs: m.mtimeMs };
}

/** Walks every cache location of an appdir. */
export async function scanAppdir(appdir: string): Promise<ScanResult> {
	const entries: ScannedEntry[] = [];
	const orphans: Orphan[] = [];
	const cache = join(appdir, 'cache');

	for (const d of await list(cache)) {
		const p = join(cache, d.name);
		if (isTempName(d.name)) {
			orphans.push(await orphanFrom(p));
			continue;
		}
		if (d.name === 'luts' || d.name === 'warp') {
			const kind: CacheKind = d.name;
			const re = kind === 'luts' ? /^([0-9a-f]{64})\.cube$/ : /^([0-9a-f]{40})\.mov$/;
			for (const f of await list(p)) {
				const fp = join(p, f.name);
				const m = re.exec(f.name);
				if (m) entries.push(await entryFrom(entryRef(kind, m[1]!), [fp]));
				else if (isTempName(f.name)) orphans.push(await orphanFrom(fp));
			}
		} else if (d.name === 'retime') {
			for (const f of await list(p)) {
				const fp = join(p, f.name);
				const m = /^([0-9a-f]{40})\.mkv$/.exec(f.name) ?? /^(frametimes-[0-9a-f]{32})\.json$/.exec(f.name);
				if (m) entries.push(await entryFrom(entryRef('retime', m[1]!), [fp]));
				else if (isTempName(f.name)) orphans.push(await orphanFrom(fp));
			}
		} else if (d.name === 'layers') {
			for (const f of await list(p)) {
				const fp = join(p, f.name);
				if (KEY40.test(f.name) && f.isDirectory())
					entries.push(await withMeta(await entryFrom(entryRef('layers', f.name), [fp])));
				else if (isTempName(f.name)) orphans.push(await orphanFrom(fp));
			}
		} else if (d.name === 'roto' && d.isDirectory()) {
			// parity (roto): one entry per computed set, and the frame pool as one entry.
			for (const f of await list(join(p, 'sets'))) {
				const fp = join(p, 'sets', f.name);
				if (ROTO_KEY.test(f.name) && f.isDirectory())
					entries.push(await entryFrom(entryRef('roto', f.name), [fp]));
				else if (isTempName(f.name)) orphans.push(await orphanFrom(fp));
			}
			const pool = join(p, 'pool');
			for (const sub of ['seg', 'png'])
				for (const f of await list(join(pool, sub)))
					if (isTempName(f.name)) orphans.push(await orphanFrom(join(pool, sub, f.name)));
			if ((await list(pool)).length) entries.push(await entryFrom(entryRef('roto', 'pool'), [pool]));
		} else if (d.name === 'previews' && d.isDirectory()) {
			// previews: one entry per file; `<hash>.part.<ext>` of interrupted renders are orphans.
			for (const f of await list(p)) {
				const fp = join(p, f.name);
				if (!PREVIEW_FORMAT.test(f.name) || !f.isDirectory()) {
					if (isTempName(f.name)) orphans.push(await orphanFrom(fp));
					continue;
				}
				for (const g of await list(fp)) {
					const gp = join(fp, g.name);
					if (PREVIEW_FILE.test(g.name))
						entries.push(await entryFrom(entryRef('previews', `${f.name}/${g.name}`), [gp]));
					else if (isTempName(g.name)) orphans.push(await orphanFrom(gp));
				}
			}
		} else if (d.name === 'jasper-proc-bundle') {
			entries.push(await entryFrom(entryRef('bundles', 'jasper-proc'), [p]));
		} else if (HEX64.test(d.name) && d.isDirectory()) {
			const groups = new Map<string, { kind: CacheKind; paths: string[] }>();
			for (const f of await list(p)) {
				const fp = join(p, f.name);
				if (isTempName(f.name)) {
					orphans.push(await orphanFrom(fp));
					continue;
				}
				const m = DERIVATIVE.exec(f.name);
				if (!m) continue;
				const key = `${d.name}/${m[1]}-${m[2]}`;
				const kind: CacheKind = isPlaybackCopy(m[1]!) ? 'proxies' : 'media-cache';
				const g = groups.get(key) ?? { kind, paths: [] };
				g.paths.push(fp);
				groups.set(key, g);
			}
			for (const [key, g] of groups) entries.push(await entryFrom(entryRef(g.kind, key), g.paths));
		}
	}

	const mg = join(appdir, 'mg');
	for (const d of await list(mg)) {
		const p = join(mg, d.name);
		if (d.name === 'posters') {
			for (const f of await list(p)) {
				const fp = join(p, f.name);
				if (isTempName(f.name)) orphans.push(await orphanFrom(fp));
				else if (f.isDirectory()) {
					// Temporary posters inside a bundle's directory are orphans of their own.
					for (const g of await list(fp))
						if (isTempName(g.name)) orphans.push(await orphanFrom(join(fp, g.name)));
					entries.push(await entryFrom(entryRef('mg-posters', f.name), [fp]));
				}
			}
		} else if (KEY40.test(d.name) && d.isDirectory()) {
			// fframes renders write into `<key>/.tmp-<jobId>/`; composition renders `<file>.part.webm`.
			for (const f of await list(p)) if (isTempName(f.name)) orphans.push(await orphanFrom(join(p, f.name)));
			entries.push(await withMeta(await entryFrom(entryRef('mg-renders', d.name), [p])));
		} else if (isTempName(d.name)) orphans.push(await orphanFrom(p));
	}

	const renders = join(appdir, 'renders');
	for (const d of await list(renders)) {
		const p = join(renders, d.name);
		if (isTrashName(d.name)) orphans.push(await orphanFrom(p));
		if (!JOB_ID.test(d.name) || !d.isDirectory()) continue;
		const files = (await list(p)).map((f) => f.name);
		const still =
			files.some((f) => f.startsWith('output.png')) && !files.some((f) => /^output\.(?!png)/.test(f));
		entries.push(await entryFrom(entryRef(still ? 'stills' : 'exports', d.name), [p]));
	}

	const bundles = join(appdir, 'remotion', 'bundle');
	for (const d of await list(bundles)) {
		const p = join(bundles, d.name);
		if (isTempName(d.name)) orphans.push(await orphanFrom(p));
		else if (d.isDirectory()) entries.push(await entryFrom(entryRef('bundles', `remotion/${d.name}`), [p]));
	}

	// Job scratch directories of jobs that are gone and per-request scratch (`layer-preview-*`, `mg-schemas-*`): the
	// caller decides which belong to running jobs.
	const tmp = join(appdir, 'tmp');
	for (const d of await list(tmp)) {
		if (/^(job_[0-9a-f]{16}|layer-preview-.+|mg-schemas-.+)$/.test(d.name))
			orphans.push(await orphanFrom(join(tmp, d.name)));
	}
	return { entries, orphans, scannedAt: Date.now() };
}

/** Sizes of engine data that is not a cache (reported in the usage, never cleaned from the cache UI). */
export async function otherUsage(appdir: string): Promise<{ id: string; label: string; bytes: number }[]> {
	const media = await measure(join(appdir, 'media'));
	const processed = await measure(join(appdir, 'media', 'processed'));
	return [
		{ id: 'media', label: 'Imported media copies', bytes: Math.max(0, media.bytes - processed.bytes) },
		{ id: 'processed', label: 'Processed media versions', bytes: processed.bytes },
		{
			id: 'mg-bundles',
			label: 'Imported composition bundles',
			bytes: (await measure(join(appdir, 'mg-bundles'))).bytes,
		},
		{ id: 'models', label: 'Processing models', bytes: (await measure(join(appdir, 'models'))).bytes },
		{
			id: 'projects',
			label: 'Projects and versions',
			bytes: (await measure(join(appdir, 'projects'))).bytes,
		},
	];
}
