// spec 13 AS-072/074: the memory a kernel stream (taps.ts) holds, shared with the planner's preflight (memory.ts) without
// an import of the stream runner.

/** Members whose pictures are decoded ahead of the one being drawn. */
export const PREFETCH_MEMBERS = 3;
/** One-frame picture decodes at the same time. */
export const DECODES_IN_FLIGHT = 3;

/** Kernel threads of one stream at most. */
export const MAX_TAP_WORKERS = 8;

/** Bytes the engine holds for a stream at most (output slots + pictures in flight), for the memory preflight. */
export function tapStreamBytes(o: { outW: number; outH: number; picture: number; workers: number }): number {
	const slots = Math.min(o.workers, MAX_TAP_WORKERS) + 3;
	return slots * o.outW * o.outH * 4 + (PREFETCH_MEMBERS + 1) * o.picture * 4;
}
