// GPU decode of a native export's video sources (docs/wp-notes/export-performance.md §5): NVDEC through
// `-hwaccel cuda` on one CUDA device per ffmpeg process, frames downloaded (NV12 / P010) for the CPU composite. The
// decoded pictures are the software decoder's (H.264 / HEVC / VP9 / AV1 decoding is exact; measured identical RGBA
// after the composite's swscale conversion on the user's PC), so the composite is unchanged; ffmpeg falls back to its
// software decoder for a stream the GPU cannot decode (4:2:2 H.264, Hi10P…). Used when ffmpeg lists the `cuda` hwaccel
// and a CUDA device works (probed once per ffmpeg binary); otherwise, and when turned off, the CPU decodes.
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import type { LocalMedia } from './planner.ts';

/** Name of the CUDA device each composite process creates (`-init_hw_device cuda=<name>`). */
export const CUDA_DEVICE = 'jcu';

/** Codecs ffmpeg's own decoders decode through NVDEC (consumer NVIDIA GPUs since Pascal / Ampere for AV1). */
const NVDEC_CODECS = new Set(['h264', 'hevc', 'vp9', 'av1']);

export type GpuDecodePolicy = {
	/** `auto` (default): NVDEC when available; `off`: the CPU decodes (`JASPER_EXPORT_NVDEC=0`). */
	mode: 'auto' | 'off';
	/**
	 * Most GPU-decoded inputs of one export, shared by its concurrent segments (default 16,
	 * `JASPER_EXPORT_NVDEC_MAX_INPUTS`): ffmpeg opens every input of a graph at once and each NVDEC decoder keeps its own
	 * surfaces (measured ≈ 90 MB per 1080p H.264 input on the user's PC), so a graph of hundreds of clips decodes the
	 * rest on the CPU instead of exhausting video memory (16 inputs ≈ 1.5 GB).
	 */
	maxInputs: number;
};

export function gpuDecodePolicyFromEnv(
	env: Record<string, string | undefined> = process.env,
): GpuDecodePolicy {
	const v = env.JASPER_EXPORT_NVDEC;
	const n = Number(env.JASPER_EXPORT_NVDEC_MAX_INPUTS);
	return {
		mode: v === '0' || v === 'off' ? 'off' : 'auto',
		maxInputs: env.JASPER_EXPORT_NVDEC_MAX_INPUTS && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 16,
	};
}

/** Whether ffmpeg's own decoder of this media's video stream can decode through NVDEC. */
export function nvdecEligible(m: LocalMedia): boolean {
	const vs = m.record.probe.streams.find((s) => s.type === 'video');
	return vs?.type === 'video' && NVDEC_CODECS.has(vs.codec) && !m.record.probe.hasAlpha;
}

/** Input arguments of a GPU-decoded input (before its `-i`). */
export const NVDEC_INPUT_ARGS: readonly string[] = ['-hwaccel', 'cuda', '-hwaccel_device', CUDA_DEVICE];

/**
 * The GPU decode of one composite process: at most `maxInputs` of its eligible inputs decode through NVDEC — the
 * builder (`buildNativeGraph`) picks the ones that decode the longest (docs/wp-notes/export-performance.md §12) — and
 * the CPU decodes the rest.
 */
export function nvdecForGraph(maxInputs: number): {
	device: string;
	maxInputs: number;
	eligible(m: LocalMedia): boolean;
} {
	return { device: CUDA_DEVICE, maxInputs, eligible: nvdecEligible };
}

const probes = new Map<string, Promise<{ ok: boolean; reason?: string }>>();

/**
 * Whether this ffmpeg can decode on a CUDA device: the `cuda` hwaccel is built in and a device opens and moves a frame
 * up and down (one tiny run, remembered per ffmpeg binary for the engine's lifetime).
 */
export function probeCudaDecode(ff: Ffmpeg): Promise<{ ok: boolean; reason?: string }> {
	const key = ff.bins.ffmpeg ?? '';
	let p = probes.get(key);
	if (!p) {
		p = ff
			.run(
				[
					...['-init_hw_device', `cuda=${CUDA_DEVICE}`, '-filter_hw_device', CUDA_DEVICE],
					...['-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=1:d=1'],
					...['-vf', 'format=nv12,hwupload_cuda,hwdownload,format=nv12', '-frames:v', '1', '-f', 'null', '-'],
				],
				{ signal: AbortSignal.timeout(20_000) },
			)
			.then(
				() => ({ ok: true }),
				(e: Error) => ({ ok: false, reason: `no CUDA device: ${e.message.split('\n')[0]!.slice(0, 160)}` }),
			);
		probes.set(key, p);
	}
	return p;
}
