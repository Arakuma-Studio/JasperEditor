// Execution-provider policy of speech-to-text (spec 16 §2.1, pure: no ONNX Runtime, no I/O; tests drive it with
// fabricated probes).
//
// - Order per platform (SG-001): macOS WebGPU → CPU; Linux x64 CUDA → WebGPU → CPU; Windows WebGPU → CPU.
//   CoreML is not used: onnxruntime-node cannot cache compiled CoreML models, so every load recompiles (measured
//   410–844 s for medium/turbo; re-evaluate on ORT upgrades). DirectML is not used: its DLL is under a proprietary
//   Microsoft licence outside the licence allowlist (SG-007, AGENTS §2.5; wp-note §11).
// - Per session (SG-002): the encoder on the best GPU provider; the decoder on the CPU, except a GPU decoder with
//   greedy decoding when the calibration of that model on this computer measured it faster.
// - Threads (SG-005): performance cores, at most 8 (measured: 10 threads slower than 4 on an M4 Max, 8 faster
//   than 4 on the 16-vCPU build VM).
// - Recommendation (SG-021) and speed estimates (SG-030).
import type { ProviderId } from '../tools/ort.ts';

export type ProviderStatus = { id: ProviderId; available: boolean; reason?: string; device?: string };

export const PROVIDER_LABEL: Record<ProviderId, string> = {
	cpu: 'CPU',
	cuda: 'CUDA',
	webgpu: 'WebGPU',
	dml: 'DirectML',
	coreml: 'Core ML',
};

export const COREML_REASON =
	'Core ML is not used: onnxruntime-node cannot cache compiled Core ML models, so every load recompiles the model (measured 7–14 minutes)';
export const DML_REASON =
	"DirectML is not used: its runtime (DirectML.dll) is licensed under proprietary Microsoft terms outside JasperEditor's licence allowlist";

/** GPU providers to probe, best first. */
export function gpuCandidates(platform: string, arch: string): ProviderId[] {
	if (platform === 'darwin') return ['webgpu'];
	if (platform === 'linux') return arch === 'x64' ? ['cuda', 'webgpu'] : ['webgpu'];
	if (platform === 'win32') return ['webgpu'];
	return [];
}

/** Providers listed as unavailable without probing (with the reason). */
export function policyExcluded(platform: string, arch: string): ProviderStatus[] {
	const out: ProviderStatus[] = [];
	if (platform === 'darwin') out.push({ id: 'coreml', available: false, reason: COREML_REASON });
	if (platform === 'win32') out.push({ id: 'dml', available: false, reason: DML_REASON });
	if (!(platform === 'linux' && arch === 'x64'))
		out.push({
			id: 'cuda',
			available: false,
			reason: 'the CUDA provider of ONNX Runtime ships for Linux x64 only',
		});
	return out;
}

/** The best usable GPU provider in probe order, or null. */
export function bestGpu(
	providers: readonly ProviderStatus[],
	order: readonly ProviderId[],
): ProviderStatus | null {
	for (const id of order) {
		const p = providers.find((x) => x.id === id);
		if (p?.available) return p;
	}
	return null;
}

/** SG-005: threads per session. */
export function threadCap(m: { performanceCores: number | null; logicalCores: number }): number {
	const cores = m.performanceCores && m.performanceCores > 0 ? m.performanceCores : m.logicalCores;
	return Math.max(1, Math.min(8, Math.floor(cores) || 1));
}

export type DevicePlan = {
	encoder: ProviderId;
	decoder: ProviderId;
	/** Time this GPU decoder against the CPU one on the first window (no calibration stored yet). */
	calibrate: ProviderId | null;
	/** No GPU could be used although one was asked for (Processor: GPU). */
	unavailableReason: string | null;
};

export type StoredCalibration = { modelId: string; provider: ProviderId; decoder: ProviderId };

/**
 * SG-002: providers for one job. `request` = the Processor setting or the job's `device`; `beamSize` 1 = greedy.
 * GPU decoders are candidates only with greedy decoding (beam search gathers its rows on the CPU each step).
 */
export function planDevices(opts: {
	providers: readonly ProviderStatus[];
	order: readonly ProviderId[];
	request: 'auto' | 'cpu' | 'gpu';
	beamSize: number;
	modelId: string;
	calibrations: readonly StoredCalibration[];
}): DevicePlan {
	if (opts.request === 'cpu')
		return { encoder: 'cpu', decoder: 'cpu', calibrate: null, unavailableReason: null };
	const gpu = bestGpu(opts.providers, opts.order);
	if (!gpu) {
		const reasons = opts.order
			.map((id) => opts.providers.find((p) => p.id === id))
			.filter((p): p is ProviderStatus => !!p && !p.available)
			.map((p) => `${PROVIDER_LABEL[p.id]}: ${p.reason ?? 'unavailable'}`);
		return {
			encoder: 'cpu',
			decoder: 'cpu',
			calibrate: null,
			unavailableReason:
				opts.request === 'gpu' ? `no usable GPU (${reasons.join('; ') || 'none found'})` : null,
		};
	}
	let decoder: ProviderId = 'cpu';
	let calibrate: ProviderId | null = null;
	if (opts.beamSize === 1 && (gpu.id === 'cuda' || gpu.id === 'webgpu')) {
		const c = opts.calibrations.find((x) => x.modelId === opts.modelId && x.provider === gpu.id);
		if (c) decoder = c.decoder;
		else calibrate = gpu.id;
	}
	return { encoder: gpu.id, decoder, calibrate, unavailableReason: null };
}

/** "NVIDIA GeForce RTX 3060 (CUDA)", "Apple M4 Max GPU (WebGPU)", "CPU". */
export function deviceLabel(p: { encoder: ProviderId; decoder: ProviderId }, gpuName: string | null): string {
	const gpu = (id: ProviderId) => `${gpuName ?? 'GPU'} (${PROVIDER_LABEL[id]})`;
	if (p.encoder === 'cpu' && p.decoder === 'cpu') return 'CPU';
	if (p.encoder !== 'cpu' && p.decoder !== 'cpu') return gpu(p.encoder);
	return p.encoder !== 'cpu'
		? `${gpu(p.encoder)} encoder · CPU decoder`
		: `CPU encoder · ${gpu(p.decoder)} decoder`;
}

export type RecommendInput = {
	entries: ReadonlyArray<{ id: string; recommend?: 'turbo-fp16' | 'turbo' | 'small'; default?: boolean }>;
	gpu: { provider: ProviderId; vramMb: number | null } | null;
	ramBytes: number;
	cores: number;
};

/**
 * SG-021 "Recommended for this computer": a usable GPU → turbo; CPU only with ≥ 16 GB of memory and ≥ 8 cores →
 * turbo (fp32); else small. Half precision only on CUDA with ≥ 6 GB of VRAM: there the decoder can run on the GPU
 * too; with WebGPU the decoder stays on the CPU, where fp16 weights run 2–4× slower (measured, spec 16 §0), so
 * WebGPU gets fp32 (deviation from the spec's "CUDA/WebGPU", recorded in the wp-note).
 */
export function recommendModel(r: RecommendInput): string | null {
	const tier = (t: 'turbo-fp16' | 'turbo' | 'small') => r.entries.find((e) => e.recommend === t)?.id ?? null;
	const GB = 1024 ** 3;
	let pick: string | null = null;
	if (r.gpu) {
		if (r.gpu.provider === 'cuda' && (r.gpu.vramMb ?? 0) >= 6 * 1024) pick = tier('turbo-fp16');
		pick ??= tier('turbo');
	} else if (r.ramBytes >= 15.5 * GB && r.cores >= 8) pick = tier('turbo');
	pick ??= tier('small');
	return pick ?? r.entries.find((e) => e.default)?.id ?? null;
}

/**
 * Reference real-time factors (processing time / audio time) for the speed estimate (SG-030), per model family on
 * a CPU at 8 threads with beam 5, from spec 16 §0 / the private research (build VM 16 vCPU: small 0.467, turbo
 * 0.454; tiny/base scaled from the M4 Max ratios — estimates) and the greedy/beam ratios measured there.
 */
const CPU_RTF_BEAM5: Array<[test: (id: string, params: number) => boolean, rtf: number, greedy: number]> = [
	[(id) => id.includes('turbo'), 0.454, 0.78],
	[(_id, p) => p >= 200, 0.467, 0.4],
	[(_id, p) => p >= 60, 0.2, 0.45],
	[() => true, 0.13, 0.46],
];

/** Encoder on a GPU: share of the CPU time left (turbo: M4 Max WebGPU 0.215/0.256; RTX 3060 CUDA greedy 0.155/0.454). */
const GPU_FACTOR: Partial<Record<ProviderId, number>> = { webgpu: 0.84, cuda: 0.45 };

export function estimateRtf(o: {
	modelId: string;
	parameters: number;
	precision?: 'fp32' | 'fp16';
	encoder: ProviderId;
	accuracy: 'standard' | 'best';
	threads: number;
}): number {
	const row = CPU_RTF_BEAM5.find(([t]) => t(o.modelId, o.parameters)) as (typeof CPU_RTF_BEAM5)[number];
	let rtf = row[1] * (o.accuracy === 'best' ? 1 : row[2]);
	// 4 threads: turbo 0.623 vs 0.454 at 8 on the build VM → (8 / t)^0.45
	rtf *= (8 / Math.max(1, o.threads)) ** 0.45;
	if (o.encoder !== 'cpu') rtf *= GPU_FACTOR[o.encoder] ?? 1;
	else if (o.precision === 'fp16') rtf *= 3;
	return Math.round(rtf * 1000) / 1000;
}
