/**
 * Generated, labelled audio for the Auto Tag classifier (wp-note "Phase 6 → WP6.3"): music (the beat-test music, pads,
 * arpeggios, a melody with vibrato, a drum loop, a slow piano-like progression), ambience (pink bed with sparse
 * events, traffic rumble, rain, wind, room tone, an air-conditioner hum, a forest bed with birds) and long sound
 * effects (an explosion with its tail, a car pass-by, a door creak, a sci-fi power-down). Deterministic (own PRNG),
 * nothing committed. Speech comes from the LJ Speech fixture (engine test), short effects from the synth kit and the
 * starter kit.
 */
import { testMusic } from './music.ts';

export type Labelled = {
	name: string;
	label: 'dialogue' | 'music' | 'sfx' | 'ambience';
	channels: Float32Array[];
	sr: number;
};

const TAU = 2 * Math.PI;

function rng(seed: number) {
	let s = (seed * 2654435761) >>> 0 || 1;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 2 ** 31 - 1;
	};
}

function pink(n: number, seed: number): Float32Array {
	const r = rng(seed);
	const out = new Float32Array(n);
	let b0 = 0;
	let b1 = 0;
	let b2 = 0;
	let b3 = 0;
	let b4 = 0;
	let b5 = 0;
	let b6 = 0;
	for (let i = 0; i < n; i++) {
		const w = r();
		b0 = 0.99886 * b0 + w * 0.0555179;
		b1 = 0.99332 * b1 + w * 0.0750759;
		b2 = 0.969 * b2 + w * 0.153852;
		b3 = 0.8665 * b3 + w * 0.3104856;
		b4 = 0.55 * b4 + w * 0.5329522;
		b5 = -0.7616 * b5 - w * 0.016898;
		out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
		b6 = w * 0.115926;
	}
	return out;
}

function onePole(x: Float32Array, a: number): Float32Array {
	const y = new Float32Array(x.length);
	let s = 0;
	for (let i = 0; i < x.length; i++) {
		s += a * (x[i]! - s);
		y[i] = s;
	}
	return y;
}

const stereo = (l: Float32Array): Float32Array[] => [l, l.slice()];

function normalise(x: Float32Array, peak = 0.5): Float32Array {
	let m = 0;
	for (const v of x) m = Math.max(m, Math.abs(v));
	if (m > 0) for (let i = 0; i < x.length; i++) x[i] = (x[i]! / m) * peak;
	return x;
}

/** Plucked note (a decaying harmonic tone) added into `out`. */
function pluck(
	out: Float32Array,
	sr: number,
	at: number,
	f: number,
	dur: number,
	amp: number,
	decay = 3,
): void {
	const n = Math.min(out.length - at, Math.round(dur * sr));
	for (let k = 0; k < n; k++) {
		const t = k / sr;
		const env = Math.min(1, t * 200) * Math.exp(-t * decay);
		out[at + k] =
			out[at + k]! +
			amp *
				env *
				(Math.sin(TAU * f * t) + 0.5 * Math.sin(TAU * 2 * f * t) + 0.25 * Math.sin(TAU * 3 * f * t));
	}
}

const note = (st: number) => 220 * 2 ** (st / 12);

export function padMusic(sr: number, seconds: number, seed: number): Float32Array[] {
	const n = Math.round(seconds * sr);
	const l = new Float32Array(n);
	const prog = [
		[0, 4, 7],
		[-3, 0, 4],
		[5, 9, 12],
		[7, 11, 14],
	];
	const chordSec = 2 + (seed % 3) * 0.5;
	for (let i = 0; i < n; i++) {
		const t = i / sr;
		const c = Math.floor(t / chordSec);
		const ch = prog[(c + seed) % prog.length]!;
		const tc = t - c * chordSec;
		const env = Math.min(1, tc / 0.3) * Math.min(1, (chordSec - tc) / 0.2);
		let v = 0;
		for (const s of ch) v += Math.sin(TAU * note(s) * t) + 0.3 * Math.sin(TAU * 2 * note(s) * t);
		l[i] = 0.08 * env * v;
	}
	return stereo(normalise(l));
}

export function arpeggio(sr: number, seconds: number, bpm: number, seed: number): Float32Array[] {
	const n = Math.round(seconds * sr);
	const l = new Float32Array(n);
	const step = 60 / bpm / 2;
	const pat = [0, 4, 7, 12, 7, 4];
	const roots = [0, -3, 5, 7];
	for (let k = 0; k * step < seconds; k++) {
		const root = roots[Math.floor(k / 8 + seed) % roots.length]!;
		pluck(l, sr, Math.round(k * step * sr), note(root + pat[k % pat.length]!), step * 2, 0.3);
	}
	return stereo(normalise(l));
}

export function melody(sr: number, seconds: number, seed: number): Float32Array[] {
	const n = Math.round(seconds * sr);
	const l = new Float32Array(n);
	const r = rng(seed);
	const scale = [0, 2, 4, 5, 7, 9, 11, 12];
	let t0 = 0;
	let ph = 0;
	while (t0 < seconds) {
		const len = [0.25, 0.5, 0.5, 1][Math.floor((r() + 1) * 2) % 4]!;
		const f = note(scale[Math.floor((r() + 1) * 4) % scale.length]! + 12);
		const a = Math.round(t0 * sr);
		const b = Math.min(n, Math.round((t0 + len) * sr));
		for (let i = a; i < b; i++) {
			const t = (i - a) / sr;
			const vib = 1 + 0.004 * Math.sin(TAU * 5.5 * t);
			ph += (TAU * f * vib) / sr;
			const env = Math.min(1, t / 0.03) * Math.min(1, (len - t) / 0.05);
			l[i] = 0.25 * env * (Math.sin(ph) + 0.2 * Math.sin(2 * ph));
		}
		t0 += len;
	}
	// soft pad underneath
	const pad = padMusic(sr, seconds, seed)[0]!;
	for (let i = 0; i < n; i++) l[i] = l[i]! + 0.3 * pad[i]!;
	return stereo(normalise(l));
}

export function drumLoop(sr: number, seconds: number, bpm: number, seed: number): Float32Array[] {
	const n = Math.round(seconds * sr);
	const l = new Float32Array(n);
	const r = rng(seed);
	const beat = 60 / bpm;
	for (let k = 0; k * beat < seconds; k++) {
		const at = Math.round(k * beat * sr);
		for (let j = 0; j < Math.min(n - at, Math.round(0.4 * sr)); j++) {
			const t = j / sr;
			if (k % 2 === 0)
				l[at + j] = l[at + j]! + 0.8 * Math.exp(-t * 10) * Math.sin(TAU * (50 + 80 * Math.exp(-t * 30)) * t);
			else if (t < 0.25) l[at + j] = l[at + j]! + 0.4 * Math.exp(-t * 20) * r();
		}
		for (let h = 0; h < 2; h++) {
			const hs = at + Math.round((h * beat * sr) / 2);
			for (let j = 0; j < Math.min(n - hs, Math.round(0.05 * sr)); j++)
				l[hs + j] = l[hs + j]! + 0.1 * Math.exp((-j / sr) * 100) * r();
		}
	}
	return stereo(normalise(l));
}

export function pianoProgression(sr: number, seconds: number, seed: number): Float32Array[] {
	const n = Math.round(seconds * sr);
	const l = new Float32Array(n);
	const chords = [
		[0, 4, 7, 12],
		[-5, 2, 7, 11],
		[-3, 0, 4, 9],
		[-7, 0, 5, 9],
	];
	const len = 1.5 + (seed % 2) * 0.5;
	for (let c = 0; c * len < seconds; c++) {
		const ch = chords[(c + seed) % chords.length]!;
		for (const [i, s] of ch.entries())
			pluck(l, sr, Math.round((c * len + i * 0.02) * sr), note(s), len * 1.2, 0.2, 1.5);
	}
	return stereo(normalise(l));
}

/** Music of every flavour, `seconds` long. */
export function musicSet(sr: number, seconds = 20): Labelled[] {
	const m = (name: string, channels: Float32Array[]): Labelled => ({ name, label: 'music', channels, sr });
	const beatMusic = (bpm: number, seed: number) => {
		const bars = Math.max(1, Math.round((seconds * bpm) / 240));
		return testMusic(sr, bpm, bars, seed).audio;
	};
	return [
		m('band 90 BPM', beatMusic(90, 1)),
		m('band 120 BPM', beatMusic(120, 2)),
		m('band 140 BPM', beatMusic(140, 3)),
		m('pad progression', padMusic(sr, seconds, 1)),
		m('pad progression 2', padMusic(sr, seconds, 2)),
		m('arpeggio 100 BPM', arpeggio(sr, seconds, 100, 0)),
		m('arpeggio 128 BPM', arpeggio(sr, seconds, 128, 1)),
		m('melody over pad', melody(sr, seconds, 3)),
		m('melody over pad 2', melody(sr, seconds, 9)),
		m('drum loop 100 BPM', drumLoop(sr, seconds, 100, 1)),
		m('drum loop 125 BPM', drumLoop(sr, seconds, 125, 2)),
		m('piano progression', pianoProgression(sr, seconds, 0)),
		m('piano progression 2', pianoProgression(sr, seconds, 1)),
	];
}

function addEvent(
	out: Float32Array,
	sr: number,
	at: number,
	kind: 'click' | 'knock' | 'chirp',
	amp: number,
	r: () => number,
) {
	const len = Math.round((kind === 'chirp' ? 0.25 : 0.08) * sr);
	for (let k = 0; k < Math.min(len, out.length - at); k++) {
		const t = k / sr;
		const v =
			kind === 'click'
				? r() * Math.exp(-t * 300)
				: kind === 'knock'
					? Math.sin(TAU * 180 * t) * Math.exp(-t * 60)
					: Math.sin(TAU * (3000 + 2000 * Math.sin(TAU * 12 * t)) * t) * Math.sin((Math.PI * t) / 0.25);
		out[at + k] = out[at + k]! + amp * v;
	}
}

export function ambienceSet(sr: number, seconds = 20): Labelled[] {
	const n = Math.round(seconds * sr);
	const a = (name: string, l: Float32Array): Labelled => ({
		name,
		label: 'ambience',
		channels: stereo(l),
		sr,
	});
	const out: Labelled[] = [];
	{
		// pink bed with a few sparse events (room with distant activity)
		const r = rng(5);
		const l = pink(n, 1);
		for (let k = 0; k < seconds / 3; k++)
			addEvent(l, sr, Math.round(((k * 3 + 1.3 + r()) * sr) | 0), 'knock', 0.05, r);
		out.push(a('pink bed + sparse knocks', l));
	}
	{
		// traffic: brown rumble with slow swells (cars passing every ~5 s)
		const l = onePole(pink(n, 2), 0.02);
		for (let i = 0; i < n; i++) l[i] = l[i]! * 6 * (1 + 0.5 * Math.sin((TAU * i) / sr / 5.3));
		out.push(a('traffic rumble', l));
	}
	{
		// rain: pink bed + dense random droplets
		const r = rng(7);
		const l = pink(n, 3);
		for (let i = 0; i < n; i++) l[i] = l[i]! * 0.6;
		for (let k = 0; k < seconds * 150; k++)
			addEvent(l, sr, Math.floor(((r() + 1) / 2) * (n - 1)), 'click', 0.05 * (0.5 + (r() + 1) / 2), r);
		out.push(a('rain', l));
	}
	{
		// wind: low-passed noise with slow gusts
		const l = onePole(pink(n, 4), 0.08);
		for (let i = 0; i < n; i++) {
			const t = i / sr;
			l[i] = l[i]! * 3 * (0.7 + 0.3 * Math.sin(TAU * 0.13 * t) * Math.sin(TAU * 0.31 * t + 1));
		}
		out.push(a('wind', l));
	}
	{
		// room tone: very quiet noise with a 60 Hz hum
		const l = pink(n, 5);
		for (let i = 0; i < n; i++) l[i] = l[i]! * 0.01 + 0.002 * Math.sin((TAU * 60 * i) / sr);
		out.push(a('room tone', l));
	}
	{
		// air conditioner: broadband noise + fan whine
		const l = pink(n, 6);
		for (let i = 0; i < n; i++)
			l[i] = l[i]! * 0.5 + 0.01 * Math.sin((TAU * 120 * i) / sr) + 0.004 * Math.sin((TAU * 1340 * i) / sr);
		out.push(a('air conditioner', l));
	}
	{
		// forest: soft wind bed + occasional bird chirps
		const r = rng(9);
		const l = onePole(pink(n, 7), 0.15);
		for (let i = 0; i < n; i++) l[i] = l[i]! * 1.5;
		for (let k = 0; k < seconds / 2.5; k++)
			addEvent(l, sr, Math.round((k * 2.5 + 1 + r()) * sr), 'chirp', 0.03, r);
		out.push(a('forest with birds', l));
	}
	{
		// crowd-less office: noise floor and keyboard clicks scattered irregularly
		const r = rng(11);
		const l = pink(n, 8);
		for (let i = 0; i < n; i++) l[i] = l[i]! * 0.2;
		let t = 0.5;
		while (t < seconds - 0.2) {
			addEvent(l, sr, Math.round(t * sr), 'click', 0.04, r);
			t += 0.15 + 0.9 * ((r() + 1) / 2) ** 2;
		}
		out.push(a('office with keyboard', l));
	}
	return out.map((x) => ({ ...x, channels: x.channels.map((c) => normalise(c, 0.3)) }));
}

/** Long sound effects (2–10 s): an explosion and its tail, a car pass-by, a door creak, a power-down, a riser. */
export function longSfxSet(sr: number): Labelled[] {
	const s = (name: string, l: Float32Array): Labelled => ({
		name,
		label: 'sfx',
		channels: stereo(normalise(l)),
		sr,
	});
	const out: Labelled[] = [];
	{
		const n = Math.round(6 * sr);
		const l = onePole(pink(n, 21), 0.05);
		for (let i = 0; i < n; i++) {
			const t = i / sr - 0.2;
			l[i] = t < 0 ? 0 : l[i]! * 8 * Math.exp(-t * 0.9) * Math.min(1, t * 100);
		}
		out.push(s('explosion with tail', l));
	}
	{
		const n = Math.round(7 * sr);
		const l = pink(n, 22);
		let ph = 0;
		for (let i = 0; i < n; i++) {
			const t = i / sr;
			const g = Math.exp(-(((t - 3.5) / 1.2) ** 2));
			ph += (TAU * (110 - 25 * Math.tanh((t - 3.5) * 2))) / sr;
			l[i] = g * (l[i]! + 0.3 * Math.sin(ph));
		}
		out.push(s('car pass-by', l));
	}
	{
		const n = Math.round(2.5 * sr);
		const l = new Float32Array(n);
		let ph = 0;
		const r = rng(23);
		for (let i = 0; i < n; i++) {
			const t = i / sr;
			ph += (TAU * (300 + 200 * Math.sin(TAU * 0.6 * t) + 30 * r())) / sr;
			l[i] = Math.sin(ph) * Math.sin((Math.PI * t) / 2.5) * (0.6 + 0.4 * Math.sin(TAU * 17 * t));
		}
		out.push(s('door creak', l));
	}
	{
		const n = Math.round(3 * sr);
		const l = new Float32Array(n);
		let ph = 0;
		for (let i = 0; i < n; i++) {
			const t = i / sr;
			ph += (TAU * 800 * Math.exp(-t * 1.2)) / sr;
			l[i] = Math.sin(ph) * Math.exp(-t * 0.8);
		}
		out.push(s('power-down', l));
	}
	{
		const n = Math.round(5 * sr);
		const l = pink(n, 24);
		let ph = 0;
		for (let i = 0; i < n; i++) {
			const t = i / sr;
			ph += (TAU * (200 * 2 ** (t / 1.5))) / sr;
			const g = (t / 5) ** 2;
			l[i] = g * (0.5 * l[i]! + 0.5 * Math.sin(ph));
		}
		out.push(s('long riser', l));
	}
	{
		// a door slam: one hit, room tail
		const n = Math.round(2 * sr);
		const r = rng(25);
		const l = new Float32Array(n);
		for (let i = 0; i < n; i++) {
			const t = i / sr - 0.1;
			if (t < 0) continue;
			l[i] = (r() * 0.5 + Math.sin(TAU * 70 * t)) * Math.exp(-t * 6);
		}
		out.push(s('door slam', l));
	}
	return out;
}
