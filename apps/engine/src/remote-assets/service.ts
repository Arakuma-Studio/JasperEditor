// Remote platform fonts and emoji (social-comment design §7.8). The engine downloads them on first need into
// `<appdir>/assets/remote/` — fonts verified against the manifest's pinned SHA-256, emoji images (not pinnable in
// advance) recorded in a per-pack index with the hash of their first verified fetch and checked against it afterwards
// — and serves them through the font routes (`/fonts/remote/…`, `/fonts/emoji/…`). Preview and export/bake read the
// same cached files. Network use is a named preference (default on); off = only what is cached is used.
//
// Files are written atomically (temp file, fsync, rename, directory fsync — AGENTS §0); concurrent requests for one
// asset share one download; downloads are capped per host, timed out, size-capped and retried a bounded number of times.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	type EmojiPackInfo,
	emojiImagePath,
	type FontFamily,
	type NetworkSettings,
	REMOTE_FONT_PREFIX,
	REMOTE_IMAGE_PREFIX,
	REMOTE_PREFETCH_MAX_EMOJI,
	type RemoteAssetFetch,
	type RemoteAssetMissing,
	type RemoteAssetPrefetchRequest,
	type RemoteAssetPrefetchResponse,
	type RemoteAssetsChangedEvent,
	type RemoteAssetsStatus,
	type RemoteImageInfo,
} from '@jasper/api';
import {
	emojiCodepointCandidates,
	emojiKey,
	graphemeOfEmojiKey,
	isEmojiGrapheme,
} from '@jasper/mg-templates';
import { z } from 'zod';
import { atomicWriteFile, atomicWriteJson, readJsonOrNull, sha256File } from '../tools/fs.ts';
import { KeyedMutex } from '../tools/mutex.ts';
import {
	asRemoteAssetError,
	checkFont,
	checkImage,
	type FetchLimits,
	fetchCapped,
	HostLimiter,
	RemoteAssetError,
} from './fetcher.ts';
import { type LoadedManifest, loadManifest, overrideStamp, shippedManifest } from './manifest.ts';
import type { RemoteEmojiPack, RemoteFontEntry, RemoteImageEntry, RemoteManifest } from './schema.ts';
import { NetworkSettingsStore } from './settings.ts';

export { RemoteAssetError } from './fetcher.ts';

export type Face = { family: string; weight: number; style: 'normal' | 'italic' };

export const DEFAULT_FONT_LIMITS: FetchLimits = {
	timeoutMs: 30_000,
	maxBytes: 16 * 1024 * 1024,
	retries: 2,
	backoffMs: 300,
};
export const DEFAULT_EMOJI_LIMITS: FetchLimits = {
	timeoutMs: 15_000,
	maxBytes: 1024 * 1024,
	retries: 2,
	backoffMs: 300,
};
/** Remote images are small (avatars); a larger download is refused. */
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const IMAGE_TYPES = {
	png: 'image/png',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
	svg: 'image/svg+xml',
} as const;
/** Simultaneous downloads per host. */
export const DEFAULT_PER_HOST = 4;
/** Emoji downloads one prefetch runs at a time (they also queue per host). */
const PREFETCH_PARALLEL = 8;

/** The emoji index of a pack version: the hash of each image's first verified fetch (its pin from then on). */
const EmojiIndexSchema = z.object({
	version: z.literal(1),
	entries: z.record(
		z.string(),
		z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().min(0), url: z.string() }),
	),
});
type EmojiIndex = z.infer<typeof EmojiIndexSchema>;

export type RemoteAssetServiceOptions = {
	/** `<appdir>/assets/remote`. */
	dir: string;
	/** `<appdir>/assets/remote-manifest.override.json`. */
	overridePath: string;
	/** `<appdir>/engine/network.json`. */
	settingsPath: string;
	/** The shipped manifest (default: `manifest.json`). */
	manifest?: RemoteManifest;
	fetchImpl?: typeof fetch;
	fontLimits?: Partial<FetchLimits>;
	emojiLimits?: Partial<FetchLimits>;
	/** Distinct emoji per pack one prefetch fetches (default `REMOTE_PREFETCH_MAX_EMOJI`; tests lower it). */
	prefetchMaxEmoji?: number;
	perHost?: number;
	/** `remoteAssets.changed` events. */
	onChanged?(e: RemoteAssetsChangedEvent): void;
	now?(): Date;
};

const faceLabel = (f: Face) => `${f.family} ${f.weight}${f.style === 'italic' ? ' italic' : ''}`;
const hostOf = (url: string) => {
	try {
		return new URL(url).host;
	} catch {
		return '';
	}
};
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export class RemoteAssetService {
	readonly settings: NetworkSettingsStore;
	private readonly base: RemoteManifest;
	private loaded: LoadedManifest;
	private stamp: string;
	private readonly hosts: HostLimiter;
	private readonly fontLimits: FetchLimits;
	private readonly emojiLimits: FetchLimits;
	private readonly inflight = new Map<string, Promise<string>>();
	private readonly mutex = new KeyedMutex();
	/** Files whose bytes were checked against their pin in this process (path → sha256). */
	private readonly verified = new Map<string, string>();
	private readonly indexes = new Map<string, EmojiIndex>();
	private pendingItems: RemoteAssetFetch[] = [];
	private flushTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly o: RemoteAssetServiceOptions) {
		this.settings = new NetworkSettingsStore(o.settingsPath);
		this.base = o.manifest ?? shippedManifest();
		this.stamp = overrideStamp(o.overridePath);
		this.loaded = loadManifest(this.base, o.overridePath);
		this.hosts = new HostLimiter(o.perHost ?? DEFAULT_PER_HOST);
		this.fontLimits = { ...DEFAULT_FONT_LIMITS, ...o.fontLimits };
		this.emojiLimits = { ...DEFAULT_EMOJI_LIMITS, ...o.emojiLimits };
	}

	/** The merged manifest (re-read when the override file changes). */
	current(): LoadedManifest {
		const s = overrideStamp(this.o.overridePath);
		if (s !== this.stamp) {
			this.stamp = s;
			this.loaded = loadManifest(this.base, this.o.overridePath);
			this.o.onChanged?.({ reason: 'manifest', notice: false });
		}
		return this.loaded;
	}

	// ── fonts ──────────────────────────────────────────────────────────────────────────────────────────────────────

	/** File name a font entry is served and cached under (the hash prefix makes the URL immutable). */
	static fontFileName(f: RemoteFontEntry): string {
		return `${f.id}-${f.sha256.slice(0, 16)}.${f.format}`;
	}

	private fontByFile(name: string): RemoteFontEntry | null {
		return this.current().manifest.fonts.find((f) => RemoteAssetService.fontFileName(f) === name) ?? null;
	}

	/**
	 * The manifest entries of a face (exact family — case-insensitive — weight and style): every entry when all of them
	 * are subsets with a unicode range, else the last one (override entries come last, so they win).
	 */
	fontsFor(face: Face): RemoteFontEntry[] {
		const name = face.family.trim().toLowerCase();
		const all = this.current().manifest.fonts.filter(
			(f) => f.family.toLowerCase() === name && f.weight === face.weight && f.style === face.style,
		);
		if (all.length > 1 && all.every((f) => f.unicodeRange)) return all;
		return all.length ? [all[all.length - 1]!] : [];
	}

	/** Engine-relative files of a face (with their unicode ranges when it is split), or null when it is not listed. */
	fontFiles(face: Face): { url: string; unicodeRange?: string }[] | null {
		const entries = this.fontsFor(face);
		if (entries.length === 0) return null;
		return entries.map((f) => ({
			url: `${REMOTE_FONT_PREFIX}${RemoteAssetService.fontFileName(f)}`,
			...(entries.length > 1 && f.unicodeRange ? { unicodeRange: f.unicodeRange } : {}),
		}));
	}

	/** Remote families for the font catalogue (`source: 'remote'`). */
	catalogFamilies(): FontFamily[] {
		const byFamily = new Map<string, FontFamily>();
		const seen = new Set<string>();
		for (const f of this.current().manifest.fonts) {
			const faceKey = `${f.family.toLowerCase()}|${f.weight}|${f.style}`;
			if (seen.has(faceKey)) continue;
			seen.add(faceKey);
			let fam = byFamily.get(f.family);
			if (!fam) {
				fam = { family: f.family, source: 'remote', weights: [], styles: [], files: [] };
				byFamily.set(f.family, fam);
			}
			if (!fam.weights.includes(f.weight)) fam.weights.push(f.weight);
			if (!fam.styles.includes(f.style)) fam.styles.push(f.style);
			for (const file of this.fontFiles(f) ?? [])
				fam.files.push({ weight: f.weight, style: f.style, ...file });
		}
		for (const fam of byFamily.values()) fam.weights.sort((a, b) => a - b);
		return [...byFamily.values()];
	}

	private fontPath(f: RemoteFontEntry): string {
		return join(this.o.dir, 'fonts', RemoteAssetService.fontFileName(f));
	}

	/**
	 * Path of a cached, verified font file by served name (`<id>-<hash>.<format>`), or null when it is not cached. Sync
	 * (layer-bake keys, catalogue lookups); the bytes were verified before the file got its name.
	 */
	cachedFontPath(name: string): string | null {
		const f = this.fontByFile(name);
		if (!f) return null;
		const p = this.fontPath(f);
		return existsSync(p) ? p : null;
	}

	/** Path of the verified font file served as `name`, downloading it when needed (policy on). */
	ensureFontFile(name: string): Promise<string> {
		const f = this.fontByFile(name);
		if (!f)
			return Promise.reject(
				new RemoteAssetError('REMOTE_ASSET_UNKNOWN', `No remote font is served as ${name}`, false, { name }),
			);
		return this.ensureFont(f);
	}

	/** Paths of the verified files of a face, downloading them when needed (policy on). */
	async ensureFace(face: Face): Promise<string[]> {
		const entries = this.fontsFor(face);
		if (entries.length === 0)
			throw new RemoteAssetError(
				'REMOTE_ASSET_UNKNOWN',
				`Font "${faceLabel(face)}" is not bundled and not in the remote-asset manifest`,
				false,
				face,
			);
		return Promise.all(entries.map((f) => this.ensureFont(f)));
	}

	private ensureFont(f: RemoteFontEntry): Promise<string> {
		const path = this.fontPath(f);
		return this.once(`font:${path}`, async () => {
			if (existsSync(path)) {
				await this.verifyFile(path, f.sha256, `Cached font ${f.id}`);
				return path;
			}
			await this.requireNetwork(`font "${faceLabel(f)}"`);
			const got = await fetchCapped(f.url, {
				limits: this.fontLimits,
				hosts: this.hosts,
				fetchImpl: this.o.fetchImpl,
			});
			const hash = sha256(got.bytes);
			if (hash !== f.sha256)
				throw new RemoteAssetError(
					'ASSET_HASH_MISMATCH',
					`The download of font "${faceLabel(f)}" does not match its pinned SHA-256 (the source changed: fix the URL in the remote-asset manifest override)`,
					false,
					{ url: f.url, expected: f.sha256, actual: hash },
				);
			checkFont(got, f.format);
			await this.write(path, got.bytes);
			this.verified.set(path, hash);
			this.fetched({ kind: 'font', label: faceLabel(f), host: hostOf(f.url), licence: f.licence });
			return path;
		});
	}

	// ── images ─────────────────────────────────────────────────────────────────────────────────────────────────────

	image(id: string): RemoteImageEntry | null {
		return this.current().manifest.images.find((i) => i.id === id) ?? null;
	}

	/** File name an image is served and cached under (immutable: the hash prefix changes with the file). */
	static imageFileName(i: RemoteImageEntry): string {
		return `${i.id}-${i.sha256.slice(0, 16)}.${i.format}`;
	}

	/** Engine-relative URL of a remote image by id (null: not in the manifest). */
	imageUrl(id: string): string | null {
		const i = this.image(id);
		return i ? `${REMOTE_IMAGE_PREFIX}${RemoteAssetService.imageFileName(i)}` : null;
	}

	/** Remote images for the font catalogue. */
	catalogImages(): RemoteImageInfo[] {
		return this.current().manifest.images.map((i) => ({
			id: i.id,
			url: `${REMOTE_IMAGE_PREFIX}${RemoteAssetService.imageFileName(i)}`,
			format: i.format,
			licence: i.licence,
		}));
	}

	private imagePath(i: RemoteImageEntry): string {
		return join(this.o.dir, 'images', RemoteAssetService.imageFileName(i));
	}

	/** Path of a cached, verified image by served name, or null when not cached (layer-bake keys). */
	cachedImagePath(name: string): string | null {
		const i = this.current().manifest.images.find((x) => RemoteAssetService.imageFileName(x) === name);
		if (!i) return null;
		const p = this.imagePath(i);
		return existsSync(p) ? p : null;
	}

	/** The verified image served as `name` (`<id>-<hash>.<format>`), downloading it when needed. */
	async ensureImageFile(name: string): Promise<{ path: string; contentType: string; sha256: string }> {
		const i = this.current().manifest.images.find((x) => RemoteAssetService.imageFileName(x) === name);
		if (!i)
			throw new RemoteAssetError('REMOTE_ASSET_UNKNOWN', `No remote image is served as ${name}`, false, {
				name,
			});
		return { path: await this.ensureImageEntry(i), contentType: IMAGE_TYPES[i.format], sha256: i.sha256 };
	}

	/** Path of a remote image by id, downloading it when needed (policy on). */
	ensureImage(id: string): Promise<string> {
		const i = this.image(id);
		if (!i)
			return Promise.reject(
				new RemoteAssetError(
					'REMOTE_ASSET_UNKNOWN',
					`Image "${id}" is not in the remote-asset manifest`,
					false,
					{
						id,
					},
				),
			);
		return this.ensureImageEntry(i);
	}

	private ensureImageEntry(i: RemoteImageEntry): Promise<string> {
		const path = this.imagePath(i);
		return this.once(`image:${path}`, async () => {
			if (existsSync(path)) {
				await this.verifyFile(path, i.sha256, `Cached image ${i.id}`);
				return path;
			}
			await this.requireNetwork(`image "${i.id}"`);
			const got = await fetchCapped(i.url, {
				limits:
					this.emojiLimits.maxBytes >= IMAGE_MAX_BYTES
						? this.emojiLimits
						: { ...this.emojiLimits, maxBytes: IMAGE_MAX_BYTES },
				hosts: this.hosts,
				fetchImpl: this.o.fetchImpl,
			});
			const hash = sha256(got.bytes);
			if (hash !== i.sha256)
				throw new RemoteAssetError(
					'ASSET_HASH_MISMATCH',
					`The download of image "${i.id}" does not match its pinned SHA-256 (the source changed: fix the URL in the remote-asset manifest override)`,
					false,
					{ url: i.url, expected: i.sha256, actual: hash },
				);
			checkImage(got, i.format);
			await this.write(path, got.bytes);
			this.verified.set(path, hash);
			this.fetched({ kind: 'image', label: i.id, host: hostOf(i.url), licence: i.licence });
			return path;
		});
	}

	// ── emoji ──────────────────────────────────────────────────────────────────────────────────────────────────────

	pack(id: string): RemoteEmojiPack | null {
		return this.current().manifest.emojiPacks.find((p) => p.id === id) ?? null;
	}

	/** Emoji packs for the font catalogue. */
	emojiPacks(): EmojiPackInfo[] {
		return this.current().manifest.emojiPacks.map((p) => ({
			id: p.id,
			name: p.name,
			version: p.version,
			format: p.format,
			licence: p.licence,
			attribution: p.attribution,
		}));
	}

	/** Engine-relative URL of a grapheme's image in a pack (null: unknown pack or not an emoji). */
	emojiUrl(packId: string, grapheme: string): string | null {
		const p = this.pack(packId);
		if (!p || !isEmojiGrapheme(grapheme)) return null;
		return emojiImagePath(p.id, p.version, emojiKey(grapheme), p.format);
	}

	/** Upstream URLs to try for a grapheme (`{cp}` per the pack's U+FE0F rule; `{name}` from its names map). */
	static emojiSourceUrls(p: RemoteEmojiPack, grapheme: string): string[] {
		const cps = emojiCodepointCandidates(grapheme, p.fe0f, {
			...(p.cpJoin !== undefined ? { join: p.cpJoin } : {}),
			...(p.cpMinDigits !== undefined ? { minDigits: p.cpMinDigits } : {}),
		});
		const needsName = p.urlTemplate.includes('{name}');
		// names are keyed by a code point sequence: as typed, without U+FE0F, or fully qualified
		const keys = [emojiKey(grapheme), ...emojiCodepointCandidates(grapheme, 'try-both')];
		const name = keys.map((k) => p.names?.[k]).find((n) => !!n);
		if (needsName && !name) return [];
		const out: string[] = [];
		for (const cp of cps) {
			const url = p.urlTemplate.replaceAll('{cp}', cp).replaceAll('{name}', name ?? '');
			if (!out.includes(url)) out.push(url);
		}
		return out;
	}

	private emojiDir(p: RemoteEmojiPack): string {
		return join(this.o.dir, 'emoji', p.id, p.version);
	}

	private async index(p: RemoteEmojiPack): Promise<EmojiIndex> {
		const file = join(this.emojiDir(p), 'index.json');
		const hit = this.indexes.get(file);
		if (hit) return hit;
		let raw: unknown = null;
		try {
			raw = await readJsonOrNull(file);
		} catch {
			raw = null;
		}
		const r = EmojiIndexSchema.safeParse(raw ?? { version: 1, entries: {} });
		const idx = r.success ? r.data : { version: 1 as const, entries: {} };
		this.indexes.set(file, idx);
		return idx;
	}

	/** SHA-256 of a cached emoji image (its first verified fetch), or null when not cached (layer-bake keys). */
	async emojiHash(packId: string, grapheme: string): Promise<string | null> {
		const p = this.pack(packId);
		if (!p) return null;
		const key = emojiKey(grapheme);
		const e = (await this.index(p)).entries[key];
		return e && existsSync(join(this.emojiDir(p), `${key}.${p.format}`)) ? e.sha256 : null;
	}

	/**
	 * The verified image of a served emoji path (`<pack>/<version>/<key>.<format>`), downloading it when needed.
	 * The version must be the manifest's current one (images of other versions are not served).
	 */
	async ensureEmojiFile(
		packId: string,
		version: string,
		file: string,
	): Promise<{ path: string; contentType: string }> {
		const p = this.pack(packId);
		const m = /^([0-9a-f-]+)\.(png|svg)$/.exec(file);
		const grapheme = m ? graphemeOfEmojiKey(m[1]!) : null;
		if (!p || p.version !== version || !m || m[2] !== p.format || !grapheme)
			throw new RemoteAssetError(
				'REMOTE_ASSET_UNKNOWN',
				`No emoji image is served as ${packId}/${version}/${file}`,
				false,
				{
					pack: packId,
					version,
					file,
				},
			);
		const path = await this.ensureEmoji(p, grapheme);
		return { path, contentType: p.format === 'png' ? 'image/png' : 'image/svg+xml' };
	}

	/** Path of a grapheme's verified image in a pack, downloading it when needed (policy on). */
	ensureEmojiImage(packId: string, grapheme: string): Promise<string> {
		const p = this.pack(packId);
		if (!p)
			return Promise.reject(
				new RemoteAssetError(
					'REMOTE_ASSET_UNKNOWN',
					`The ${packId} emoji pack is not in the remote-asset manifest`,
					false,
					{
						pack: packId,
					},
				),
			);
		if (!isEmojiGrapheme(grapheme))
			return Promise.reject(
				new RemoteAssetError('REMOTE_ASSET_UNKNOWN', `${JSON.stringify(grapheme)} is not an emoji`, false, {
					pack: packId,
				}),
			);
		return this.ensureEmoji(p, grapheme);
	}

	private ensureEmoji(p: RemoteEmojiPack, grapheme: string): Promise<string> {
		const key = emojiKey(grapheme);
		const dir = this.emojiDir(p);
		const path = join(dir, `${key}.${p.format}`);
		return this.once(`emoji:${path}`, async () => {
			const idx = await this.index(p);
			const pinned = idx.entries[key];
			if (existsSync(path)) {
				if (pinned) {
					await this.verifyFile(path, pinned.sha256, `Cached emoji ${grapheme} (${p.name})`);
					return path;
				}
				// Written but not indexed (interrupted between the two writes): its bytes were verified before the rename.
				const hash = await sha256File(path);
				await this.recordEmoji(p, key, { sha256: hash, size: (await readFile(path)).length, url: '' });
				this.verified.set(path, hash);
				return path;
			}
			await this.requireNetwork(`emoji ${grapheme} (${p.name})`);
			const urls = RemoteAssetService.emojiSourceUrls(p, grapheme);
			if (urls.length === 0)
				throw new RemoteAssetError(
					'DOWNLOAD_NOT_FOUND',
					`Emoji ${grapheme} is not in the ${p.name} pack`,
					false,
					{
						pack: p.id,
						grapheme,
					},
				);
			let last: RemoteAssetError | null = null;
			for (const url of urls) {
				try {
					const got = await fetchCapped(url, {
						limits: this.emojiLimits,
						hosts: this.hosts,
						fetchImpl: this.o.fetchImpl,
					});
					checkImage(got, p.format);
					const hash = sha256(got.bytes);
					if (pinned && pinned.sha256 !== hash)
						throw new RemoteAssetError(
							'ASSET_HASH_MISMATCH',
							`Emoji ${grapheme} (${p.name}) changed since it was first downloaded (the pack's files moved or changed: bump the pack version in the remote-asset manifest override)`,
							false,
							{ url, expected: pinned.sha256, actual: hash },
						);
					await this.write(path, got.bytes);
					await this.recordEmoji(p, key, { sha256: hash, size: got.bytes.length, url });
					this.verified.set(path, hash);
					this.fetched({
						kind: 'emoji',
						label: `${grapheme} (${p.name})`,
						host: hostOf(url),
						licence: p.licence,
					});
					return path;
				} catch (e) {
					last = asRemoteAssetError(e);
					// try-both: only a missing file moves on to the other spelling
					if (last.code !== 'DOWNLOAD_NOT_FOUND') throw last;
				}
			}
			throw new RemoteAssetError(
				'DOWNLOAD_NOT_FOUND',
				`Emoji ${grapheme} is not available in the ${p.name} pack`,
				false,
				{
					pack: p.id,
					grapheme,
					...(last ? { cause: last.toJSON() } : {}),
				},
			);
		});
	}

	private async recordEmoji(
		p: RemoteEmojiPack,
		key: string,
		entry: EmojiIndex['entries'][string],
	): Promise<void> {
		const file = join(this.emojiDir(p), 'index.json');
		await this.mutex.run(file, async () => {
			const idx = await this.index(p);
			const next: EmojiIndex = { version: 1, entries: { ...idx.entries, [key]: entry } };
			await atomicWriteJson(file, next);
			this.indexes.set(file, next);
		});
	}

	// ── prefetch ───────────────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Makes the given faces and emoji available before a render (downloads when the policy allows) and returns what is
	 * still missing, with why. Faces resolved by `bundled` (the bundled catalogue) are available without the network.
	 */
	async prefetch(
		req: RemoteAssetPrefetchRequest,
		bundled: (face: Face) => boolean = () => false,
	): Promise<RemoteAssetPrefetchResponse> {
		const missing: RemoteAssetMissing[] = [];
		let available = 0;
		const seenFaces = new Set<string>();
		for (const face of req.fonts ?? []) {
			const k = `${face.family.toLowerCase()}|${face.weight}|${face.style}`;
			if (seenFaces.has(k)) continue;
			seenFaces.add(k);
			if (bundled(face)) {
				available++;
				continue;
			}
			try {
				await this.ensureFace(face);
				available++;
			} catch (e) {
				missing.push({ kind: 'font', ...face, error: asRemoteAssetError(e).toJSON() });
			}
		}
		// Distinct emoji per pack, bounded: the ones over the cap are reported missing by name (never skipped silently).
		const cap = Math.max(1, Math.floor(this.o.prefetchMaxEmoji ?? REMOTE_PREFETCH_MAX_EMOJI));
		const jobs: { pack: string; grapheme: string }[] = [];
		const perPack = new Map<string, Set<string>>();
		for (const { pack, graphemes } of req.emoji ?? []) {
			let seen = perPack.get(pack);
			if (!seen) perPack.set(pack, (seen = new Set()));
			for (const g of graphemes) {
				if (seen.has(g)) continue;
				seen.add(g);
				if (seen.size <= cap) jobs.push({ pack, grapheme: g });
				else
					missing.push({
						kind: 'emoji',
						pack,
						grapheme: g,
						error: new RemoteAssetError(
							'PREFETCH_LIMIT',
							`More than ${cap} different emoji of the ${pack} pack in one render: ${g} was not fetched`,
							false,
							{ pack, limit: cap },
						).toJSON(),
					});
			}
		}
		let next = 0;
		const worker = async () => {
			while (next < jobs.length) {
				const j = jobs[next++]!;
				try {
					await this.ensureEmojiImage(j.pack, j.grapheme);
					available++;
				} catch (e) {
					missing.push({ kind: 'emoji', ...j, error: asRemoteAssetError(e).toJSON() });
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(PREFETCH_PARALLEL, jobs.length) }, worker));
		for (const id of [...new Set(req.images ?? [])]) {
			try {
				await this.ensureImage(id);
				available++;
			} catch (e) {
				missing.push({ kind: 'image', id, error: asRemoteAssetError(e).toJSON() });
			}
		}
		return { available, missing };
	}

	// ── status / notice ────────────────────────────────────────────────────────────────────────────────────────────

	async status(): Promise<RemoteAssetsStatus> {
		const { manifest, override } = this.current();
		const notice = await this.settings.notice();
		const emojiPacks: RemoteAssetsStatus['emojiPacks'] = [];
		for (const p of manifest.emojiPacks)
			emojiPacks.push({
				id: p.id,
				name: p.name,
				version: p.version,
				host: hostOf(p.urlTemplate.replace(/\{(cp|name)\}/g, 'x')),
				licence: p.licence,
				attribution: p.attribution,
				// files actually on disk (the cache may have been cleared since they were indexed)
				cached: Object.keys((await this.index(p)).entries).filter((k) =>
					existsSync(join(this.emojiDir(p), `${k}.${p.format}`)),
				).length,
			});
		return {
			settings: await this.settings.get(),
			manifest: {
				version: manifest.version,
				fonts: manifest.fonts.length,
				emojiPacks: manifest.emojiPacks.length,
				images: manifest.images.length,
				override,
			},
			fonts: manifest.fonts.map((f) => ({
				id: f.id,
				family: f.family,
				weight: f.weight,
				style: f.style,
				cached: existsSync(this.fontPath(f)),
				host: hostOf(f.url),
				licence: f.licence,
			})),
			emojiPacks,
			images: manifest.images.map((i) => ({
				id: i.id,
				cached: existsSync(this.imagePath(i)),
				host: hostOf(i.url),
				licence: i.licence,
			})),
			notice: {
				pending: !!notice && !notice.acknowledged,
				firstFetchAt: notice?.firstFetchAt ?? null,
				items: notice?.items ?? [],
			},
		};
	}

	async acknowledgeNotice(): Promise<RemoteAssetsStatus> {
		await this.settings.acknowledge();
		return this.status();
	}

	async putSettings(next: NetworkSettings): Promise<NetworkSettings> {
		const saved = await this.settings.put(next);
		this.o.onChanged?.({ reason: 'settings', notice: false });
		return saved;
	}

	// ── internals ──────────────────────────────────────────────────────────────────────────────────────────────────

	/** Runs `fn` once per key at a time: concurrent requests for one asset share one download. */
	private once(key: string, fn: () => Promise<string>): Promise<string> {
		const hit = this.inflight.get(key);
		if (hit) return hit;
		const p = fn().finally(() => this.inflight.delete(key));
		this.inflight.set(key, p);
		return p;
	}

	private async requireNetwork(what: string): Promise<void> {
		if (!(await this.settings.get()).platformAssets)
			throw new RemoteAssetError(
				'REMOTE_ASSETS_OFF',
				`The ${what} is not downloaded and "Platform fonts & emoji for social templates" is off (Settings ▸ Privacy & Network)`,
				false,
			);
	}

	private async verifyFile(path: string, expected: string, what: string): Promise<void> {
		if (this.verified.get(path) === expected) return;
		const hash = await sha256File(path);
		if (hash !== expected)
			throw new RemoteAssetError(
				'ASSET_HASH_MISMATCH',
				`${what} is damaged (its SHA-256 differs from the pinned one); delete ${path} to download it again`,
				false,
				{ path, expected, actual: hash },
			);
		this.verified.set(path, hash);
	}

	private async write(path: string, bytes: Buffer): Promise<void> {
		try {
			await atomicWriteFile(path, bytes);
		} catch (e) {
			throw new RemoteAssetError(
				'ASSET_CACHE_WRITE',
				`Could not write ${path}: ${(e as Error).message}`,
				true,
				{
					path,
				},
			);
		}
	}

	/** Records a download for the first-fetch notice and announces it (batched). */
	private fetched(item: RemoteAssetFetch): void {
		this.pendingItems.push(item);
		if (this.flushTimer) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			const items = this.pendingItems.splice(0);
			void (async () => {
				let pending = false;
				for (const i of items)
					pending = (await this.settings.recordFetch(i, this.o.now?.() ?? new Date())) || pending;
				this.o.onChanged?.({ reason: 'fetched', notice: pending, items });
			})().catch(() => undefined);
		}, 200);
		this.flushTimer.unref?.();
	}

	/** Waits for batched notice writes (tests, shutdown). */
	async flush(): Promise<void> {
		if (!this.flushTimer) return;
		clearTimeout(this.flushTimer);
		this.flushTimer = null;
		const items = this.pendingItems.splice(0);
		let pending = false;
		for (const i of items)
			pending = (await this.settings.recordFetch(i, this.o.now?.() ?? new Date())) || pending;
		this.o.onChanged?.({ reason: 'fetched', notice: pending, items });
	}
}
