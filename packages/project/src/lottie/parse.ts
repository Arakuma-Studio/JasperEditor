// Lottie documents (imports workstream, docs/wp-notes/imports.md): validation of untrusted Lottie JSON, the header
// the editor stores (`LottieInfo`) and the list of what the player may draw differently from After Effects.
// Implemented from the Lottie format documentation (lottie-spec 1.0 schema, LottieFiles "lottie-docs"); pure.
import type { LottieInfo } from '../schema/media.ts';

export class LottieParseError extends Error {
	readonly code = 'INVALID_LOTTIE';
	constructor(message: string) {
		super(message);
		this.name = 'LottieParseError';
	}
}

/** Bounds on hostile input. */
export const LOTTIE_LIMITS = {
	maxBytes: 64 * 1024 * 1024,
	maxSize: 16384,
	maxSeconds: 24 * 3600,
	maxLayers: 100_000,
	maxDepth: 64,
} as const;

export type LottieDoc = Record<string, unknown> & {
	v?: string;
	fr: number;
	ip: number;
	op: number;
	w: number;
	h: number;
	nm?: string;
	layers: unknown[];
	assets?: unknown[];
};

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** True when a parsed JSON value looks like a Lottie animation (the required top-level keys). */
export function isLottieDocument(v: unknown): v is LottieDoc {
	if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
	const o = v as Record<string, unknown>;
	return num(o.fr) && num(o.ip) && num(o.op) && num(o.w) && num(o.h) && Array.isArray(o.layers);
}

/** Parses and validates a Lottie document (text or value). Throws `LottieParseError` with a reason. */
export function parseLottie(input: string | unknown): LottieDoc {
	let v: unknown = input;
	if (typeof input === 'string') {
		if (input.length > LOTTIE_LIMITS.maxBytes) throw new LottieParseError('The animation is too large');
		try {
			v = JSON.parse(input);
		} catch (e) {
			throw new LottieParseError(`Not JSON: ${(e as Error).message.slice(0, 200)}`);
		}
	}
	if (!isLottieDocument(v))
		throw new LottieParseError('Not a Lottie animation (needs fr, ip, op, w, h and layers)');
	const d = v;
	if (!(d.fr > 0 && d.fr <= 1000)) throw new LottieParseError(`Invalid frame rate ${d.fr}`);
	if (!(d.op > d.ip)) throw new LottieParseError('The out point must be after the in point');
	if ((d.op - d.ip) / d.fr > LOTTIE_LIMITS.maxSeconds) throw new LottieParseError('The animation is too long');
	if (!(d.w >= 1 && d.h >= 1 && d.w <= LOTTIE_LIMITS.maxSize && d.h <= LOTTIE_LIMITS.maxSize))
		throw new LottieParseError(`Invalid size ${d.w}×${d.h}`);
	if (d.layers.length > LOTTIE_LIMITS.maxLayers) throw new LottieParseError('Too many layers');
	if (d.assets !== undefined && !Array.isArray(d.assets)) throw new LottieParseError('assets must be a list');
	return d;
}

/** Image assets of a document (`assets[]` entries with `p`, not precomps). */
export function lottieImageAssets(
	d: LottieDoc,
): { index: number; id: string; dir: string; file: string; embedded: boolean }[] {
	const out: { index: number; id: string; dir: string; file: string; embedded: boolean }[] = [];
	(d.assets ?? []).forEach((a, index) => {
		if (!a || typeof a !== 'object') return;
		const o = a as Record<string, unknown>;
		if (Array.isArray(o.layers) || typeof o.p !== 'string') return;
		const file = o.p;
		out.push({
			index,
			id: typeof o.id === 'string' ? o.id : String(index),
			dir: typeof o.u === 'string' ? o.u : '',
			file,
			embedded: o.e === 1 || file.startsWith('data:'),
		});
	});
	return out;
}

/**
 * What the Lottie player (lottie-web, SVG renderer) may draw differently from After Effects, found by walking the
 * document (bounded depth): expressions, text needing fonts, 3D layers, merge paths, layer styles, effects it does not
 * implement, external images.
 */
export function lottieWarnings(d: LottieDoc): string[] {
	const found = new Set<string>();
	const fonts = new Set<string>();
	const walk = (v: unknown, depth: number, key: string | null) => {
		if (depth > LOTTIE_LIMITS.maxDepth || !v || typeof v !== 'object') return;
		if (Array.isArray(v)) {
			for (const x of v) walk(x, depth + 1, key);
			return;
		}
		const o = v as Record<string, unknown>;
		if (typeof o.x === 'string' && ('k' in o || 'a' in o)) found.add('expressions');
		if (o.ddd === 1 && key === 'layers') found.add('3d');
		if (o.ty === 'mm') found.add('merge-paths');
		if (Array.isArray(o.sy) && o.sy.length > 0) found.add('layer-styles');
		if (key === 'layers' && o.ty === 5) found.add('text');
		if (key === 'layers' && o.ty === 13) found.add('camera');
		if (key === 'layers' && Array.isArray(o.ef) && o.ef.length > 0) found.add('effects');
		for (const [k, x] of Object.entries(o)) walk(x, depth + 1, k);
	};
	walk(d.layers, 0, 'layers');
	for (const a of d.assets ?? []) {
		const o = a as Record<string, unknown> | null;
		if (o && Array.isArray(o.layers)) walk(o.layers, 1, 'layers');
	}
	const list = (d.fonts as { list?: unknown[] } | undefined)?.list;
	if (Array.isArray(list))
		for (const f of list) {
			const o = f as Record<string, unknown> | null;
			if (o && typeof o.fFamily === 'string') fonts.add(o.fFamily);
		}
	const hasChars = Array.isArray(d.chars) && d.chars.length > 0;
	const out: string[] = [];
	if (found.has('expressions'))
		out.push('Uses expressions: the Lottie player evaluates them (random-based ones such as wiggle may differ).');
	if (found.has('text') && !hasChars)
		out.push(
			`Text layers are drawn with the fonts ${[...fonts].join(', ') || 'they name'}; fonts that are not installed fall back.`,
		);
	if (found.has('3d') || found.has('camera')) out.push('3D layers and cameras are drawn flat by the Lottie player.');
	if (found.has('merge-paths')) out.push('Merge Paths are not drawn by the Lottie player.');
	if (found.has('layer-styles')) out.push('Layer styles are not drawn by the Lottie player.');
	if (found.has('effects')) out.push('Layer effects other than the few the Lottie player implements are ignored.');
	return out;
}

/** The header the editor stores for a Lottie document. */
export function lottieInfo(d: LottieDoc, extra: { warnings?: string[]; dotLottie?: LottieInfo['dotLottie'] } = {}): LottieInfo {
	const warnings = [...lottieWarnings(d), ...(extra.warnings ?? [])];
	return {
		fps: d.fr,
		inFrame: d.ip,
		outFrame: d.op,
		width: Math.round(d.w),
		height: Math.round(d.h),
		...(typeof d.v === 'string' ? { version: d.v.slice(0, 32) } : {}),
		...(typeof d.nm === 'string' && d.nm ? { name: d.nm.slice(0, 256) } : {}),
		layers: d.layers.length,
		...(extra.dotLottie ? { dotLottie: extra.dotLottie } : {}),
		...(warnings.length ? { warnings } : {}),
	};
}

/**
 * The Lottie frame (absolute, `ip` based) shown at `seconds` of file time: Frame Sampling like footage — the last
 * whole Lottie frame at or before that time, clamped to [ip, op − 1]. (`seconds` is file time: an assumed frame rate
 * or a loop was applied by `fileTimeOf` before.)
 */
export function lottieFrameAt(info: Pick<LottieInfo, 'fps' | 'inFrame' | 'outFrame'>, seconds: number): number {
	const f = Math.floor(seconds * info.fps + 1e-6);
	const last = Math.max(0, Math.ceil(info.outFrame - info.inFrame) - 1);
	return info.inFrame + Math.max(0, Math.min(last, Number.isFinite(f) ? f : 0));
}
