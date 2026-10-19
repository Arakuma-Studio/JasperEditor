// Export time of a loudness-normalised delivery (wp-note sound-design "Fix: preview loudness parity, codec-aware Sound
// Check, delivery speed"): 10 s mixes — the typical programme (voice, bed, two hits) and the loud stress fixture —
// exported to H.264 + AAC (128 / 256 kb/s), VP9 + Opus 160 and ProRes + PCM, normalised to the Web target (−14 LUFS /
// −1 dBTP), and the same export without normalisation. Each run exports a mix of its own (a 1e-6 gain step per run), so
// no delivery is reused; `warm` exports the same mix twice and times the second (the delivery cache). A benchmark, not a
// gate: it runs only with JASPER_DELIVERY_BENCH=1:
//   JASPER_DELIVERY_BENCH=1 pnpm vitest run apps/engine/test/delivery-speed.bench.test.ts --maxWorkers=1
// and prints one line per case (median of JASPER_DELIVERY_BENCH_RUNS, default 3).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, JSON_H, makeApp, register, type TestApp } from './helpers.ts';
import { loudMix, typicalMix, writeMixWav } from './loud-fixture.ts';

const RUN = process.env.JASPER_DELIVERY_BENCH === '1';
const RUNS = Number(process.env.JASPER_DELIVERY_BENCH_RUNS ?? 3);
const ONLY = process.env.JASPER_DELIVERY_BENCH_ONLY ?? '';

describe.runIf(RUN)('delivery export time (benchmark)', { timeout: 3_600_000 }, () => {
	let app: TestApp;
	let dir: string;
	let n = 0;
	beforeAll(async () => {
		app = await makeApp();
		dir = mkdtempSync(join(tmpdir(), 'jasper-deliver-bench-'));
	}, 120_000);
	afterAll(closeApps);

	function wavOf(kind: 'loud' | 'typical', run: number): string {
		const mix = (kind === 'loud' ? loudMix : typicalMix)(10);
		const k = 1 + run * 1e-6;
		for (const c of mix) for (let i = 0; i < c.length; i++) c[i] = c[i]! * k;
		return writeMixWav(join(dir, `${kind}-${run}-${n++}.wav`), mix);
	}

	async function exportMs(wav: string, audio: Record<string, unknown>, container: string): Promise<number> {
		const d = new DocBuilder();
		const m = d.addMedia(await register(app, wav));
		d.tx([{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { audio: 'A1' } }]);
		const settings = {
			sequenceId: d.seqId,
			range: { type: 'entire' },
			container,
			video: {
				codec: container === 'webm' ? 'vp9' : container === 'mov' ? 'prores' : 'h264',
				width: 320,
				height: 180,
				frameRate: { num: 30, den: 1 },
				scaling: 'fit',
				quality: { mode: 'crf', value: container === 'webm' ? 40 : 30 },
				encoderSpeed: 'fast',
				...(container === 'mov' ? { proresProfile: 'hq' } : {}),
			},
			audio: { sampleRate: 48000, channels: 2, ...audio },
			engine: 'native',
		};
		const t0 = performance.now();
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings },
		});
		expect(start.statusCode, start.body).toBe(202);
		const done = await coreServices(app).queue.wait(start.json().id);
		expect(done.error, JSON.stringify(done.error)).toBeUndefined();
		const ms = performance.now() - t0;
		if (process.env.JASPER_DELIVERY_BENCH_LOG === '1') {
			// the job's own account of the audio (export/service.ts renderAudio's log line)
			const entries = (coreServices(app).queue as unknown as { entries: Map<string, { logLines: string[] }> })
				.entries;
			const lines = entries.get(start.json().id)?.logLines.filter((l) => l.startsWith('audio:')) ?? [];
			console.log(`bench-log ${(ms / 1000).toFixed(2)} s ${lines.join(' | ')}`);
		}
		return ms;
	}

	const WEB = { targetLufs: -14, truePeakDb: -1 };
	const CASES: [string, Record<string, unknown>, string][] = [
		['aac 256, no normalisation', { codec: 'aac', bitrateKbps: 256, normalize: null }, 'mp4'],
		['aac 256, web', { codec: 'aac', bitrateKbps: 256, normalize: WEB }, 'mp4'],
		['aac 128, web', { codec: 'aac', bitrateKbps: 128, normalize: WEB }, 'mp4'],
		['opus 160, web', { codec: 'opus', bitrateKbps: 160, normalize: WEB }, 'webm'],
		['pcm, web', { codec: 'pcm', normalize: WEB }, 'mov'],
	];
	const fmt = (ms: number[]) => {
		const s = [...ms].sort((a, b) => a - b);
		return `median ${(s[Math.floor(s.length / 2)]! / 1000).toFixed(2)} s (runs ${ms.map((v) => (v / 1000).toFixed(2)).join(', ')})`;
	};
	for (const kind of ['typical', 'loud'] as const)
		for (const [name, audio, container] of CASES)
			it.runIf(!ONLY || `${kind} ${name}`.includes(ONLY))(`${kind}: ${name}`, async () => {
				const ms: number[] = [];
				for (let i = 0; i < RUNS; i++) ms.push(await exportMs(wavOf(kind, i), audio, container));
				console.log(`bench ${kind} ${name}: ${fmt(ms)}`);
			});
	for (const kind of ['typical', 'loud'] as const)
		it.runIf(!ONLY || `warm ${kind}`.includes(ONLY))(
			`warm ${kind}: aac 256, web (the same mix again)`,
			async () => {
				const ms: number[] = [];
				for (let i = 0; i < RUNS; i++) {
					const wav = wavOf(kind, 100 + i);
					await exportMs(wav, { codec: 'aac', bitrateKbps: 256, normalize: WEB }, 'mp4');
					ms.push(await exportMs(wav, { codec: 'aac', bitrateKbps: 256, normalize: WEB }, 'mp4'));
				}
				console.log(`bench warm ${kind} aac 256, web: ${fmt(ms)}`);
			},
		);
});
