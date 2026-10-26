// Spec 16 SG-040 on real NVIDIA hardware (opt-in: SPEECH_GPU_E2E=1 on Linux x64 with an NVIDIA GPU, the CUDA 13
// runtime and cuDNN 9 on the loader path, and JASPER_SPEECH_MODELS_DIR holding whisper-tiny.en and
// whisper-large-v3-turbo; whisper-large-v3-turbo-fp16 is used when present): "Enable NVIDIA GPU" downloads the
// provider through the engine, the probe finds CUDA, the encoder runs on CUDA with the decoder calibrated (greedy),
// CPU and GPU transcripts of the LJ fixture agree, a GPU fault mid-job reruns on the CPU, and WER/RTF are logged.
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineJob, SpeechProbe, TranscriptionResult } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApps, JSON_H, makeApp, ROOT, register, type TestApp, until } from './helpers.ts';
import { wordErrorRate } from './speech-wer.ts';

const MODELS = process.env.JASPER_SPEECH_MODELS_DIR ?? '';
const enabled =
	process.env.SPEECH_GPU_E2E === '1' &&
	process.platform === 'linux' &&
	process.arch === 'x64' &&
	existsSync(join(MODELS, 'whisper-tiny.en')) &&
	existsSync(join(MODELS, 'whisper-large-v3-turbo'));
const FIXTURE = join(ROOT, 'fixtures', 'speech', 'lj-composite.flac');
const truth = JSON.parse(readFileSync(FIXTURE.replace(/\.flac$/, '.json'), 'utf8')) as {
	utterances: Array<{ text: string }>;
};
const reference = truth.utterances.map((u) => u.text).join(' ');
const H = { host: '127.0.0.1:47900' };
let app: TestApp;
let mediaKey = '';

async function job(id: string, timeoutMs = 1_200_000): Promise<EngineJob> {
	return until(
		async () => {
			const j = (await app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: H })).json() as EngineJob;
			return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.state) ? j : null;
		},
		timeoutMs,
		250,
	);
}

async function transcribe(payload: Record<string, unknown>): Promise<TranscriptionResult> {
	const r = await app.inject({
		method: 'POST',
		url: `/api/media/${mediaKey}/transcribe`,
		headers: JSON_H,
		payload: { language: 'en', ...payload },
	});
	expect(r.statusCode, r.body).toBe(202);
	const done = await job((r.json() as EngineJob).id);
	expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
	return done.result as TranscriptionResult;
}

const text = (r: TranscriptionResult) => r.words.map((w) => w.text).join(' ');

describe.skipIf(!enabled)('speech on a real NVIDIA GPU (spec 16 SG-040)', () => {
	beforeAll(async () => {
		app = await makeApp({ totalSlots: 8 });
		const dir = join(app.appdir, 'models', 'speech');
		mkdirSync(dir, { recursive: true });
		for (const id of ['whisper-tiny.en', 'whisper-large-v3-turbo', 'whisper-large-v3-turbo-fp16'])
			if (existsSync(join(MODELS, id))) symlinkSync(join(MODELS, id), join(dir, id), 'dir');
		mediaKey = (await register(app, FIXTURE)).mediaKey;
	}, 120_000);
	afterAll(async () => {
		await closeApps();
	});

	it('Enable NVIDIA GPU: downloads the provider through the engine; the probe then finds CUDA', async () => {
		const before = (await app.inject({ method: 'GET', url: '/api/speech/cuda', headers: H })).json() as {
			state: string;
			runtime: { ok: boolean; missing: string[]; gpu: string | null; driverVersion: string | null };
		};
		console.log(`CUDA status before: ${JSON.stringify(before)}`);
		expect(before.runtime.ok, JSON.stringify(before.runtime.missing)).toBe(true);
		const r = await app.inject({ method: 'POST', url: '/api/speech/cuda/install', headers: H });
		const done = await job((r.json() as EngineJob).id);
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		const probe = (
			await app.inject({ method: 'GET', url: '/api/speech/probe', headers: H })
		).json() as SpeechProbe;
		console.log(
			`probe: ${JSON.stringify({ providers: probe.providers, chosen: probe.chosen, gpu: probe.gpu, threads: probe.threads })}`,
		);
		expect(probe.cuda.state).toBe('installed');
		expect(probe.providers.find((p) => p.id === 'cuda')).toMatchObject({ available: true });
		expect(probe.chosen.encoder).toBe('cuda');
		expect(probe.gpu?.vramMb).toBeGreaterThan(0);
	}, 1_200_000);

	it('tiny.en: encoder on CUDA, decoder calibrated; the GPU transcript matches the CPU one', async () => {
		const gpu = await transcribe({ model: 'whisper-tiny.en', device: 'gpu' });
		const cpu = await transcribe({ model: 'whisper-tiny.en', device: 'cpu' });
		const cal = (
			(await app.inject({ method: 'GET', url: '/api/speech/probe', headers: H })).json() as SpeechProbe
		).calibrations.find((c) => c.modelId === 'whisper-tiny.en');
		const parity = wordErrorRate(text(cpu), text(gpu));
		console.log(
			`tiny.en GPU ${gpu.device?.label} rtf ${gpu.timings.rtf} WER ${(wordErrorRate(reference, text(gpu)) * 100).toFixed(2)} %; CPU rtf ${cpu.timings.rtf} WER ${(wordErrorRate(reference, text(cpu)) * 100).toFixed(2)} %; CPU-vs-GPU word difference ${(parity * 100).toFixed(2)} %, identical ${text(cpu) === text(gpu)}; calibration ${JSON.stringify(cal)}`,
		);
		expect(gpu.device?.encoder).toBe('cuda');
		expect(gpu.device?.fallbacks).toEqual([]);
		expect(cpu.device).toMatchObject({ encoder: 'cpu', decoder: 'cpu' });
		expect(cal).toMatchObject({ provider: 'cuda' });
		expect(cal!.cpuMsPerToken).toBeGreaterThan(0);
		expect(cal!.gpuMsPerToken).toBeGreaterThan(0);
		expect(parity).toBeLessThanOrEqual(0.02);
		// the second greedy job uses the stored decision (no new calibration)
		const again = await transcribe({ model: 'whisper-tiny.en', device: 'gpu' });
		expect(again.device?.decoder).toBe(cal!.decoder);
	}, 1_200_000);

	it('a GPU fault mid-job reruns the job on the CPU and the result says so', async () => {
		process.env.JASPER_SPEECH_GPU_FAULT_AFTER = '2';
		try {
			const r = await transcribe({ model: 'whisper-tiny.en', device: 'gpu' });
			console.log(`fault: ${JSON.stringify(r.device)}`);
			expect(r.device).toMatchObject({ encoder: 'cpu', decoder: 'cpu' });
			expect(r.device?.fallbacks).toContainEqual(
				expect.objectContaining({ stage: 'job', from: 'cuda', to: 'cpu' }),
			);
			expect(wordErrorRate(reference, text(r))).toBeLessThanOrEqual(0.04);
		} finally {
			delete process.env.JASPER_SPEECH_GPU_FAULT_AFTER;
		}
	}, 1_200_000);

	it('large-v3-turbo on CUDA (greedy, beam 5, fp16) vs the CPU: WER, RTF and text parity', async () => {
		const runs: Array<[string, TranscriptionResult]> = [];
		runs.push(['gpu standard', await transcribe({ model: 'whisper-large-v3-turbo', device: 'gpu' })]);
		runs.push([
			'gpu standard (calibrated)',
			await transcribe({ model: 'whisper-large-v3-turbo', device: 'gpu' }),
		]);
		runs.push([
			'gpu best',
			await transcribe({ model: 'whisper-large-v3-turbo', device: 'gpu', accuracy: 'best' }),
		]);
		runs.push(['cpu standard', await transcribe({ model: 'whisper-large-v3-turbo', device: 'cpu' })]);
		if (existsSync(join(MODELS, 'whisper-large-v3-turbo-fp16')))
			runs.push([
				'gpu fp16 standard',
				await transcribe({ model: 'whisper-large-v3-turbo-fp16', device: 'gpu' }),
			]);
		const cal = (
			(await app.inject({ method: 'GET', url: '/api/speech/probe', headers: H })).json() as SpeechProbe
		).calibrations;
		for (const [name, r] of runs)
			console.log(
				`turbo ${name}: ${r.device?.label} (threads ${r.device?.threads}) rtf ${r.timings.rtf} load ${r.timings.loadMs} ms WER ${(wordErrorRate(reference, text(r)) * 100).toFixed(2)} % fallbacks ${JSON.stringify(r.device?.fallbacks)}`,
			);
		console.log(`calibrations: ${JSON.stringify(cal)}`);
		const gpu = runs[0]![1];
		const cpu = runs.find(([n]) => n === 'cpu standard')![1];
		const parity = wordErrorRate(text(cpu), text(gpu));
		console.log(
			`turbo CPU-vs-GPU word difference ${(parity * 100).toFixed(2)} %, identical ${text(cpu) === text(gpu)}`,
		);
		for (const [name, r] of runs) {
			expect(wordErrorRate(reference, text(r)), name).toBeLessThanOrEqual(0.04);
			if (name.startsWith('gpu')) expect(r.device?.encoder, name).toBe('cuda');
		}
		expect(parity).toBeLessThanOrEqual(0.02);
	}, 3_600_000);

	it('WebGPU (NVIDIA GPU support off): encoder on WebGPU, device-resident decoder calibrated, CPU parity', async () => {
		await app.inject({
			method: 'PUT',
			url: '/api/speech/settings',
			headers: JSON_H,
			payload: { nvidiaGpu: false },
		});
		const probe = (
			await app.inject({ method: 'POST', url: '/api/speech/probe', headers: H })
		).json() as SpeechProbe;
		console.log(
			`probe without CUDA: ${JSON.stringify({ providers: probe.providers, chosen: probe.chosen })}`,
		);
		const webgpu = probe.providers.find((p) => p.id === 'webgpu');
		if (!webgpu?.available) {
			console.log(`WebGPU unavailable here: ${webgpu?.reason}`);
			return;
		}
		expect(probe.chosen.encoder).toBe('webgpu');
		const runs: Array<[string, TranscriptionResult]> = [];
		for (const model of ['whisper-tiny.en', 'whisper-large-v3-turbo']) {
			runs.push([`${model} gpu`, await transcribe({ model, device: 'gpu' })]);
			runs.push([`${model} gpu (calibrated)`, await transcribe({ model, device: 'gpu' })]);
			runs.push([`${model} cpu`, await transcribe({ model, device: 'cpu' })]);
		}
		const cal = (
			(await app.inject({ method: 'GET', url: '/api/speech/probe', headers: H })).json() as SpeechProbe
		).calibrations.filter((c) => c.provider === 'webgpu');
		for (const [name, r] of runs)
			console.log(
				`webgpu run ${name}: ${r.device?.label} rtf ${r.timings.rtf} WER ${(wordErrorRate(reference, text(r)) * 100).toFixed(2)} % fallbacks ${JSON.stringify(r.device?.fallbacks)}`,
			);
		console.log(`webgpu calibrations: ${JSON.stringify(cal)}`);
		for (const model of ['whisper-tiny.en', 'whisper-large-v3-turbo']) {
			const gpu = runs.find(([n]) => n === `${model} gpu (calibrated)`)![1];
			const cpu = runs.find(([n]) => n === `${model} cpu`)![1];
			const parity = wordErrorRate(text(cpu), text(gpu));
			console.log(
				`${model} WebGPU-vs-CPU word difference ${(parity * 100).toFixed(2)} %, identical ${text(cpu) === text(gpu)}`,
			);
			expect(gpu.device?.encoder).toBe('webgpu');
			expect(gpu.device?.fallbacks).toEqual([]);
			expect(parity).toBeLessThanOrEqual(0.02);
		}
		expect(cal.length).toBe(2);
	}, 3_600_000);
});
