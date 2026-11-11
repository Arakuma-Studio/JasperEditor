// ONNX Runtime (onnxruntime-node, MIT) loading and the one execution-provider probe (spec 16 SG-001 / SG-008),
// shared by the speech worker (jasper-speech) and the processing worker (jasper-proc). Workers only: loading the
// native binding — and a GPU driver with it — never happens in the engine process (D-07).
//
// `JASPER_ORT_DIR` points at a directory whose `node_modules/onnxruntime-node` is a copy of the installed
// package plus the downloaded CUDA provider libraries (speech/cuda.ts): ONNX Runtime loads provider libraries
// from the directory of its own shared library, so the CUDA provider must sit next to a copy of it. The workers
// load the binding from there when the engine sets the variable (Enable NVIDIA GPU).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export type Ort = typeof import('onnxruntime-node');
export type OrtSession = import('onnxruntime-node').InferenceSession;
export type OrtTensor = import('onnxruntime-node').Tensor;

export const ORT_DIR_ENV = 'JASPER_ORT_DIR';

/** Execution providers JasperEditor knows (spec 16). */
export type ProviderId = 'cpu' | 'cuda' | 'webgpu' | 'dml' | 'coreml';

let cached: { dir: string | null; ort: Ort } | null = null;

function requireFrom(dir: string | null): NodeJS.Require {
	return dir ? createRequire(join(dir, 'package.json')) : createRequire(import.meta.url);
}

/** Loads onnxruntime-node (from `JASPER_ORT_DIR` when set). Throws when it is not installed. */
export function loadOrt(env: Record<string, string | undefined> = process.env): Ort {
	const dir = env[ORT_DIR_ENV] || null;
	if (cached && cached.dir === dir) return cached.ort;
	const ort = requireFrom(dir)('onnxruntime-node') as Ort;
	cached = { dir, ort };
	return ort;
}

/** Directory of the onnxruntime-node package that `loadOrt` would load, or null. */
export function ortPackageDir(env: Record<string, string | undefined> = process.env): string | null {
	try {
		return dirname(requireFrom(env[ORT_DIR_ENV] || null).resolve('onnxruntime-node/package.json'));
	} catch {
		return null;
	}
}

/** The installed onnxruntime-node version, or null. */
export function ortVersion(env: Record<string, string | undefined> = process.env): string | null {
	const dir = ortPackageDir(env);
	if (!dir) return null;
	try {
		return (
			(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string }).version ?? null
		);
	} catch {
		return null;
	}
}

/** The platform directory of the native binding (`bin/napi-vN/<platform>/<arch>`), or null. */
export function ortBinDir(pkgDir: string | null): string | null {
	if (!pkgDir) return null;
	try {
		const bin = join(pkgDir, 'bin');
		for (const napi of readdirSync(bin)) {
			const d = join(bin, napi, process.platform, process.arch);
			if (existsSync(d)) return d;
		}
	} catch {
		// not installed
	}
	return null;
}

/** The CUDA provider library sits next to the runtime (the NuGet package's files, see speech/cuda.ts). */
export function cudaProviderLibraryPresent(env: Record<string, string | undefined> = process.env): boolean {
	const d = ortBinDir(ortPackageDir(env));
	return (
		!!d &&
		(existsSync(join(d, 'libonnxruntime_providers_cuda.so')) ||
			existsSync(join(d, 'onnxruntime_providers_cuda.dll')))
	);
}

/** The session option entry of a provider. */
export function providerOption(
	id: ProviderId,
): import('onnxruntime-node').InferenceSession.ExecutionProviderConfig {
	switch (id) {
		case 'cuda':
			return { name: 'cuda', deviceId: 0 } as never;
		case 'webgpu':
			return { name: 'webgpu' } as never;
		case 'dml':
			return { name: 'dml', deviceId: 0 } as never;
		case 'coreml':
			return { name: 'coreml' } as never;
		default:
			return 'cpu';
	}
}

/** A CUDA library's failure status in an ONNX Runtime error ("CUDNN failure 4: CUDNN_STATUS_INTERNAL_ERROR"). */
export const CUDA_STATUS = /\b(?:CUDNN|CUBLAS|CUFFT|CURAND|CUDA) failure \d+: [^;]*[^;\s]/i;

/** The longest reason (characters). */
const REASON_MAX = 300;

/**
 * First line of an error, bounded (reasons are shown to people). ONNX Runtime's source locations, failed checks and
 * the C++ signature it prints before a CUDA status (templates, parameter lists, "[with …]") are dropped; a line still
 * too long keeps its head and the CUDA status — or its end, where ONNX Runtime puts the status — never the status cut
 * off (run 5 of the hidden-retake test reported a cuDNN failure as 300 characters of `std::conditional_t<…>
 * onnxruntime::CudaCall(…)` without the status).
 */
export function shortReason(e: unknown): string {
	const m = e instanceof Error ? e.message : String(e);
	let line = (m.split('\n').find((l) => l.trim()) ?? m).trim();
	// ONNX Runtime prefixes its messages with the source location and the failed check:
	// "/onnxruntime_src/…/webgpu_context.cc:136 … was false. Failed to get a WebGPU adapter: …"
	const after = /\bwas false\.\s*(.+)$/.exec(line);
	if (after?.[1]) line = after[1];
	line = line
		.replace(/\S+\.(?:cc|cpp|h):\d+\s+/g, '')
		.replace(/std::conditional_t<[^>]*>\s*/g, '')
		.replace(/[\w:]+::\w+\([^()]*\)\s*/g, '')
		.replace(/\[with [^\]]*\]\s*/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (line.length > REASON_MAX) {
		const status = line.match(CUDA_STATUS)?.[0];
		const tail =
			status && status.length < REASON_MAX / 2
				? status
				: line.slice(line.length - REASON_MAX * 0.4).trimStart();
		line = `${line.slice(0, REASON_MAX - tail.length - 3).trimEnd()} … ${tail}`;
	}
	return line || 'unknown error';
}

export type ProviderProbe = { id: ProviderId; available: boolean; reason?: string };

/**
 * THE execution-provider probe (SG-001, SG-008): for each candidate, a session of `model` is created with only
 * that provider and run once on `feeds()`; a failure makes the provider unavailable with the error as reason.
 * `cpu` is always probed last.
 */
export async function probeOrtProviders(
	ort: Pick<Ort, 'InferenceSession' | 'Tensor'>,
	candidates: readonly ProviderId[],
	model: Uint8Array,
	feeds: () => Record<string, OrtTensor>,
	precheck: (id: ProviderId) => string | null = () => null,
): Promise<ProviderProbe[]> {
	const out: ProviderProbe[] = [];
	for (const id of [...candidates.filter((c) => c !== 'cpu'), 'cpu' as const]) {
		const blocked = precheck(id);
		if (blocked) {
			out.push({ id, available: false, reason: blocked });
			continue;
		}
		try {
			const s = await ort.InferenceSession.create(model, {
				executionProviders: [providerOption(id)],
				logSeverityLevel: 4,
			} as never);
			try {
				await s.run(feeds());
			} finally {
				await s.release();
			}
			out.push({ id, available: true });
		} catch (e) {
			out.push({ id, available: false, reason: shortReason(e) });
		}
	}
	return out;
}
