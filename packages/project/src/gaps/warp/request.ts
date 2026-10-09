// Warp Stabilizer ▸ which instances need a (new) analysis and over which media frames (workstream gaps, §FX-6): shared
// by the editor's background analysis and the MCP `stabilize_clip` tool. An analysis is reused while it is for the
// clip's media, with the same Detailed Analysis setting, and covers every frame the clip shows.
import type { Clip, Sequence } from '../../schema/sequence.ts';
import type { ProjectDocument } from '../../schema/document.ts';
import { FLICKS_PER_SECOND, type Rational } from '../../time.ts';
import { WARP_STABILIZER_EFFECT_ID, type WarpAnalysisData, warpFrameCount } from './analysis.ts';

/** Frames analysed beyond the clip on each side (trims and transition handles without a re-analysis). */
export const WARP_HANDLE_FRAMES = 15;

type FxInst = { id: string; effectId: string; enabled: boolean; params: Record<string, unknown>; warpAnalysis?: WarpAnalysisData };

const mediaKeyOf = (asset: { locators: readonly { type: string; key?: string }[] } | undefined): string | null => {
	const l = asset?.locators.find((x) => x.type === 'engine-store');
	return l?.key ?? null;
};

export type WarpRequest = {
	fxId: string;
	clipId: string;
	sequenceId: string;
	mediaId: string;
	mediaKey: string;
	startFrame: number;
	frameCount: number;
	detailed: boolean;
};

const paramValue = (fx: FxInst, k: string): unknown => {
	const a = fx.params[k] as { value?: unknown } | undefined;
	return a && typeof a === 'object' && 'value' in a ? a.value : undefined;
};

/** The media frames [first, last] a clip shows (its in-point, duration and speed), in the media's frame rate. */
export function warpClipMediaFrames(clip: Clip, seqRate: Rational, mediaRate: Rational): [number, number] {
	const c = clip as { sourceIn?: number; speed?: { rate?: number } };
	const speed = Math.abs(c.speed?.rate ?? 1) || 1;
	const mf = (FLICKS_PER_SECOND * mediaRate.den) / mediaRate.num;
	const first = Math.floor((c.sourceIn ?? 0) / mf);
	const seconds = (clip.duration * seqRate.den) / seqRate.num;
	return [first, first + Math.max(1, Math.ceil((seconds * speed * mediaRate.num) / mediaRate.den)) - 1];
}

/** The analysis request a Warp Stabilizer instance needs now, or null when its stored analysis is usable. */
export function warpRequestFor(
	doc: ProjectDocument,
	seq: Sequence,
	clip: Clip,
	fx: FxInst,
): WarpRequest | null {
	if (!fx.enabled || fx.effectId !== WARP_STABILIZER_EFFECT_ID || clip.kind !== 'video') return null;
	const mediaId = (clip as { mediaId?: string }).mediaId;
	const asset = mediaId ? doc.media[mediaId] : undefined;
	const key = mediaKeyOf(asset);
	const vs = asset?.probe.streams.find((s) => s.type === 'video');
	if (!asset || !key || vs?.type !== 'video' || !(vs.frameRate.num > 0)) return null;
	const rate = { num: vs.frameRate.num, den: vs.frameRate.den };
	const [first, last] = warpClipMediaFrames(clip, seq.settings.frameRate, rate);
	const total = asset.probe.durationFlicks
		? Math.max(1, Math.round((asset.probe.durationFlicks * rate.num) / (FLICKS_PER_SECOND * rate.den)))
		: null;
	const detailed = paramValue(fx, 'detailedAnalysis') === true;
	const a = fx.warpAnalysis;
	if (a) {
		const fd = rate.den / rate.num;
		const a0 = Math.round(a.start / fd);
		const a1 = a0 + warpFrameCount(a) - 1;
		const covers = a0 <= first && (a1 >= last || (total !== null && a1 >= total - 1));
		if ((a.mediaId === undefined || a.mediaId === mediaId) && a.detailed === detailed && covers) return null;
	}
	const startFrame = Math.max(0, first - WARP_HANDLE_FRAMES);
	let end = last + WARP_HANDLE_FRAMES + 1;
	if (total !== null) end = Math.min(end, total);
	return {
		fxId: fx.id,
		clipId: clip.id,
		sequenceId: seq.id,
		mediaId: mediaId!,
		mediaKey: key,
		startFrame,
		frameCount: Math.max(2, Math.min(54_000, end - startFrame)),
		detailed,
	};
}


export const warpRequestSignature = (r: WarpRequest): string =>
	`${r.mediaKey}|${r.startFrame}|${r.frameCount}|${r.detailed}`;

/** Every Warp Stabilizer of the project that needs an analysis. */
export function pendingWarpRequests(doc: ProjectDocument): WarpRequest[] {
	const out: WarpRequest[] = [];
	for (const seq of Object.values(doc.sequences))
		for (const clip of Object.values(seq.clips))
			for (const fx of ((clip as { effects?: FxInst[] }).effects ?? []) as FxInst[]) {
				const r = warpRequestFor(doc, seq, clip, fx);
				if (r) out.push(r);
			}
	return out;
}
