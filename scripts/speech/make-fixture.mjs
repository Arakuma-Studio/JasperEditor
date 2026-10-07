#!/usr/bin/env node
// Builds the committed speech fixture `fixtures/speech/lj-composite.*` (wp speech, end-to-end Whisper test).
//
// Source: the LJ Speech Dataset (Keith Ito and Linda Johnson, 2017), which is in the public domain (its readings
// come from LibriVox public-domain recordings of public-domain books). Twelve single-sentence clips are fetched
// from the Hugging Face dataset viewer mirror `MikhailT/lj-speech`, resampled to 16 kHz mono, trimmed to their
// speech (10 ms frames within 35 dB of the clip's peak, plus a 40 ms margin each side) and concatenated with
// known gaps of near-silence (a deterministic noise floor at about −74 dBFS runs under the whole file).
//
// The ground truth `lj-composite.json` lists, per utterance, the reference text and the measured speech onset
// and offset in the composite (seconds), so the test can check the first/last word bounds of every sentence
// and that no word crosses a gap. The composite is 75 s long: three Whisper windows, so it also exercises the
// long-audio seek/stitch path.
//
//   node scripts/speech/make-fixture.mjs [--ffmpeg /path/to/ffmpeg]
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(root, 'fixtures', 'speech');
const argv = process.argv.slice(2);
const ffmpeg = argv.includes('--ffmpeg') ? argv[argv.indexOf('--ffmpeg') + 1] : 'ffmpeg';
const SR = 16_000;
const FRAME = SR / 100;

/** Row indices in the `MikhailT/lj-speech` viewer (file names are recorded in the ground truth). */
const ROWS = [3, 1002, 6001, 8, 1007, 3007, 6005, 9009, 12008, 1001, 6008, 3010];
const GAPS = [0.6, 1.1, 0.8, 1.4, 0.9, 1.2, 0.75, 1.5, 1.0, 0.85, 1.3, 0.95, 0.7];

async function row(i) {
	for (let attempt = 0; attempt < 5; attempt++) {
		const r = await fetch(
			`https://datasets-server.huggingface.co/rows?dataset=MikhailT/lj-speech&config=default&split=full&offset=${i}&length=1`,
		);
		if (r.ok) {
			const j = await r.json();
			const x = j.rows[0].row;
			return { file: x.file, text: x.normalized_text, url: x.audio[0].src };
		}
		await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
	}
	throw new Error(`row ${i}: the dataset viewer did not answer`);
}

function decode(url) {
	const r = spawnSync(ffmpeg, ['-v', 'error', '-i', url, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], {
		maxBuffer: 1 << 28,
	});
	if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
	const b = r.stdout;
	return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

function frameDb(a) {
	const out = [];
	for (let i = 0; i + FRAME <= a.length; i += FRAME) {
		let e = 0;
		for (let k = 0; k < FRAME; k++) e += a[i + k] * a[i + k];
		out.push(10 * Math.log10(e / FRAME + 1e-12));
	}
	return out;
}

let seed = 12345;
const noise = () => {
	seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
	return (seed / 2 ** 32 - 0.5) * 0.00055;
};

const parts = [];
const utterances = [];
let t = 0;
const pushSilence = (sec) => {
	const n = Math.round(sec * SR);
	parts.push(new Float32Array(n));
	t += n;
};
pushSilence(GAPS[0]);
for (let k = 0; k < ROWS.length; k++) {
	const r = await row(ROWS[k]);
	const a = decode(r.url);
	const db = frameDb(a);
	const peak = Math.max(...db);
	const on = db.findIndex((v) => v > peak - 35);
	let off = db.length - 1;
	while (off > on && db[off] <= peak - 35) off--;
	const margin = 4; // frames
	const s = Math.max(0, (on - margin) * FRAME);
	const e = Math.min(a.length, (off + 1 + margin) * FRAME);
	const clip = a.slice(s, e);
	const fade = 80; // 5 ms
	for (let i = 0; i < fade; i++) {
		clip[i] *= i / fade;
		clip[clip.length - 1 - i] *= i / fade;
	}
	const start = (t + (on * FRAME - s)) / SR;
	const end = (t + ((off + 1) * FRAME - s)) / SR;
	parts.push(clip);
	t += clip.length;
	utterances.push({
		file: r.file,
		text: r.text,
		start: Math.round(start * 1000) / 1000,
		end: Math.round(end * 1000) / 1000,
	});
	console.log(`${r.file} ${start.toFixed(2)}–${end.toFixed(2)} ${r.text}`);
	pushSilence(GAPS[k + 1]);
}
const all = new Float32Array(t);
let o = 0;
for (const p of parts) {
	all.set(p, o);
	o += p.length;
}
for (let i = 0; i < all.length; i++) all[i] += noise();

mkdirSync(outDir, { recursive: true });
const raw = join(outDir, 'lj-composite.f32.tmp');
writeFileSync(raw, Buffer.from(all.buffer));
const enc = spawnSync(
	ffmpeg,
	[
		'-v',
		'error',
		'-y',
		'-f',
		'f32le',
		'-ar',
		String(SR),
		'-ac',
		'1',
		'-i',
		raw,
		'-c:a',
		'flac',
		'-sample_fmt',
		's16',
		join(outDir, 'lj-composite.flac'),
	],
	{ stdio: 'inherit' },
);
spawnSync('rm', ['-f', raw]);
if (enc.status !== 0) throw new Error('flac encode failed');
writeFileSync(
	join(outDir, 'lj-composite.json'),
	`${JSON.stringify(
		{
			source: 'LJ Speech Dataset 1.1 (public domain), via huggingface.co/datasets/MikhailT/lj-speech',
			sampleRate: SR,
			durationSeconds: Math.round((all.length / SR) * 1000) / 1000,
			utterances,
		},
		null,
		'\t',
	)}\n`,
);
console.log(`wrote ${join(outDir, 'lj-composite.flac')} (${(all.length / SR).toFixed(1)} s)`);
