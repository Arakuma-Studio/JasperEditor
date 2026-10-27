// Jasper Synth recipes (spec 12 §2.1): one procedural generator per sound type, each a small subtractive / additive
// patch whose parameters are drawn from the seed. A TEST FIXTURE and offline fallback, not the library: real
// recordings always rank above these. Every recipe renders stereo at the given rate and must pass the judge for its
// own type (packages/audio-fx/test/sound-synth.test.ts).
import type { SoundTypeId } from '../analysis/sound-judge.ts';
import {
	addNoise,
	addSaw,
	addSine,
	attackDecay,
	bell,
	buffer,
	expDecay,
	filter,
	finish,
	mixInto,
	panStereo,
	reverse,
	type SplitMix32,
	TWO_PI,
} from './kit.ts';

export interface SynthRecipe {
	/** Stable id (`synth.<type>`), part of the library source `{type: 'synth', recipe, seed}`. */
	readonly id: string;
	/** The type this recipe is meant to be (the judge checks it against that type's profile). */
	readonly type: SoundTypeId;
	readonly title: string;
	/** Render stereo audio from a seeded generator. */
	readonly render: (rng: SplitMix32, sr: number) => Float32Array[];
}

/** A short noise transient (bandpassed), shared by impacts. */
function transient(
	sr: number,
	rng: SplitMix32,
	seconds: number,
	tau: number,
	fc: number,
	q = 0.8,
): Float64Array {
	const x = buffer(sr, seconds);
	addNoise(x, sr, rng, expDecay(tau));
	return filter(x, sr, 'bandPass', fc, q);
}

/** Two channels of the same mono buffer with a little independent noise (keeps a natural, narrow width). */
function nearMono(
	x: Float64Array,
	sr: number,
	rng: SplitMix32,
	spread: number,
	tau: number,
	fc: number,
): Float64Array[] {
	const chs = [Float64Array.from(x), Float64Array.from(x)];
	for (const c of chs) mixInto(c, transient(sr, rng, x.length / sr, tau, fc), spread);
	return chs;
}

const hit: SynthRecipe = {
	id: 'synth.hit',
	type: 'hit',
	title: 'Synth hit',
	render(rng, sr) {
		const dur = rng.range(0.7, 1.2);
		const x = buffer(sr, dur);
		const f0 = rng.range(120, 180);
		const tauBody = rng.range(0.08, 0.16);
		addSine(x, sr, (t) => f0 * (1 + 1.2 * Math.exp(-t / 0.015)), attackDecay(0.0005, tauBody), 0);
		const ring = rng.range(320, 620);
		const ringEnv = attackDecay(0.0005, tauBody * 0.6);
		addSine(
			x,
			sr,
			() => ring,
			(t) => 0.35 * ringEnv(t),
		);
		mixInto(x, transient(sr, rng, dur, rng.range(0.015, 0.04), rng.range(1500, 3200)), rng.range(2, 2.8));
		return finish(nearMono(x, sr, rng, 0.15, 0.02, 2500), sr);
	},
};

const boom: SynthRecipe = {
	id: 'synth.boom',
	type: 'boom',
	title: 'Synth boom',
	render(rng, sr) {
		const tau = rng.range(0.45, 0.9);
		const dur = tau * 3.4 + 0.3;
		const x = buffer(sr, dur);
		const f0 = rng.range(38, 56);
		addSine(x, sr, (t) => f0 * (1 + 1.5 * Math.exp(-t / 0.06)), attackDecay(0.002, tau));
		const rumble = buffer(sr, dur);
		addNoise(rumble, sr, rng, attackDecay(0.003, tau * 0.6));
		filter(rumble, sr, 'lowPass', rng.range(180, 350), Math.SQRT1_2, 2);
		mixInto(x, rumble, rng.range(0.8, 1.4));
		mixInto(x, transient(sr, rng, dur, 0.01, rng.range(700, 1200)), 0.5);
		return finish(nearMono(x, sr, rng, 0.08, 0.3, 200), sr);
	},
};

const riser: SynthRecipe = {
	id: 'synth.riser',
	type: 'riser',
	title: 'Synth riser',
	render(rng, sr) {
		const T = rng.range(1.5, 3.5);
		const x = buffer(sr, T);
		const curve = rng.range(2, 4);
		const ramp = (t: number): number => (t / T) ** curve;
		const lo = rng.range(250, 450);
		const hi = rng.range(2500, 4500);
		const sweep = (t: number): number => lo * (hi / lo) ** (t / T);
		addNoise(x, sr, rng, ramp);
		filter(x, sr, 'bandPass', sweep, rng.range(1.5, 3));
		const tone = rng.range(140, 220);
		const octaves = rng.range(2, 3);
		addSine(
			x,
			sr,
			(t) => tone * 2 ** ((octaves * t) / T),
			(t) => 0.25 * ramp(t),
		);
		const width = rng.range(0.2, 0.5);
		return finish(
			panStereo(x, sr, (t) => width * Math.sin((TWO_PI * t) / T)),
			sr,
			{ fadeOut: 0.02 },
		);
	},
};

const reverseFx: SynthRecipe = {
	id: 'synth.reverse',
	type: 'reverse',
	title: 'Synth reverse swell',
	render(rng, sr) {
		const T = rng.range(1, 2.5);
		const x = buffer(sr, T);
		const tau = T / rng.range(3, 5);
		addNoise(x, sr, rng, expDecay(tau));
		filter(x, sr, 'bandPass', rng.range(900, 2200), 0.9);
		const f = rng.range(180, 420);
		addSine(
			x,
			sr,
			() => f,
			(t) => 0.4 * Math.exp(-t / tau),
		);
		addSine(
			x,
			sr,
			() => f * 1.5,
			(t) => 0.2 * Math.exp(-t / (tau * 0.8)),
		);
		reverse(x);
		return finish(nearMono(x, sr, rng, 0, 0.01, 1000), sr, { fadeOut: 0.004 });
	},
};

const transition: SynthRecipe = {
	id: 'synth.transition',
	type: 'transition',
	title: 'Synth transition sweep',
	render(rng, sr) {
		const T = rng.range(0.9, 2);
		const x = buffer(sr, T);
		const env = bell(0, T, rng.range(0.3, 0.5));
		addNoise(x, sr, rng, env);
		const hi = rng.range(3000, 5000);
		const lo = rng.range(250, 500);
		filter(x, sr, 'bandPass', (t) => hi * (lo / hi) ** (t / T), 1.2);
		const g0 = rng.range(350, 500);
		addSine(
			x,
			sr,
			(t) => g0 * (80 / g0) ** (t / T),
			(t) => 0.3 * env(t),
		);
		const dir = rng.unit() < 0.5 ? -1 : 1;
		return finish(
			panStereo(x, sr, (t) => dir * 0.5 * (2 * (t / T) - 1)),
			sr,
		);
	},
};

const whoosh: SynthRecipe = {
	id: 'synth.whoosh',
	type: 'whoosh',
	title: 'Synth whoosh',
	render(rng, sr) {
		const T = rng.range(0.5, 1.2);
		const pk = rng.range(0.4, 0.6);
		const x = buffer(sr, T);
		const env = bell(0, T, pk);
		addNoise(x, sr, rng, env);
		const lo = rng.range(300, 500);
		const top = rng.range(1800, 3000);
		filter(x, sr, 'bandPass', (t) => lo + (top - lo) * env(t), rng.range(1.2, 2.2));
		const dir = rng.unit() < 0.5 ? -1 : 1;
		return finish(
			panStereo(x, sr, (t) => dir * 0.8 * (2 * (t / T) - 1)),
			sr,
		);
	},
};

const swish: SynthRecipe = {
	id: 'synth.swish',
	type: 'swish',
	title: 'Synth swish',
	render(rng, sr) {
		const T = rng.range(0.15, 0.4);
		const x = buffer(sr, T);
		const env = bell(0, T, rng.range(0.3, 0.5));
		addNoise(x, sr, rng, env);
		const lo = rng.range(1500, 2500);
		const top = rng.range(4500, 6500);
		filter(x, sr, 'bandPass', (t) => lo + (top - lo) * env(t), rng.range(1.5, 2.5));
		const dir = rng.unit() < 0.5 ? -1 : 1;
		return finish(
			panStereo(x, sr, (t) => dir * 0.6 * (2 * (t / T) - 1)),
			sr,
		);
	},
};

const glitch: SynthRecipe = {
	id: 'synth.glitch',
	type: 'glitch',
	title: 'Synth glitch',
	render(rng, sr) {
		const grains = rng.int(6, 12);
		const lens = Array.from({ length: grains }, () => rng.range(0.015, 0.045));
		const gaps = Array.from({ length: grains }, () => (rng.unit() < 0.35 ? rng.range(0.005, 0.03) : 0));
		const T = lens.reduce((s, v) => s + v, 0) + gaps.reduce((s, v) => s + v, 0) + 0.02;
		const x = buffer(sr, T);
		let pos = 0;
		for (let g = 0; g < grains; g++) {
			const start = Math.round(pos * sr);
			const n = Math.round(lens[g]! * sr);
			const kind = rng.int(0, 2);
			const amp = rng.range(0.5, 1);
			if (kind === 0) {
				// square wave
				const f = rng.logRange(200, 1600);
				for (let i = 0; i < n && start + i < x.length; i++)
					x[start + i] = amp * (Math.sin((TWO_PI * f * i) / sr) >= 0 ? 0.6 : -0.6);
			} else if (kind === 1) {
				// sample-and-hold noise
				const hold = Math.max(1, Math.round(sr / rng.range(1500, 5000)));
				let v = 0;
				for (let i = 0; i < n && start + i < x.length; i++) {
					if (i % hold === 0) v = rng.bipolar();
					x[start + i] = amp * v;
				}
			} else {
				// bit-crushed sine
				const f = rng.logRange(300, 2000);
				const steps = rng.int(2, 5);
				for (let i = 0; i < n && start + i < x.length; i++)
					x[start + i] = amp * (Math.round(Math.sin((TWO_PI * f * i) / sr) * steps) / steps);
			}
			pos += lens[g]! + gaps[g]!;
		}
		filter(x, sr, 'lowPass', rng.range(5000, 7000), Math.SQRT1_2, 2);
		const chs = panStereo(x, sr, rng.range(-0.3, 0.3));
		return finish(chs, sr);
	},
};

const ui: SynthRecipe = {
	id: 'synth.ui',
	type: 'ui',
	title: 'Synth UI blip',
	render(rng, sr) {
		const f1 = rng.range(620, 1200);
		const f2 = f1 * rng.pick([1.25, 1.335, 1.5, 2]);
		const gap = rng.range(0.06, 0.09);
		const tau = rng.range(0.025, 0.045);
		const T = gap + tau * 6 + 0.02;
		const x = buffer(sr, T);
		const e1 = attackDecay(0.002, tau);
		const e2 = attackDecay(0.002, tau, gap);
		addSine(x, sr, () => f1, e1);
		addSine(
			x,
			sr,
			() => f1 * 2,
			(t) => 0.15 * e1(t),
		);
		addSine(
			x,
			sr,
			() => f2,
			(t) => 0.9 * e2(t),
		);
		addSine(
			x,
			sr,
			() => f2 * 2,
			(t) => 0.12 * e2(t),
		);
		return finish(panStereo(x, sr, 0), sr);
	},
};

const click: SynthRecipe = {
	id: 'synth.click',
	type: 'click',
	title: 'Synth click',
	render(rng, sr) {
		const T = rng.range(0.05, 0.08);
		const x = transient(sr, rng, T, rng.range(0.001, 0.0025), rng.range(2500, 5000), 1.2);
		const f = rng.range(2800, 4500);
		const ring = attackDecay(0.0002, rng.range(0.003, 0.006));
		addSine(
			x,
			sr,
			() => f,
			(t) => 0.5 * ring(t),
		);
		return finish(panStereo(x, sr, rng.range(-0.2, 0.2)), sr, { fadeOut: 0.004 });
	},
};

const key: SynthRecipe = {
	id: 'synth.key',
	type: 'key',
	title: 'Synth key press',
	render(rng, sr) {
		const T = rng.range(0.09, 0.15);
		const x = transient(sr, rng, T, rng.range(0.0015, 0.003), rng.range(2500, 4000), 1);
		const body = buffer(sr, T);
		addNoise(body, sr, rng, attackDecay(0.0005, rng.range(0.01, 0.02)));
		filter(body, sr, 'bandPass', rng.range(500, 1100), 1.5);
		mixInto(x, body, rng.range(0.8, 1.3));
		const thock = rng.range(200, 300);
		const thockEnv = attackDecay(0.0008, 0.018);
		addSine(
			x,
			sr,
			() => thock,
			(t) => 0.2 * thockEnv(t),
		);
		return finish(panStereo(x, sr, rng.range(-0.3, 0.3)), sr, { fadeOut: 0.01 });
	},
};

const tick: SynthRecipe = {
	id: 'synth.tick',
	type: 'tick',
	title: 'Synth tick',
	render(rng, sr) {
		const T = rng.range(0.03, 0.06);
		const x = buffer(sr, T);
		const f = rng.range(3500, 5500);
		addSine(x, sr, () => f, attackDecay(0.0002, rng.range(0.002, 0.005)));
		mixInto(x, transient(sr, rng, T, 0.0008, f, 2), 0.6);
		return finish(panStereo(x, sr, rng.range(-0.2, 0.2)), sr, { fadeOut: 0.004 });
	},
};

const tap: SynthRecipe = {
	id: 'synth.tap',
	type: 'tap',
	title: 'Synth tap',
	render(rng, sr) {
		const T = rng.range(0.15, 0.3);
		const x = buffer(sr, T);
		const f = rng.range(250, 700);
		const tau = rng.range(0.02, 0.05);
		for (const [ratio, a, k] of [
			[1, 1, 1],
			[2.32, 0.5, 0.7],
			[3.86, 0.3, 0.5],
		] as const) {
			const e = attackDecay(0.0006, tau * k);
			addSine(
				x,
				sr,
				() => f * ratio,
				(t) => a * e(t),
			);
		}
		const tr = buffer(sr, T);
		addNoise(tr, sr, rng, expDecay(0.0015));
		filter(tr, sr, 'lowPass', 3000, Math.SQRT1_2);
		mixInto(x, tr, 0.6);
		return finish(panStereo(x, sr, rng.range(-0.3, 0.3)), sr, { fadeOut: 0.01 });
	},
};

const pop: SynthRecipe = {
	id: 'synth.pop',
	type: 'pop',
	title: 'Synth pop',
	render(rng, sr) {
		const T = rng.range(0.08, 0.2);
		const x = buffer(sr, T);
		const f0 = rng.range(300, 600);
		const up = rng.range(1.8, 3);
		const glide = rng.range(0.015, 0.035);
		addSine(x, sr, (t) => f0 * up ** Math.min(1, t / glide), attackDecay(0.001, rng.range(0.015, 0.03)));
		mixInto(x, transient(sr, rng, T, 0.0008, 2000, 1), 0.2);
		return finish(panStereo(x, sr, rng.range(-0.3, 0.3)), sr, { fadeOut: 0.008 });
	},
};

const thump: SynthRecipe = {
	id: 'synth.thump',
	type: 'thump',
	title: 'Synth thump',
	render(rng, sr) {
		const tau = rng.range(0.08, 0.16);
		const T = tau * 4 + 0.1;
		const x = buffer(sr, T);
		const f0 = rng.range(55, 90);
		const sub = attackDecay(0.001, tau);
		addSine(
			x,
			sr,
			(t) => f0 * (1 + 0.8 * Math.exp(-t / 0.02)),
			(t) => 0.7 * sub(t),
		);
		const lo = buffer(sr, T);
		addNoise(lo, sr, rng, attackDecay(0.001, 0.03));
		filter(lo, sr, 'lowPass', rng.range(250, 400), Math.SQRT1_2, 2);
		mixInto(x, lo, 0.8);
		// the knock: a damped mid resonance and a short transient
		const knock = rng.range(180, 260);
		const knockEnv = attackDecay(0.001, tau * 0.35);
		addSine(
			x,
			sr,
			() => knock,
			(t) => 0.5 * knockEnv(t),
		);
		mixInto(x, transient(sr, rng, T, 0.004, rng.range(600, 900), 1), 1.2);
		return finish(panStereo(x, sr, 0), sr, { fadeOut: 0.02 });
	},
};

const paper: SynthRecipe = {
	id: 'synth.paper',
	type: 'paper',
	title: 'Synth paper rustle',
	render(rng, sr) {
		const T = rng.range(0.5, 1.4);
		const x = buffer(sr, T);
		// continuous rustle under a Poisson stream of crackles
		const env = new Float64Array(x.length);
		const bed = rng.range(0.08, 0.18);
		const shape = bell(0, T, rng.range(0.3, 0.6));
		for (let i = 0; i < env.length; i++) env[i] = bed * shape(i / sr);
		const rate = rng.range(40, 110);
		let t = rng.range(0, 0.02);
		while (t < T - 0.02) {
			const a = rng.range(0.3, 1) * (0.3 + 0.7 * shape(t));
			const tau = rng.range(0.002, 0.008);
			const i0 = Math.round(t * sr);
			for (let i = i0; i < Math.min(env.length, i0 + Math.round(tau * 6 * sr)); i++)
				env[i] += a * Math.exp(-(i - i0) / (tau * sr));
			t += -Math.log(1 - rng.unit()) / rate;
		}
		for (let i = 0; i < x.length; i++) x[i] = rng.bipolar() * env[i]!;
		filter(x, sr, 'highPass', rng.range(700, 1100), Math.SQRT1_2, 2);
		filter(x, sr, 'lowPass', rng.range(5500, 7500), Math.SQRT1_2, 2);
		const chs = [x, Float64Array.from(x)];
		// a little width: the right channel delayed by a fraction of a millisecond
		const d = Math.round(rng.range(0.0002, 0.0007) * sr);
		chs[1]!.copyWithin(d, 0);
		chs[1]!.fill(0, 0, d);
		return finish(chs, sr, { fadeIn: 0.005, fadeOut: 0.02 });
	},
};

const chime: SynthRecipe = {
	id: 'synth.chime',
	type: 'chime',
	title: 'Synth chime',
	render(rng, sr) {
		const tau = rng.range(0.6, 1.2);
		const T = tau * 3.2 + 0.3;
		const x = buffer(sr, T);
		const f0 = rng.range(650, 1300);
		for (const [ratio, a] of [
			[1, 1],
			[2.0, 0.45],
			[2.76, 0.4],
			[4.07, 0.22],
			[5.4, 0.12],
		] as const) {
			const e = attackDecay(0.001, tau / ratio ** 0.6);
			if (f0 * ratio < 0.45 * sr)
				addSine(
					x,
					sr,
					() => f0 * ratio,
					(t) => a * e(t),
					rng.range(0, TWO_PI),
				);
		}
		const strike = transient(sr, rng, T, 0.002, f0 * 2, 1);
		mixInto(x, strike, 0.15);
		const p = rng.range(-0.4, 0.4);
		return finish(panStereo(x, sr, p), sr, { fadeOut: 0.05 });
	},
};

const shimmer: SynthRecipe = {
	id: 'synth.shimmer',
	type: 'shimmer',
	title: 'Synth shimmer',
	render(rng, sr) {
		const T = rng.range(1.5, 3);
		const l = buffer(sr, T);
		const r = buffer(sr, T);
		const env = bell(0, T, rng.range(0.35, 0.6));
		const partials = rng.int(12, 20);
		for (let k = 0; k < partials; k++) {
			const f = rng.logRange(1800, 6500);
			const drift = rng.range(-0.04, 0.04);
			const tremRate = rng.range(3, 9);
			const tremPh = rng.range(0, TWO_PI);
			const a = rng.range(0.3, 1);
			const pan = rng.bipolar();
			const amp = (t: number): number => a * env(t) * (0.6 + 0.4 * Math.sin(TWO_PI * tremRate * t + tremPh));
			const freq = (t: number): number => f * (1 + drift * (t / T));
			const gl = Math.cos(((pan + 1) * Math.PI) / 4);
			const gr = Math.sin(((pan + 1) * Math.PI) / 4);
			const ph = rng.range(0, TWO_PI);
			addSine(l, sr, freq, (t) => gl * amp(t), ph);
			addSine(r, sr, freq, (t) => gr * amp(t), ph);
		}
		return finish([l, r], sr, { fadeOut: 0.02 });
	},
};

const zap: SynthRecipe = {
	id: 'synth.zap',
	type: 'zap',
	title: 'Synth zap',
	render(rng, sr) {
		const T = rng.range(0.18, 0.4);
		const x = buffer(sr, T);
		const f0 = rng.range(1400, 2600);
		const f1 = rng.range(80, 200);
		const tau = rng.range(0.05, 0.12);
		addSaw(x, sr, (t) => f0 * (f1 / f0) ** Math.min(1, t / (T * 0.8)), attackDecay(0.002, tau), 48);
		filter(x, sr, 'lowPass', rng.range(3500, 5000), Math.SQRT1_2, 2);
		return finish(panStereo(x, sr, rng.range(-0.3, 0.3)), sr, { fadeOut: 0.01 });
	},
};

/**
 * TV static (spec 15 EA-026: the generated noise under a stinger, never a recording): white noise with a fast random
 * level flutter, band-limited to the hiss band (high-pass ≈ 250 Hz, two-stage low-pass ≈ 5.5 kHz), the right channel
 * slightly decorrelated; 1.6–2 s so a 29-frame stinger fits at any frame rate (the placement trims it).
 */
const tvStatic: SynthRecipe = {
	id: 'synth.static',
	type: 'glitch',
	title: 'Synth TV static',
	render(rng, sr) {
		const T = rng.range(1.6, 2);
		const x = buffer(sr, T);
		const hold = Math.max(1, Math.round(sr / rng.range(25, 60)));
		let g = 1;
		for (let i = 0; i < x.length; i++) {
			if (i % hold === 0) g = 1 + rng.range(-0.25, 0.25);
			x[i] = rng.bipolar() * g;
		}
		const lp = rng.range(4500, 6500);
		const hp = rng.range(180, 320);
		filter(x, sr, 'lowPass', lp, Math.SQRT1_2, 2);
		filter(x, sr, 'highPass', hp, Math.SQRT1_2, 1);
		const side = buffer(sr, T);
		addNoise(side, sr, rng, () => 1);
		filter(side, sr, 'lowPass', lp, Math.SQRT1_2, 2);
		filter(side, sr, 'highPass', hp, Math.SQRT1_2, 1);
		const chs = [Float64Array.from(x), mixInto(Float64Array.from(x), side, 0.35)];
		return finish(chs, sr, { fadeIn: 0.003, fadeOut: 0.03 });
	},
};

/** Recipes beyond the one per type (named sounds other passes ask for by recipe id). */
export const SYNTH_EXTRA_RECIPES: readonly SynthRecipe[] = /* @__PURE__ */ Object.freeze([tvStatic]);

/** Every recipe, one per type of the 19 sound-effect types, in taxonomy order. */
export const SYNTH_RECIPES: readonly SynthRecipe[] = /* @__PURE__ */ Object.freeze([
	hit,
	boom,
	riser,
	reverseFx,
	transition,
	whoosh,
	swish,
	glitch,
	ui,
	click,
	key,
	tick,
	tap,
	pop,
	thump,
	paper,
	chime,
	shimmer,
	zap,
]);
