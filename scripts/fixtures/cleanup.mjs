// Clean Up Voice fixture (spec 14 TC-070 e2e), original work generated here and never committed:
//   cleanup-voice.mp4  640×360 30 fps test pattern with a synthetic Spanish "recording" — no TTS, no recorded speech:
//                      every word is a voiced harmonic tone (f0 110–170 Hz, 8 harmonics, 20 ms attack, ≈ 70 ms
//                      decay) over a white-noise room floor (≈ −64 dBFS), the same synthesis as
//                      packages/project/test/cleanup-synth.ts. It says an abandoned take, the full line, a filler
//                      between pauses, then two more lines, with long pauses between.
// `cleanupVoiceWords()` returns the word timings (seconds) for the e2e transcript (`transcript.create`).
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';

const SR = 16_000;
export const CLEANUP_VOICE_EVENTS = [
	{ say: 'hoy vamos a crear un juego', keep: false },
	{ pauseS: 0.9 },
	{ say: 'hoy vamos a crear un juego de carreras', keep: true },
	{ pauseS: 1.2 },
	{ say: 'eh', keep: false },
	{ pauseS: 0.5 },
	{ say: 'primero diseñé la carretera con curvas', keep: true },
	{ pauseS: 1.5 },
	{ say: 'después programé los coches', keep: true },
	{ pauseS: 1.0 },
];

function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function layout(events, r) {
	const words = [];
	let t = 0.6;
	for (const ev of events) {
		if ('pauseS' in ev) {
			t += ev.pauseS;
			continue;
		}
		const f0 = 110 + r() * 60;
		for (const w of ev.say.split(/\s+/)) {
			const letters = w.replace(/[^\p{L}]/gu, '').length;
			const d = Math.min(0.6, Math.max(0.15, 0.06 + 0.055 * letters));
			words.push({ text: w, s: t, e: t + d, keep: ev.keep, f0 });
			t += d + 0.03 + r() * 0.04;
		}
		t += 0.25;
	}
	return { words, durationS: t + 1 };
}

/** The words of cleanup-voice.mp4: text, sound start / end (s), whether an editor keeps them. */
export function cleanupVoiceWords() {
	return layout(CLEANUP_VOICE_EVENTS, rng(11)).words.map(({ text, s, e, keep }) => ({ text, s, e, keep }));
}

function samples() {
	const r = rng(11);
	const { words, durationS } = layout(CLEANUP_VOICE_EVENTS, r);
	const out = new Float32Array(Math.round(durationS * SR));
	for (let i = 0; i < out.length; i++) out[i] = 0.0011 * (r() * 2 - 1);
	for (const w of words) {
		const a0 = Math.round(w.s * SR);
		const n = Math.round((w.e - w.s) * SR);
		const attack = 0.02 * SR;
		const decay = 0.07 * SR;
		for (let i = 0; i < n + decay * 3 && a0 + i < out.length; i++) {
			const t = i / SR;
			const env = i < attack ? i / attack : i < n ? 1 : Math.exp(-(i - n) / decay);
			if (i >= n && env < 1e-4) break;
			const f = w.f0 * (1 + 0.02 * Math.sin(2 * Math.PI * 5 * t));
			let x = 0;
			for (let k = 1; k <= 8; k++) x += Math.sin(2 * Math.PI * f * k * t) / k;
			out[a0 + i] += 0.12 * env * x * 0.5;
		}
	}
	return { out, durationS };
}

/** @param {import('./types.ts').FixtureContext} ctx */
export function fixtures({ ffmpeg, base, h264, aac }) {
	return [
		{
			name: 'cleanup-voice.mp4',
			recipe: 'cleanup-voice v1',
			make(out) {
				const { out: pcm, durationS } = samples();
				const raw = `${out}.f32`;
				writeFileSync(raw, Buffer.from(pcm.buffer));
				try {
					const r = spawnSync(
						ffmpeg,
						[
							...base,
							...['-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=30:duration=${durationS.toFixed(3)}`],
							...['-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', raw],
							...h264,
							...aac,
							...['-shortest', '-movflags', '+faststart', '-f', 'mp4', out],
						],
						{ stdio: ['ignore', 'inherit', 'inherit'] },
					);
					if (r.error || r.status !== 0) throw r.error ?? new Error(`ffmpeg exited ${r.status}`);
				} finally {
					rmSync(raw, { force: true });
				}
			},
		},
	];
}
