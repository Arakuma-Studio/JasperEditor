// Spec 16 SG-022 / SG-023: resumable verified downloads against an HTTP server that drops connections, and the
// zod validation of the speech model catalogue.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeStoredZip } from '../src/imports/zip.ts';
import { loadCatalog } from '../src/processing/models.ts';
import { cudaGuidance, listZipEntries } from '../src/speech/cuda.ts';
import { SpeechModelStore, validateSpeechCatalog } from '../src/speech/models.ts';
import { DownloadError, downloadVerified } from '../src/tools/download.ts';

const PAYLOAD = randomBytes(3 * 1024 * 1024 + 123);
const SHA = createHash('sha256').update(PAYLOAD).digest('hex');

type Req = { range: string | null; sent: number };

/**
 * Serves PAYLOAD with Range support. `cutAfter(n)`: the n-th request (1-based) is cut after that many bytes
 * (socket destroyed mid-body); `ignoreRange`: answers 200 with the whole body; `status`: a fixed error status.
 */
async function server(
	opts: { cutAfter?: (n: number) => number | null; ignoreRange?: boolean; status?: number } = {},
) {
	const reqs: Req[] = [];
	const srv: Server = createServer((req, res) => {
		const n = reqs.length + 1;
		const r: Req = { range: req.headers.range ?? null, sent: 0 };
		reqs.push(r);
		if (opts.status) {
			res.writeHead(opts.status);
			res.end();
			return;
		}
		let start = 0;
		const m = /bytes=(\d+)-/.exec(r.range ?? '');
		if (m && !opts.ignoreRange) start = Number(m[1]);
		if (start >= PAYLOAD.length) {
			res.writeHead(416);
			res.end();
			return;
		}
		const body = PAYLOAD.subarray(start);
		res.writeHead(m && !opts.ignoreRange ? 206 : 200, {
			'content-length': String(body.length),
			...(m && !opts.ignoreRange
				? { 'content-range': `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}` }
				: {}),
		});
		const cut = opts.cutAfter?.(n) ?? null;
		if (cut !== null) {
			res.write(body.subarray(0, cut), () => {
				r.sent = cut;
				res.socket?.destroy();
			});
			return;
		}
		r.sent = body.length;
		res.end(body);
	});
	await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
	const port = (srv.address() as { port: number }).port;
	return {
		url: `http://127.0.0.1:${port}/model.onnx`,
		reqs,
		close: () => new Promise<void>((ok) => srv.close(() => ok())),
	};
}

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'jasper-dl-'));
});

const spec = (url: string) => ({ url, sha256: SHA, sizeBytes: PAYLOAD.length });

describe('resumable downloads (SG-022)', () => {
	it('an interrupted transfer resumes with a Range request instead of starting over', async () => {
		const s = await server({ cutAfter: (n) => (n === 1 ? 1024 * 1024 : n === 2 ? 512 * 1024 : null) });
		try {
			const dest = join(dir, 'a.onnx');
			const retries: number[] = [];
			await downloadVerified(spec(s.url), dest, {
				backoffMs: 5,
				onRetry: (_n, _e, from) => retries.push(from),
			});
			expect(readFileSync(dest).equals(PAYLOAD)).toBe(true);
			expect(existsSync(`${dest}.partial`)).toBe(false);
			// each retry resumes from the bytes on disk (what arrived before the connection dropped)
			expect(s.reqs).toHaveLength(3);
			expect(s.reqs[0]!.range).toBeNull();
			const from = s.reqs.slice(1).map((r) => Number(/bytes=(\d+)-/.exec(r.range ?? '')?.[1]));
			expect(from[0]).toBeGreaterThan(0);
			expect(from[1]).toBeGreaterThan(from[0]!);
			expect(retries).toEqual(from);
			// never restarted from zero: far less than twice the file went over the wire
			expect(s.reqs.reduce((a, r) => a + r.sent, 0)).toBeLessThan(PAYLOAD.length * 1.2);
		} finally {
			await s.close();
		}
	});

	it('a cancelled download keeps its partial file and the next install resumes from it', async () => {
		const s = await server();
		try {
			const dest = join(dir, 'b.onnx');
			writeFileSync(`${dest}.partial`, PAYLOAD.subarray(0, 2_000_000));
			await downloadVerified(spec(s.url), dest, { backoffMs: 5 });
			expect(s.reqs[0]!.range).toBe('bytes=2000000-');
			expect(readFileSync(dest).equals(PAYLOAD)).toBe(true);
			const ac = new AbortController();
			ac.abort();
			const dest2 = join(dir, 'b2.onnx');
			writeFileSync(`${dest2}.partial`, PAYLOAD.subarray(0, 10));
			await expect(downloadVerified(spec(s.url), dest2, { signal: ac.signal })).rejects.toBeTruthy();
			expect(statSync(`${dest2}.partial`).size).toBe(10);
		} finally {
			await s.close();
		}
	});

	it('a server that ignores Range restarts the file; a wrong hash deletes the part file', async () => {
		const s = await server({ ignoreRange: true });
		try {
			const dest = join(dir, 'c.onnx');
			writeFileSync(`${dest}.partial`, PAYLOAD.subarray(0, 1000));
			await downloadVerified(spec(s.url), dest, { backoffMs: 5 });
			expect(readFileSync(dest).equals(PAYLOAD)).toBe(true);
			const bad = join(dir, 'd.onnx');
			const err = await downloadVerified({ ...spec(s.url), sha256: '0'.repeat(64) }, bad, {
				backoffMs: 5,
			}).catch((e) => e);
			expect(err).toBeInstanceOf(DownloadError);
			expect(err.code).toBe('CHECKSUM');
			expect(existsSync(`${bad}.partial`)).toBe(false);
			expect(existsSync(bad)).toBe(false);
		} finally {
			await s.close();
		}
	});

	it('server errors are retried with backoff, then reported; 404 is not retried', async () => {
		const s = await server({ status: 503 });
		try {
			const err = await downloadVerified(spec(s.url), join(dir, 'e.onnx'), {
				backoffMs: 1,
				retries: 2,
			}).catch((e) => e);
			expect(err).toMatchObject({ code: 'DOWNLOAD_FAILED' });
			expect(s.reqs).toHaveLength(3);
		} finally {
			await s.close();
		}
		const s404 = await server({ status: 404 });
		try {
			await expect(
				downloadVerified(spec(s404.url), join(dir, 'f.onnx'), { backoffMs: 1 }),
			).rejects.toMatchObject({
				code: 'DOWNLOAD_FAILED',
			});
			expect(s404.reqs).toHaveLength(1);
		} finally {
			await s404.close();
		}
	});

	it('a speech model installs across dropped connections and writes install.json', async () => {
		const s = await server({ cutAfter: (n) => (n === 1 ? 700_000 : null) });
		try {
			const small = Buffer.from('{"num_mel_bins":80}');
			writeFileSync(join(dir, 'config.json'), small);
			const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
			const store = new SpeechModelStore(join(dir, 'models'), [
				{
					id: 'm',
					name: 'M',
					parameters: 1,
					multilingual: true,
					description: '',
					license: 'MIT',
					licenseUrl: '',
					attribution: '',
					sourceUrl: '',
					upstreamUrl: '',
					revision: 'r',
					files: [
						{
							path: 'config.json',
							url: join(dir, 'config.json'),
							sha256: sha(small),
							sizeBytes: small.length,
						},
						{ path: 'encoder_model.onnx', url: s.url, sha256: SHA, sizeBytes: PAYLOAD.length },
					],
				},
			]);
			const progress: number[] = [];
			await store.install('m', { download: { backoffMs: 5 }, onProgress: (d) => progress.push(d) });
			expect(await store.installed(store.entry('m')!)).toBe(true);
			const rec = JSON.parse(readFileSync(join(dir, 'models', 'm', 'install.json'), 'utf8'));
			expect(rec.files['encoder_model.onnx'].sha256).toBe(SHA);
			expect(progress.at(-1)).toBe(PAYLOAD.length + small.length);
			expect(s.reqs).toHaveLength(2);
			expect(s.reqs[1]!.range).toMatch(/^bytes=[1-9]\d*-$/);
		} finally {
			await s.close();
		}
	});
});

describe('speech catalogue validation (SG-020, SG-023)', () => {
	it('the built-in catalogue is valid: turbo fp32 (external data) and fp16, small/base/tiny (+ .en), no medium or int8', () => {
		const c = loadCatalog({});
		expect(c.speechErrors).toEqual([]);
		const ids = c.speech.map((e) => e.id);
		expect(ids).toEqual(
			expect.arrayContaining([
				'whisper-large-v3-turbo',
				'whisper-large-v3-turbo-fp16',
				'whisper-small',
				'whisper-small.en',
				'whisper-base',
				'whisper-base.en',
				'whisper-tiny',
				'whisper-tiny.en',
			]),
		);
		expect(ids.some((id) => /medium|int8|q8|quant/.test(id))).toBe(false);
		for (const e of c.speech) {
			expect(e.license).toMatch(/MIT/);
			for (const f of e.files) {
				expect(f.url).toContain(e.revision);
				expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
				expect(f.url).not.toMatch(/quantized|int8|q8/);
			}
		}
		const turbo = c.speech.find((e) => e.id === 'whisper-large-v3-turbo')!;
		expect(turbo.files.map((f) => f.path)).toContain('encoder_model.onnx_data');
		expect(turbo.recommend).toBe('turbo');
		const fp16 = c.speech.find((e) => e.id === 'whisper-large-v3-turbo-fp16')!;
		expect(fp16).toMatchObject({ precision: 'fp16', gpuOnly: true, recommend: 'turbo-fp16' });
		expect(c.speech.find((e) => e.id === 'whisper-small')?.recommend).toBe('small');
	});

	it('bad entries are refused with a reason; good ones stay', () => {
		const good = loadCatalog({}).speech[0]!;
		const bad = [
			{ ...good, id: 'bad-sha', files: good.files.map((f, i) => (i === 0 ? { ...f, sha256: 'xyz' } : f)) },
			{ ...good, id: 'bad-path', files: [...good.files, { ...good.files[0]!, path: '../evil.onnx' }] },
			{ ...good, id: 'no-encoder', files: good.files.filter((f) => f.path !== 'encoder_model.onnx') },
			{ ...good, id: 'extra-key', unknownKey: 1 },
			'not an object',
			good,
		];
		const r = validateSpeechCatalog([good, ...bad]);
		expect(r.entries.map((e) => e.id)).toEqual([good.id]);
		expect(r.errors).toHaveLength(6);
		expect(r.errors.find((e) => e.startsWith('bad-sha'))).toMatch(/sha256/);
		expect(r.errors.find((e) => e.startsWith('bad-path'))).toMatch(/plain names/);
		expect(r.errors.find((e) => e.startsWith('no-encoder'))).toMatch(/missing file encoder_model\.onnx/);
		expect(r.errors.some((e) => /duplicate id/.test(e))).toBe(true);
		expect(validateSpeechCatalog({}).errors).toEqual(['the speech model list is not an array']);
	});

	it('validation never throws (fuzz)', () => {
		fc.assert(
			fc.property(fc.anything(), (x) => {
				const r = validateSpeechCatalog(x);
				return Array.isArray(r.entries) && Array.isArray(r.errors);
			}),
			{ numRuns: 300 },
		);
	});

	it('a catalogue override with a bad entry loads the good ones and reports the bad one', () => {
		const good = loadCatalog({}).speech.find((e) => e.id === 'whisper-tiny')!;
		const file = join(dir, 'catalog.json');
		writeFileSync(file, JSON.stringify({ models: [], speech: [good, { ...good, id: 'Bad Id' }] }));
		const c = loadCatalog({ JASPER_MODEL_CATALOG: file });
		expect(c.speech.map((e) => e.id)).toEqual(['whisper-tiny']);
		expect(c.speechErrors[0]).toMatch(/^Bad Id: id/);
	});
});

describe('CUDA runtime guidance (SG-006; found on the RTX 4060 Ti box: CUDA 12.8 toolkit, no CUDA 13)', () => {
	it('names the CUDA 13 libraries a CUDA 12 install lacks, with NVIDIA package names that exist', () => {
		const g = cudaGuidance({
			missing: ['libcudart.so.13', 'libcublas.so.13', 'libcublasLt.so.13'],
			olderCuda: 12,
		});
		expect(g).toMatch(
			/CUDA 12 is installed, but ONNX Runtime 1\.30\.0's CUDA provider needs the CUDA 13 runtime/,
		);
		expect(g).toContain('cuda-cudart-13-0');
		expect(g).toContain('libcudnn9-cuda-13');
		expect(g).toContain('nvidia-cuda-runtime');
		expect(g).not.toMatch(/cuda-runtime-13\b|libcurand-10\b/);
		expect(g).toContain('Missing: libcudart.so.13, libcublas.so.13, libcublasLt.so.13.');
		expect(cudaGuidance({ missing: ['libcudnn.so.9'], olderCuda: null })).not.toMatch(/CUDA 12 is installed/);
	});
});

describe('CUDA provider package reading (SG-006)', () => {
	it('lists ZIP entries from the central directory without reading the archive', async () => {
		const zip = writeStoredZip([
			{ name: 'runtimes/linux-x64/native/libonnxruntime_providers_cuda.so', data: new Uint8Array([1, 2, 3]) },
			{ name: 'LICENSE', data: new TextEncoder().encode('MIT') },
		]);
		const p = join(dir, 'pkg.nupkg');
		writeFileSync(p, zip);
		const e = await listZipEntries(p);
		expect([...e.keys()]).toEqual(['runtimes/linux-x64/native/libonnxruntime_providers_cuda.so', 'LICENSE']);
		expect(e.get('LICENSE')).toMatchObject({ size: 3, method: 0 });
		writeFileSync(join(dir, 'junk.nupkg'), randomBytes(100));
		await expect(listZipEntries(join(dir, 'junk.nupkg'))).rejects.toThrow(/not a ZIP/);
	});
});

afterAll(() => {
	// temp dirs are left to the OS cleanup (tmpdir)
});
