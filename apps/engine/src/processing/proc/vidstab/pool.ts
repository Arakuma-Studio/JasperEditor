// Parallel 16-bit warp: N worker threads, each with its own vidstab.wasm instance, warp one row band of the
// frame each. The frame travels through SharedArrayBuffers (one copy in, one copy out); every worker only
// copies the source rows its band can reach (math.ts sourceRows). The worker is an eval'd CommonJS string so
// it works the same from source (tsx/vitest) and from the esbuild bundle (no extra file to locate); the
// compiled WebAssembly.Module is shared with it through workerData.
import { Worker } from 'node:worker_threads';
import { rowBands, sourceRows } from './math.ts';
import { VidstabWasm, type VsTransform } from './wasm.ts';

const WORKER_SOURCE = `
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
let mem = null;
const bad = () => 8;
const imports = { wasi_snapshot_preview1: {
	environ_sizes_get: (c, s) => { const v = new DataView(mem.buffer); v.setUint32(c, 0, true); v.setUint32(s, 0, true); return 0; },
	environ_get: () => 0,
	clock_time_get: (_id, _p, out) => { new DataView(mem.buffer).setBigUint64(out, process.hrtime.bigint(), true); return 0; },
	fd_write: (_fd, iovs, n, written) => { const v = new DataView(mem.buffer); let t = 0; for (let i = 0; i < n; i++) t += v.getUint32(iovs + i * 8 + 4, true); v.setUint32(written, t, true); return 0; },
	fd_prestat_get: bad, fd_prestat_dir_name: bad, fd_close: bad, fd_fdstat_get: bad, fd_fdstat_set_flags: bad,
	fd_read: bad, fd_seek: bad, path_open: () => 52,
	proc_exit: (code) => { throw new Error('vidstab.wasm proc_exit(' + code + ')'); },
} };
const ex = new WebAssembly.Instance(workerData.module, imports).exports;
mem = ex.memory;
ex._initialize();
let srcPtr = 0, srcCap = 0, dstPtr = 0, dstCap = 0;
function reserve(ptr, cap, bytes) {
	if (bytes <= cap) return [ptr, cap];
	if (ptr) ex.vsx_free(ptr);
	const p = ex.vsx_malloc(bytes);
	if (!p) throw new Error('vidstab.wasm: out of memory');
	return [p, bytes];
}
parentPort.on('message', (m) => {
	try {
		const rowBytes = m.width * 6;
		const srcLen = (m.row1 - m.row0) * rowBytes;
		const dstLen = (m.y1 - m.y0) * rowBytes;
		[srcPtr, srcCap] = reserve(srcPtr, srcCap, srcLen + 16);
		[dstPtr, dstCap] = reserve(dstPtr, dstCap, dstLen + 16);
		new Uint8Array(mem.buffer, srcPtr, srcLen).set(new Uint8Array(m.src, m.row0 * rowBytes, srcLen));
		ex.vsx_warp_rgb48(srcPtr, m.row0, m.row1 - m.row0, dstPtr, m.width, m.height, m.t.x, m.t.y, m.t.alpha, m.t.zoom, m.border, m.y0, m.y1);
		new Uint8Array(m.dst, m.y0 * rowBytes, dstLen).set(new Uint8Array(mem.buffer, dstPtr, dstLen));
		parentPort.postMessage({ id: m.id });
	} catch (e) {
		parentPort.postMessage({ id: m.id, error: String((e && e.stack) || e) });
	}
});
`;

type Pending = { resolve: () => void; reject: (e: Error) => void };

/** Warps rgb48 frames in place, in parallel (threads ≥ 2) or on the calling thread (threads = 1). */
export class WarpPool {
	private workers: Worker[] = [];
	private pending = new Map<number, Pending>();
	private nextId = 1;
	private src: SharedArrayBuffer | null = null;
	private dst: SharedArrayBuffer | null = null;
	private local: { vs: VidstabWasm; src: number; dst: number; bytes: number } | null = null;
	private failed: Error | null = null;

	private constructor(readonly threads: number) {}

	static async create(module: WebAssembly.Module, threads: number): Promise<WarpPool> {
		const pool = new WarpPool(Math.max(1, Math.floor(threads)));
		if (pool.threads === 1) {
			pool.local = { vs: await VidstabWasm.create(module), src: 0, dst: 0, bytes: 0 };
			return pool;
		}
		for (let i = 0; i < pool.threads; i++) {
			const w = new Worker(WORKER_SOURCE, { eval: true, workerData: { module } });
			w.unref();
			w.on('message', (m: { id: number; error?: string }) => {
				const p = pool.pending.get(m.id);
				if (!p) return;
				pool.pending.delete(m.id);
				if (m.error) p.reject(new Error(m.error));
				else p.resolve();
			});
			w.on('error', (e) => pool.fail(e instanceof Error ? e : new Error(String(e))));
			w.on('exit', (code) => {
				if (code !== 0) pool.fail(new Error(`vid.stab warp worker exited (${code})`));
			});
			pool.workers.push(w);
		}
		return pool;
	}

	private fail(e: Error): void {
		this.failed ??= e;
		for (const p of this.pending.values()) p.reject(e);
		this.pending.clear();
	}

	/** Applies `t` to `data` (interleaved rgb48, width·height·3) in place. border 0 = black, 1 = replicate. */
	async warp(data: Uint16Array, width: number, height: number, t: VsTransform, border: 0 | 1): Promise<void> {
		if (this.failed) throw this.failed;
		const bytes = width * height * 6;
		const view = new Uint8Array(data.buffer, data.byteOffset, bytes);
		if (this.local) {
			const l = this.local;
			if (l.bytes < bytes) {
				if (l.src) l.vs.free(l.src);
				if (l.dst) l.vs.free(l.dst);
				l.src = l.vs.malloc(bytes + 16);
				l.dst = l.vs.malloc(bytes + 16);
				l.bytes = bytes;
			}
			l.vs.u8(l.src, bytes).set(view);
			l.vs.warpRaw(l.src, 0, height, l.dst, width, height, t, border, 0, height);
			view.set(l.vs.u8(l.dst, bytes));
			return;
		}
		if (!this.src || this.src.byteLength < bytes) {
			this.src = new SharedArrayBuffer(bytes);
			this.dst = new SharedArrayBuffer(bytes);
		}
		const src = this.src;
		const dst = this.dst as SharedArrayBuffer;
		new Uint8Array(src, 0, bytes).set(view);
		const jobs = rowBands(height, this.workers.length).map(([y0, y1], i) => {
			const [row0, row1] = sourceRows(t, width, height, y0, y1);
			const id = this.nextId++;
			return new Promise<void>((resolve, reject) => {
				this.pending.set(id, { resolve, reject });
				this.workers[i].postMessage({ id, src, dst, width, height, t, border, y0, y1, row0, row1 });
			});
		});
		await Promise.all(jobs);
		view.set(new Uint8Array(dst, 0, bytes));
	}

	async close(): Promise<void> {
		const ws = this.workers;
		this.workers = [];
		this.fail(new Error('warp pool closed'));
		await Promise.all(ws.map((w) => w.terminate()));
		this.local = null;
		this.src = this.dst = null;
	}
}
