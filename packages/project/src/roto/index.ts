// Roto / object mattes (parity workstream `roto`): the pure model shared by the command handlers, the renderer,
// the engine, the UI and MCP — settings with their defaults, the inputs hash that says whether computed mattes are
// current, frame mapping between clip time and media frames, and the render reference of computed mattes.
import type { ProjectDocument } from '../schema/document.ts';
import type { MediaAsset } from '../schema/media.ts';
import type { ClipRoto, RotoSettings } from '../schema/sequence.ts';
import { flicksPerFrame, type Rational } from '../time.ts';

/** Effect that cuts a clip out by an object matte (After Effects' Roto Brush & Refine Edge output). */
export const OBJECT_MATTE_EFFECT_ID = 'jasper.object-matte';
/** Effect that blurs / pixelates / fills the region of an object matte (Blur Faces). */
export const OBJECT_BLUR_EFFECT_ID = 'jasper.object-blur';
/** `ui.control` of a string param that names a roto object of the clip (Effect Controls shows a picker). */
export const ROTO_OBJECT_CONTROL = 'roto-object';

/**
 * String params that name a roto object of the clip, per effect id (Effect Controls shows a picker; invariants and
 * repairs check them without the registry). Kept equal to the registry's `ui.control: 'roto-object'` params by a
 * catalogue test.
 */
export const ROTO_OBJECT_PARAMS: Readonly<Record<string, readonly string[]>> = {
	[OBJECT_MATTE_EFFECT_ID]: ['object'],
	[OBJECT_BLUR_EFFECT_ID]: ['object'],
	'jasper.screen-keyer': ['insideObject', 'outsideObject'],
};

/** Default segmentation model (processing-model catalogue id) and face model. */
export const ROTO_DEFAULT_MODEL = 'sam2.1-hiera-tiny';
export const FACE_DEFAULT_MODEL = 'mediapipe-face-landmarker';

export type ResolvedRotoSettings = {
	engine: 'model' | 'classic';
	model: string;
	quality: 'standard' | 'best';
	searchRadius: number;
	motionThreshold: number;
	motionDamping: number;
	edgeMode: 'off' | 'guided' | 'closed-form';
	edgeRadius: number;
	edgeSmooth: number;
	faceThreshold: number;
	faceExpand: number;
	faceShape: 'outline' | 'ellipse';
};

/**
 * Defaults: After Effects' Roto Brush propagation defaults (Search Radius 15, Motion Threshold 10 %, Motion Damping
 * 20 %); a 3 px guided-filter edge band with Smooth 1 (Refine Edge's default Smooth); faces at 0.5 confidence, the
 * face outline grown 15 %.
 */
export const ROTO_DEFAULTS: ResolvedRotoSettings = {
	engine: 'model',
	model: ROTO_DEFAULT_MODEL,
	quality: 'standard',
	searchRadius: 15,
	motionThreshold: 10,
	motionDamping: 20,
	edgeMode: 'guided',
	edgeRadius: 3,
	edgeSmooth: 1,
	faceThreshold: 0.5,
	faceExpand: 15,
	faceShape: 'outline',
};

export function rotoSettingsOf(
	r: Pick<ClipRoto, 'settings'> | { settings?: RotoSettings },
): ResolvedRotoSettings {
	const s = r.settings ?? {};
	const out = { ...ROTO_DEFAULTS };
	for (const k of Object.keys(out) as (keyof ResolvedRotoSettings)[]) {
		const v = (s as Record<string, unknown>)[k];
		if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	}
	return out;
}

/** Canonical JSON (sorted keys) for hashing. */
function canonical(v: unknown): string {
	if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
	if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
	const keys = Object.keys(v as Record<string, unknown>)
		.filter((k) => (v as Record<string, unknown>)[k] !== undefined)
		.sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** 64-bit FNV-1a of a string's UTF-8 bytes as 16 hex digits. */
export function fnv64(text: string): string {
	let h = 0xcbf29ce484222325n;
	const mask = 0xffffffffffffffffn;
	const step = (b: number) => {
		h = ((h ^ BigInt(b)) * 0x100000001b3n) & mask;
	};
	for (const ch of text) {
		const c = ch.codePointAt(0)!;
		if (c < 0x80) step(c);
		else if (c < 0x800) {
			step(0xc0 | (c >> 6));
			step(0x80 | (c & 63));
		} else if (c < 0x10000) {
			step(0xe0 | (c >> 12));
			step(0x80 | ((c >> 6) & 63));
			step(0x80 | (c & 63));
		} else {
			step(0xf0 | (c >> 18));
			step(0x80 | ((c >> 12) & 63));
			step(0x80 | ((c >> 6) & 63));
			step(0x80 | (c & 63));
		}
	}
	return h.toString(16).padStart(16, '0');
}

/** What the computed mattes of a roto depend on (everything but its name, result and freeze state). */
export function rotoInputs(r: ClipRoto) {
	return {
		kind: r.kind,
		mediaId: r.mediaId,
		rate: { num: r.rate.num, den: r.rate.den },
		base: r.base,
		span: [r.span[0], r.span[1]],
		strokes: r.strokes.map((s) => ({
			kind: s.kind,
			frame: s.frame,
			radius: s.radius,
			points: s.points.map((p) => [p[0], p[1]]),
		})),
		boxes: (r.boxes ?? []).map((b) => ({ frame: b.frame, rect: [...b.rect] })),
		settings: rotoSettingsOf(r),
	};
}

export function rotoInputsHash(r: ClipRoto): string {
	return fnv64(canonical(rotoInputs(r)));
}

/** The computed mattes no longer match the roto (strokes, span or settings changed since). */
export function rotoIsStale(r: ClipRoto): boolean {
	return !!r.result && r.result.inputs !== rotoInputsHash(r);
}

/** Whether the roto has something to segment from (a selecting stroke or a box; faces need nothing). */
export function rotoHasPrompt(r: Pick<ClipRoto, 'kind' | 'strokes' | 'boxes'>): boolean {
	return r.kind === 'faces' || r.strokes.some((s) => s.kind === 'fg') || (r.boxes?.length ?? 0) > 0;
}

export type RotoLocation = { sequenceId: string; clipId: string; roto: ClipRoto };

/** Finds a roto object anywhere in the document. */
export function findRoto(doc: ProjectDocument, rotoId: string): RotoLocation | null {
	for (const seq of Object.values(doc.sequences))
		for (const clip of Object.values(seq.clips)) {
			const r = (clip as { rotos?: ClipRoto[] }).rotos?.find((x) => x.id === rotoId);
			if (r) return { sequenceId: seq.id, clipId: clip.id, roto: r };
		}
	return null;
}

/** Media frame containing a content time (flicks) at `rate`. */
export function mediaFrameAt(contentFlicks: number, rate: Rational): number {
	return Math.max(0, Math.floor(contentFlicks / flicksPerFrame(rate) + 1e-6));
}

/** Content time (flicks) of the start of a media frame. */
export function mediaFrameFlicks(frame: number, rate: Rational): number {
	return Math.round(frame * flicksPerFrame(rate));
}

/** Frame rate used for a medium's frames (video: its nominal rate; stills: 1 frame). */
export function rotoRateOf(
	asset: Pick<MediaAsset, 'probe' | 'kind'> | null | undefined,
	fallback: Rational,
): Rational {
	const vs = asset?.probe.streams.find((s) => s.type === 'video');
	if (asset?.kind === 'video' && vs && vs.type === 'video' && vs.frameRate.num > 0)
		return { num: vs.frameRate.num, den: vs.frameRate.den };
	return { num: fallback.num, den: fallback.den };
}

/** Number of media frames (null when unknown); stills have one. */
export function rotoFrameCount(
	asset: Pick<MediaAsset, 'probe' | 'kind'> | null | undefined,
	rate: Rational,
): number | null {
	if (!asset) return null;
	if (asset.kind === 'image') return 1;
	const d = asset.probe.durationFlicks;
	if (!d || d <= 0) return null;
	return Math.max(1, Math.round(d / flicksPerFrame(rate) - 1e-3));
}

/** Inclusive media frames a clip shows (its content span), clamped to the media. */
export function clipMediaFrames(
	clip: { sourceIn: number; duration: number; speed: { rate: number } },
	seqRate: Rational,
	rate: Rational,
	frameCount: number | null,
): [number, number] {
	const span = clip.duration * flicksPerFrame(seqRate) * clip.speed.rate;
	const step = flicksPerFrame(rate);
	const first = Math.max(0, Math.floor(clip.sourceIn / step + 1e-6));
	let last = Math.max(first, Math.ceil((clip.sourceIn + span) / step - 1e-6) - 1);
	if (frameCount !== null) last = Math.min(last, frameCount - 1);
	return [Math.min(first, last), last];
}

/** The render reference of a roto's computed mattes (snapshot `RenderVisualClip.rotos`). */
export type RenderRotoMatte = {
	/** Matte store key. */
	key: string;
	/**
	 * URL of the store: frame f's matte (8-bit grey PNG) is `url` + `&n=<f>` (`?n=` when the URL has no query).
	 * Default `/roto/<key>` (same-origin engine path); engine renders sign it for the headless browser.
	 */
	url: string;
	start: number;
	end: number;
	rate: Rational;
	width: number;
	height: number;
	/** The roto changed since these mattes were computed. */
	stale: boolean;
};

/** Engine path of a matte store (signable, like `/media/…`). */
export function rotoStorePath(key: string): string {
	return `/mg/roto/${encodeURIComponent(key)}`;
}

/** URL of one frame's matte. */
export function rotoFrameUrl(m: Pick<RenderRotoMatte, 'url'>, frame: number): string {
	return `${m.url}${m.url.includes('?') ? '&' : '?'}n=${frame}`;
}

/**
 * Resets roto-object params of an effect instance that name a roto the clip does not have (effects pasted or
 * applied from presets onto another clip): such an effect then has no object ("none"). Mutates `fx`.
 */
export function dropForeignRotoRefs(
	clip: { rotos?: readonly { id: string }[] },
	fx: { effectId: string; params: Record<string, { value: unknown; keyframes: unknown[] }> },
): void {
	const ids = new Set((clip.rotos ?? []).map((r) => r.id));
	for (const name of ROTO_OBJECT_PARAMS[fx.effectId] ?? []) {
		const a = fx.params[name];
		if (a && typeof a.value === 'string' && a.value !== '' && !ids.has(a.value)) {
			a.value = '';
			a.keyframes = [];
		}
	}
}

type MutableRoto = {
	mediaId: string;
	rate: Rational;
	base: number | null;
	span: [number, number];
	strokes: { frame: number; radius: number; points: [number, number][] }[];
	boxes?: { frame: number; rect: [number, number, number, number] }[];
	result: unknown;
};

/**
 * Moves roto objects with their clip's source (in place, plain objects or Immer drafts): `shiftFlicks` moves every
 * frame in content time (`shiftClipContentTime`), `to` re-targets them to another media (its id, frame rate and the
 * pixel scale of a different size). The computed mattes belong to the old frames / pixels and are dropped (the roto
 * needs a new propagation); frames that fall before the media start are clamped to 0.
 */
export function retargetRotos(
	rotos: MutableRoto[] | undefined,
	opts: { shiftFlicks?: number; to?: { mediaId: string; rate: Rational; scaleX: number; scaleY: number } },
): void {
	if (!rotos?.length) return;
	const shift = opts.shiftFlicks ?? 0;
	if (shift === 0 && !opts.to) return;
	for (const r of rotos) {
		const from = r.rate;
		const rate = opts.to?.rate ?? from;
		const map = (f: number) => mediaFrameAt(mediaFrameFlicks(f, from) + shift, rate);
		r.base = r.base === null ? null : map(r.base);
		r.span = [map(r.span[0]), map(r.span[1])];
		const sx = opts.to?.scaleX ?? 1;
		const sy = opts.to?.scaleY ?? 1;
		for (const s of r.strokes) {
			s.frame = map(s.frame);
			if (sx !== 1 || sy !== 1) {
				s.points = s.points.map(([x, y]) => [x * sx, y * sy]);
				s.radius *= Math.sqrt(sx * sy);
			}
		}
		for (const b of r.boxes ?? []) {
			b.frame = map(b.frame);
			if (sx !== 1 || sy !== 1) b.rect = [b.rect[0] * sx, b.rect[1] * sy, b.rect[2] * sx, b.rect[3] * sy];
		}
		if (opts.to) {
			r.mediaId = opts.to.mediaId;
			r.rate = { num: rate.num, den: rate.den };
		}
		r.result = null;
	}
}
