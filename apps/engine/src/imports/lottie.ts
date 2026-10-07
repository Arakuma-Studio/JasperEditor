// Lottie import on the engine (imports workstream): `.json` Lottie documents and `.lottie` (dotLottie) archives
// register as `animated-image` media with a `lottie` header. The players (preview, Remotion renders, layer bakes)
// load one normalised JSON (`/media/:key/lottie.json`): the chosen animation of a dotLottie with its images embedded
// as data URIs, or a plain document whose external images (next to the file) are embedded the same way.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import {
	EMPTY_PROBE,
	type LottieDoc,
	type LottieInfo,
	LottieParseError,
	lottieImageAssets,
	lottieInfo,
	parseLottie,
	secondsToFlicks,
} from '@jasper/project';
import { JobError } from '../jobs/types.ts';
import type { ProbeResult } from '../media/probe.ts';
import { listZip, looksLikeZip, MAX_ENTRY_BYTES, readZipEntry, ZipError } from './zip.ts';

const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
/** Normaliser version: bump to rebuild cached `lottie.json` files. */
export const LOTTIE_NORMALIZE_VERSION = 1;

const MIME: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
	gif: 'image/gif',
	svg: 'image/svg+xml',
};
const mimeOf = (name: string) =>
	MIME[name.toLowerCase().split('.').pop() ?? ''] ?? 'application/octet-stream';

export const isLottieFileName = (file: string) => /\.(lottie|json)$/i.test(file);

type Loaded = { doc: LottieDoc; info: LottieInfo };

/** Error for the import (job / route): the file is not a usable Lottie animation. */
function bad(message: string): never {
	throw new JobError('INVALID_LOTTIE', message, false);
}

/**
 * Reads a `.json` / `.lottie` file into a normalised document (images embedded) and its header. A `.json` that is not
 * a Lottie document fails with `UNSUPPORTED_MEDIA` (other JSON files are not media).
 */
export async function loadLottieFile(file: string): Promise<Loaded> {
	const st = await stat(file);
	if (st.size > MAX_FILE_BYTES) bad(`The file is too large (${st.size} bytes)`);
	const buf = await readFile(file);
	if (looksLikeZip(buf)) return loadDotLottie(buf);
	let doc: LottieDoc;
	try {
		doc = parseLottie(buf.toString('utf8'));
	} catch (e) {
		if (e instanceof LottieParseError) {
			if (/\.json$/i.test(file) && /^Not (JSON|a Lottie)/.test(e.message))
				throw new JobError('UNSUPPORTED_MEDIA', `${e.message}`, false);
			bad(e.message);
		}
		throw e;
	}
	const warnings: string[] = [];
	await embedImages(
		doc,
		async (dir, name) => {
			// External images next to the document (Bodymovin's `images/` folder): only inside the document's folder.
			const base = dirname(resolve(file));
			const p = normalize(join(base, dir, name));
			if (!p.startsWith(base + sep)) return null;
			const s = await stat(p).catch(() => null);
			if (!s?.isFile() || s.size > MAX_IMAGE_BYTES) return null;
			return readFile(p);
		},
		warnings,
	);
	return { doc, info: lottieInfo(doc, { warnings }) };
}

/** dotLottie (v1 `animations/`, v2 `a/`): the manifest's active (else first) animation, images from the archive. */
function loadDotLottie(buf: Buffer): Promise<Loaded> {
	return (async () => {
		let entries: ReturnType<typeof listZip>;
		try {
			entries = listZip(buf);
		} catch (e) {
			if (e instanceof ZipError) bad(`Not a valid .lottie archive: ${e.message}`);
			throw e;
		}
		const byName = new Map(entries.map((e) => [e.name.replace(/^\/+/, ''), e]));
		const read = (name: string, max = MAX_ENTRY_BYTES) => {
			const e = byName.get(name);
			if (!e) return null;
			try {
				return readZipEntry(buf, e, max);
			} catch (err) {
				if (err instanceof ZipError) bad(err.message);
				throw err;
			}
		};
		const animations = entries
			.map((e) => /^(?:animations|a)\/([^/]+)\.json$/.exec(e.name.replace(/^\/+/, '')))
			.filter((m): m is RegExpExecArray => !!m);
		if (animations.length === 0) bad('The .lottie archive has no animation');
		let wanted: string | null = null;
		const manifestBytes = read('manifest.json', 4 * 1024 * 1024);
		if (manifestBytes) {
			try {
				const m = JSON.parse(manifestBytes.toString('utf8')) as {
					activeAnimationId?: unknown;
					animations?: { id?: unknown }[];
				};
				if (typeof m.activeAnimationId === 'string') wanted = m.activeAnimationId;
				else if (Array.isArray(m.animations) && typeof m.animations[0]?.id === 'string')
					wanted = m.animations[0].id as string;
			} catch {
				// a broken manifest: take the first animation
			}
		}
		const chosen = animations.find((m) => m[1] === wanted) ?? animations[0]!;
		const json = read(chosen[0]);
		if (!json) bad('The .lottie animation cannot be read');
		let doc: LottieDoc;
		try {
			doc = parseLottie(json.toString('utf8'));
		} catch (e) {
			if (e instanceof LottieParseError) bad(e.message);
			throw e;
		}
		const warnings: string[] = [];
		if (animations.length > 1)
			warnings.push(`The archive holds ${animations.length} animations; "${chosen[1]}" was imported.`);
		await embedImages(
			doc,
			async (dir, name) => {
				const clean = `${dir}${name}`.replace(/^\/+/, '');
				return (
					read(clean, MAX_IMAGE_BYTES) ??
					read(`images/${name}`, MAX_IMAGE_BYTES) ??
					read(`i/${name}`, MAX_IMAGE_BYTES)
				);
			},
			warnings,
		);
		return {
			doc,
			info: lottieInfo(doc, {
				warnings,
				dotLottie: { animationId: chosen[1]!.slice(0, 256), animations: animations.length },
			}),
		};
	})();
}

/** Embeds every non-embedded image asset as a data URI (`e: 1`); missing ones are listed in `warnings`. */
async function embedImages(
	doc: LottieDoc,
	fetch: (dir: string, name: string) => Promise<Buffer | null>,
	warnings: string[],
): Promise<void> {
	const missing: string[] = [];
	for (const img of lottieImageAssets(doc)) {
		if (img.embedded) continue;
		const bytes = await fetch(img.dir, img.file);
		const asset = (doc.assets as Record<string, unknown>[])[img.index]!;
		if (!bytes) {
			missing.push(img.file);
			continue;
		}
		asset.u = '';
		asset.p = `data:${mimeOf(img.file)};base64,${bytes.toString('base64')}`;
		asset.e = 1;
	}
	if (missing.length)
		warnings.push(
			`${missing.length} image(s) are not in the file and are drawn empty: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`,
		);
}

/** Probe result of a Lottie file: an `animated-image` with a synthetic video stream at the Lottie's rate. */
export async function probeLottie(file: string): Promise<ProbeResult> {
	const { info } = await loadLottieFile(file);
	const seconds = (info.outFrame - info.inFrame) / info.fps;
	const rate = fpsRational(info.fps);
	return {
		kind: 'animated-image',
		container: /\.lottie$/i.test(file) ? 'dotlottie' : 'lottie',
		probe: {
			...EMPTY_PROBE,
			durationFlicks: secondsToFlicks(seconds),
			streams: [
				{
					index: 0,
					type: 'video',
					codec: 'lottie',
					width: info.width,
					height: info.height,
					pixelAspect: { num: 1, den: 1 },
					frameRate: rate,
					pixelFormat: 'rgba',
					bitDepth: 8,
					color: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', range: 'pc' },
					browserDecodable: true,
				},
			],
			hasAlpha: true,
		},
		browserPlayable: 'yes',
		durationSec: seconds,
		frameCount: Math.round(info.outFrame - info.inFrame),
		interlaced: false,
		hasVideo: true,
		hasAudio: false,
		display: { width: info.width, height: info.height },
		lottie: info,
	};
}

/** A frame rate as a rational (29.97 → 30000/1001; other fractional rates over 1000). */
export function fpsRational(fps: number): { num: number; den: number } {
	for (const [num, den] of [
		[24000, 1001],
		[30000, 1001],
		[60000, 1001],
	] as const)
		if (Math.abs(fps - num / den) < 1e-3) return { num, den };
	if (Number.isInteger(fps)) return { num: fps, den: 1 };
	return { num: Math.max(1, Math.round(fps * 1000)), den: 1000 };
}

/**
 * The normalised JSON of a Lottie media (`<cacheDir>/<fingerprint>/lottie-<v>.json`), written once (atomic rename)
 * and served to every player.
 */
export async function normalizedLottieFile(
	src: string,
	cacheDir: string,
	fingerprintHex: string,
): Promise<string> {
	const key = createHash('sha256').update(`${LOTTIE_NORMALIZE_VERSION}`).digest('hex').slice(0, 8);
	const out = join(cacheDir, fingerprintHex, `lottie-${key}.json`);
	if ((await stat(out).catch(() => null))?.isFile()) return out;
	const { doc } = await loadLottieFile(src);
	await mkdir(dirname(out), { recursive: true });
	const tmp = `${out}.${process.pid}.${Date.now().toString(36)}.tmp`;
	await writeFile(tmp, JSON.stringify(doc));
	await rename(tmp, out);
	return out;
}
