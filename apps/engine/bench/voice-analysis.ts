// Run: pnpm exec tsx apps/engine/bench/voice-analysis.ts [minutes=60] [threads=1,2,4]
// Spec 14 TC-060: the `voice-analysis` job on an hour of audio (target ≤ 2 min on the build VM). The recording is
// synthetic and openly reproducible: a 60 s speech-like pattern (voiced harmonic tones of varying pitch and level,
// breath-like noise bursts, pauses over a −65 dBFS floor) looped to the length and encoded like an OBS recording
// (AAC-LC 160 kb/s, 48 kHz stereo, by FFmpeg's native LGPL encoder). Each thread count runs the real job (queue,
// FFmpeg decode, bundled worker threads, classification, atomic write) on an empty cache; the FFmpeg decode alone is
// timed for reference. Prints the machine, its load and the timings as JSON lines.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeWav } from '@jasper/audio-dsp';
import { build } from 'esbuild';
import { JobQueue } from '../src/jobs/queue.ts';
import type { MediaRecord, MediaRegistry } from '../src/media/registry.ts';
import { Ffmpeg, resolveBinaries } from '../src/tools/ffmpeg.ts';
import { findVendorDir } from '../src/tools/lgpl.ts';
import { VoiceAnalysisService } from '../src/voice/service.ts';

const minutes = Number(process.argv[2] ?? 60);
const threadSets = (process.argv[3] ?? '1,2,4').split(',').map(Number);
const SR = 16_000;
const dir = join(tmpdir(), 'jasper-voice-bench');
mkdirSync(dir, { recursive: true });
const bins = resolveBinaries({ vendorDir: findVendorDir({}) });
const ff = new Ffmpeg(bins);

function pattern(): Float32Array {
	const n = 60 * SR;
	const x = new Float32Array(n);
	let s = 1;
	const rnd = () => {
		s ^= s << 13;
		s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		return (s / 2 ** 32) * 2 - 1;
	};
	let phase = 0;
	for (let i = 0; i < n; i++) {
		const t = i / SR;
		x[i] = rnd() * 10 ** (-65 / 20) * Math.sqrt(3);
		const c = t % 3.7;
		if (c < 2.2) {
			// syllables: 5 Hz amplitude modulation, pitch gliding 100–220 Hz
			const f0 = 100 + 60 * (1 + Math.sin(t * 0.9)) ;
			phase += (2 * Math.PI * f0) / SR;
			const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 5 * t);
			let v = 0;
			for (let h = 1; h * f0 < 3500; h++) v += Math.sin(phase * h) / h;
			x[i]! += 0.06 * env * v;
		} else if (c > 2.6 && c < 2.95) x[i]! += rnd() * 0.004;
	}
	return x;
}

const pat = join(dir, 'pattern.wav');
const rec = join(dir, `recording-${minutes}min.m4a`);
if (!existsSync(rec)) {
	writeFileSync(pat, encodeWav([pattern()], SR, 'f32'));
	const r = spawnSync(
		bins.ffmpeg!,
		[
			...['-v', 'error', '-y', '-stream_loop', String(minutes - 1), '-i', pat],
			...['-ar', '48000', '-ac', '2', '-c:a', 'aac', '-b:a', '160k', rec],
		],
		{ encoding: 'utf8' },
	);
	if (r.status !== 0) throw new Error(r.stderr);
}
const worker = join(dir, 'voice-worker.mjs');
await build({
	entryPoints: [fileURLToPath(new URL('../src/voice/worker.ts', import.meta.url))],
	outfile: worker,
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	logLevel: 'silent',
});

console.log(
	JSON.stringify({
		node: process.version,
		cpu: cpus()[0]?.model,
		cores: cpus().length,
		load: loadavg(),
		ffmpeg: bins.ffmpeg,
		recording: { minutes, bytes: statSync(rec).size, codec: 'aac 160k 48 kHz stereo' },
	}),
);

{
	const t0 = performance.now();
	const r = spawnSync(bins.ffmpeg!, ['-v', 'error', '-i', rec, '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-f', 'null', '-']);
	if (r.status !== 0) throw new Error(String(r.stderr));
	console.log(JSON.stringify({ step: 'ffmpeg decode + resample only', seconds: (performance.now() - t0) / 1000 }));
}

const record = {
	mediaKey: 'mk_000000000000000000000001',
	fingerprint: `q1:${'0'.repeat(63)}1`,
	originalName: 'recording.m4a',
	sizeBytes: statSync(rec).size,
	mtimeMs: 0,
	durationSec: minutes * 60,
	probe: { streams: [{ index: 0, type: 'audio' }] },
} as unknown as MediaRecord;
const registry = {
	get: (k: string) => (k === record.mediaKey ? record : undefined),
	resolvePath: async () => rec,
} as unknown as MediaRegistry;

for (const threads of threadSets) {
	const cache = join(dir, `cache-${threads}`);
	rmSync(cache, { recursive: true, force: true });
	const queue = new JobQueue({ journalPath: null, tmpDir: join(dir, 'jobs'), totalSlots: threads });
	queue.start();
	const svc = new VoiceAnalysisService({ queue, ffmpeg: ff, registry }, cache, {
		workerUrl: pathToFileURL(worker),
	});
	svc.registerRunner();
	const t0 = performance.now();
	const job = svc.submit(record.mediaKey, {});
	const done = await queue.wait(job.id);
	const seconds = (performance.now() - t0) / 1000;
	if (done.state !== 'succeeded') throw new Error(JSON.stringify(done.error));
	const r = done.result as { frameCount: number; seconds: Record<string, number>; bytes: number };
	console.log(
		JSON.stringify({
			step: 'voice-analysis job',
			threads,
			seconds,
			realtime: (minutes * 60) / seconds,
			frames: r.frameCount,
			bytes: r.bytes,
			classSeconds: r.seconds,
			load: loadavg(),
		}),
	);
	await queue.shutdown();
}
