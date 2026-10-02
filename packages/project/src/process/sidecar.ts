// Source-range sidecars (S07:PRC-019): a JSON file next to a rendered video that says which source frames it
// holds. Parsed the same way by the engine (files registered by path) and the web client (a .json picked
// together with an uploaded video), then stored as `MediaAsset.sourceRange` (origin `sidecar`).
//
// Accepted shapes (all keys optional except the first frame):
//   { "first_src_frame": 174, "frames": 130, "handles": [0, 8], "source": "crudo.mp4", "fps": "30/1" }
//   - `firstFrame` may stand for `first_src_frame`; `handles` may be `{pre, post}`;
//   - the source name may also come from `spec.src` (the trailer grade pipeline), the rate from
//     `probe.r_frame_rate`;
//   - jasper-proc's own sidecar (`<output>.json`: `name: "jasper-proc"`, `input.range: [start, end]`,
//     `input.fps`, `output.frames`).
// Sidecar names looked up next to `<dir>/<stem>.<ext>`: `<stem>.<ext>.json`, then `<stem>.json`.
import type { MediaAsset, SourceRange } from '../schema/media.ts';
import type { Rational } from '../time.ts';
import { mediaFrameRate } from '../tracking/request.ts';
import { mediaFrameCount } from './source-range.ts';

export type SourceSidecarInfo = {
	/** File name of the sidecar. */
	sidecar: string;
	sourceName: string | null;
	firstFrame: number;
	frames: number | null;
	frameRate: Rational | null;
	/** Frames before / after the shot the render was made for, when the sidecar says so (informational). */
	handles: [number, number] | null;
};

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const nonNeg = (v: unknown): number | null =>
	typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
const pos = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** `30`, `"30/1"`, `"30000/1001"`, `29.97` → a rational; null for anything else. */
export function parseRate(v: unknown): Rational | null {
	if (typeof v === 'number' && v > 0 && Number.isFinite(v)) {
		if (Number.isInteger(v)) return { num: v, den: 1 };
		for (const den of [1001, 100, 1000]) {
			const num = Math.round(v * den);
			if (Math.abs(num / den - v) < 1e-6) return den === 1001 ? { num, den } : reduce(num, den);
		}
		return null;
	}
	if (typeof v === 'string') {
		const m = /^\s*(\d+)\s*(?:\/\s*(\d+))?\s*$/.exec(v);
		if (m) {
			const num = Number(m[1]);
			const den = m[2] ? Number(m[2]) : 1;
			return num > 0 && den > 0 ? { num, den } : null;
		}
		const f = Number(v);
		return Number.isFinite(f) ? parseRate(f) : null;
	}
	return null;
}

function reduce(num: number, den: number): Rational {
	const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
	const d = g(num, den);
	return { num: num / d, den: den / d };
}

function parseHandles(v: unknown): [number, number] | null {
	if (Array.isArray(v) && v.length === 2) {
		const a = nonNeg(v[0]);
		const b = nonNeg(v[1]);
		return a !== null && b !== null ? [a, b] : null;
	}
	if (isRec(v)) {
		const a = nonNeg(v.pre);
		const b = nonNeg(v.post);
		return a !== null && b !== null ? [a, b] : null;
	}
	return null;
}

/** Reads a source-range sidecar; null when the JSON does not describe a source range. */
export function parseSourceSidecar(json: unknown, sidecarName = 'sidecar.json'): SourceSidecarInfo | null {
	if (!isRec(json)) return null;
	// jasper-proc (S07:PRC-013)
	if (json.name === 'jasper-proc' && isRec(json.input)) {
		const input = json.input;
		const range = Array.isArray(input.range) ? input.range : null;
		const first = range ? nonNeg(range[0]) : null;
		if (first === null) return null;
		const end = range ? pos(range[1]) : null;
		const out = isRec(json.output) ? pos(json.output.frames) : null;
		const path = str(input.path);
		return {
			sidecar: baseName(sidecarName),
			sourceName: path ? baseName(path) : null,
			firstFrame: first,
			frames: out ?? (end !== null && end > first ? end - first : null),
			frameRate: parseRate(input.fps),
			handles: null,
		};
	}
	const first = nonNeg(json.first_src_frame) ?? nonNeg(json.firstFrame);
	if (first === null) return null;
	const spec = isRec(json.spec) ? json.spec : {};
	const probe = isRec(json.probe) ? json.probe : {};
	const source = str(json.source) ?? str(json.src) ?? str(spec.src);
	return {
		sidecar: baseName(sidecarName),
		sourceName: source ? baseName(source) : null,
		firstFrame: first,
		frames: pos(json.frames),
		frameRate: parseRate(json.fps) ?? parseRate(json.frameRate) ?? parseRate(probe.r_frame_rate),
		handles: parseHandles(json.handles) ?? parseHandles(spec.handles),
	};
}

/** Sidecar file names to look for next to a video file, in order. */
export function sidecarCandidates(videoFileName: string): string[] {
	const name = baseName(videoFileName);
	const dot = name.lastIndexOf('.');
	const stem = dot > 0 ? name.slice(0, dot) : name;
	return [`${name}.json`, `${stem}.json`];
}

/**
 * The `sourceRange` a sidecar gives a media asset: the source is resolved by file name among the project's
 * media (case-insensitive, unique match; never the asset itself or a media with its fingerprint — the same
 * bytes), the rate and frame count default to the file's own.
 */
export function sourceRangeFromSidecar(
	doc: { media: Record<string, Pick<MediaAsset, 'id' | 'originalName'> & { fingerprint?: string }> },
	info: SourceSidecarInfo,
	asset: Pick<MediaAsset, 'probe'> & { id?: string; fingerprint?: string },
): SourceRange | null {
	const rate = info.frameRate ?? mediaFrameRate(asset);
	const frames = info.frames ?? mediaFrameCount(asset);
	if (!rate || !frames) return null;
	let mediaId: string | null = null;
	if (info.sourceName) {
		const want = info.sourceName.toLowerCase();
		const hits = Object.values(doc.media).filter(
			(m) =>
				m.id !== asset.id &&
				!(asset.fingerprint && m.fingerprint === asset.fingerprint) &&
				baseName(m.originalName).toLowerCase() === want,
		);
		if (hits.length === 1) mediaId = hits[0]!.id;
	}
	return {
		mediaId,
		sourceName: info.sourceName,
		firstFrame: info.firstFrame,
		frames,
		frameRate: rate,
		origin: 'sidecar',
	};
}
