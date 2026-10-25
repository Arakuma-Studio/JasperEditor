// Spec 16 SG-006 on Linux x64 with the real pinned NuGet package: resumable download (an HTTP server that drops the
// first connection), sha256 check, extraction next to a copy of onnxruntime-node in the app directory, and the
// worker probe loading ONNX Runtime from there. Opt-in: SPEECH_CUDA_PACKAGE=<path of the downloaded .nupkg>.
// Without an NVIDIA runtime the probe must say what is missing (the build VM); with one (a GPU box) CUDA must load.
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CudaProvider, ORT_CUDA_PACKAGE } from '../src/speech/cuda.ts';
import { speechCommand } from '../src/speech/entry.ts';

const PKG = process.env.SPEECH_CUDA_PACKAGE ?? null;
const enabled = !!PKG && process.platform === 'linux' && process.arch === 'x64';

let srv: Server;
let url = '';
let requests: Array<string | null> = [];

describe.skipIf(!enabled)('NVIDIA CUDA provider install (SG-006, real package)', () => {
	beforeAll(async () => {
		const size = statSync(PKG as string).size;
		srv = createServer((req, res) => {
			requests.push(req.headers.range ?? null);
			const m = /bytes=(\d+)-/.exec(req.headers.range ?? '');
			const start = m ? Number(m[1]) : 0;
			res.writeHead(m ? 206 : 200, {
				'content-length': String(size - start),
				...(m ? { 'content-range': `bytes ${start}-${size - 1}/${size}` } : {}),
			});
			const s = createReadStream(PKG as string, { start });
			if (requests.length === 1) {
				// the first transfer drops after 20 MB
				let sent = 0;
				s.on('data', (c) => {
					sent += c.length;
					res.write(c);
					if (sent > 20 * 1024 * 1024) {
						s.destroy();
						res.socket?.destroy();
					}
				});
			} else s.pipe(res);
		});
		await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
		url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/pkg.nupkg`;
	});
	afterAll(async () => {
		await new Promise<void>((ok) => srv.close(() => ok()));
	});

	it('downloads with resume, verifies, installs and the worker loads ONNX Runtime from the copy', async () => {
		const root = mkdtempSync(join(tmpdir(), 'jasper-cuda-'));
		const cuda = new CudaProvider(root, process.env, 'linux', 'x64', url);
		expect(await cuda.state()).toBe('not-installed');
		const progress: number[] = [];
		await cuda.install({ onProgress: (d) => progress.push(d) });
		expect(requests.length).toBeGreaterThanOrEqual(2);
		expect(requests[1]).toMatch(/^bytes=[1-9]\d*-$/);
		expect(progress.at(-1)).toBe(ORT_CUDA_PACKAGE.sizeBytes);
		expect(await cuda.state()).toBe('installed');
		const rec = JSON.parse(readFileSync(join(cuda.dir, 'install.json'), 'utf8'));
		expect(Object.keys(rec.files).sort()).toEqual([
			'libonnxruntime_providers_cuda.so',
			'libonnxruntime_providers_shared.so',
		]);
		expect(existsSync(join(cuda.dir, 'LICENSE-onnxruntime-gpu.txt'))).toBe(true);
		// the package download is removed after the install
		expect(existsSync(join(root, 'runtimes', 'downloads', 'onnxruntime-gpu-linux-1.30.0.nupkg'))).toBe(false);
		const rt = cuda.runtime();
		const req = join(root, 'probe-req.json');
		writeFileSync(req, JSON.stringify({ candidates: ['cuda'] }));
		const cmd = speechCommand(process.env);
		const r = spawnSync(cmd.command, [...cmd.args, 'probe', req, join(root, 'probe.json')], {
			env: { ...process.env, ...cuda.workerEnv(rt) },
			encoding: 'utf8',
			timeout: 120_000,
		});
		expect(r.status, r.stderr).toBe(0);
		const probe = JSON.parse(readFileSync(join(root, 'probe.json'), 'utf8')) as {
			ortVersion: string;
			providers: Array<{ id: string; available: boolean; reason?: string }>;
		};
		expect(probe.ortVersion).toBe('1.30.0');
		const c = probe.providers.find((p) => p.id === 'cuda')!;
		console.log(`CUDA probe: ${JSON.stringify(c)}; runtime ${JSON.stringify({ ok: rt.ok, missing: rt.missing, gpu: rt.gpu })}`);
		if (rt.ok) expect(c.available).toBe(true);
		else {
			expect(c.available).toBe(false);
			// the provider library itself was found: the failure is the NVIDIA runtime, not a missing provider
			expect(c.reason).toMatch(/libcu|cuda/i);
		}
		expect((await cuda.remove()).freedBytes).toBeGreaterThan(200_000_000);
		expect(await cuda.state()).toBe('not-installed');
	}, 600_000);
});
