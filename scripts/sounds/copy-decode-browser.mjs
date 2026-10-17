#!/usr/bin/env node
// WP6.5b evidence (wp-note: FLAC vs WAV for the managed copies of library sounds): decodes generated sounds in a real
// browser the way the web app's scrub / Detect Peak decoder does (mediabunny `AudioBufferSink.buffers(t0 − 0.05, t1)`,
// samples placed by timestamp; apps/web/src/audio/browser-decode.ts) at many In points, and compares them with
// ffmpeg's full decode sample for sample. A format is fit for the copies only when every In point is bit-exact.
//
//   node scripts/sounds/copy-decode-browser.mjs                 Playwright's bundled Chromium
//   CHANNEL=chrome node scripts/sounds/copy-decode-browser.mjs  Google Chrome (the E2E suite's browser)
//
// Needs ffmpeg on PATH (or FFMPEG=…) and a Playwright browser. Writes only into a temp directory; prints one JSON line
// per format: {file, canDecode, points, exact, worstAbsDiff}.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(join(root, 'package.json'));
const { chromium } = require('@playwright/test');
// the web app's own mediabunny (apps/web depends on it)
const mediabunny = createRequire(join(root, 'apps/web/package.json'))
	.resolve('mediabunny')
	.replace(/dist[\\/].*$/, 'dist/bundles/mediabunny.mjs');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const SR = 48_000;
const dir = mkdtempSync(join(tmpdir(), 'jasper-copy-decode-'));
const ff = (args) => execFileSync(FFMPEG, ['-v', 'error', '-y', ...args]);

const noise = (seed) => [
	'-f',
	'lavfi',
	'-i',
	`anoisesrc=d=12:c=pink:r=${SR}:a=0.3:s=${seed},aformat=channel_layouts=stereo`,
];
ff([...noise(1), '-c:a', 'pcm_s16le', join(dir, 's16.wav')]);
ff([...noise(2), '-c:a', 'pcm_s24le', join(dir, 's24.wav')]);
ff(['-i', join(dir, 's16.wav'), '-c:a', 'flac', join(dir, 's16.flac')]);
ff(['-i', join(dir, 's24.wav'), '-c:a', 'flac', join(dir, 's24.flac')]);
const vorbis = execFileSync(FFMPEG, ['-hide_banner', '-encoders']).toString().includes('libvorbis')
	? ['-c:a', 'libvorbis', '-q:a', '4']
	: ['-c:a', 'vorbis', '-strict', '-2'];
ff(['-i', join(dir, 's16.wav'), ...vorbis, join(dir, 'v.ogg')]);
ff(['-i', join(dir, 'v.ogg'), '-c:a', 'pcm_f32le', join(dir, 'f32.wav')]);
const files = ['s16.wav', 's24.wav', 'f32.wav', 's16.flac', 's24.flac', 'v.ogg'];
for (const f of files) ff(['-i', join(dir, f), '-f', 'f32le', join(dir, `${f}.raw`)]);

const types = { wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg' };
const server = http.createServer((req, res) => {
	const path = new URL(req.url, 'http://x').pathname;
	if (path === '/')
		return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>x</title>');
	if (path === '/mb.mjs')
		return res.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync(mediabunny));
	let buf;
	try {
		buf = readFileSync(join(dir, path.slice(1).replace(/[\\/]/g, '')));
	} catch {
		return res.writeHead(404).end();
	}
	const type = types[path.split('.').pop()] ?? 'application/octet-stream';
	const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
	if (!m) return res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes' }).end(buf);
	const a = Number(m[1]);
	const b = m[2] ? Number(m[2]) : buf.length - 1;
	res
		.writeHead(206, {
			'content-type': type,
			'content-range': `bytes ${a}-${b}/${buf.length}`,
			'accept-ranges': 'bytes',
		})
		.end(buf.subarray(a, b + 1));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {});
try {
	const page = await browser.newPage();
	await page.goto(`http://127.0.0.1:${server.address().port}/`);
	const out = await page.evaluate(async (list) => {
		const mb = await import('/mb.mjs');
		const res = [];
		let seed = 7;
		const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
		for (const f of list) {
			const ref = new Float32Array(await (await fetch(`/${f}.raw`)).arrayBuffer());
			const input = new mb.Input({ source: new mb.UrlSource(`/${f}`), formats: mb.ALL_FORMATS });
			const track = await input.getPrimaryAudioTrack();
			const rate = track.sampleRate;
			const nch = track.numberOfChannels;
			const points = [0, 1, 127, 128, 129, 1013, 4095, 4096, 4097, 4608, 47_999];
			for (let i = 0; i < 25; i++) points.push(Math.floor(rnd() * rate * 11));
			let exact = 0;
			let worst = 0;
			for (const s of points) {
				const n = 4800;
				const t0 = s / rate;
				const data = Array.from({ length: nch }, () => new Float32Array(n));
				for await (const wb of new mb.AudioBufferSink(track).buffers(Math.max(0, t0 - 0.05), t0 + n / rate)) {
					const b = wb.buffer;
					const off = Math.round((wb.timestamp - t0) * rate);
					for (let c = 0; c < Math.min(nch, b.numberOfChannels); c++) {
						const src = b.getChannelData(c);
						const from = Math.max(0, -off);
						const to = Math.min(src.length, n - off);
						if (to > from) data[c].set(src.subarray(from, to), off + from);
					}
				}
				let d = 0;
				for (let i = 0; i < n; i++)
					for (let c = 0; c < nch; c++) d = Math.max(d, Math.abs(data[c][i] - ref[(s + i) * nch + c]));
				if (d === 0) exact++;
				worst = Math.max(worst, d);
			}
			res.push({
				file: f,
				canDecode: await track.canDecode(),
				points: points.length,
				exact,
				worstAbsDiff: worst,
			});
		}
		return res;
	}, files);
	console.log(`browser ${browser.version()}`);
	for (const r of out) console.log(JSON.stringify(r));
} finally {
	await browser.close();
	server.close();
	rmSync(dir, { recursive: true, force: true });
}
