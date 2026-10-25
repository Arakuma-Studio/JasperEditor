// `jasper-speech probe`: which execution providers really work on this computer (spec 16 SG-001), with the one
// probe implementation of tools/ort.ts (the upscaler uses it too, SG-008). Runs in the worker so a GPU driver that
// crashes or hangs takes down a child process, not the engine (the engine kills it after a timeout).
import { tinySrModel } from '../../processing/proc/tiny-onnx.ts';
import {
	loadOrt,
	ortVersion,
	type ProviderId,
	type ProviderProbe,
	probeOrtProviders,
	shortReason,
} from '../../tools/ort.ts';

export type ProbeRequest = {
	/** GPU providers to try, best first (the engine's per-platform order). */
	candidates: ProviderId[];
	/** Providers known unusable before trying (e.g. the CUDA runtime is missing), with the reason. */
	blocked?: Partial<Record<ProviderId, string>>;
};

export type ProbeResponse = { ortVersion: string | null; providers: ProviderProbe[]; error?: string };

export async function runProbe(req: ProbeRequest): Promise<ProbeResponse> {
	const candidates = (Array.isArray(req?.candidates) ? req.candidates : []).filter((c): c is ProviderId =>
		['cuda', 'webgpu', 'dml', 'coreml', 'cpu'].includes(c),
	);
	let ort: ReturnType<typeof loadOrt>;
	try {
		ort = loadOrt();
	} catch (e) {
		const reason = `ONNX Runtime could not be loaded: ${shortReason(e)}`;
		return {
			ortVersion: null,
			providers: [...candidates, 'cpu' as const].map((id) => ({ id, available: false, reason })),
			error: reason,
		};
	}
	const providers = await probeOrtProviders(
		ort,
		candidates,
		tinySrModel(),
		() => ({ input: new ort.Tensor('float32', new Float32Array(48), [1, 3, 4, 4]) }),
		(id) => req.blocked?.[id] ?? null,
	);
	return { ortVersion: ortVersion(), providers };
}
