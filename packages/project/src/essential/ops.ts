// Shared helpers of the Essential Sound engine round trips (audio-fx), used by the editor and the MCP tools: which
// clips trigger Ducking, and the content range a Remix plans over.
import type { AudioClip, Sequence } from '../schema/sequence.ts';
import { contentSpanFlicks, FLICKS_PER_SECOND, type Rational } from '../time.ts';
import { type AudioType, type EssentialSound, readEssentialSound } from './model.ts';

/** Clips of the sequence that trigger ducking for these settings: the "Duck against" types (untyped when asked). */
export function duckTriggerClips(seq: Sequence, targets: readonly string[], s: EssentialSound): string[] {
	const want = new Set<AudioType>(s.ducking.against);
	return Object.values(seq.clips)
		.filter((c): c is AudioClip => c.kind === 'audio' && !targets.includes(c.id))
		.filter((c) => {
			const t = readEssentialSound(c.essential)?.type;
			return t ? want.has(t) : s.ducking.againstUntyped;
		})
		.map((c) => c.id);
}

/** The content range (seconds from the media start) a remix plans over: the clip's own range or a remix's original. */
export function remixSourceRange(clip: AudioClip, rate: Rational): { startSec: number; durSec: number } {
	const o = clip.remix?.original;
	const sourceIn = o ? o.sourceIn : clip.sourceIn;
	const dur = o ? o.duration : clip.duration;
	return {
		startSec: sourceIn / FLICKS_PER_SECOND,
		durSec: contentSpanFlicks(dur, rate, 1) / FLICKS_PER_SECOND,
	};
}

/** A remix anchor (spec 12 P6-E11): seconds from the original clip's content start → the sequence frame it plays at. */
export type RemixAnchorRecord = { sourceSeconds: number; frame: number };

const isAnchorRecord = (x: unknown): x is RemixAnchorRecord => {
	const a = x as RemixAnchorRecord | null;
	return (
		!!a &&
		typeof a === 'object' &&
		typeof a.sourceSeconds === 'number' &&
		Number.isFinite(a.sourceSeconds) &&
		a.sourceSeconds >= 0 &&
		a.sourceSeconds <= 864_000 &&
		Number.isSafeInteger(a.frame) &&
		a.frame >= 0
	);
};

/** The readable anchors a remix recorded (`ClipRemix.anchors`), at most 4; malformed entries are left out. Pure. */
export function readRemixAnchors(remix: { anchors?: unknown } | null | undefined): RemixAnchorRecord[] {
	const raw = remix && typeof remix === 'object' ? remix.anchors : undefined;
	if (!Array.isArray(raw)) return [];
	return raw
		.filter(isAnchorRecord)
		.slice(0, 4)
		.map((a) => ({ sourceSeconds: a.sourceSeconds, frame: a.frame }));
}

/** Whether a remix's stored anchors are all readable (an invariant; `repairDocument` keeps the readable ones). */
export function remixAnchorsValid(remix: { anchors?: unknown } | null | undefined): boolean {
	const raw = remix && typeof remix === 'object' ? remix.anchors : undefined;
	return raw === undefined || (Array.isArray(raw) && raw.length <= 4 && raw.every(isAnchorRecord));
}
