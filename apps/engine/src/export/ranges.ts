// Multi-range exports (`range: {type: 'ranges'}`; docs/wp-notes/agent-footage-export.md "Several ranges in one file"):
// a review cut of several sequence ranges in one file, in the order given. Each range is planned as a `custom` range
// export of its own (its own path, blockers and warnings: exactly what that range alone would render), and the plans
// are joined here into the plan of the whole file. The service renders each range to a picture intermediate through
// its own path and encodes their concatenation once (the Use Previews machinery); the sound is the mix of each range,
// joined with the 4 ms equal-power join fade Clean Up gives a hard cut (`JOIN_FADE_MS`, audio/mixdown.ts), so no join
// clicks. Pure.
import { createHash } from 'node:crypto';
import type { ExportSettings, RenderPlan } from '@jasper/api';
import type { RenderSnapshot } from '@jasper/project';
import { gifFrames } from './deliverables.ts';
import type { PlannedExport } from './planner.ts';

/** One range of a multi-range export: the sequence frames it shows and the snapshot its own plan built. */
export type JoinedPart = { range: { start: number; end: number }; snapshot: RenderSnapshot };

/**
 * The pieces a multi-range export joins, in the order given (null for every other range type). Ranges that touch — one
 * ends on the frame the next starts — are one continuous stretch of the sequence: they merge into one piece, so it
 * gets no join fade, no join cut and no intermediate (a list that merges into one range is a plain range export).
 * The order is never changed: a later range may go back in the sequence or repeat a moment on purpose.
 */
export function joinedRanges(
	settings: Pick<ExportSettings, 'range'>,
): { start: number; end: number }[] | null {
	const r = settings.range;
	if (r.type !== 'ranges') return null;
	const out: { start: number; end: number }[] = [];
	for (const x of r.ranges) {
		const last = out[out.length - 1];
		if (last && x.startFrame === last.end) last.end = x.endFrame;
		else out.push({ start: x.startFrame, end: x.endFrame });
	}
	return out;
}

/**
 * Why the pieces cannot be joined as given, or null: a piece that starts inside the one before it and runs on past its
 * end continues it with an overlap, so the frames in between would play twice in a row with a join between them (a
 * stutter, such as 1869–3001 then 3000–6000). A piece that goes back and ends within or before the previous one is a
 * deliberate replay and is joined.
 */
export function overlapRefusal(pieces: readonly { start: number; end: number }[]): string | null {
	for (let i = 1; i < pieces.length; i++) {
		const a = pieces[i - 1]!;
		const b = pieces[i]!;
		if (b.start > a.start && b.start < a.end && b.end > a.end)
			return `The range ${b.start}–${b.end} starts inside the one before it (${a.start}–${a.end}) and continues past it, so frames ${b.start}–${a.end} would play twice in a row: start it at ${a.end} to continue`;
	}
	return null;
}

/**
 * Why these settings cannot be joined, or null. Everything else a range export writes is the same per range; these
 * outputs are not: caption streams and sidecars are timed on the sequence, an alpha master or a colour space other
 * than BT.709 would not survive the BT.709 concatenation of the intermediates (use-previews.ts `concatFilter`).
 */
export function joinRefusal(settings: ExportSettings, first: PlannedExport): string | null {
	const c = settings.captions;
	if (c?.embed || c?.sidecar?.length)
		return 'Embedded and sidecar captions are not written for several ranges: burn the captions in, or export each range on its own';
	if (settings.video?.alpha || first.output.alpha)
		return 'An alpha master cannot join several ranges: export each range on its own';
	const tags = first.output.color?.tags;
	if (tags && (tags.primaries !== 'bt709' || tags.trc !== 'bt709' || tags.matrix !== 'bt709'))
		return `Several ranges are joined in BT.709; this export writes ${tags.primaries}/${tags.trc}: export each range on its own`;
	return null;
}

const PATH_RANK: Record<string, number> = { copy: 0, audio: 0, native: 1, hybrid: 2, remotion: 3 };

/** First of each identical item (by key), in order. */
function unique<T>(items: readonly T[], key: (x: T) => string): T[] {
	const seen = new Set<string>();
	return items.filter((x) => {
		const k = key(x);
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

/**
 * The plan of the whole file from the plans of its ranges (`parts`, in file order): frames, duration, estimate and a
 * GIF's frame count add up; the path is the slowest part's; blockers and warnings are every part's, once each;
 * `soundWarnings` replaces the parts' W_SOUND_* warnings (they are recomputed over every range's sound).
 */
export function joinPlans(
	parts: readonly PlannedExport[],
	settings: ExportSettings,
	soundWarnings: RenderPlan['warnings'],
): PlannedExport {
	const first = parts[0]!;
	const frames = parts.reduce((n, p) => n + (p.range.end - p.range.start), 0);
	const fps = first.snapshot.settings.fps;
	const durationSec = (frames * fps.den) / fps.num;
	const path = parts
		.map((p) => p.plan.path)
		.reduce((a, b) => ((PATH_RANK[b] ?? 3) > (PATH_RANK[a] ?? 3) ? b : a));
	const warnings = unique(
		parts.flatMap((p) => p.plan.warnings.filter((w) => !w.code.startsWith('W_SOUND_'))),
		(w) => `${w.code}\u0000${w.message}`,
	);
	warnings.push(...soundWarnings, {
		code: 'RANGES_JOINED',
		level: 'info',
		message: `${parts.length} ranges are rendered one by one and joined in this order (one more encode, from ProRes 4444 intermediates); the sound of each range is joined with a 4 ms equal-power fade`,
	});
	const plan: PlannedExport['plan'] = {
		...first.plan,
		planId: `pln_${createHash('sha256')
			.update(JSON.stringify(parts.map((p) => p.plan.planId)))
			.digest('hex')
			.slice(0, 16)}`,
		path,
		segments: parts.flatMap((p) => p.plan.segments),
		blockers: unique(
			parts.flatMap((p) => p.plan.blockers),
			(b) => `${b.itemId ?? ''}\u0000${b.path}\u0000${b.reason}`,
		),
		warnings,
		estimate: {
			seconds: parts.reduce((n, p) => n + p.plan.estimate.seconds, 0),
			bytes: parts.reduce((n, p) => n + p.plan.estimate.bytes, 0),
		},
	};
	delete plan.pipeline;
	delete plan.smart;
	if (settings.smartRender === true)
		plan.smart = {
			used: false,
			copiedFrames: 0,
			reasons: ['Several ranges are rendered and joined, never copied'],
		};
	let deliverable = first.deliverable;
	if (deliverable?.kind === 'gif') {
		const gif = { ...deliverable.gif, frames: gifFrames(durationSec, deliverable.gif.fps) };
		deliverable = { ...deliverable, gif };
		if (plan.deliverable?.kind === 'gif') plan.deliverable = { ...plan.deliverable, frames: gif.frames };
	}
	const joined: PlannedExport = {
		...first,
		plan,
		range: {
			start: Math.min(...parts.map((p) => p.range.start)),
			end: Math.max(...parts.map((p) => p.range.end)),
		},
		media: Object.assign({}, ...parts.map((p) => p.media)),
		output: { ...first.output, frames, durationSec },
		joined: parts.map((p) => ({ range: p.range, snapshot: p.snapshot })),
	};
	delete joined.smart;
	delete joined.previews;
	if (deliverable) joined.deliverable = deliverable;
	return joined;
}

/** Where each part starts in the file, in sequence-rate frames (the parts' lengths added up). */
export function partOffsets(parts: readonly { start: number; end: number }[]): number[] {
	const out: number[] = [];
	let at = 0;
	for (const p of parts) {
		out.push(at);
		at += p.end - p.start;
	}
	return out;
}
