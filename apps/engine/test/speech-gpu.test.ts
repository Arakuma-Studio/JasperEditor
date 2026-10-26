// Spec 16 SG-040: execution-provider policy, per-session fallbacks, mid-job GPU failure → CPU retry, decoder
// calibration and WebGPU device-resident decoding — all with a fake onnxruntime-node binding (no GPU needed).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	bestGpu,
	COREML_REASON,
	DML_REASON,
	deviceLabel,
	estimateRtf,
	gpuCandidates,
	type ProviderStatus,
	planDevices,
	policyExcluded,
	recommendModel,
	threadCap,
} from '../src/speech/providers.ts';
import { runSpeechJob } from '../src/speech/worker/run.ts';
import { createPartSession, fromHalf, toHalf } from '../src/speech/worker/sessions.ts';
import { chooseCalibratedDecoder, WhisperModel } from '../src/speech/worker/whisper.ts';
import { shortReason } from '../src/tools/ort.ts';
import { fakeModelDir, fakeOrt, noiseAudio } from './speech-fake-ort.ts';

const cpu: ProviderStatus = { id: 'cpu', available: true };
const GB = 1024 ** 3;

describe('provider policy (SG-001, SG-002, SG-005, SG-021)', () => {
	it('probes WebGPU on macOS, CUDA then WebGPU on Linux x64, WebGPU on Windows; never Core ML or DirectML', () => {
		expect(gpuCandidates('darwin', 'arm64')).toEqual(['webgpu']);
		expect(gpuCandidates('linux', 'x64')).toEqual(['cuda', 'webgpu']);
		expect(gpuCandidates('linux', 'arm64')).toEqual(['webgpu']);
		expect(gpuCandidates('win32', 'x64')).toEqual(['webgpu']);
		expect(policyExcluded('darwin', 'arm64')).toEqual(
			expect.arrayContaining([{ id: 'coreml', available: false, reason: COREML_REASON }]),
		);
		expect(policyExcluded('win32', 'x64')).toEqual(
			expect.arrayContaining([{ id: 'dml', available: false, reason: DML_REASON }]),
		);
		expect(policyExcluded('linux', 'x64').some((p) => p.id === 'cuda')).toBe(false);
		expect(policyExcluded('win32', 'x64').some((p) => p.id === 'cuda')).toBe(true);
	});

	it('encoder on the best GPU, decoder on the CPU unless a greedy calibration chose the GPU', () => {
		const providers: ProviderStatus[] = [
			{ id: 'cuda', available: true, device: 'RTX' },
			{ id: 'webgpu', available: true },
			cpu,
		];
		const base = { providers, order: ['cuda', 'webgpu'] as const, modelId: 'm', calibrations: [] };
		expect(planDevices({ ...base, order: [...base.order], request: 'auto', beamSize: 1 })).toEqual({
			encoder: 'cuda',
			decoder: 'cpu',
			calibrate: 'cuda',
			unavailableReason: null,
		});
		// beam search: no GPU decoder candidate
		expect(planDevices({ ...base, order: [...base.order], request: 'auto', beamSize: 5 })).toMatchObject({
			encoder: 'cuda',
			decoder: 'cpu',
			calibrate: null,
		});
		const calibrated = [{ modelId: 'm', provider: 'cuda' as const, decoder: 'cuda' as const }];
		expect(
			planDevices({
				...base,
				order: [...base.order],
				request: 'auto',
				beamSize: 1,
				calibrations: calibrated,
			}),
		).toMatchObject({ encoder: 'cuda', decoder: 'cuda', calibrate: null });
		expect(planDevices({ ...base, order: [...base.order], request: 'cpu', beamSize: 1 })).toMatchObject({
			encoder: 'cpu',
			decoder: 'cpu',
		});
		// CUDA gone: WebGPU
		const noCuda = providers.map((p) =>
			p.id === 'cuda' ? { ...p, available: false, reason: 'no libs' } : p,
		);
		expect(
			planDevices({ ...base, providers: noCuda, order: [...base.order], request: 'gpu', beamSize: 5 }),
		).toMatchObject({ encoder: 'webgpu', decoder: 'cpu' });
	});

	it('Processor GPU without a usable GPU runs on the CPU and says why', () => {
		const providers: ProviderStatus[] = [
			{ id: 'webgpu', available: false, reason: 'Failed to get a WebGPU adapter' },
			cpu,
		];
		const p = planDevices({
			providers,
			order: ['webgpu'],
			request: 'gpu',
			beamSize: 1,
			modelId: 'm',
			calibrations: [],
		});
		expect(p).toMatchObject({ encoder: 'cpu', decoder: 'cpu' });
		expect(p.unavailableReason).toContain('WebGPU: Failed to get a WebGPU adapter');
		expect(
			planDevices({
				providers,
				order: ['webgpu'],
				request: 'auto',
				beamSize: 1,
				modelId: 'm',
				calibrations: [],
			}).unavailableReason,
		).toBeNull();
		expect(bestGpu(providers, ['webgpu'])).toBeNull();
	});

	it('threads: the performance cores, at most 8', () => {
		expect(threadCap({ performanceCores: 10, logicalCores: 14 })).toBe(8);
		expect(threadCap({ performanceCores: 4, logicalCores: 8 })).toBe(4);
		expect(threadCap({ performanceCores: null, logicalCores: 16 })).toBe(8);
		expect(threadCap({ performanceCores: null, logicalCores: 2 })).toBe(2);
		fc.assert(
			fc.property(fc.option(fc.integer({ min: -4, max: 256 })), fc.integer({ min: 1, max: 512 }), (p, l) => {
				const t = threadCap({ performanceCores: p, logicalCores: l });
				return t >= 1 && t <= 8 && Number.isInteger(t);
			}),
		);
	});

	it('recommends turbo with a GPU (fp16 on CUDA ≥ 6 GB), turbo on a big CPU, else small', () => {
		const entries = [
			{ id: 'small', recommend: 'small' as const },
			{ id: 'turbo', recommend: 'turbo' as const },
			{ id: 'turbo16', recommend: 'turbo-fp16' as const },
		];
		const r = (gpu: Parameters<typeof recommendModel>[0]['gpu'], ram: number, cores: number) =>
			recommendModel({ entries, gpu, ramBytes: ram, cores });
		expect(r({ provider: 'cuda', vramMb: 12_288 }, 8 * GB, 4)).toBe('turbo16');
		expect(r({ provider: 'cuda', vramMb: 4096 }, 8 * GB, 4)).toBe('turbo');
		expect(r({ provider: 'webgpu', vramMb: 24_576 }, 8 * GB, 4)).toBe('turbo');
		expect(r(null, 32 * GB, 8)).toBe('turbo');
		expect(r(null, 16 * GB - 300 * 1024 ** 2, 8)).toBe('turbo'); // "16 GB" machines report a little less
		expect(r(null, 8 * GB, 16)).toBe('small');
		expect(r(null, 32 * GB, 4)).toBe('small');
		// a catalogue without tiers: its default
		expect(
			recommendModel({
				entries: [{ id: 'a' }, { id: 'b', default: true }],
				gpu: null,
				ramBytes: 0,
				cores: 1,
			}),
		).toBe('b');
	});

	it('speed estimates: GPU and greedy are faster, fewer threads slower; labels name the device', () => {
		const e = (o: Partial<Parameters<typeof estimateRtf>[0]>) =>
			estimateRtf({
				modelId: 'whisper-large-v3-turbo',
				parameters: 809,
				encoder: 'cpu',
				accuracy: 'best',
				threads: 8,
				...o,
			});
		expect(e({})).toBeCloseTo(0.454, 3);
		expect(e({ accuracy: 'standard' })).toBeLessThan(e({}));
		expect(e({ encoder: 'cuda' })).toBeLessThan(e({ encoder: 'webgpu' }));
		expect(e({ threads: 4 })).toBeGreaterThan(e({}));
		expect(e({ precision: 'fp16' })).toBeGreaterThan(e({}));
		expect(deviceLabel({ encoder: 'cuda', decoder: 'cpu' }, 'RTX 3060')).toBe(
			'RTX 3060 (CUDA) encoder · CPU decoder',
		);
		expect(deviceLabel({ encoder: 'cuda', decoder: 'cuda' }, 'RTX 3060')).toBe('RTX 3060 (CUDA)');
		expect(deviceLabel({ encoder: 'cpu', decoder: 'cpu' }, null)).toBe('CPU');
	});

	it('calibration keeps the GPU decoder only when clearly faster', () => {
		expect(chooseCalibratedDecoder({ cpuMsPerToken: 24, gpuMsPerToken: 15 }, 'cuda')).toBe('cuda');
		expect(chooseCalibratedDecoder({ cpuMsPerToken: 7.5, gpuMsPerToken: 10.6 }, 'webgpu')).toBe('cpu');
		expect(chooseCalibratedDecoder({ cpuMsPerToken: 10, gpuMsPerToken: 9.5 }, 'cuda')).toBe('cpu');
		expect(
			chooseCalibratedDecoder({ cpuMsPerToken: 10, gpuMsPerToken: Number.POSITIVE_INFINITY }, 'cuda'),
		).toBe('cpu');
	});

	it('short reasons drop ONNX Runtime source locations', () => {
		expect(
			shortReason(
				new Error(
					'/onnxruntime_src/onnxruntime/core/providers/webgpu/webgpu_context.cc:136 onnxruntime::webgpu::X adapter_result.status == wgpu::RequestAdapterStatus::Success was false. Failed to get a WebGPU adapter: No supported adapters',
				),
			),
		).toBe('Failed to get a WebGPU adapter: No supported adapters');
		expect(shortReason('plain\nsecond line')).toBe('plain');
	});
});

describe('sessions on a fake binding (SG-003, SG-004, fp16)', () => {
	it('a GPU session that cannot be created runs on the CPU with the reason', async () => {
		const f = fakeOrt({
			createError: (_part, p) => (p === 'cuda' ? 'libcudnn.so.9: cannot open shared object file' : null),
		});
		const s = await createPartSession(f.ort, '/m/encoder_model.onnx', { provider: 'cuda', threads: 4 });
		expect(s.provider).toBe('cpu');
		expect(s.fallback).toEqual({ from: 'cuda', reason: 'libcudnn.so.9: cannot open shared object file' });
		expect(f.sessions.map((x) => x.provider)).toEqual(['cpu']);
	});

	it('WebGPU device-resident decoding: cache outputs stay on the GPU, cached steps on a second session, other passes on the CPU', async () => {
		const f = fakeOrt();
		const plain = await createPartSession(f.ort, '/m/decoder_model_merged.onnx', {
			provider: 'cpu',
			threads: 2,
		});
		const s = await createPartSession(f.ort, '/m/decoder_model_merged.onnx', {
			provider: 'webgpu',
			threads: 2,
			deviceResident: true,
			plain,
		});
		expect(s.deviceResident).toBe(true);
		// plain (cpu) + released probe + full + steps
		const gpu = f.sessions.filter((x) => x.provider === 'webgpu');
		expect(gpu).toHaveLength(3);
		expect(gpu[0]!.released).toBe(true);
		const [full, steps] = [gpu[1]!, gpu[2]!];
		expect(full.location?.['present.0.decoder.key']).toBe('gpu-buffer');
		expect(full.location?.logits).toBe('cpu');
		expect(full.location?.['cross_attentions.0']).toBe('cpu');
		const T = (f.ort as unknown as { Tensor: new (...a: unknown[]) => unknown }).Tensor;
		const feeds = (cache: boolean) => ({
			input_ids: new T('int64', BigInt64Array.from([1n]), [1, 1]) as never,
			use_cache_branch: new T('bool', Uint8Array.from([cache ? 1 : 0]), [1]) as never,
		});
		await s.run(feeds(false), ['logits', 'present.0.decoder.key']);
		await s.run(feeds(true), ['logits', 'present.0.decoder.key']);
		await s.run(feeds(false), ['logits', 'cross_attentions.0']);
		expect(full.runs).toHaveLength(1);
		expect(steps.runs).toEqual([{ cached: true, fetches: ['logits', 'present.0.decoder.key'] }]);
		expect(f.sessions[0]!.runs).toHaveLength(1); // the alignment pass went to the CPU decoder
	});

	it('greedy recognition with a device-resident decoder disposes the replaced cache tensors', async () => {
		const dir = fakeModelDir();
		const f = fakeOrt();
		const m = await WhisperModel.load(dir, { ort: f.ort, encoder: 'webgpu', decoder: 'webgpu', threads: 2 });
		expect(m.providers).toEqual({ encoder: 'webgpu', decoder: 'webgpu' });
		await m.transcribe(
			noiseAudio(3, (t) => t % 1 < 0.6),
			{ language: 'en', beamSize: 1, temperatureFallback: false },
		);
		await m.release();
		const steps = f.sessions.filter((x) => x.provider === 'webgpu' && x.location).at(-1)!;
		expect(steps.runs.every((r) => r.cached)).toBe(true);
		expect(steps.runs.length).toBeGreaterThan(0);
		expect(f.disposed.length).toBeGreaterThan(0);
		await expect(
			(async () => {
				const m2 = await WhisperModel.load(dir, {
					ort: f.ort,
					encoder: 'cpu',
					decoder: 'webgpu',
					threads: 2,
				});
				try {
					await m2.transcribe(
						noiseAudio(3, (t) => t % 1 < 0.6),
						{ language: 'en', beamSize: 5 },
					);
				} finally {
					await m2.release();
				}
			})(),
		).rejects.toThrow(/beam search needs a CPU-resident decoder cache/);
	});

	it('float16 conversion round-trips within half precision', () => {
		fc.assert(
			fc.property(fc.float({ min: -60000, max: 60000, noNaN: true }), (v) => {
				const back = fromHalf(toHalf(v));
				return Math.abs(back - v) <= Math.max(Math.abs(v) * 2 ** -10, 2 ** -24);
			}),
		);
		expect(fromHalf(toHalf(1))).toBe(1);
		expect(fromHalf(toHalf(Number.POSITIVE_INFINITY))).toBe(Number.POSITIVE_INFINITY);
		expect(Number.isNaN(fromHalf(toHalf(Number.NaN)))).toBe(true);
		expect(fromHalf(toHalf(1e6))).toBe(Number.POSITIVE_INFINITY);
	});
});

describe('jobs on a fake binding (SG-002, SG-003, SG-011)', () => {
	it('a session that fails on the GPU is recorded and the job runs', async () => {
		const dir = fakeModelDir();
		const f = fakeOrt({
			createError: (part, p) => (part === 'encoder' && p === 'webgpu' ? 'no adapter' : null),
		});
		const out = await runSpeechJob(
			{
				modelDir: dir,
				modelId: 'fake',
				input: { f32: '' },
				language: 'en',
				device: { encoder: 'webgpu', decoder: 'cpu' },
			},
			{ ort: f.ort, audio: noiseAudio(3, (t) => t % 1 < 0.6) },
		);
		expect(out.device).toMatchObject({ encoder: 'cpu', decoder: 'cpu' });
		expect(out.device.fallbacks).toEqual([
			{ stage: 'session', part: 'encoder', from: 'webgpu', to: 'cpu', reason: 'no adapter' },
		]);
	});

	it('a GPU error mid-job runs the job once more on the CPU and the result says so', async () => {
		const dir = fakeModelDir();
		const f = fakeOrt({
			runError: (part, p) => (part === 'encoder' && p === 'webgpu' ? 'device lost' : null),
		});
		const devices: string[] = [];
		const out = await runSpeechJob(
			{
				modelDir: dir,
				modelId: 'fake',
				input: { f32: '' },
				language: 'en',
				device: { encoder: 'webgpu', decoder: 'cpu' },
			},
			{
				ort: f.ort,
				audio: noiseAudio(3, (t) => t % 1 < 0.6),
				onDevice: (d) => devices.push(`${d.encoder}/${d.decoder}#${d.attempt}`),
			},
		);
		expect(devices).toEqual(['webgpu/cpu#1', 'cpu/cpu#2']);
		expect(out.device).toMatchObject({ encoder: 'cpu', decoder: 'cpu' });
		expect(out.device.fallbacks).toContainEqual({
			stage: 'job',
			part: 'both',
			from: 'webgpu',
			to: 'cpu',
			reason: 'device lost',
		});
	});

	it('when the CPU retry fails too, the job fails with the original GPU error', async () => {
		const dir = fakeModelDir();
		const f = fakeOrt({
			runError: (part, p) =>
				part === 'encoder' ? (p === 'webgpu' ? 'device lost' : 'out of memory on the CPU') : null,
		});
		await expect(
			runSpeechJob(
				{
					modelDir: dir,
					modelId: 'fake',
					input: { f32: '' },
					language: 'en',
					device: { encoder: 'webgpu', decoder: 'cpu' },
				},
				{ ort: f.ort, audio: noiseAudio(3, (t) => t % 1 < 0.6) },
			),
		).rejects.toThrow('device lost');
	});

	it('a CPU failure is not retried', async () => {
		const dir = fakeModelDir();
		let runs = 0;
		const f = fakeOrt({ runError: (part) => (part === 'encoder' && ++runs > 0 ? 'broken model' : null) });
		await expect(
			runSpeechJob(
				{ modelDir: dir, modelId: 'fake', input: { f32: '' }, language: 'en' },
				{ ort: f.ort, audio: noiseAudio(3, (t) => t % 1 < 0.6) },
			),
		).rejects.toThrow('broken model');
		expect(runs).toBe(1);
	});

	it('calibration on the first window keeps the faster decoder (greedy)', async () => {
		const dir = fakeModelDir();
		for (const [cpuMs, gpuMs, want] of [
			[6, 1, 'cuda'],
			[1, 6, 'cpu'],
		] as const) {
			const f = fakeOrt({ decoderDelayMs: (p) => (p === 'cuda' ? gpuMs : cpuMs) });
			const out = await runSpeechJob(
				{
					modelDir: dir,
					modelId: 'fake',
					input: { f32: '' },
					language: 'en',
					beamSize: 1,
					device: { encoder: 'cuda', decoder: 'cpu', calibrate: 'cuda' },
				},
				{ ort: f.ort, audio: noiseAudio(3, (t) => t % 1 < 0.6) },
			);
			expect(out.calibration).toMatchObject({ provider: 'cuda', decoder: want });
			expect(out.calibration!.cpuMsPerToken).toBeGreaterThan(0);
			expect(out.device.decoder).toBe(want);
			// the losing decoder session was released
			const dec = f.sessions.filter((s) => s.path.includes('decoder'));
			expect(dec.filter((s) => !s.released)).toHaveLength(0);
		}
	});

	it('windows without voice are not decoded (SG-011)', async () => {
		const dir = fakeModelDir();
		const f = fakeOrt();
		const audio = new Float32Array(16_000 * 65); // digital silence: three windows
		const out = await runSpeechJob(
			{ modelDir: dir, modelId: 'fake', input: { f32: '' }, language: 'en' },
			{ ort: f.ort, audio },
		);
		expect(out.guard.skippedWindows).toBeGreaterThanOrEqual(2);
		expect(out.words).toEqual([]);
		const enc = f.sessions.find((s) => s.path.includes('encoder'))!;
		expect(enc.runs).toHaveLength(0);
	});
});
