// Parallel picture segments of a native / hybrid export (docs/wp-notes/export-performance.md). One ffmpeg filter graph
// runs its overlays one frame at a time on few threads, and every frame passes every overlay of the range (`enable=`
// skips drawing, not the traversal): a 15 min sequence with ≈ 2,000 layers encoded at ≈ 73 fps with more than half the
// CPU idle (measured on the user's PC, see the note). The range is split into frame-exact segments, each built as an
// export of its own sub-range (`buildNativeGraph` with `snapshot.range` = the segment: only the layers it shows, each
// started mid-layer exactly as a range export starts), encoded concurrently and joined by stream copy (concat
// demuxer: timestamps continue from each segment's duration; every segment starts with a key frame).
import type { RenderSnapshot } from '@jasper/project';
import type { OutputSpec } from './planner.ts';

/** How segments are chosen (environment, read per export). */
export type SegmentPolicy = {
	/** `auto` (default): from the job's CPU slots and the encoder; a number: that many (≥ 1); 1 = one graph. */
	count: 'auto' | number;
	/** Shortest segment, seconds of output (default 20): shorter exports keep one graph. */
	minSec: number;
	/**
	 * Concurrent sessions of a hardware encoder (default 4). Consumer NVIDIA drivers allow a fixed number of NVENC
	 * sessions per system (3 before 2023, 5 from driver 530, 8 from driver 551; see the note): 4 leaves sessions to
	 * other applications and jobs.
	 */
	hwSessions: number;
	/** CPU slots per segment in `auto` (default 3): composite thread + encoder / kernel streams. */
	slotsPerSegment: number;
	/** Most segments of a range (default 64): more, shorter segments when the graphs would not fit in memory. */
	maxSegments: number;
	/** Shortest segment cut for memory, seconds (default 2). */
	memoryMinSec: number;
};

const num = (v: string | undefined, d: number, min: number) => {
	const n = Number(v);
	return v !== undefined && v !== '' && Number.isFinite(n) && n >= min ? n : d;
};

export function segmentPolicyFromEnv(env: Record<string, string | undefined> = process.env): SegmentPolicy {
	const c = env.JASPER_EXPORT_SEGMENTS;
	return {
		count: c === undefined || c === '' || c === 'auto' ? 'auto' : Math.floor(num(c, 1, 1)),
		minSec: num(env.JASPER_EXPORT_SEGMENT_MIN_SEC, 20, 0),
		hwSessions: Math.floor(num(env.JASPER_EXPORT_HW_SESSIONS, 4, 1)),
		slotsPerSegment: num(env.JASPER_EXPORT_SEGMENT_SLOTS, 3, 1),
		maxSegments: Math.floor(num(env.JASPER_EXPORT_MAX_SEGMENTS, 64, 1)),
		memoryMinSec: num(env.JASPER_EXPORT_SEGMENT_MEMORY_MIN_SEC, 2, 0),
	};
}

/** At most this many segments render at once whatever the policy says (processes, open inputs). */
export const MAX_SEGMENTS = 16;

/** Encoders whose separately encoded segments join by stream copy (same parameter sets; each starts with a key frame). */
const JOINABLE =
	/^(libx264|libopenh264|h264_(nvenc|qsv|vaapi|amf|videotoolbox)|hevc_(nvenc|qsv|vaapi|amf|videotoolbox)|libkvazaar|prores_ks)$/;

export type PictureSegment = { start: number; end: number };
export type SegmentPlan = {
	segments: PictureSegment[];
	/** Segments rendered at once (the others wait for a free place). */
	concurrency: number;
	/** Estimated peak memory of `concurrency` segments running at once (bytes; 0 without an estimate). */
	peakBytes: number;
	/** Why the range was not split, or why fewer segments run at once than the CPU would allow. */
	reason?: string;
	/**
	 * Even the least memory-hungry plan (the most, shortest segments, one at a time) would not fit the budget: the
	 * native composite cannot run (a plan blocker, never an out-of-memory kill).
	 */
	blocker?: string;
};

/** The memory side of a segment plan: the budget, and one graph's estimate over a range with its CPU threads. */
export type SegmentMemory = {
	budget: number;
	estimate(range: PictureSegment, threads: number): number;
};

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;

/**
 * The segments of the export range and how many render at once. Speed: `count` near-equal parts (auto: from the CPU
 * slots, the 20 s minimum and the hardware encoder's sessions), inner boundaries on the nearest cut of the lowest video
 * track within a quarter segment. Memory (`memory`): the segments running at once must fit the budget, so the range is
 * cut into more, shorter segments (down to `memoryMinSec`, at most `maxSegments`) that run `concurrency` at a time,
 * fewer at once when even the shortest do not fit; a blocker when one shortest segment alone does not fit. One
 * segment, with the reason, when splitting is off, would not pay or cannot join exactly.
 */
export function planPictureSegments(o: {
	snapshot: RenderSnapshot;
	output: OutputSpec;
	slots: number;
	policy: SegmentPolicy;
	memory?: SegmentMemory;
}): SegmentPlan {
	const { snapshot: snap, output, policy, memory } = o;
	const R0 = snap.range.start;
	const R1 = snap.range.end;
	const frames = R1 - R0;
	const whole = [{ start: R0, end: R1 }];
	const slots = Math.max(1, o.slots);
	/** Peak bytes of `k` of these segments at once (each graph with its share of the CPU). */
	const peak = (segs: readonly PictureSegment[], k: number) =>
		memory ? k * Math.max(...segs.map((sg) => memory.estimate(sg, Math.max(1, Math.floor(slots / k))))) : 0;
	const tooBig = (bytes: number, what: string) =>
		`the native composite needs ≈ ${gb(bytes)} of memory ${what}, more than the ${gb(memory!.budget)} this machine has available now (rendered by the Remotion path)`;
	const one = (reason: string): SegmentPlan => {
		const bytes = peak(whole, 1);
		return {
			segments: whole,
			concurrency: 1,
			peakBytes: bytes,
			reason,
			...(memory && bytes > memory.budget ? { blocker: tooBig(bytes, 'in one graph') } : {}),
		};
	};
	if (policy.count === 1) return one('segments are off (JASPER_EXPORT_SEGMENTS=1)');
	const enc = output.encoder;
	if (!enc || !JOINABLE.test(enc.encoder))
		return one(`${enc?.encoder ?? 'no encoder'} segments are not joined`);
	if (output.alpha) return one('alpha masters render in one piece');
	const fps = snap.settings.fps;
	if (output.fps.num * fps.den !== fps.num * output.fps.den)
		return one('the output rate differs from the sequence');
	if (output.frames !== frames) return one('the output frame count differs from the range');
	const fpsN = fps.num / fps.den;
	const byLength = Math.floor(frames / Math.max(1, Math.ceil(policy.minSec * fpsN)));
	let k0: number;
	if (policy.count === 'auto') {
		const bySlots = Math.floor(slots / policy.slotsPerSegment);
		k0 = Math.min(byLength, bySlots, enc.hardware ? policy.hwSessions : MAX_SEGMENTS);
	} else k0 = Math.min(policy.count, byLength);
	k0 = Math.max(1, Math.min(MAX_SEGMENTS, k0));
	const speedReason =
		k0 < 2
			? byLength < 2
				? `shorter than two segments of ${policy.minSec} s`
				: 'not enough CPU slots'
			: undefined;
	const maxS = Math.max(
		k0,
		Math.min(policy.maxSegments, Math.floor(frames / Math.max(1, Math.ceil(policy.memoryMinSec * fpsN)))),
	);
	let best: SegmentPlan | null = null;
	for (let n = k0; ; ) {
		const segs = n === 1 ? whole : split(snap, n);
		for (let k = Math.min(k0, n); k >= 1; k--) {
			const bytes = peak(segs, k);
			if (memory && bytes > memory.budget) continue;
			const full = k === Math.min(k0, n);
			const plan: SegmentPlan = {
				segments: segs,
				concurrency: k,
				peakBytes: bytes,
				...(n === 1 && speedReason
					? { reason: speedReason }
					: !full
						? { reason: `${k} at a time to stay within ${gb(memory!.budget)} of memory` }
						: {}),
			};
			if (full) return plan;
			if (!best || k > best.concurrency) best = plan;
			break;
		}
		if (n >= maxS) break;
		n = Math.min(maxS, Math.max(n + 1, Math.ceil(n * 1.25)));
	}
	if (best) return best;
	const segs = maxS === 1 ? whole : split(snap, maxS);
	return {
		segments: segs,
		concurrency: 1,
		peakBytes: peak(segs, 1),
		reason: 'over the memory budget',
		blocker: tooBig(
			peak(segs, 1),
			`even in ${segs.length} segment${segs.length === 1 ? '' : 's'} rendered one at a time`,
		),
	};
}

/** `n` segments of the range, inner boundaries on lowest-track cuts within a quarter segment. */
function split(snap: RenderSnapshot, n: number): PictureSegment[] {
	const R0 = snap.range.start;
	const R1 = snap.range.end;
	const frames = R1 - R0;
	// cuts on the lowest video track (clip starts and ends inside the range)
	const cuts = new Set<number>();
	for (const c of snap.videoTracks[0]?.clips ?? []) {
		for (const f of [c.start, c.start + c.duration]) if (f > R0 && f < R1) cuts.add(f);
	}
	const sorted = [...cuts].sort((a, b) => a - b);
	const len = frames / n;
	const bounds: number[] = [R0];
	for (let i = 1; i < n; i++) {
		const ideal = Math.round(R0 + i * len);
		let best = ideal;
		let dist = len / 4;
		for (const c of sorted) {
			const d = Math.abs(c - ideal);
			if (d <= dist) {
				dist = d;
				best = c;
			}
		}
		// strictly increasing, every segment at least one frame
		bounds.push(Math.min(R1 - (n - i), Math.max(bounds[i - 1]! + 1, best)));
	}
	bounds.push(R1);
	const segments: PictureSegment[] = [];
	for (let i = 0; i < n; i++) segments.push({ start: bounds[i]!, end: bounds[i + 1]! });
	return segments;
}
