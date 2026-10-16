// The export mixer's solo / bed renders skip the strips no audible clip reaches (`OfflineMixer` option
// `skipSilentStrips`, Phase 4 sound-design performance): that is exact only if every audio effect maps silence to
// silence from its reset state. This checks every effect of the catalogue with its defaults, every parameter at its
// minimum and at its maximum, and seeded random settings, at 48 kHz stereo and 44.1 kHz mono.
import { AUDIO_EFFECTS, type ParamSpec } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { createProcessor } from '../src/registry.ts';

type Setting = Record<string, number | string | boolean>;

function settings(params: readonly ParamSpec[], seed: number): Setting[] {
	const pick = (p: ParamSpec, mode: 'min' | 'max' | number): number | string | boolean => {
		if (p.type === 'boolean') return mode === 'min' ? false : mode === 'max' ? true : (mode as number) > 0.5;
		if (p.type === 'enum') {
			const o = (p as { options: readonly string[] }).options;
			return mode === 'min'
				? o[0]!
				: mode === 'max'
					? o[o.length - 1]!
					: o[Math.floor((mode as number) * o.length)]!;
		}
		const r = (p as { range?: { min: number; max: number } }).range;
		if (!r) return p.default as number;
		return mode === 'min' ? r.min : mode === 'max' ? r.max : r.min + (r.max - r.min) * (mode as number);
	};
	let s = seed >>> 0;
	const rnd = () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
	const out: Setting[] = [{}];
	out.push(Object.fromEntries(params.map((p) => [p.name, pick(p, 'min')])));
	out.push(Object.fromEntries(params.map((p) => [p.name, pick(p, 'max')])));
	for (let k = 0; k < 3; k++) out.push(Object.fromEntries(params.map((p) => [p.name, pick(p, rnd())])));
	return out;
}

describe('every audio effect maps silence to silence', () => {
	// heavy effects (multiband, convolution, spectral) take seconds per setting on a loaded host
	for (const spec of AUDIO_EFFECTS)
		it(spec.id, { timeout: 300_000 }, () => {
			for (const [sr, ch] of [
				[48000, 2],
				[44100, 1],
			] as const)
				for (const set of settings(spec.params, spec.id.length * 7919)) {
					const p = createProcessor(spec.id, sr, ch);
					if (!p) continue; // no DSP (analysis-only effects): nothing to process
					for (const [k, v] of Object.entries(set)) p.setParam(k, v as never);
					p.reset();
					const bufs = Array.from({ length: ch }, () => new Float32Array(2048));
					let max = 0;
					for (let b = 0; b < 12; b++) {
						for (const x of bufs) x.fill(0);
						p.process(bufs, 0, 2048);
						for (const x of bufs) for (const v of x) max = Math.max(max, Math.abs(v));
					}
					expect(max, `${spec.id} ${JSON.stringify(set)} @${sr}/${ch}`).toBe(0);
				}
		});
});
