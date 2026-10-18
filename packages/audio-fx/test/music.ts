/**
 * Generated rhythmic test music (tests here and in the engine): drums on every beat, a bass note per beat, hats on
 * eighths and a chord pad per bar following four-bar progressions. Returns stereo audio and the true beat positions.
 */
export function testMusic(
	sr: number,
	bpm: number,
	bars: number,
	seed: number,
): { audio: Float32Array[]; beats: number[] } {
	const beat = (sr * 60) / bpm;
	const n = Math.round(bars * 4 * beat);
	const l = new Float32Array(n);
	let rng = (Math.imul(seed, 747796405) + 2891336453) >>> 0;
	const noise = () => {
		rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
		return ((rng >>> 8) / (1 << 24)) * 2 - 1;
	};
	const aSec = [3, 0, 8, 10];
	const bSec = [5, 10, 7, 0];
	const form = [aSec, aSec, bSec, aSec, bSec, aSec];
	const minor = (r: number) => r === 0 || r === 5 || r === 7;
	const tau = 2 * Math.PI;
	const beats: number[] = [];
	for (let bar = 0; bar < bars; bar++) {
		const root = form[Math.floor(bar / 4) % form.length]![bar % 4]!;
		const notes = [root, root + (minor(root) ? 3 : 4), root + 7];
		const b0 = Math.round(bar * 4 * beat);
		const b1 = Math.round((bar + 1) * 4 * beat);
		for (let i = b0; i < Math.min(b1, n); i++) {
			const t = (i - b0) / sr;
			const env = (1 - Math.exp(-t * 30)) * 0.9 ** t;
			let v = 0;
			for (const nt of notes) {
				const f = 220 * 2 ** (nt / 12);
				v += Math.sin((tau * f * i) / sr) + 0.3 * Math.sin((tau * 2 * f * i) / sr);
			}
			l[i] = l[i]! + 0.06 * env * v;
		}
		for (let q = 0; q < 4; q++) {
			const start = Math.round((bar * 4 + q) * beat);
			beats.push(start);
			const bassF = (110 * 2 ** (root / 12)) / (q % 2 === 0 ? 1 : 2 ** (-7 / 12));
			const dur = Math.floor(beat * 0.9);
			for (let k = 0; k < Math.min(dur, n - start); k++) {
				const t = k / sr;
				const i = start + k;
				if (q % 2 === 0) {
					const f = 50 + 90 * Math.exp(-t * 25);
					l[i] = l[i]! + 0.8 * Math.exp(-t * 9) * Math.sin(tau * f * t);
				} else if (t < 0.2) l[i] = l[i]! + 0.35 * Math.exp(-t * 22) * noise();
				l[i] = l[i]! + 0.15 * Math.exp(-t * 3) * Math.sin(tau * bassF * t);
			}
			for (let h = 0; h < 2; h++) {
				const hs = start + Math.floor((h * beat) / 2);
				for (let k = 0; k < Math.min(Math.floor(sr / 25), n - hs); k++)
					l[hs + k] = l[hs + k]! + 0.08 * Math.exp((-k / sr) * 120) * noise();
			}
		}
	}
	return { audio: [l, l.slice()], beats };
}

/**
 * Generated music with a known key, bar lines and drop (P6-E11 tests here and in the engine): `bars` bars of 4 beats.
 * Before `dropBar` (1-based) a quiet intro: a soft rim on every beat (louder on beat 1), hats on eighths and a soft
 * chord pad. From `dropBar` on the loud section: kick on 1 (and softer on 3), snare on 2 and 4, a bass note per beat,
 * hats and a louder pad. The chords follow I–V–vi–IV of `tonic` (pitch class, C = 0) major, or i–VI–III–VII minor.
 * Returns stereo audio and the true positions (samples): every beat, every downbeat and the drop's downbeat.
 */
export function dropMusic(
	sr: number,
	bpm: number,
	bars: number,
	dropBar: number,
	opts: { seed?: number; tonic?: number; mode?: 'major' | 'minor'; pad?: number } = {},
): { audio: Float32Array[]; beats: number[]; downbeats: number[]; drop: number } {
	const beat = (sr * 60) / bpm;
	const n = Math.round(bars * 4 * beat);
	const l = new Float32Array(n);
	let rng = (Math.imul(opts.seed ?? 11, 747796405) + 2891336453) >>> 0;
	const noise = () => {
		rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
		return ((rng >>> 8) / (1 << 24)) * 2 - 1;
	};
	const tonic = opts.tonic ?? 0;
	const mode = opts.mode ?? 'major';
	// chord roots (semitones over the tonic) and qualities
	const prog: [number, 'maj' | 'min'][] =
		mode === 'major'
			? [
					[0, 'maj'],
					[7, 'maj'],
					[9, 'min'],
					[5, 'maj'],
				]
			: [
					[0, 'min'],
					[8, 'maj'],
					[3, 'maj'],
					[10, 'maj'],
				];
	const tau = 2 * Math.PI;
	const beats: number[] = [];
	const downbeats: number[] = [];
	const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12);
	for (let bar = 0; bar < bars; bar++) {
		const loud = bar + 1 >= dropBar;
		const [root, q] = prog[bar % 4]!;
		const r = 60 + ((tonic + root) % 12);
		const notes = [r, r + (q === 'maj' ? 4 : 3), r + 7];
		const b0 = Math.round(bar * 4 * beat);
		const b1 = Math.min(n, Math.round((bar + 1) * 4 * beat));
		const padAmp = (opts.pad ?? 1) * (loud ? 0.05 : 0.02);
		for (let i = b0; i < b1; i++) {
			const t = (i - b0) / sr;
			const env = (1 - Math.exp(-t * 30)) * 0.9 ** t;
			let v = 0;
			for (const nt of notes) {
				const f = midiHz(nt);
				v += Math.sin((tau * f * i) / sr) + 0.3 * Math.sin((tau * 2 * f * i) / sr);
			}
			l[i] = l[i]! + padAmp * env * v;
		}
		for (let qn = 0; qn < 4; qn++) {
			const start = Math.round((bar * 4 + qn) * beat);
			beats.push(start);
			if (qn === 0) downbeats.push(start);
			const dur = Math.min(Math.floor(beat * 0.9), n - start);
			const bassF = midiHz(36 + ((tonic + root) % 12));
			for (let k = 0; k < dur; k++) {
				const t = k / sr;
				const i = start + k;
				if (loud) {
					if (qn === 0 || qn === 2) {
						const f = 50 + 90 * Math.exp(-t * 25);
						l[i] = l[i]! + (qn === 0 ? 0.9 : 0.55) * Math.exp(-t * 9) * Math.sin(tau * f * t);
					} else if (t < 0.2) l[i] = l[i]! + 0.35 * Math.exp(-t * 22) * noise();
					l[i] = l[i]! + 0.15 * Math.exp(-t * 3) * Math.sin(tau * bassF * t);
				} else if (t < 0.05) l[i] = l[i]! + (qn === 0 ? 0.3 : 0.12) * Math.exp(-t * 90) * noise();
			}
			for (let h = 0; h < 2; h++) {
				const hs = start + Math.floor((h * beat) / 2);
				for (let k = 0; k < Math.min(Math.floor(sr / 25), n - hs); k++)
					l[hs + k] = l[hs + k]! + (loud ? 0.08 : 0.03) * Math.exp((-k / sr) * 120) * noise();
			}
		}
	}
	return { audio: [l, l.slice()], beats, downbeats, drop: downbeats[dropBar - 1]! };
}
