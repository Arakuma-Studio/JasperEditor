// audio-fx on the native path (docs/wp-notes/audio-fx.md §Export): which clips are rendered by the shared DSP chain,
// and the plan of one such clip — the decoder that delivers its source (speed via atempo, reversal in memory), the
// clip-chain settings and the sample positions to feed, skip and write. The chain output is streamed into the
// composite ffmpeg on a `pipe:N` input (raw f32le stereo at 48 kHz), placed with `adelay` like any clip.
import { type ClipChainConfig, clipNeedsChain, createProcessor } from '@jasper/audio-fx';
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational, type RenderAudioClip } from '@jasper/project';

export const SAMPLE_RATE = 48000;
/** Seconds of the clip processed before an export range that starts inside it (effect state warms up). */
export const PREROLL_SEC = 3;

/**
 * True when a clip needs the DSP chain on export: enabled audio effects, clip or track pan, or reversed playback.
 * Everything else keeps the ffmpeg-only chain (volume/afade/atempo), whose output equals the chain's at unity.
 */
export function audioClipNeedsDsp(a: Pick<RenderAudioClip, 'effects' | 'pan' | 'track' | 'speed'>): boolean {
	return a.speed.reverse || clipNeedsChain(a);
}

/** Chain settings of a snapshot clip. */
export function chainConfigOf(
	a: RenderAudioClip,
	fps: Rational,
	master: { volumeDb: RenderAudioClip['volumeDb'] },
): ClipChainConfig {
	return {
		sampleRate: SAMPLE_RATE,
		fps,
		clip: {
			start: a.start,
			duration: a.duration,
			sourceIn: a.sourceIn,
			speed: { rate: a.speed.rate, reverse: a.speed.reverse },
			...(a.headHandle ? { headHandle: a.headHandle } : {}),
			...(a.tailHandle ? { tailHandle: a.tailHandle } : {}),
			gainDb: a.gainDb,
			volumeDb: a.volumeDb,
			pan: a.pan,
			effects: a.effects,
			track: a.track,
			...(a.fades ? { fades: a.fades } : {}),
		},
		master,
	};
}

/** Latency (samples) of the enabled effects of a clip, as the chain will report it. */
export function chainLatency(a: Pick<RenderAudioClip, 'effects'>): number {
	let l = 0;
	for (const fx of a.effects) {
		if (!fx.enabled) continue;
		const p = createProcessor(fx.effectId, SAMPLE_RATE, 2);
		if (!p) continue;
		for (const [name, anim] of Object.entries(fx.params)) p.setParam(name, anim.value as number);
		l += p.latency();
	}
	return l;
}

export type AudioDspPlan = {
	clipId: string;
	config: ClipChainConfig;
	/** ffmpeg arguments (after `-hide_banner -nostdin -loglevel error`) that write f32le stereo 48 kHz to stdout. */
	decodeArgs: string[];
	/** The decoded samples are played backwards (reversed clip). */
	reverse: boolean;
	/** Chain input position of the first decoded sample. */
	decodeStart: number;
	/** Decoded samples used (fewer are padded with silence, more are dropped). */
	decodeCount: number;
	/** First and end (exclusive) chain input positions fed to the chain. */
	inStart: number;
	inEnd: number;
	/** First output position written (outputs of earlier positions are pre-roll and latency, dropped). */
	outStart: number;
	/** Samples written to the composite. */
	outCount: number;
	/** Silence before the clip in the composite (`adelay`), samples. */
	delay: number;
};

/**
 * Plans the DSP rendering of `a` for the export range `[R0, R1)`; null when the clip has no audible part in the
 * range or no audio stream.
 */
export function planAudioDsp(o: {
	clip: RenderAudioClip;
	media: { path: string; streamIndex: number } | null;
	fps: Rational;
	range: { start: number; end: number };
	master: { volumeDb: RenderAudioClip['volumeDb'] };
	/** Latency override (tests); default: measured from the effects. */
	latency?: number;
}): AudioDspPlan | null {
	const { clip: a, fps } = o;
	if (!o.media) return null;
	const head = a.headHandle ?? 0;
	const a0 = a.start - head;
	const f0 = Math.max(a0, o.range.start);
	const f1 = Math.min(a.start + a.duration + (a.tailHandle ?? 0), o.range.end);
	if (f1 <= f0) return null;
	const frameSec = fps.den / fps.num;
	const config = chainConfigOf(a, fps, o.master);
	const span = Math.round((a.duration + head + (a.tailHandle ?? 0)) * frameSec * SAMPLE_RATE);
	const outStart = Math.round((f0 - a0) * frameSec * SAMPLE_RATE);
	const outCount = Math.round((f1 - f0) * frameSec * SAMPLE_RATE);
	const delay = Math.round((f0 - o.range.start) * frameSec * SAMPLE_RATE);
	const L = o.latency ?? chainLatency(a);
	const inStart = Math.max(0, outStart - Math.round(PREROLL_SEC * SAMPLE_RATE));
	const inEnd = outStart + outCount + L;
	// Source needed for positions [inStart, decodeEnd) (beyond the span the chain hears silence).
	const decodeEnd = Math.min(inEnd, span);
	const F = flicksPerFrame(fps);
	/** Continuous content time (flicks) at span position p. */
	const contentAt = (p: number) => {
		const t = (p * fps.num) / (fps.den * SAMPLE_RATE) - head; // clip frames, continuous
		return a.speed.reverse
			? a.sourceIn + (a.duration - t) * F * a.speed.rate
			: a.sourceIn + t * F * a.speed.rate;
	};
	// Forward: decode from the content at inStart. Reverse: decode the same content range forwards from its
	// earliest point (the content at decodeEnd), then reverse it in memory.
	let decodeStart = inStart;
	let startFlicks = a.speed.reverse ? contentAt(decodeEnd) : contentAt(inStart);
	let decodeCount = Math.max(0, decodeEnd - inStart);
	if (startFlicks < 0) {
		// Content before the media's start (an over-long handle): silence there.
		const lead = Math.round(((-startFlicks / F) * frameSec * SAMPLE_RATE) / a.speed.rate);
		if (!a.speed.reverse) decodeStart += lead;
		decodeCount = Math.max(0, decodeCount - lead);
		startFlicks = 0;
	}
	const startSec = startFlicks / FLICKS_PER_SECOND;
	const durSec = (decodeCount / SAMPLE_RATE) * a.speed.rate + 0.1;
	const decodeArgs = [
		'-ss',
		startSec.toFixed(6),
		'-t',
		durSec.toFixed(6),
		'-i',
		o.media.path,
		'-map',
		`0:${o.media.streamIndex}`,
		'-af',
		[
			'asetpts=PTS-STARTPTS',
			...atempoChain(a.speed.rate),
			`aresample=${SAMPLE_RATE}`,
			'aformat=sample_fmts=flt:channel_layouts=stereo',
		].join(','),
		'-f',
		'f32le',
		'-ac',
		'2',
		'-ar',
		String(SAMPLE_RATE),
		'pipe:1',
	];
	return {
		clipId: a.clipId,
		config,
		decodeArgs,
		reverse: a.speed.reverse,
		decodeStart,
		decodeCount,
		inStart,
		inEnd,
		outStart,
		outCount,
		delay,
	};
}

/** atempo chain for a constant speed (each instance limited to 0.5…100), like the ffmpeg-only clip chain. */
export function atempoChain(speed: number): string[] {
	if (Math.abs(speed - 1) < 1e-9) return [];
	const parts: number[] = [];
	let s = speed;
	while (s < 0.5) {
		parts.push(0.5);
		s /= 0.5;
	}
	while (s > 100) {
		parts.push(100);
		s /= 100;
	}
	parts.push(s);
	return parts.map((p) => `atempo=${Math.round(p * 1e6) / 1e6}`);
}
