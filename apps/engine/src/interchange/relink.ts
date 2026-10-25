// Link Media on the engine (docs/wp-notes/link-media.md): verifying a located file against Premiere's Match File
// Properties, and the `relink-scan` search — last known paths, Relink others automatically from located files
// (folder mappings, project-relative paths, the located file's folder, a bounded search under it) and a folder search
// with a fingerprint fallback. Every candidate is verified; several matching files are reported, never guessed.
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
	AssetRelinkResponse,
	RegisteredMedia,
	RelinkCriterion,
	RelinkScanRequestSchema,
	RelinkScanResult,
	RelinkStep,
} from '@jasper/api';
import {
	decideCandidates,
	fileExtensionOf,
	fileStemOf,
	formatPath,
	type HostPlatform,
	isHostAbsolute,
	type MediaAsset,
	type PlannedStep,
	parsePath,
	planContext,
	plannedSteps,
	segmentKey,
	type VerifiedCandidate,
} from '@jasper/project';
import type { z } from 'zod';
import { JobError } from '../jobs/types.ts';

const FLICKS = 705_600_000;
/** Depth of the folder walk below each search root. */
export const SCAN_MAX_DEPTH = 32;
/** Same-named files beyond this are reported as ambiguous without registering each of them. */
const MAX_NAME_CANDIDATES = 20;
/** Offline assets verified at once (each registration probes and fingerprints one file). */
const VERIFY_CONCURRENCY = 4;

export const hostPlatform = (): HostPlatform => (process.platform === 'win32' ? 'win32' : 'posix');

/** What differs between an asset and a candidate file (what the user is asked to confirm). */
export function relinkDiff(asset: MediaAsset, reg: RegisteredMedia): AssetRelinkResponse['diff'] {
	const out: AssetRelinkResponse['diff'] = [];
	const fmtDur = (f: number | null) => (f === null ? 'none' : `${(f / FLICKS).toFixed(2)} s`);
	const v = (p: MediaAsset['probe']) =>
		p.streams.find((s) => s.type === 'video') as
			| { width: number; height: number; frameRate: { num: number; den: number } }
			| undefined;
	const audio = (p: MediaAsset['probe']) =>
		p.streams
			.filter((s) => s.type === 'audio')
			.map((s) => `${(s as { channels: number }).channels} ch`)
			.join(' + ') || 'none';
	if (asset.kind !== reg.kind) out.push({ field: 'kind', was: asset.kind, now: reg.kind });
	if (durationDiffers(asset, reg))
		out.push({
			field: 'duration',
			was: fmtDur(asset.probe.durationFlicks),
			now: fmtDur(reg.probe.durationFlicks),
		});
	const va = v(asset.probe);
	const vb = v(reg.probe as MediaAsset['probe']);
	if (va && vb && (va.width !== vb.width || va.height !== vb.height))
		out.push({ field: 'resolution', was: `${va.width}×${va.height}`, now: `${vb.width}×${vb.height}` });
	if (
		va?.frameRate?.den &&
		vb?.frameRate?.den &&
		va.frameRate.num * vb.frameRate.den !== vb.frameRate.num * va.frameRate.den
	) {
		const f = (r: { num: number; den: number }) => `${Math.round((r.num / r.den) * 1000) / 1000} fps`;
		out.push({ field: 'frameRate', was: f(va.frameRate), now: f(vb.frameRate) });
	}
	const aa = audio(asset.probe);
	const ab = audio(reg.probe as MediaAsset['probe']);
	if (aa !== ab && asset.probe.streams.some((s) => s.type === 'audio'))
		out.push({ field: 'audio', was: aa, now: ab });
	if (asset.originalName.toLowerCase() !== reg.originalName.toLowerCase())
		out.push({ field: 'name', was: asset.originalName, now: reg.originalName });
	if (asset.sizeBytes > 0 && asset.sizeBytes !== reg.sizeBytes)
		out.push({ field: 'size', was: `${asset.sizeBytes} bytes`, now: `${reg.sizeBytes} bytes` });
	if (asset.probe.startTimecode && reg.probe.startTimecode !== asset.probe.startTimecode)
		out.push({ field: 'mediaStart', was: asset.probe.startTimecode, now: reg.probe.startTimecode ?? 'none' });
	return out;
}

/**
 * Longer or shorter by more than a frame; an imported placeholder knows at least the length its clips use (often only
 * that), so for it only a shorter file differs.
 */
function durationDiffers(asset: MediaAsset, reg: RegisteredMedia): boolean {
	const a = asset.probe.durationFlicks;
	const b = reg.probe.durationFlicks;
	const va = asset.probe.streams.find((s) => s.type === 'video') as
		| { frameRate?: { num: number; den: number } }
		| undefined;
	const fr = va?.frameRate;
	const frame = fr && fr.num > 0 && fr.den > 0 ? (FLICKS * fr.den) / fr.num : FLICKS / 100;
	const placeholder = isPlaceholder(asset);
	if (a !== null && b !== null) return placeholder ? b < a - frame : Math.abs(a - b) > frame;
	return !placeholder && a !== b;
}

const isPlaceholder = (a: MediaAsset) => a.fingerprint.startsWith('pending:interchange:');

export function relinkMatch(asset: MediaAsset, reg: RegisteredMedia): AssetRelinkResponse['match'] {
	if (asset.fingerprint === reg.fingerprint) return 'fingerprint';
	return isPlaceholder(asset) ? 'placeholder' : 'different';
}

/**
 * A different file is relinked only when confirmed; so is a placeholder whose kind differs or whose file is shorter
 * than the document's clips need. A placeholder's resolution and frame rate are often guesses (EDL, ALE): their
 * differences are listed but do not block.
 */
export function relinkNeedsConfirm(
	match: AssetRelinkResponse['match'],
	diff: AssetRelinkResponse['diff'],
): boolean {
	if (match === 'fingerprint') return false;
	if (match === 'different') return true;
	return diff.some((d) => d.field === 'kind' || d.field === 'duration');
}

/**
 * The match properties to compare. Older clients send `name` meaning the whole file name: unless they ask to ignore
 * the extension, `name` brings `extension` along.
 */
export function effectiveCriteria(
	match: readonly RelinkCriterion[],
	ignoreExtension: boolean,
): RelinkCriterion[] {
	const out = [...new Set(match)];
	if (out.includes('name') && !ignoreExtension && !out.includes('extension')) out.push('extension');
	return out;
}

/** Name / extension checks that need only the candidate's file name. */
export function nameFails(
	asset: MediaAsset,
	fileName: string,
	criteria: readonly RelinkCriterion[],
): RelinkCriterion[] {
	const out: RelinkCriterion[] = [];
	if (
		criteria.includes('name') &&
		segmentKey(fileStemOf(fileName)) !== segmentKey(fileStemOf(asset.originalName))
	)
		out.push('name');
	if (criteria.includes('extension') && fileExtensionOf(fileName) !== fileExtensionOf(asset.originalName))
		out.push('extension');
	return out;
}

/** The streams the asset's clips use are in the file: same kind family, a picture for a picture, audio for audio. */
function streamsFail(asset: MediaAsset, reg: RegisteredMedia): boolean {
	const picture = (k: string) => k === 'video' || k === 'image' || k === 'animated-image';
	if (asset.kind === 'audio' ? reg.kind !== 'audio' : !picture(reg.kind) && reg.kind !== asset.kind)
		return true;
	const has = (p: { streams: { type: string }[] }, t: string) => p.streams.some((s) => s.type === t);
	if (has(asset.probe, 'video') && !has(reg.probe, 'video') && asset.kind === 'video') return true;
	if (has(asset.probe, 'audio') && !has(reg.probe, 'audio')) return true;
	return false;
}

/** Selected match properties a registered file does not satisfy (those the asset does not record are skipped). */
export function failedCriteria(
	asset: MediaAsset,
	reg: RegisteredMedia,
	fileName: string,
	criteria: readonly RelinkCriterion[],
): RelinkCriterion[] {
	const out = nameFails(asset, fileName, criteria);
	if (criteria.includes('size') && asset.sizeBytes > 0 && reg.sizeBytes !== asset.sizeBytes) out.push('size');
	if (criteria.includes('duration') && durationDiffers(asset, reg)) out.push('duration');
	if (
		criteria.includes('mediaStart') &&
		asset.probe.startTimecode &&
		reg.probe.startTimecode !== asset.probe.startTimecode
	)
		out.push('mediaStart');
	if (criteria.includes('streams') && streamsFail(asset, reg)) out.push('streams');
	return out;
}

/** Criteria that were compared for this asset (for the result's `matched`). */
function comparedCriteria(asset: MediaAsset, criteria: readonly RelinkCriterion[]): RelinkCriterion[] {
	return criteria.filter(
		(m) => (m !== 'size' || asset.sizeBytes > 0) && (m !== 'mediaStart' || !!asset.probe.startTimecode),
	);
}

/** The asset's last known path and project-relative path. */
export function assetPaths(a: MediaAsset): { oldPath: string | null; relativePath: string | null } {
	for (const l of a.locators)
		if (l.type === 'path' && l.path)
			return {
				oldPath: l.path,
				relativePath: (l as { relativeToProject?: string | null }).relativeToProject ?? null,
			};
	return { oldPath: null, relativePath: null };
}

export type RelinkScanDeps = {
	/** Registers (probes, fingerprints) a file of the engine host; throws when it cannot be read. */
	register(path: string): Promise<RegisteredMedia>;
	/** Content fingerprint of a file (null when unreadable). */
	fingerprint(path: string): Promise<string | null>;
	host: HostPlatform;
	signal: AbortSignal;
	progress(progress: number | null, stage: string): void;
};

type IndexedFile = { path: string; name: string };
type ScanRequest = z.output<typeof RelinkScanRequestSchema>;

const nameIndexKey = (name: string, criteria: readonly RelinkCriterion[]) =>
	segmentKey(criteria.includes('extension') ? name : fileStemOf(name));

/** Search roots: no root inside another one (it would be walked twice). */
function outermost(roots: string[]): string[] {
	const parsed = roots.map((r) => ({ r, p: parsePath(r) }));
	return parsed
		.filter(
			({ p }, i) =>
				!parsed.some(
					(o, j) =>
						j !== i &&
						o.p.style === p.style &&
						segmentKey(o.p.root) === segmentKey(p.root) &&
						o.p.segments.length <= p.segments.length &&
						o.p.segments.every((s, k) => segmentKey(s) === segmentKey(p.segments[k]!)) &&
						(o.p.segments.length < p.segments.length || j < i),
				),
		)
		.map(({ r }) => r);
}

export async function runRelinkScan(req: ScanRequest, deps: RelinkScanDeps): Promise<RelinkScanResult> {
	const now = Date.now;
	const criteria = effectiveCriteria(req.match, req.ignoreExtension);
	const anchors = (req.anchors ?? []).filter((a) => isHostAbsolute(a.to, deps.host));
	const ctx = planContext(anchors);
	const aborted = () => {
		if (deps.signal.aborted) throw new JobError('JOB_CANCELLED', 'cancelled', true);
	};

	// --- caches (bounded by the number of distinct candidate paths / folders) ---
	const stats = new Map<string, Promise<{ size: number } | null>>();
	const statFile = (p: string) => {
		let s = stats.get(p);
		if (!s) {
			s = stat(p)
				.then((x) => (x.isFile() ? { size: x.size } : null))
				.catch(() => null);
			stats.set(p, s);
		}
		return s;
	};
	const regs = new Map<string, Promise<RegisteredMedia | null>>();
	const registered = (p: string) => {
		let r = regs.get(p);
		if (!r) {
			r = deps.register(p).catch(() => null);
			regs.set(p, r);
		}
		return r;
	};
	const listings = new Map<string, Promise<Map<string, string[]>>>();
	const listing = (folder: string) => {
		let l = listings.get(folder);
		if (!l) {
			l = readdir(folder, { withFileTypes: true })
				.then((entries) => {
					const m = new Map<string, string[]>();
					for (const e of entries) {
						if (!e.isFile() || e.name.startsWith('.')) continue;
						const k = nameIndexKey(e.name, criteria);
						m.set(k, [...(m.get(k) ?? []), join(folder, e.name)]);
					}
					return m;
				})
				.catch(() => new Map<string, string[]>());
			listings.set(folder, l);
		}
		return l;
	};

	// --- the bounded folder walk (built once, when an asset needs it) ---
	const searchRoots = outermost(
		[...(req.folder ? [req.folder] : []), ...ctx.folders].filter((f) => isHostAbsolute(f, deps.host)),
	);
	let walked: Promise<{ byName: Map<string, IndexedFile[]>; files: IndexedFile[] }> | null = null;
	let scannedFiles = 0;
	let truncated = false;
	let timedOut = false;
	const walk = () => {
		walked ??= (async () => {
			const files: IndexedFile[] = [];
			const byName = new Map<string, IndexedFile[]>();
			const deadline = now() + req.timeLimitSec * 1000;
			// Breadth first with an explicit queue: no recursion, depth-capped; symbolic links are not followed, so
			// a link cycle cannot loop.
			const queue: { dir: string; depth: number }[] = searchRoots.map((dir) => ({ dir, depth: 0 }));
			for (let qi = 0; qi < queue.length; qi++) {
				aborted();
				if (now() > deadline) {
					timedOut = true;
					break;
				}
				const { dir, depth } = queue[qi]!;
				const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
				for (const e of entries) {
					if (e.name.startsWith('.')) continue;
					const p = join(dir, e.name);
					if (e.isDirectory()) {
						if (depth < SCAN_MAX_DEPTH) queue.push({ dir: p, depth: depth + 1 });
					} else if (e.isFile()) {
						if (files.length >= req.maxFiles) {
							truncated = true;
							break;
						}
						const f = { path: p, name: e.name };
						files.push(f);
						const k = nameIndexKey(e.name, criteria);
						const list = byName.get(k);
						if (list) list.push(f);
						else byName.set(k, [f]);
					}
				}
				if (truncated) break;
				if (qi % 50 === 0) deps.progress(null, `Searching: ${files.length} files in ${qi + 1} folders`);
				// Let the event loop breathe on huge trees (progress events, cancellation).
				if (qi % 200 === 199) await new Promise((r) => setImmediate(r));
			}
			scannedFiles = files.length;
			return { byName, files };
		})();
		return walked;
	};
	let bySize: Promise<Map<number, string[]>> | null = null;
	const sizeIndex = () => {
		bySize ??= (async () => {
			const m = new Map<number, string[]>();
			const { files } = await walk();
			for (const f of files) {
				aborted();
				const s = await statFile(f.path);
				if (s) m.set(s.size, [...(m.get(s.size) ?? []), f.path]);
			}
			return m;
		})();
		return bySize;
	};

	const verify = async (
		a: MediaAsset,
		path: string,
	): Promise<(VerifiedCandidate & { reg: RegisteredMedia; confirm: boolean }) | null> => {
		const name = path.split(/[/\\]/).pop() ?? path;
		if (nameFails(a, name, criteria).length) return null;
		const s = await statFile(path);
		if (!s) return null;
		if (criteria.includes('size') && a.sizeBytes > 0 && s.size !== a.sizeBytes) return null;
		aborted();
		const reg = await registered(path);
		if (!reg) return null;
		const failed = failedCriteria(a, reg, name, criteria);
		// A placeholder's kind and streams are often guesses of the document (an EDL reel used for picture and
		// sound): a file that differs there is found, but linked only when the user confirms.
		const soft = isPlaceholder(a) && failed.length === 1 && failed[0] === 'streams';
		return {
			path,
			ok: failed.length === 0 || soft,
			sameContent: reg.fingerprint === a.fingerprint,
			reg,
			confirm: soft,
		};
	};

	const found: RelinkScanResult['found'] = [];
	const ambiguous: RelinkScanResult['ambiguous'] = [];
	const notFound: string[] = [];

	const resolveOne = async (a: MediaAsset): Promise<void> => {
		const { oldPath, relativePath } = assetPaths(a);
		const steps: (PlannedStep | { step: 'original'; paths: string[] })[] = [];
		if (oldPath && isHostAbsolute(oldPath, deps.host)) steps.push({ step: 'original', paths: [oldPath] });
		steps.push(...plannedSteps({ name: a.originalName, oldPath, relativePath }, ctx));
		// A folder search without located files: by name under the folder.
		if (req.folder && !steps.some((s) => s.step === 'search'))
			steps.push({ step: 'search', roots: searchRoots, name: a.originalName });
		for (const s of steps) {
			aborted();
			let paths: string[] = [];
			if (s.step === 'same-folder') {
				const k = nameIndexKey(s.name, criteria);
				for (const f of s.folders) paths.push(...((await listing(f)).get(k) ?? []));
			} else if (s.step === 'search') {
				const { byName } = await walk();
				paths = (byName.get(nameIndexKey(s.name, criteria)) ?? []).map((f) => f.path);
				if (paths.length > MAX_NAME_CANDIDATES) {
					ambiguous.push({ assetId: a.id, step: 'search', candidates: paths.slice(0, MAX_NAME_CANDIDATES) });
					return;
				}
			} else paths = s.paths.filter((p) => isHostAbsolute(p, deps.host));
			if (!paths.length) continue;
			const verified: (VerifiedCandidate & { reg: RegisteredMedia; confirm: boolean })[] = [];
			for (const p of [...new Set(paths)]) {
				const v = await verify(a, p);
				if (v) verified.push(v);
			}
			const d = decideCandidates(verified);
			if (d.kind === 'ambiguous') {
				ambiguous.push({ assetId: a.id, step: s.step, candidates: d.paths.slice(0, MAX_NAME_CANDIDATES) });
				return;
			}
			if (d.kind === 'link') {
				const v = verified.find((x) => x.path === d.path)!;
				push(a, v.reg, d.path, s.step, v.confirm);
				return;
			}
		}
		// Moved and renamed: a file of the asset's size with its bytes, under the searched folders.
		if (searchRoots.length && a.sizeBytes > 0 && !a.fingerprint.startsWith('pending:')) {
			const same = (await sizeIndex()).get(a.sizeBytes) ?? [];
			for (const p of same.slice(0, MAX_NAME_CANDIDATES)) {
				aborted();
				if ((await deps.fingerprint(p)) !== a.fingerprint) continue;
				const reg = await registered(p);
				if (reg) {
					push(a, reg, p, 'fingerprint');
					return;
				}
			}
		}
		notFound.push(a.id);
	};

	const push = (a: MediaAsset, reg: RegisteredMedia, path: string, step: RelinkStep, confirm = false) => {
		const match = relinkMatch(a, reg);
		const diff = relinkDiff(a, reg);
		found.push({
			assetId: a.id,
			path,
			media: reg,
			matched: step === 'fingerprint' ? [] : comparedCriteria(a, criteria),
			match,
			diff,
			step,
			needsConfirm: confirm || relinkNeedsConfirm(match, diff),
		});
	};

	const assets = req.assets as MediaAsset[];
	let next = 0;
	let done = 0;
	const worker = async () => {
		for (let i = next++; i < assets.length; i = next++) {
			aborted();
			await resolveOne(assets[i]!);
			done++;
			if (done % 10 === 0 || done === assets.length)
				deps.progress(done / assets.length, `Relinking ${done}/${assets.length}: ${assets[i]!.originalName}`);
		}
	};
	await Promise.all(Array.from({ length: Math.min(VERIFY_CONCURRENCY, assets.length) }, worker));
	aborted();
	if (walked) await walked;
	const order = new Map(assets.map((a, i) => [a.id, i]));
	const byOrder = (x: { assetId: string }, y: { assetId: string }) =>
		order.get(x.assetId)! - order.get(y.assetId)!;
	found.sort(byOrder);
	ambiguous.sort(byOrder);
	notFound.sort((x, y) => order.get(x)! - order.get(y)!);
	return {
		found,
		ambiguous,
		notFound,
		scannedFiles,
		truncated,
		timedOut,
		mappings: ctx.mappings.map((m) => ({ from: formatPath(m.from), to: formatPath(m.to) })),
	};
}
