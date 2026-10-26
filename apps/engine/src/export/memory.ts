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
import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import {
	contentTimeAt,
	maskExportRoute,
	type RenderSnapshot,
	type RenderVisualClip,
	resolveLayerProps,
} from '@jasper/project';
import { bakeClip, isStaticLayer, layerStill, needsBake } from '../layer-bake/layer.ts';
import { runEligible, shakeRuns } from '../layer-bake/runs.ts';
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
	video: 100 * MB,
};

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

/** Estimated peak memory of the native composite of `snap` over `range` (top-level tracks; nests count as media). */
export function estimateComposite(
	snap: RenderSnapshot,
	range: { start: number; end: number },
	workers = 8,
): CompositeEstimate {
	const W = snap.settings.width;
	const H = snap.settings.height;
	const scale = Math.max(0.25, (W * H) / REF_PIXELS);
	const inputs = { masters: 0, stills: 0, streams: 0, kernelStreams: 0, media: 0 };
	let bytes = COST.base * scale;
	for (const t of snap.videoTracks) {
		let members = 0;
		const masters: RenderVisualClip[] = [];
		for (const c of t.clips) {
			const f0 = c.start - (c.headHandle ?? 0);
			const f1 = c.start + c.duration + (c.tailHandle ?? 0);
			if (f1 <= range.start || f0 >= range.end) continue;
			const k = kindOf(c, snap.settings.fps);
			if (k === 'member') {
				members++;
				continue;
			}
			if (k === 'master') {
				inputs.masters++;
				masters.push(c);
			}
			else if (k === 'still') inputs.stills++;
			else if (k === 'stream') inputs.streams++;
			else if (k === 'media') inputs.media++;
		}
		// A run of shaken masters is one input (AS-073).
		for (const run of shakeRuns(masters.filter(runEligible), (c) => c)) inputs.masters -= run.length - 1;
		// One member alone is drawn as a stream of its own; two or more share a kernel stream (AS-072).
		if (members === 1) inputs.streams++;
		else if (members > 1) inputs.kernelStreams++;
	}
	bytes +=
		inputs.masters * COST.master * scale +
		inputs.stills * COST.still * scale +
		inputs.streams * COST.stream * scale +
		inputs.media * COST.video * scale +
		inputs.kernelStreams * (tapStreamBytes({ outW: W, outH: H, picture: W * H, workers }) + 50 * MB);
	return { bytes: Math.round(bytes), inputs };
}

/**
 * Memory the native composite may use (bytes): `JASPER_EXPORT_MEMORY_BUDGET_MB` when set, else 60 % of the
 * physical memory or of the engine's cgroup limit (containers, systemd units), whichever is smaller.
 */
export function compositeMemoryBudget(env: Record<string, string | undefined> = process.env): number {
	const set = Number(env.JASPER_EXPORT_MEMORY_BUDGET_MB);
	if (Number.isFinite(set) && set > 0) return set * MB;
	let limit = totalmem();
	for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
		try {
			const v = Number(readFileSync(file, 'utf8').trim());
			if (Number.isFinite(v) && v > 0 && v < limit) limit = v;
		} catch {
			// not on Linux / no cgroup limit
		}
	}
	return Math.round(limit * 0.6);
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
