// Clip chain: effects + automation + levels + pan, block-size independence (the preview worklet runs 128-sample
// quanta, the export large blocks: both must produce the same samples), span window, entry reset.
import { type Animatable, FLICKS_PER_SECOND, flicksPerFrame } from '@jasper/project/audio';
import { describe, expect, it } from 'vitest';
import { type ClipChainConfig, ClipChain, clipNeedsChain, spanSamples } from '../src/chain/clip-chain.ts';
import { dbToGain } from '../src/core/math.ts';
import { panGains } from '../src/core/pan.ts';
import { noise, SR } from './util.ts';

const fps = { num: 30, den: 1 };
const F = flicksPerFrame(fps);
const still = <T>(value: T): Animatable<T> => ({ value, keyframes: [] });
const key = (time: number, value: number) => ({
	id: `k${time}`,
	time,
	value,
	interpolation: 'linear' as const,
	easeIn: { influence: 1 / 3, slope: 0 },
	easeOut: { influence: 1 / 3, slope: 0 },
});

function config(over: Partial<ClipChainConfig['clip']> = {}): ClipChainConfig {
	return {
		sampleRate: SR,
		fps,
		clip: {
			start: 30,
			duration: 60,
			sourceIn: 10 * F,
			speed: { rate: 1, reverse: false },
			gainDb: 0,
			volumeDb: still(0),
			pan: still(0),
			effects: [],
			track: { volumeDb: still(0), pan: still(0) },
			...over,
		},
		master: { volumeDb: still(0) },
	};
}

function render(cfg: ClipChainConfig, input: [Float32Array, Float32Array], s0: number, sizes: () => number) {
	const chain = new ClipChain(cfg);
	const l = input[0].slice();
	const r = input[1].slice();
	let i = 0;
	while (i < l.length) {
		const n = Math.min(sizes(), l.length - i);
		chain.process([l, r], i, i + n, s0 + i);
		i += n;
	}
	return [l, r] as const;
}

describe('ClipChain', () => {
	it('span and needs-chain rules', () => {
		expect(spanSamples({ duration: 60 }, fps, SR)).toBe(96000);
		expect(spanSamples({ duration: 60, headHandle: 15, tailHandle: 15 }, fps, SR)).toBe(144000);
		expect(clipNeedsChain(config().clip)).toBe(false);
		expect(clipNeedsChain(config({ pan: still(10) }).clip)).toBe(true);
		expect(
			clipNeedsChain(
				config({ effects: [{ id: 'fx1', effectId: 'jasper.audio.invert', enabled: false, params: {} }] }).clip,
			),
		).toBe(false);
	});

	it('applies clip gain, volume, track and master volume, and the pan laws', () => {
		const cfg = config({ gainDb: -3, volumeDb: still(-2), pan: still(50), track: { volumeDb: still(-1), pan: still(-20) } });
		cfg.master = { volumeDb: still(-4) };
		const n = 2000;
		const one = new Float32Array(n).fill(1);
		const [l, r] = render(cfg, [one, one.slice()], 0, () => n);
		const g = dbToGain(-10);
		const [pl, pr] = panGains(0.5);
		const [tl, tr] = panGains(-0.2);
		expect(l[1000]).toBeCloseTo(g * pl * tl, 6);
		expect(r[1000]).toBeCloseTo(g * pr * tr, 6);
	});

	it('is block-size independent with keyframed effect params, volume, pan and fades', () => {
		const cfg = config({
			headHandle: 6,
			volumeDb: { value: 0, keyframes: [key(10 * F, -12), key(40 * F, 3)] },
			pan: { value: 0, keyframes: [key(15 * F, -100), key(60 * F, 100)] },
			fades: [{ type: 'in', start: 24, frames: 12, curve: 'equal-power' }],
			effects: [
				{
					id: 'fx1',
					effectId: 'jasper.audio.stereo-width',
					enabled: true,
					params: { width: { value: 100, keyframes: [key(12 * F, 0), key(50 * F, 200)] } },
				},
				{
					id: 'fx2',
					effectId: 'jasper.audio.amplify',
					enabled: true,
					params: { leftGain: { value: 0, keyframes: [key(20 * F, -20), key(30 * F, 6)] } },
				},
				{ id: 'fx3', effectId: 'jasper.audio.invert', enabled: false, params: {} },
			],
		});
		const total = spanSamples(cfg.clip, fps, SR) + 3000;
		const input: [Float32Array, Float32Array] = [noise(1, total, 0.5), noise(2, total, 0.5)];
		const big = render(cfg, input, -1000, () => Number.MAX_SAFE_INTEGER);
		const quanta = render(cfg, input, -1000, () => 128);
		let seed = 9;
		const odd = render(cfg, input, -1000, () => {
			seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
			return 1 + (seed % 700);
		});
		let diffs = 0;
		for (let c = 0; c < 2; c++)
			for (let i = 0; i < total; i++) if (quanta[c]![i] !== big[c]![i] || odd[c]![i] !== big[c]![i]) diffs++;
		expect(diffs).toBe(0);
		// Silence before the span, nothing after it.
		for (let i = 0; i < 1000; i++) expect(big[0]![i]).toBe(0);
		const end = 1000 + spanSamples(cfg.clip, fps, SR);
		for (let i = end; i < total; i++) expect(big[0]![i]).toBe(0);
		// Equal-power fade-in starting at the span start (frame 24 = start − head).
		expect(Math.abs(big[0]![1000 + 10]!)).toBeLessThan(0.01);
	});

	it('restarts the effects with fresh state when it (re)enters the clip', () => {
		const cfg = config({
			effects: [{ id: 'a', effectId: 'jasper.audio.mono-maker', enabled: true, params: { mode: still('below') } }],
		});
		const n = 9600;
		const x = noise(5, n, 0.5);
		const chain = new ClipChain(cfg);
		const a = [x.slice(), x.slice()];
		chain.process(a, 0, n, 48000);
		chain.reset();
		const b = [x.slice(), x.slice()];
		chain.process(b, 0, n, 48000);
		for (let i = 0; i < n; i++) expect(b[0]![i]).toBe(a[0]![i]);
	});

	it('evaluates effect keyframes in content time (reverse-aware)', () => {
		const fwd = new ClipChain(config());
		const rev = new ClipChain(config({ speed: { rate: 1, reverse: true } }));
		// s = 0 → frame 0 of the clip: content sourceIn forward, last frame reversed.
		expect(fwd.paramTime(0)).toBe(10 * F);
		expect(rev.paramTime(0)).toBe(10 * F + 59 * F);
		expect(fwd.paramTime(SR)).toBe(10 * F + 30 * F);
		expect(FLICKS_PER_SECOND).toBe(705_600_000);
	});
});
