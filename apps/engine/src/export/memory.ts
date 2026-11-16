// spec 13 AS-074 — memory preflight of the native composite. Before an export starts its composite (and before a
// long bake runs for nothing), the planner estimates the peak memory of the ffmpeg composite and the engine's kernel
// streams from the layers it will draw, and refuses the native / hybrid path with a named blocker when it exceeds
// the machine's budget (the export then goes through the Remotion path, whose memory is bounded, or fails with the
// reason when the native path was forced).
//
// Per-input costs are the textperf measurements on the build VM (private research `textperf` §5.3, FINDINGS §0):
// ≈ 220 MB per ProRes 4444 master input at 1080×1920, ≈ 40 MB per looped still input, ≈ 165 MB per sub-pixel stream
// layer (decoder + frame slots), ≈ 0.3 GB for the base composite with one video. Kernel streams (stream/taps.ts)
// hold their output slots and a few pictures whatever their clip count. The estimate scales the per-input costs by
// the sequence's pixel count and is deliberately conservative.
// Media inputs (docs/wp-notes/export-performance.md §6): ffmpeg opens every input of a graph at once and each video
// decoder keeps frame buffers per thread. Measured on the user's PC (1080p60 H.264 inputs of an overlay chain, peak
// RSS): FFmpeg 6.1 ≈ 63 MB per input at 1 decoder thread, 78 MB at 2, 266 MB at its default (16 frame threads);
// FFmpeg 7.1 (the shipped build, which runs every decoder in its own thread and buffers frames per input) ≈ 181 MB at
// 1 thread and 200 MB at 2 (59 inputs: 10.7 / 11.9 GB; 20 synthetic inputs: 4.0 GB). The model takes 7.1's numbers,
// ≈ 170 MB + 14 MB per thread, scaled by the decoded picture's size. The composite caps each input's decoder threads
// (`decoderThreadsFor`), the budget follows the memory actually available, and a watchdog (service.ts) stops a
// composite that still grows past it.
import { readFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import {
	contentTimeAt,
	maskExportRoute,
	type RenderSnapshot,
	type RenderVisualClip,
	resolveLayerProps,
} from '@jasper/project';
import { bakeClip, isStaticLayer, layerStill, needsBake } from '../layer-bake/layer.ts';
import { runEligible, shakeRuns } from '../layer-bake/runs.ts';
import { isKernelAdjustment } from './blend/adjust.ts';
import { tapStreamBytes } from './stream/limits.ts';
import { needsSubpixel } from './stream/plan.ts';

const MB = 1024 * 1024;
/** Measured at 1080×1920 (2.07 Mpx). */
const REF_PIXELS = 1080 * 1920;
const COST = {
	base: 300 * MB,
	master: 220 * MB,
	still: 40 * MB,
	stream: 165 * MB,
};
/** Measured per 1080p video input (see above): fixed part and per decoder thread. */
const MEDIA_FIXED = 170 * MB;
const MEDIA_PER_THREAD = 14 * MB;
const MEDIA_REF_PIXELS = 1920 * 1080;

/**
 * Decoder threads of each file input of a composite graph with `threads` CPU threads and `inputs` file inputs: ffmpeg's
 * default (a thread per CPU, 16 frame threads for H.264) multiplies every input's frame buffers; 2 per input decodes
 * as fast in a many-input graph (measured: 43 s vs 47 s, 7.8 GB vs 26.6 GB for 100 inputs) and a graph of few inputs
 * keeps up to 8.
 */
export function decoderThreadsFor(threads: number, inputs: number): number {
	return Math.max(2, Math.min(8, Math.round((4 * Math.max(1, threads)) / Math.max(1, inputs))));
}

/** Whether an ffmpeg input (its arguments up to and including `-i <path>`) reads a file (not a pipe or lavfi). */
export function isFileInput(input: readonly string[]): boolean {
	const i = input.lastIndexOf('-i');
	const path = input[i + 1] ?? '';
	return i >= 0 && !path.startsWith('pipe:') && !input.includes('lavfi');
}

/** The file inputs' decoders limited to `threads` threads each (`-threads` before `-i`; one already set is kept). */
export function capDecoderThreads(inputs: readonly (readonly string[])[], threads: number): string[][] {
	return inputs.map((input) => {
		if (!isFileInput(input) || input.includes('-threads')) return [...input];
		const i = input.lastIndexOf('-i');
		return [...input.slice(0, i), '-threads', String(threads), ...input.slice(i)];
	});
}

/** Estimated memory of one video input decoded with `threads` threads at `pixels` per picture. */
export function mediaInputBytes(pixels: number, threads: number): number {
	return (MEDIA_FIXED + MEDIA_PER_THREAD * threads) * Math.max(0.25, pixels / MEDIA_REF_PIXELS);
}

/** What the composite of a planned export will hold, by kind of input. */
export type CompositeEstimate = {
	bytes: number;
	inputs: { masters: number; stills: number; streams: number; kernelStreams: number; media: number };
};

type Kind = 'master' | 'still' | 'stream' | 'member' | 'media' | 'none';

/**
 * The bake recipe the layer bake picks for a layer it bakes: one still (static layers, lowered layers' layer stills,
 * rendered in sheets, AS-071) or a master of the drawn span.
 */
export function bakeRecipeOf(c: RenderVisualClip): 'still' | 'master' {
	if (!c.threeD && layerStill(c)) return 'still';
	return isStaticLayer(bakeClip(c, { variant: { recipe: 'master' }, stripColor: true })) ? 'still' : 'master';
}

/** How the native builder draws a layer (mirrors native.ts `memberOf` / the layer bake's recipes). */
function kindOf(c: RenderVisualClip, fps: RenderSnapshot['settings']['fps']): Kind {
	const memberBase =
		(c.blendMode ?? 'normal') === 'normal' &&
		!c.fades?.length &&
		!c.headHandle &&
		!c.tailHandle &&
		maskExportRoute(c) === 'none' &&
		!c.threeD;
	if (needsBake(c)) {
		if (!c.threeD && layerStill(c)) return memberBase ? 'member' : 'stream';
		const asBaked = bakeClip(c, { variant: { recipe: 'master' }, stripColor: true });
		if (isStaticLayer(asBaked)) return memberBase ? 'member' : 'still';
		return 'master';
	}
	if (c.kind === 'adjustment' || 'nest' in c.source) return 'none';
	if (c.kind === 'video' || c.kind === 'animated-image' || c.kind === 'motion-graphic') return 'media';
	if (c.kind === 'still' || c.kind === 'solid') {
		const props = resolveLayerProps(c, contentTimeAt(c, c.start, fps));
		const box = {
			bw: Math.max(1, Math.round(c.intrinsicBox.width)),
			bh: Math.max(1, Math.round(c.intrinsicBox.height)),
		};
		if (needsSubpixel(c, props, box) || maskExportRoute(c) === 'stream')
			return memberBase ? 'member' : 'stream';
		return c.kind === 'still' ? 'still' : 'none';
	}
	return 'media';
}

/**
 * One layer of a composite profile: its drawn span, how it is drawn, its track and (media) decoded pixels; `covers`: a
 * piece of the composite's base (decoded like any media, drawn without an overlay, native.ts §12).
 */
type ProfileItem = {
	f0: number;
	f1: number;
	kind: Kind;
	track: number;
	pixels: number;
	run: number | null;
	covers?: boolean;
};

/**
 * How each top-level layer of `snap` is drawn (computed once; `estimateFrom` then counts any range cheaply). Masters
 * in one run of shaken masters share a `run` id (one input, AS-073). `covers`: the media layers that would be a piece
 * of the composite's base (opaque, filling the frame: decided by the caller from the media and the Motion); as in the
 * builder, pieces do not overlap and a blend-mode layer or an adjustment layer with geometric effects closes the base.
 */
export function compositeProfile(
	snap: RenderSnapshot,
	covers: (c: RenderVisualClip) => boolean = () => false,
): ProfileItem[] {
	const items: ProfileItem[] = [];
	let runId = 0;
	let baseOpen = true;
	const pieces: ProfileItem[] = [];
	for (const [ti, t] of snap.videoTracks.entries()) {
		const masters: RenderVisualClip[] = [];
		const byClip = new Map<RenderVisualClip, ProfileItem>();
		for (const c of t.clips) {
			const k = kindOf(c, snap.settings.fps);
			const item: ProfileItem = {
				f0: c.start - (c.headHandle ?? 0),
				f1: c.start + c.duration + (c.tailHandle ?? 0),
				kind: k,
				track: ti,
				pixels: Math.max(1, c.intrinsicBox.width) * Math.max(1, c.intrinsicBox.height),
				run: null,
			};
			if ((c.blendMode ?? 'normal') !== 'normal' || isKernelAdjustment(c)) baseOpen = false;
			if (baseOpen && k === 'media' && !pieces.some((p) => p.f0 < item.f1 && item.f0 < p.f1) && covers(c)) {
				item.covers = true;
				pieces.push(item);
			}
			items.push(item);
			byClip.set(c, item);
			if (k === 'master') masters.push(c);
		}
		for (const run of shakeRuns(masters.filter(runEligible), (c) => c)) {
			runId++;
			for (const c of run) byClip.get(c)!.run = runId;
		}
	}
	return items;
}

/**
 * Estimated peak memory of one composite graph over `range` from a profile: media inputs with the decoder threads
 * the graph gives them (`decoderThreadsFor` of its `threads`), the other inputs at their measured costs.
 */
export function estimateFrom(
	snap: RenderSnapshot,
	profile: readonly ProfileItem[],
	range: { start: number; end: number },
	opts: { workers?: number; threads?: number } = {},
): CompositeEstimate {
	const W = snap.settings.width;
	const H = snap.settings.height;
	const scale = Math.max(0.25, (W * H) / REF_PIXELS);
	const inputs = { masters: 0, stills: 0, streams: 0, kernelStreams: 0, media: 0 };
	const members = new Map<number, number>();
	const runs = new Set<number>();
	const mediaPixels: number[] = [];
	for (const it of profile) {
		if (it.f1 <= range.start || it.f0 >= range.end) continue;
		if (it.kind === 'member') members.set(it.track, (members.get(it.track) ?? 0) + 1);
		else if (it.kind === 'master') {
			if (it.run === null) inputs.masters++;
			else if (!runs.has(it.run)) {
				runs.add(it.run);
				inputs.masters++;
			}
		} else if (it.kind === 'still') inputs.stills++;
		else if (it.kind === 'stream') inputs.streams++;
		else if (it.kind === 'media') {
			inputs.media++;
			mediaPixels.push(it.pixels);
		}
	}
	// One member alone is drawn as a stream of its own; two or more share a kernel stream (AS-072).
	for (const n of members.values()) {
		if (n === 1) inputs.streams++;
		else inputs.kernelStreams++;
	}
	const threads = decoderThreadsFor(opts.threads ?? 8, inputs.media + inputs.masters + inputs.stills);
	const workers = opts.workers ?? 8;
	const bytes =
		COST.base * scale +
		inputs.masters * COST.master * scale +
		inputs.stills * COST.still * scale +
		inputs.streams * COST.stream * scale +
		mediaPixels.reduce((t, px) => t + mediaInputBytes(px, threads), 0) +
		inputs.kernelStreams * (tapStreamBytes({ outW: W, outH: H, picture: W * H, workers }) + 50 * MB);
	return { bytes: Math.round(bytes), inputs };
}

/**
 * The overlays of one composite graph over `range` (the plan's `pipeline.overlays`, the result counting the built
 * graph's): one per drawn layer, none for a base piece, one per kernel stream of a track's constant-picture members,
 * one per run master, and the mattes. Nested stacks and pre-rendered transition spans are not counted.
 */
export function overlaysFrom(
	snap: RenderSnapshot,
	profile: readonly ProfileItem[],
	range: { start: number; end: number },
): number {
	let n = 0;
	const memberTracks = new Set<number>();
	const runs = new Set<number>();
	for (const it of profile) {
		if (it.f1 <= range.start || it.f0 >= range.end || it.covers) continue;
		if (it.kind === 'member') memberTracks.add(it.track);
		else if (it.run !== null) runs.add(it.run);
		else n++;
	}
	for (const t of snap.videoTracks)
		for (const m of t.mattes ?? []) if (m.start + m.duration > range.start && m.start < range.end) n++;
	return n + memberTracks.size + runs.size;
}

/** Estimated peak memory of the native composite of `snap` over `range` (top-level tracks; nests count as media). */
export function estimateComposite(
	snap: RenderSnapshot,
	range: { start: number; end: number },
	workers = 8,
	threads = 8,
): CompositeEstimate {
	return estimateFrom(snap, compositeProfile(snap), range, { workers, threads });
}

const readNumber = (file: string): number | null => {
	try {
		const v = Number(readFileSync(file, 'utf8').trim());
		return Number.isFinite(v) && v > 0 ? v : null;
	} catch {
		return null;
	}
};

/**
 * The engine's memory limits on Linux: the smallest `memory.max` (cgroup v2) / `memory.limit_in_bytes` (v1) of its
 * own cgroup and its ancestors (a systemd unit or scope, a container), and the room left under it (limit − usage).
 */
function cgroupLimit(): { limit: number; room: number } | null {
	let best: { limit: number; room: number } | null = null;
	const consider = (limit: number | null, usage: number | null) => {
		if (limit === null || limit >= 2 ** 60) return;
		const room = Math.max(0, limit - (usage ?? 0));
		if (!best || room < best.room) best = { limit, room };
	};
	let lines: string[] = [];
	try {
		lines = readFileSync('/proc/self/cgroup', 'utf8').split('\n');
	} catch {
		return null;
	}
	for (const line of lines) {
		const [, controllers, path] = line.split(':');
		if (path === undefined) continue;
		const v2 = controllers === '';
		if (!v2 && !controllers!.split(',').includes('memory')) continue;
		const root = v2 ? '/sys/fs/cgroup' : '/sys/fs/cgroup/memory';
		const parts = path.split('/').filter(Boolean);
		for (let i = parts.length; i >= 0; i--) {
			const dir = [root, ...parts.slice(0, i)].join('/');
			if (v2) consider(readNumber(`${dir}/memory.max`), readNumber(`${dir}/memory.current`));
			else consider(readNumber(`${dir}/memory.limit_in_bytes`), readNumber(`${dir}/memory.usage_in_bytes`));
		}
	}
	return best;
}

/** `MemAvailable` (Linux), else the free memory Node reports. */
function availableMemory(): number {
	try {
		const m = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'));
		if (m) return Number(m[1]) * 1024;
	} catch {
		// not Linux
	}
	return freemem();
}

/**
 * The memory the engine may use (bytes): `limit` = the physical memory or the engine's cgroup limit (containers,
 * systemd units and scopes, found from `/proc/self/cgroup`), whichever is smaller; `available` = what is left under it
 * now (`MemAvailable`, or the room left in the cgroup when that is less); `taken` = `limit − available`.
 */
export function memoryRoom(): { limit: number; available: number; taken: number } {
	let limit = totalmem();
	let available = availableMemory();
	const cg = cgroupLimit() as { limit: number; room: number } | null;
	if (cg) {
		limit = Math.min(limit, cg.limit);
		available = Math.min(available, cg.room);
	}
	return { limit, available, taken: Math.max(0, limit - available) };
}

/**
 * Share of the memory limit an export may take by default: the rest stays with the desktop and the applications open
 * beside it (docs/wp-notes/export-performance.md §17).
 */
const BUDGET_SHARE = 0.5;

/**
 * Memory the native composite may use (bytes): `JASPER_EXPORT_MEMORY_BUDGET_MB` when set, else the smaller of half
 * the memory limit (`memoryRoom`) and 80 % of what is available under it now.
 */
export function compositeMemoryBudget(env: Record<string, string | undefined> = process.env): number {
	const set = Number(env.JASPER_EXPORT_MEMORY_BUDGET_MB);
	if (Number.isFinite(set) && set > 0) return set * MB;
	const { limit, available } = memoryRoom();
	return Math.round(Math.min(limit * BUDGET_SHARE, available * 0.8));
}

/**
 * Memory that must stay available to the machine while an export composites (bytes): 10 % of the memory limit. Below
 * it the export stops segments (or fails), whatever budget is configured: the desktop and other applications keep
 * working instead of the machine thrashing into a freeze.
 */
export function memoryFloor(): number {
	return Math.round(memoryRoom().limit * 0.1);
}

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;

/** The blocker text of an estimate over budget (null = it fits). */
export function compositeMemoryBlocker(est: CompositeEstimate, budget: number): string | null {
	if (est.bytes <= budget) return null;
	const parts = [
		est.inputs.masters ? `${est.inputs.masters} animated graphics masters` : null,
		est.inputs.stills ? `${est.inputs.stills} looped stills` : null,
		est.inputs.streams ? `${est.inputs.streams} sub-pixel layers` : null,
		est.inputs.media ? `${est.inputs.media} media layers` : null,
	].filter((x): x is string => x !== null);
	return `the native composite needs ≈ ${gb(est.bytes)} of memory (${parts.join(', ') || 'its layers'} as separate inputs), more than the ${gb(budget)} this machine allows (rendered by the Remotion path)`;
}
