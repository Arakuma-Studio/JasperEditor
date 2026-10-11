// An export whose codec matches its sources stream-copies untouched source stretches and re-encodes only around
// edits, effects and transitions.
//
// - Copyable stretches come from `copyableRuns` (@jasper/project): one untouched video clip at the sequence's size
//   and rate is all that is drawn.
// - GOP-aware: only whole *closed* GOPs are copied (a keyframe whose GOP shows nothing earlier than it — no leading
//   pictures referencing the previous GOP); the frames before the first such GOP and after the last one are rendered.
//   ProRes (and any all-intra source) copies frame-exact ranges.
// - Seamless: H.264 / HEVC pieces are joined as one Annex B stream with in-band parameter sets at every IDR and muxed
//   as `avc3` / `hev1` (ISO/IEC 14496-15: parameter sets may change in the stream), so copied GOPs keep the source's
//   SPS/PPS and re-encoded GOPs carry the export encoder's; ProRes pieces join in one MOV track.
// The planner says why a sequence is not smart-rendered (`plan.smart.reasons`).
import type { ExportSettings } from '@jasper/api';
import type { CopyableRun } from '@jasper/project';
import type { Ffmpeg } from '../tools/ffmpeg.ts';

/** Export codecs that can copy their sources (the LGPL build has no HEVC export encoder: HEVC sources re-encode). */
export type SmartCodec = 'h264' | 'prores';

/** The frames of a source's first video stream in presentation order, with the closed-GOP starts. */
export type SourceFrames = {
	codec: string;
	profile: string | null;
	pixFmt: string | null;
	width: number;
	height: number;
	/** Seconds of each presented frame (presentation order). */
	times: number[];
	/** Presentation indexes where a closed GOP starts (copying may start there). */
	gopStarts: number[];
	/** Every frame is a keyframe (ProRes, intra-only streams). */
	allIntra: boolean;
};

type Packet = { pts: number; dts: number; key: boolean };

/** Closed-GOP starts and presentation times from packets in decode order (pure, tested). */
export function analysePackets(
	packets: readonly Packet[],
	timeBase: number,
): Omit<SourceFrames, 'codec' | 'profile' | 'pixFmt' | 'width' | 'height'> {
	const order = packets.map((p, i) => ({ ...p, i })).sort((a, b) => a.pts - b.pts);
	const presIndex = new Map<number, number>();
	for (const [k, p] of order.entries()) presIndex.set(p.i, k);
	const gopStarts: number[] = [];
	const keys = packets.map((p, i) => (p.key ? i : -1)).filter((i) => i >= 0);
	for (let g = 0; g < keys.length; g++) {
		const from = keys[g]!;
		const to = g + 1 < keys.length ? keys[g + 1]! : packets.length;
		const kpts = packets[from]!.pts;
		let closed = true;
		for (let i = from + 1; i < to; i++)
			if (packets[i]!.pts < kpts) {
				closed = false;
				break;
			}
		// The GOP must also be the frames presented next (its keyframe starts a presentation run).
		if (closed) gopStarts.push(presIndex.get(from)!);
	}
	gopStarts.sort((a, b) => a - b);
	return {
		times: order.map((p) => p.pts * timeBase),
		gopStarts,
		allIntra: packets.length > 0 && packets.every((p) => p.key),
	};
}

const cache = new Map<string, Promise<SourceFrames>>();

/** Probes (cached per file and size/mtime key) the frames and GOP structure of a source. */
export function probeSourceFrames(
	ff: Ffmpeg,
	path: string,
	key: string,
	signal?: AbortSignal,
): Promise<SourceFrames> {
	const id = `${path}|${key}`;
	let hit = cache.get(id);
	if (!hit) {
		hit = (async () => {
			const s = await ff.probeJson(
				[
					'-select_streams',
					'v:0',
					'-show_entries',
					'stream=codec_name,profile,pix_fmt,width,height,time_base',
					'-show_packets',
					'-show_entries',
					'packet=pts,dts,flags',
					path,
				],
				signal ? { signal } : {},
			);
			const st = (s.streams as Record<string, unknown>[] | undefined)?.[0] ?? {};
			const [num, den] = String(st.time_base ?? '1/1')
				.split('/')
				.map(Number);
			const tb = (num ?? 1) / (den || 1);
			const packets: Packet[] = ((s.packets as Record<string, unknown>[] | undefined) ?? [])
				.map((p) => ({
					pts: Number(p.pts),
					dts: Number(p.dts ?? p.pts),
					key: String(p.flags ?? '').includes('K'),
				}))
				.filter((p) => Number.isFinite(p.pts));
			return {
				codec: String(st.codec_name ?? ''),
				profile: typeof st.profile === 'string' ? st.profile : null,
				pixFmt: typeof st.pix_fmt === 'string' ? st.pix_fmt : null,
				width: Number(st.width ?? 0),
				height: Number(st.height ?? 0),
				...analysePackets(packets, tb),
			};
		})();
		hit.catch(() => cache.delete(id));
		cache.set(id, hit);
		if (cache.size > 64) cache.delete(cache.keys().next().value!);
	}
	return hit;
}

export type SmartPiece =
	| { kind: 'copy'; start: number; end: number; mediaId: string; sourceFrame: number }
	| { kind: 'render'; start: number; end: number };

/**
 * Splits `range` into copied and rendered pieces: each copyable run copies the whole closed GOPs inside it (all
 * frames when the source is intra-only) and renders the frames around them. Pure (tested).
 */
export function smartPieces(
	range: { start: number; end: number },
	runs: readonly CopyableRun[],
	frames: (mediaId: string) => SourceFrames | undefined,
): SmartPiece[] {
	const out: SmartPiece[] = [];
	const render = (a: number, b: number) => {
		if (b <= a) return;
		const last = out[out.length - 1];
		if (last?.kind === 'render' && last.end === a) last.end = b;
		else out.push({ kind: 'render', start: a, end: b });
	};
	let at = range.start;
	for (const r of [...runs].sort((x, y) => x.start - y.start)) {
		const a = Math.max(r.start, range.start);
		const b = Math.min(r.end, range.end);
		if (b <= a || a < at) continue;
		const src = frames(r.mediaId);
		const s0 = r.sourceFrame + (a - r.start);
		const s1 = s0 + (b - a);
		if (!src || s1 > src.times.length) {
			render(at, b);
			at = b;
			continue;
		}
		let c0: number;
		let c1: number;
		if (src.allIntra) {
			c0 = s0;
			c1 = s1;
		} else {
			// The first closed GOP at or after s0, and the last GOP boundary at or before s1.
			const starts = src.gopStarts;
			const first = starts.find((g) => g >= s0);
			let end = -1;
			for (let k = 0; k < starts.length; k++) {
				const g = starts[k]!;
				if (g < (first ?? Number.POSITIVE_INFINITY)) continue;
				const next = k + 1 < starts.length ? starts[k + 1]! : src.times.length;
				// Only whole GOPs, and the boundary after them must itself be a closed GOP start or the stream end.
				if (next <= s1) end = next;
				else break;
			}
			if (first === undefined || end <= first) {
				render(at, b);
				at = b;
				continue;
			}
			c0 = first;
			c1 = end;
		}
		render(at, a + (c0 - s0));
		out.push({ kind: 'copy', start: a + (c0 - s0), end: a + (c1 - s0), mediaId: r.mediaId, sourceFrame: c0 });
		at = a + (c1 - s0);
		render(at, b);
		at = b;
	}
	render(at, range.end);
	return out;
}

/** The codec family of an export's settings, or null (smart rendering needs H.264 or ProRes). */
export function smartCodecOf(settings: ExportSettings): SmartCodec | null {
	const c = settings.video?.codec;
	return c === 'h264' || c === 'prores' ? c : null;
}

/** ffprobe codec names per family. */
export const SOURCE_CODECS: Record<SmartCodec, string> = { h264: 'h264', prores: 'prores' };

/** ProRes profile names (ffprobe) per export profile. */
export function proresProfileMatches(
	exportProfile: 'hq' | '4444' | undefined,
	sourceProfile: string | null,
): boolean {
	const p = (sourceProfile ?? '').toLowerCase();
	return (exportProfile ?? 'hq') === '4444' ? p.includes('4444') && !p.includes('xq') : p === 'hq';
}
