#!/usr/bin/env node
// jasper-clap: the Describe-it search model in its own process (spec 12 P6-E14, WP-E9; heavy work never runs in the
// engine process, D-07). Long-lived: the engine keeps it while it has work and ends it when idle (runtime.ts).
//
//   jasper-clap <modelDir> [threads]
//
// Requests are NDJSON lines on stdin, answers NDJSON lines on stdout, in order:
//   {"id":1,"op":"text","texts":["glass shattering"]}                     → {"id":1,"ok":true,"vectors":"<base64 f32>"}
//   {"id":2,"op":"audio","input":{"path":…,"ffmpeg":…},"windows":[{"startSec":0,"endSec":3.2}]}
//                                                                         → {"id":2,"ok":true,"vectors":"<base64 f32>"}
//   {"id":3,"op":"levels","input":{…},"windows":[…],"trim":true}         → {"id":3,"ok":true,"levels":[{startSec,endSec,headDb,tailDb,trimmed}]}
//   failures: {"id":…,"ok":false,"code":"…","message":"…"}
// Vectors are 512 float32 per text / window, unit length, little-endian. It exits when stdin closes (0), on a bad
// argument (2), or on SIGTERM / SIGINT (130).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { CLAP_RATE, CLAP_WINDOW_SEC } from '../frontend.ts';
import { edgeLevels, trimToSound } from '../levels.ts';
import { ClapModel } from './clap.ts';

type Win = { startSec: number; endSec: number };
type Input = { path: string; ffmpeg: string; stream?: number };
type Req =
	| { id: number; op: 'text'; texts: string[] }
	| { id: number; op: 'audio'; input: Input; windows: Win[] }
	| { id: number; op: 'levels'; input: Input; windows: Win[]; trim?: boolean };

const [dir, threadsArg] = process.argv.slice(2);
if (!dir) {
	process.stderr.write('usage: jasper-clap <modelDir> [threads]\n');
	process.exit(2);
}
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => process.exit(130));
const model = new ClapModel(dir, Number(threadsArg) || 2);

/** Mono 48 kHz float32 of `[startSec, startSec + durSec)` of the input's audio stream. */
function decode(input: Input, startSec: number, durSec: number): Promise<Float32Array> {
	const args = ['-v', 'error', '-nostdin'];
	if (startSec > 0) args.push('-ss', startSec.toFixed(6));
	args.push('-t', Math.max(0.001, durSec).toFixed(6), '-i', input.path);
	args.push('-map', input.stream !== undefined ? `0:${input.stream}` : '0:a:0');
	args.push('-vn', '-ac', '1', '-ar', String(CLAP_RATE), '-f', 'f32le', 'pipe:1');
	return new Promise((resolve, reject) => {
		const child = spawn(input.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		const chunks: Buffer[] = [];
		let err = '';
		child.stdout.on('data', (c: Buffer) => chunks.push(c));
		child.stderr.on('data', (c: Buffer) => {
			if (err.length < 2000) err += c.toString();
		});
		child.on('error', reject);
		child.on('close', (code) => {
			if (code !== 0)
				return reject(
					Object.assign(new Error(`ffmpeg could not decode the audio: ${err.trim() || `exit ${code}`}`), {
						code: 'DECODE_FAILED',
					}),
				);
			const b = Buffer.concat(chunks);
			const out = new Float32Array(Math.floor(b.byteLength / 4));
			for (let i = 0; i < out.length; i++) out[i] = b.readFloatLE(i * 4);
			resolve(out);
		});
	});
}

/** The samples of each window: one decode of their span when they lie close together, else one per window. */
async function windowsOf(input: Input, windows: Win[]): Promise<Float32Array[]> {
	if (!windows.length) return [];
	const lo = Math.min(...windows.map((w) => w.startSec));
	const hi = Math.max(...windows.map((w) => w.endSec));
	const total = windows.reduce((s, w) => s + (w.endSec - w.startSec), 0);
	if (hi - lo <= Math.max(120, 3 * total) && hi - lo <= 600) {
		const all = await decode(input, lo, hi - lo);
		return windows.map((w) => {
			const a = Math.max(0, Math.round((w.startSec - lo) * CLAP_RATE));
			const b = Math.min(all.length, Math.round((w.endSec - lo) * CLAP_RATE));
			return all.slice(Math.min(a, b), b);
		});
	}
	const out: Float32Array[] = [];
	for (const w of windows) out.push(await decode(input, w.startSec, w.endSec - w.startSec));
	return out;
}

function valid(windows: unknown): windows is Win[] {
	return (
		Array.isArray(windows) &&
		windows.length <= 256 &&
		windows.every(
			(w) =>
				w &&
				Number.isFinite(w.startSec) &&
				Number.isFinite(w.endSec) &&
				w.startSec >= 0 &&
				w.endSec > w.startSec &&
				w.endSec - w.startSec <= CLAP_WINDOW_SEC + 1e-6,
		)
	);
}

const b64 = (vs: Float32Array[]) => {
	const all = new Float32Array(vs.length * (vs[0]?.length ?? 0));
	for (let i = 0; i < vs.length; i++) all.set(vs[i]!, i * vs[i]!.length);
	return Buffer.from(all.buffer, all.byteOffset, all.byteLength).toString('base64');
};

async function handle(r: Req): Promise<Record<string, unknown>> {
	if (r.op === 'text') {
		if (!Array.isArray(r.texts) || r.texts.length > 512 || !r.texts.every((t) => typeof t === 'string'))
			throw Object.assign(new Error('texts must be at most 512 strings'), { code: 'INVALID_REQUEST' });
		return { vectors: b64(await model.embedTexts(r.texts.map((t) => t.slice(0, 1000)))) };
	}
	if (r.op !== 'audio' && r.op !== 'levels')
		throw Object.assign(new Error('unknown op'), { code: 'INVALID_REQUEST' });
	if (!r.input || typeof r.input.path !== 'string' || typeof r.input.ffmpeg !== 'string' || !valid(r.windows))
		throw Object.assign(new Error('input and up to 256 windows of at most 10 s are required'), {
			code: 'INVALID_REQUEST',
		});
	const samples = await windowsOf(r.input, r.windows);
	if (r.op === 'audio') return { vectors: b64(await model.embedAudio(samples)) };
	return {
		levels: r.windows.map((w, i) => {
			let x = samples[i]!;
			let { startSec, endSec } = w;
			let trimmed = false;
			if (r.trim && x.length) {
				const t = trimToSound(x, CLAP_RATE);
				if (t.start > 0 || t.end < x.length) {
					trimmed = true;
					startSec = w.startSec + t.start / CLAP_RATE;
					endSec = w.startSec + t.end / CLAP_RATE;
					x = x.subarray(t.start, t.end);
				}
			}
			const round = (v: number) => Math.round(v * 1e6) / 1e6;
			return { startSec: round(startSec), endSec: round(endSec), trimmed, ...edgeLevels(x, CLAP_RATE) };
		}),
	};
}

const out = (o: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(o)}\n`);
const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
// One request at a time, in order (the engine sends the next after the answer).
let chain = Promise.resolve();
rl.on('line', (line) => {
	if (!line.trim()) return;
	chain = chain.then(async () => {
		let req: Req;
		try {
			req = JSON.parse(line) as Req;
		} catch {
			out({ id: null, ok: false, code: 'INVALID_REQUEST', message: 'not JSON' });
			return;
		}
		try {
			out({ id: req.id, ok: true, ...(await handle(req)) });
		} catch (e) {
			const err = e as Error & { code?: string };
			out({
				id: req?.id ?? null,
				ok: false,
				code: err.code ?? 'CLAP_FAILED',
				message: err.message ?? String(e),
			});
		}
	});
});
rl.on('close', () => {
	void chain.then(() => process.exit(0));
});
