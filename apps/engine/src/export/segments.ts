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
	};
}

/** At most this many segments whatever the policy says (processes, open inputs, memory). */
export const MAX_SEGMENTS = 16;

/** Encoders whose separately encoded segments join by stream copy (same parameter sets; each starts with a key frame). */
const JOINABLE =
	/^(libx264|libopenh264|h264_(nvenc|qsv|vaapi|amf|videotoolbox)|hevc_(nvenc|qsv|vaapi|amf|videotoolbox)|libkvazaar|prores_ks)$/;

export type PictureSegment = { start: number; end: number };
export type SegmentPlan = { segments: PictureSegment[]; reason?: string };

/**
 * The segments of the export range: `count` near-equal parts whose inner boundaries move to the nearest cut on the
 * lowest video track within a quarter segment (a segment then starts on a fresh source), else stay where they are
 * (any frame is exact). One segment, with the reason, when splitting is off, would not pay or cannot join exactly.
 */
export function planPictureSegments(o: {
	snapshot: RenderSnapshot;
	output: OutputSpec;
	slots: number;
	policy: SegmentPolicy;
}): SegmentPlan {
	const { snapshot: snap, output, policy } = o;
	const R0 = snap.range.start;
	const R1 = snap.range.end;
	const frames = R1 - R0;
	const one = (reason: string): SegmentPlan => ({ segments: [{ start: R0, end: R1 }], reason });
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
	const minFrames = Math.max(1, Math.ceil(policy.minSec * fpsN));
	const byLength = Math.floor(frames / minFrames);
	let n: number;
	if (policy.count === 'auto') {
		const bySlots = Math.floor(Math.max(1, o.slots) / policy.slotsPerSegment);
		n = Math.min(byLength, bySlots, enc.hardware ? policy.hwSessions : MAX_SEGMENTS);
	} else n = Math.min(policy.count, byLength);
	n = Math.max(1, Math.min(MAX_SEGMENTS, n));
	if (n < 2)
		return one(byLength < 2 ? `shorter than two segments of ${policy.minSec} s` : 'not enough CPU slots');
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
	return { segments };
}

/** Top-level visual layers (clips with their handles, mattes) of the busiest segment: the plan's overlay estimate. */
export function layersPerSegment(snap: RenderSnapshot, segments: readonly PictureSegment[]): number {
	let most = 0;
	for (const s of segments) {
		let n = 0;
		for (const t of snap.videoTracks) {
			for (const c of t.clips) {
				const f0 = c.start - (c.headHandle ?? 0);
				const f1 = c.start + c.duration + (c.tailHandle ?? 0);
				if (f1 > s.start && f0 < s.end) n++;
			}
			for (const m of t.mattes ?? []) if (m.start + m.duration > s.start && m.start < s.end) n++;
		}
		most = Math.max(most, n);
	}
	return most;
}
