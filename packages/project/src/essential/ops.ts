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
