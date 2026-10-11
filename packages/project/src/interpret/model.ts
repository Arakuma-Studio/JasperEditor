// Interpret Footage (docs/wp-notes/imports.md): how a media file is read — an assumed frame
// rate, a conformed pixel aspect ratio, a field order (interlaced pictures are deinterlaced into the progressive
// sequence), the alpha channel's meaning and a loop count — without touching the file. The asset's `probe` stays the
// file's truth; everything that needs the interpreted value asks these helpers.
//
// Time model. A clip's content times (`sourceIn`, keyframes, remap `source` values) are *interpreted media time*. The
// file is read at `fileTime = (interpreted time mod loopPeriod) · timeScale` with `timeScale = assumed rate / file
// rate` (a 24 fps file assumed to be 30 fps plays 1.25 file seconds per interpreted second). `timeScale` is 1 and
// there is no loop period for uninterpreted media, so every existing document reads exactly as before.
import type { RGBA } from '../schema/common.ts';
import type { MediaAsset, MediaInterpretation, VideoStream } from '../schema/media.ts';
import { FLICKS_PER_SECOND, type Rational } from '../time.ts';

export type FieldOrder = 'progressive' | 'upper' | 'lower';
export type AlphaMode = 'straight' | 'premultiplied' | 'ignore';

/** Media kinds whose pictures have frames in time (frame rate and loop apply). */
const TIMED_KINDS: ReadonlySet<string> = new Set(['video', 'animated-image']);
/** Animated images whose frames the editor draws itself (Lottie). GIF / WebP animate natively in the browser. */
const isFrameExact = (asset: { kind: string; lottie?: unknown }) => asset.kind === 'video' || !!asset.lottie;
/** Media kinds with a picture (pixel aspect, field order and alpha apply). */
const PICTURE_KINDS: ReadonlySet<string> = new Set(['video', 'image', 'animated-image']);

export const MIN_ASSUMED_FPS = 1;
export const MAX_ASSUMED_FPS = 1000;
export const MAX_LOOP_COUNT = 1000;

type AssetLike = Pick<MediaAsset, 'kind' | 'probe'> & {
	interpretation?: MediaInterpretation | null;
	lottie?: unknown;
};

function videoStream(asset: Pick<MediaAsset, 'probe'>): VideoStream | null {
	const vs = asset.probe.streams.find((s) => s.type === 'video');
	return vs && vs.type === 'video' ? (vs as VideoStream) : null;
}

const finiteRational = (r: Rational | null | undefined): r is Rational =>
	!!r && Number.isFinite(r.num) && Number.isFinite(r.den) && r.num > 0 && r.den > 0;

/** A frame rate in fps (1…1000) → a rational; NTSC rates (23.976, 29.97, 59.94, 119.88) become 1001 fractions. */
export function rationalFromFps(fps: number): Rational | null {
	if (!Number.isFinite(fps) || fps < 1 || fps > 1000) return null;
	for (const [num, den] of [
		[24000, 1001],
		[30000, 1001],
		[60000, 1001],
		[120000, 1001],
	] as const)
		if (Math.abs(fps - num / den) < 0.005) return { num, den };
	if (Math.abs(fps - Math.round(fps)) < 1e-9) return { num: Math.round(fps), den: 1 };
	return { num: Math.round(fps * 1000), den: 1000 };
}

/** Whether frame rate / loop interpretation applies to the asset (video, animated images, Lottie, sequences). */
export function isTimedMedia(asset: Pick<MediaAsset, 'kind' | 'probe'> & { lottie?: unknown }): boolean {
	return TIMED_KINDS.has(asset.kind) && isFrameExact(asset) && !!videoStream(asset);
}

/** Whether pixel interpretation (aspect, fields, alpha) applies to the asset. */
export function isPictureMedia(asset: Pick<MediaAsset, 'kind' | 'probe'>): boolean {
	return PICTURE_KINDS.has(asset.kind) && !!videoStream(asset);
}

/** The file's own video frame rate (null without a video stream). */
export function fileFrameRate(asset: Pick<MediaAsset, 'probe'>): Rational | null {
	const vs = videoStream(asset);
	return vs && finiteRational(vs.frameRate) ? { num: vs.frameRate.num, den: vs.frameRate.den } : null;
}

/** The frame rate the editor uses: the assumed rate when one is set, else the file's. */
export function interpretedFrameRate(asset: AssetLike): Rational | null {
	const own = fileFrameRate(asset);
	const assumed = asset.interpretation?.frameRate;
	if (own && isTimedMedia(asset) && finiteRational(assumed)) return { num: assumed.num, den: assumed.den };
	return own;
}

/** `assumed rate / file rate` (1 = the file plays as recorded). File time = interpreted time · scale. */
export function mediaTimeScale(asset: AssetLike): number {
	const own = fileFrameRate(asset);
	const assumed = asset.interpretation?.frameRate;
	if (!own || !isTimedMedia(asset) || !finiteRational(assumed)) return 1;
	const k = (assumed.num * own.den) / (assumed.den * own.num);
	return Number.isFinite(k) && k > 0 ? k : 1;
}

/** Loop count (1 = plays once). */
export function mediaLoopCount(asset: AssetLike): number {
	const n = asset.interpretation?.loop;
	if (!isTimedMedia(asset) || typeof n !== 'number' || !Number.isFinite(n)) return 1;
	return Math.max(1, Math.min(MAX_LOOP_COUNT, Math.floor(n)));
}

/** Duration of one pass of the media in interpreted time (flicks), or null (stills, unknown). */
export function mediaPassFlicks(asset: AssetLike): number | null {
	const d = asset.probe.durationFlicks;
	if (d === null || !Number.isFinite(d) || d <= 0) return d === 0 ? 0 : null;
	return Math.round(d / mediaTimeScale(asset));
}

/**
 * The media duration the editor uses (flicks): the file's duration at the assumed frame rate, times the loop count.
 * Null when the file has none (stills).
 */
export function mediaDurationFlicks(asset: AssetLike): number | null {
	const pass = mediaPassFlicks(asset);
	if (pass === null) return null;
	return pass * mediaLoopCount(asset);
}

/** The file's own pixel aspect ratio (1:1 when unknown or invalid). */
export function filePixelAspect(asset: Pick<MediaAsset, 'probe'>): Rational {
	const vs = videoStream(asset);
	return vs && finiteRational(vs.pixelAspect)
		? { num: vs.pixelAspect.num, den: vs.pixelAspect.den }
		: { num: 1, den: 1 };
}

/** Pixel aspect ratio the picture is shown with (the conformed one, else the file's). */
export function mediaPixelAspect(asset: AssetLike): Rational {
	const p = asset.interpretation?.pixelAspect;
	if (isPictureMedia(asset) && finiteRational(p)) return { num: p.num, den: p.den };
	return filePixelAspect(asset);
}

/**
 * Display size of the picture in square sequence pixels: rotation applied, then the pixel aspect ratio stretches the
 * width (a 720×480 DV frame with PAR 10:11 shows as 655×480; anamorphic 1440×1080 with 4:3 as 1920×1080). This is the
 * layer's intrinsic box everywhere (Motion, preview, every export path). Null without a video stream.
 */
export function mediaDisplaySize(asset: AssetLike): { width: number; height: number } | null {
	const vs = videoStream(asset);
	if (!vs) return null;
	const swap = asset.probe.rotationDegrees === 90 || asset.probe.rotationDegrees === 270;
	const par = mediaPixelAspect(asset);
	const ratio = par.num / par.den;
	const w = swap ? vs.height : vs.width;
	const h = swap ? vs.width : vs.height;
	if (!(ratio > 0) || Math.abs(ratio - 1) < 1e-9) return { width: w, height: h };
	// Rotated pictures: the stored pixels are stretched along the stored width, which becomes the display height.
	if (swap) return { width: w, height: Math.max(1, Math.round(h * ratio)) };
	return { width: Math.max(1, Math.round(w * ratio)), height: h };
}

/** The file's field order (`progressive` when unknown). */
export function fileFieldOrder(asset: Pick<MediaAsset, 'probe'>): FieldOrder {
	const fo = videoStream(asset)?.fieldOrder;
	if (fo === 'tt' || fo === 'tb') return 'upper';
	if (fo === 'bb' || fo === 'bt') return 'lower';
	return 'progressive';
}

/** Field order the picture is read with. Interlaced (upper / lower) pictures are deinterlaced on every path. */
export function mediaFieldOrder(asset: AssetLike): FieldOrder {
	const fo = asset.interpretation?.fieldOrder;
	if (isTimedMedia(asset) && (fo === 'progressive' || fo === 'upper' || fo === 'lower')) return fo;
	return isTimedMedia(asset) ? fileFieldOrder(asset) : 'progressive';
}

export type AlphaInterpretation = {
	mode: AlphaMode;
	/** Premultiplied: the colour the picture was matted with (straight RGB, alpha ignored). */
	matte: [number, number, number];
	invert: boolean;
};

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

/** The alpha interpretation (straight, black matte, not inverted when unset). */
export function mediaAlpha(asset: AssetLike): AlphaInterpretation {
	const a = asset.interpretation?.alpha;
	if (!a || !isPictureMedia(asset)) return { mode: 'straight', matte: [0, 0, 0], invert: false };
	const mode: AlphaMode = a.mode === 'premultiplied' || a.mode === 'ignore' ? a.mode : 'straight';
	const m = (a.matte ?? [0, 0, 0, 1]) as RGBA;
	return { mode, matte: [clamp01(m[0]), clamp01(m[1]), clamp01(m[2])], invert: a.invert === true };
}

/**
 * What a decoder must do to the pixels of this media (null = nothing): deinterlace with a field order, unpremultiply
 * from a matte colour, drop or invert the alpha. One description shared by the native export (ffmpeg filters), the
 * proxy / display derivatives and the agent queries.
 */
export type PixelInterpretation = {
	/** Deinterlace (`upper` = top field first). Absent = progressive. */
	deinterlace?: 'upper' | 'lower';
	alpha?: AlphaInterpretation;
};

export function pixelInterpretation(asset: AssetLike): PixelInterpretation | null {
	const out: PixelInterpretation = {};
	const fo = mediaFieldOrder(asset);
	if (fo !== 'progressive') out.deinterlace = fo;
	const alpha = mediaAlpha(asset);
	if (alpha.mode !== 'straight' || alpha.invert) out.alpha = alpha;
	return out.deinterlace || out.alpha ? out : null;
}

const hex2 = (v: number) =>
	Math.round(clamp01(v) * 255)
		.toString(16)
		.padStart(2, '0');

/**
 * Canonical text of a pixel interpretation ('' = none), e.g. `fo=upper;a=premultiplied;m=000000;inv=1`. It is the
 * derivative variant: proxies and display pictures made with it are cached under it.
 */
export function pixelVariantKey(p: PixelInterpretation | null): string {
	if (!p) return '';
	const parts: string[] = [];
	if (p.deinterlace) parts.push(`fo=${p.deinterlace}`);
	if (p.alpha) {
		if (p.alpha.mode !== 'straight') parts.push(`a=${p.alpha.mode}`);
		if (p.alpha.mode === 'premultiplied') parts.push(`m=${p.alpha.matte.map(hex2).join('')}`);
		if (p.alpha.invert) parts.push('inv=1');
	}
	return parts.join(';');
}

/** Parses a variant key (from a URL or job input); null when malformed. Inverse of `pixelVariantKey`. */
export function parsePixelVariant(text: string): PixelInterpretation | null {
	if (text === '') return null;
	if (text.length > 80) return null;
	const out: PixelInterpretation = {};
	let alpha: AlphaInterpretation | null = null;
	for (const part of text.split(';')) {
		const [k, v] = part.split('=');
		if (k === 'fo' && (v === 'upper' || v === 'lower')) out.deinterlace = v;
		else if (k === 'a' && (v === 'premultiplied' || v === 'ignore')) {
			alpha = { ...(alpha ?? { matte: [0, 0, 0], invert: false }), mode: v };
		} else if (k === 'm' && v && /^[0-9a-f]{6}$/i.test(v)) {
			const n = (i: number) => Number.parseInt(v.slice(i, i + 2), 16) / 255;
			alpha = { ...(alpha ?? { mode: 'straight', invert: false }), matte: [n(0), n(2), n(4)] };
		} else if (k === 'inv' && v === '1') {
			alpha = { ...(alpha ?? { mode: 'straight', matte: [0, 0, 0] }), invert: true };
		} else return null;
	}
	if (alpha) out.alpha = alpha;
	const canonical = pixelVariantKey(out.deinterlace || out.alpha ? out : null);
	return canonical === text ? out : null;
}

/** The variant key of an asset (`pixelVariantKey(pixelInterpretation(asset))`). */
export function mediaPixelVariant(asset: AssetLike): string {
	return pixelVariantKey(pixelInterpretation(asset));
}

/**
 * ffmpeg filters that apply a pixel interpretation to a decoded picture, in order: deinterlace (bwdif, one frame per
 * frame, at the given field parity), then the alpha (the picture is converted to RGBA first). Filters used:
 * `bwdif`, `format`, `geq`/`unpremultiply`, `lutrgb` — all in the LGPL build. The output is straight RGBA when an
 * alpha interpretation is present.
 */
export function pixelInterpretationFilters(p: PixelInterpretation | null): string[] {
	if (!p) return [];
	const f: string[] = [];
	if (p.deinterlace)
		f.push(`bwdif=mode=send_frame:parity=${p.deinterlace === 'upper' ? 'tff' : 'bff'}:deint=all`);
	const a = p.alpha;
	if (a) {
		f.push('format=rgba');
		if (a.mode === 'ignore') f.push('lutrgb=a=maxval');
		else if (a.mode === 'premultiplied') {
			const [r, g, b] = a.matte;
			if (r === 0 && g === 0 && b === 0) f.push('unpremultiply=inplace=1');
			else {
				// Matted with a colour: C = (C' − (1 − α)·M) / α (After Effects' "Premultiplied – Matted With Color").
				const ch = (c: string, m: number) => {
					const mm = Math.round(clamp01(m) * 255);
					return `clip((${c}(X,Y)-(255-alpha(X,Y))*${mm}/255)*255/max(alpha(X,Y),1),0,255)`;
				};
				f.push(`geq=r='${ch('r', r)}':g='${ch('g', g)}':b='${ch('b', b)}':a='alpha(X,Y)'`);
			}
		}
		if (a.invert) f.push('lutrgb=a=negval');
	}
	return f;
}

/** Interpreted media time (flicks) → file time (flicks): loop wrap, then the frame-rate scale. */
export function fileTimeOf(map: MediaTimeMap | null | undefined, mediaFlicks: number): number {
	if (!map) return mediaFlicks;
	let t = mediaFlicks;
	if (map.period && map.period > 0) {
		t %= map.period;
		if (t < 0) t += map.period;
	}
	return t * map.scale;
}

/**
 * How a render clip reads its media in time (render snapshot field `mediaTime`): `scale` = file seconds per
 * interpreted second, `period` = interpreted flicks of one loop pass (absent = no loop). Absent on uninterpreted media.
 */
export type MediaTimeMap = { scale: number; period?: number };

/** The time map of an asset, or null when it reads its file linearly (no assumed rate, no loop). */
export function mediaTimeMap(asset: AssetLike): MediaTimeMap | null {
	const scale = mediaTimeScale(asset);
	const loops = mediaLoopCount(asset);
	const pass = loops > 1 ? mediaPassFlicks(asset) : null;
	if (scale === 1 && !(pass && pass > 0)) return null;
	return { scale, ...(pass && pass > 0 ? { period: pass } : {}) };
}

/** Seconds of the file shown at interpreted media time `mediaFlicks`. */
export function fileSecondsOf(map: MediaTimeMap | null | undefined, mediaFlicks: number): number {
	return fileTimeOf(map, mediaFlicks) / FLICKS_PER_SECOND;
}

/** Validation issues of an interpretation (for the command and the invariants). */
export function interpretationIssues(asset: AssetLike, interp: MediaInterpretation): string[] {
	const out: string[] = [];
	const fr = interp.frameRate;
	if (fr !== undefined && fr !== null) {
		if (!isTimedMedia(asset)) out.push(`${asset.kind} media has no frame rate to interpret`);
		else if (!finiteRational(fr) || fr.num / fr.den < MIN_ASSUMED_FPS || fr.num / fr.den > MAX_ASSUMED_FPS)
			out.push(`frame rate must be ${MIN_ASSUMED_FPS}…${MAX_ASSUMED_FPS} fps`);
	}
	const par = interp.pixelAspect;
	if (par !== undefined && par !== null) {
		if (!isPictureMedia(asset)) out.push(`${asset.kind} media has no picture`);
		else if (!finiteRational(par) || par.num / par.den < 0.1 || par.num / par.den > 10)
			out.push('pixel aspect ratio must be between 0.1 and 10');
	}
	if (interp.fieldOrder !== undefined && interp.fieldOrder !== null && !isTimedMedia(asset))
		out.push(`${asset.kind} media has no fields`);
	if (interp.alpha !== undefined && interp.alpha !== null && !isPictureMedia(asset))
		out.push(`${asset.kind} media has no picture`);
	const loop = interp.loop;
	if (loop !== undefined && loop !== null) {
		if (!isTimedMedia(asset)) out.push(`${asset.kind} media cannot loop`);
		else if (!Number.isInteger(loop) || loop < 1 || loop > MAX_LOOP_COUNT)
			out.push(`loop count must be an integer 1…${MAX_LOOP_COUNT}`);
		else if ((asset.probe.durationFlicks ?? 0) <= 0) out.push('media without a duration cannot loop');
	}
	return out;
}

/** True when an interpretation changes nothing (every field unset). */
export function isEmptyInterpretation(i: MediaInterpretation | null | undefined): boolean {
	if (!i) return true;
	return Object.entries(i).every(([, v]) => v === undefined || v === null);
}

/** One stretch of interpreted media time read from one contiguous stretch of the file. */
export type FilePiece = {
	/** Interpreted media time (flicks), `from < to`. */
	from: number;
	to: number;
	/** File time (flicks) of `from` and `to` (`fileTo − fileFrom = (to − from) · scale`). */
	fileFrom: number;
	fileTo: number;
};

/**
 * The file stretches that make interpreted media time [t0, t1) (split where a loop wraps). Decoders that read ranges
 * (audio) read each piece and resample it by `1 / scale`. At most `maxPieces` pieces (longer ranges are cut).
 */
export function filePieces(
	map: MediaTimeMap | null | undefined,
	t0: number,
	t1: number,
	maxPieces = 4096,
): FilePiece[] {
	if (!(t1 > t0)) return [];
	if (!map) return [{ from: t0, to: t1, fileFrom: t0, fileTo: t1 }];
	const k = map.scale;
	const P = map.period && map.period > 0 ? map.period : null;
	if (!P) return [{ from: t0, to: t1, fileFrom: t0 * k, fileTo: t1 * k }];
	const out: FilePiece[] = [];
	let a = t0;
	while (a < t1 && out.length < maxPieces) {
		const pass = Math.floor(a / P);
		const end = Math.min(t1, (pass + 1) * P);
		const off = a - pass * P;
		out.push({ from: a, to: end, fileFrom: off * k, fileTo: (off + (end - a)) * k });
		if (end <= a) break;
		a = end;
	}
	return out;
}

/**
 * The imports descriptors (vector, Lottie, layered, image sequence) a registration carries, copied for a new asset
 * (every client that turns an engine `RegisteredMedia` into a `MediaAsset` spreads this in).
 */
export function importedDescriptors(reg: {
	vector?: unknown;
	lottie?: unknown;
	layered?: unknown;
	imageSequence?: unknown;
}): Pick<MediaAsset, 'vector' | 'lottie' | 'layered' | 'imageSequence'> {
	const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
	return {
		...(reg.vector ? { vector: copy(reg.vector as MediaAsset['vector']) } : {}),
		...(reg.lottie ? { lottie: copy(reg.lottie as MediaAsset['lottie']) } : {}),
		...(reg.layered ? { layered: copy(reg.layered as MediaAsset['layered']) } : {}),
		...(reg.imageSequence ? { imageSequence: copy(reg.imageSequence as MediaAsset['imageSequence']) } : {}),
	};
}

/**
 * What a browser-side renderer (Program monitor, Remotion render, layer bake) needs to show an asset exactly as the
 * native export decodes it:
 * - `loader`: Lottie and vector media are drawn by the composition from their JSON / SVG / PDF (`mediaLoaderPath`);
 * - `picture`: a still the browser cannot decode or that has a pixel interpretation is shown from the engine's
 *   `display` PNG; a video with a pixel interpretation from its interpreted `proxy` (preview) / `master` (renders),
 *   both made with `variant`.
 */
export function browserPictureNeed(asset: AssetLike & { vector?: unknown; locators?: unknown }): {
	loader: 'lottie' | 'vector' | null;
	picture: 'display' | 'proxy' | null;
	variant: string;
} {
	if (asset.lottie) return { loader: 'lottie', picture: null, variant: '' };
	if ((asset as { vector?: unknown }).vector) return { loader: 'vector', picture: null, variant: '' };
	const variant = mediaPixelVariant(asset);
	const vs = videoStream(asset);
	if (asset.kind === 'image' && vs)
		return {
			loader: null,
			picture: variant !== '' || vs.browserDecodable === false ? 'display' : null,
			variant,
		};
	if (asset.kind === 'video' && vs && variant !== '') return { loader: null, picture: 'proxy', variant };
	return { loader: null, picture: null, variant };
}

/** Same-origin path of the document a Lottie / vector asset is drawn from (`/media/<key>/lottie.json` / `…/vector`). */
export function mediaLoaderPath(
	asset: Pick<MediaAsset, 'locators'> & { lottie?: unknown; vector?: unknown },
): string | null {
	const loc = asset.locators.find((l) => l.type === 'engine-store');
	if (loc?.type !== 'engine-store') return null;
	const k = encodeURIComponent(loc.key);
	if (asset.lottie) return `/media/${k}/lottie.json`;
	if (asset.vector) return `/media/${k}/vector`;
	return null;
}
