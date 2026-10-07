// Messages between the preview (main thread) and the clip-chain AudioWorklet processor.
import type { ClipChainConfig } from '../chain/clip-chain.ts';

/** Registered name of the processor. */
export const CLIP_CHAIN_PROCESSOR = 'jasper-audio-fx-clip-chain';

/** Main → worklet. */
export type ToWorklet =
	/** Clip settings (the worklet's own `sampleRate` replaces `config.sampleRate`). */
	| { type: 'config'; config: ClipChainConfig }
	/**
	 * Time mapping: composition seconds at context time `t` = (t − anchor) · rate (Remotion's audio sync anchor and
	 * the player's playback rate); `startSec` = composition seconds of the clip's span start (s = 0).
	 */
	| { type: 'timing'; anchor: number; rate: number; startSec: number }
	/** Post meter values every ~100 ms while on. */
	| { type: 'meters'; on: boolean }
	/** Stop processing (the node is being discarded). */
	| { type: 'dispose' };

/** Worklet → main. */
export type FromWorklet =
	/** Live meters per effect instance (gain reduction dB per band, loudness readings…), plus the chain latency. */
	| { type: 'meters'; latency: number; values: Record<string, number[]> }
	/** The chain latency changed (samples): the host compensates by scheduling the source earlier. */
	| { type: 'latency'; samples: number };
