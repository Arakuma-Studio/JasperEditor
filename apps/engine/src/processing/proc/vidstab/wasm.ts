// vid.stab WebAssembly loader (S07 PST-001…003, D-25): the cross-platform stabiliser of jasper-proc.
// vidstab.wasm is built by scripts/vidstab-wasm/build.sh (libvidstab, pinned LGPL commit, + glue.c) and ships
// as a separate, replaceable file (LGPL relinking route, NOTICE-vidstab.txt). It is a reactor module whose
// only imports are a few WASI functions, stubbed here: nothing touches the file system or the environment.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Doubles per LocalMotion exported by glue.c: v.x, v.y, f.x, f.y, f.size, contrast, match. */
export const LM_STRIDE = 7;

/**
 * Where vidstab.wasm is: `JASPER_VIDSTAB_WASM` → next to the running module (`dist/vidstab.wasm` beside the
 * esbuild bundle `dist/jasper-proc.mjs`; this directory under tsx/vitest) → the source location seen from a
 * bundle in `apps/engine/dist` (`../src/processing/proc/vidstab/vidstab.wasm`, dev checkouts). Returns null
 * when none exists.
 */
export function resolveVidstabWasm(env: NodeJS.ProcessEnv = process.env): string | null {
	const candidates: string[] = [];
	if (env.JASPER_VIDSTAB_WASM) candidates.push(env.JASPER_VIDSTAB_WASM);
	try {
		const here = fileURLToPath(new URL('./vidstab.wasm', import.meta.url));
		candidates.push(here, join(dirname(here), '..', 'src', 'processing', 'proc', 'vidstab', 'vidstab.wasm'));
	} catch {
		// not a file: URL
	}
	for (const c of candidates) if (c && existsSync(c)) return c;
	return null;
}

type Exports = {
	memory: WebAssembly.Memory;
	_initialize(): void;
	vsx_log_ptr(): number;
	vsx_log_len(): number;
	vsx_log_clear(): void;
	vsx_set_log_level(level: number): void;
	vsx_malloc(n: number): number;
	vsx_free(p: number): void;
	vsx_version(): number;
	vsx_set_simd(on: number): void;
	vsx_simd(): number;
	vsx_detect_free(): void;
	vsx_detect_init(
		w: number,
		h: number,
		shakiness: number,
		accuracy: number,
		step: number,
		minContrast: number,
	): number;
	vsx_detect_luma(): number;
	vsx_detect_restart(): void;
	vsx_detect_frame(): number;
	vsx_detect_motions(): number;
	vsx_path_free(): void;
	vsx_path_init(w: number, h: number): number;
	vsx_path_scratch(count: number): number;
	vsx_path_add(count: number): number;
	vsx_path_compute(
		smoothing: number,
		algo: number,
		optZoom: number,
		zoom: number,
		zoomSpeed: number,
		maxShift: number,
		maxAngle: number,
	): number;
	vsx_path_result(): number;
	vsx_path_zoom(): number;
	vsx_warp_rgb48(
		src: number,
		srcRow0: number,
		srcRows: number,
		dst: number,
		w: number,
		h: number,
		x: number,
		y: number,
		alpha: number,
		zoom: number,
		border: number,
		y0: number,
		y1: number,
	): void;
	vsx_ref_free(): void;
	vsx_ref_init(w: number, h: number, crop: number, interpol: number): number;
	vsx_ref_src(): number;
	vsx_ref_dst(): number;
	vsx_ref_apply(x: number, y: number, alpha: number, zoom: number): number;
};

/** WASI preview1 stubs: no files, no environment, stderr collected. Everything else fails with ENOSYS. */
function wasiStubs(
	memory: () => WebAssembly.Memory,
	onStderr: (text: string) => void,
): WebAssembly.ModuleImports {
	const ENOSYS = 52;
	const EBADF = 8;
	return {
		environ_sizes_get: (countPtr: number, sizePtr: number) => {
			const v = new DataView(memory().buffer);
			v.setUint32(countPtr, 0, true);
			v.setUint32(sizePtr, 0, true);
			return 0;
		},
		environ_get: () => 0,
		clock_time_get: (_id: number, _precision: bigint, outPtr: number) => {
			new DataView(memory().buffer).setBigUint64(outPtr, process.hrtime.bigint(), true);
			return 0;
		},
		fd_write: (fd: number, iovs: number, iovsLen: number, nwrittenPtr: number) => {
			const v = new DataView(memory().buffer);
			let n = 0;
			let text = '';
			for (let i = 0; i < iovsLen; i++) {
				const ptr = v.getUint32(iovs + i * 8, true);
				const len = v.getUint32(iovs + i * 8 + 4, true);
				if (fd === 2) text += Buffer.from(memory().buffer, ptr, len).toString('utf8');
				n += len;
			}
			v.setUint32(nwrittenPtr, n, true);
			if (text) onStderr(text);
			return 0;
		},
		fd_prestat_get: () => EBADF,
		fd_prestat_dir_name: () => EBADF,
		fd_close: () => EBADF,
		fd_fdstat_get: () => EBADF,
		fd_fdstat_set_flags: () => EBADF,
		fd_read: () => EBADF,
		fd_seek: () => EBADF,
		path_open: () => ENOSYS,
		proc_exit: (code: number) => {
			throw new Error(`vidstab.wasm called proc_exit(${code})`);
		},
	};
}

let cachedModule: { path: string; module: WebAssembly.Module } | null = null;

/** Compiles (once per path) the vid.stab module. Throws when the file is missing or invalid. */
export async function loadVidstabModule(path = resolveVidstabWasm()): Promise<WebAssembly.Module> {
	if (!path)
		throw new Error('vidstab.wasm not found (set JASPER_VIDSTAB_WASM or rebuild scripts/vidstab-wasm)');
	if (cachedModule?.path === path) return cachedModule.module;
	const module = await WebAssembly.compile(readFileSync(path));
	const names = new Set(WebAssembly.Module.exports(module).map((e) => e.name));
	for (const need of ['memory', '_initialize', 'vsx_detect_init', 'vsx_path_compute', 'vsx_warp_rgb48']) {
		if (!names.has(need)) throw new Error(`vidstab.wasm lacks the export ${need}`);
	}
	cachedModule = { path, module };
	return module;
}

let availability: Promise<boolean> | null = null;

/** True when vidstab.wasm resolves, compiles and instantiates (cached after the first call). */
export function vidstabWasmAvailable(): Promise<boolean> {
	availability ??= (async () => {
		try {
			const vs = await VidstabWasm.create();
			return vs.version().length > 0;
		} catch {
			return false;
		}
	})();
	return availability;
}

export type VidstabPathOptions = {
	smoothing: number;
	/** vid.stab `optalgo`: 'opt' (L1 optimal, 1.4+), 'gauss', 'avg'. */
	algo: 'opt' | 'gauss' | 'avg';
	/** 0 none, 1 optimal static zoom, 2 adaptive. */
	optZoom: 0 | 1 | 2;
	/** Extra zoom in percent. */
	zoom: number;
	zoomSpeed: number;
	/** Detection-resolution pixels; -1 = unlimited. */
	maxShift: number;
	/** Radians; -1 = unlimited. */
	maxAngle: number;
};

export type VsTransform = { x: number; y: number; alpha: number; zoom: number };

/** One instance of the module (its own memory). Not thread-safe; one per worker. */
export class VidstabWasm {
	private constructor(
		private readonly ex: Exports,
		readonly stderr: string[],
	) {}

	static async create(module?: WebAssembly.Module): Promise<VidstabWasm> {
		const mod = module ?? (await loadVidstabModule());
		const stderr: string[] = [];
		let mem: WebAssembly.Memory | null = null;
		const instance = await WebAssembly.instantiate(mod, {
			wasi_snapshot_preview1: wasiStubs(
				() => mem as WebAssembly.Memory,
				(t) => {
					if (stderr.length < 100) stderr.push(t);
				},
			),
		});
		const ex = instance.exports as unknown as Exports;
		mem = ex.memory;
		ex._initialize();
		return new VidstabWasm(ex, stderr);
	}

	private get mem(): ArrayBuffer {
		return this.ex.memory.buffer;
	}

	private cstr(ptr: number): string {
		const bytes = new Uint8Array(this.mem, ptr);
		const end = bytes.indexOf(0);
		return Buffer.from(bytes.subarray(0, end < 0 ? 0 : end)).toString('utf8');
	}

	version(): string {
		return this.cstr(this.ex.vsx_version());
	}

	simd(): string {
		return this.cstr(this.ex.vsx_simd());
	}

	setSimd(on: boolean): void {
		this.ex.vsx_set_simd(on ? 1 : 0);
	}

	setLogLevel(level: number): void {
		this.ex.vsx_set_log_level(level);
	}

	/** vid.stab log lines since the last call. */
	takeLog(): string[] {
		const len = this.ex.vsx_log_len();
		if (!len) return [];
		const text = Buffer.from(new Uint8Array(this.mem, this.ex.vsx_log_ptr(), len)).toString('utf8');
		this.ex.vsx_log_clear();
		return text.split('\n').filter(Boolean);
	}

	malloc(bytes: number): number {
		const p = this.ex.vsx_malloc(bytes);
		if (!p) throw new Error('vidstab.wasm: out of memory');
		return p;
	}

	free(ptr: number): void {
		this.ex.vsx_free(ptr);
	}

	u8(ptr: number, length: number): Uint8Array {
		return new Uint8Array(this.mem, ptr, length);
	}

	u16(ptr: number, length: number): Uint16Array {
		return new Uint16Array(this.mem, ptr, length);
	}

	// --- detection -----------------------------------------------------------------------------------------

	detectInit(
		width: number,
		height: number,
		p: { shakiness: number; accuracy: number; stepSize: number; minContrast: number },
	): void {
		if (this.ex.vsx_detect_init(width, height, p.shakiness, p.accuracy, p.stepSize, p.minContrast) !== 0) {
			throw new Error(`vid.stab detect init failed: ${this.takeLog().join('; ')}`);
		}
	}

	/** Copies `luma` (width·height bytes) in, detects, returns the LocalMotions (LM_STRIDE doubles each). */
	detectFrame(luma: Uint8Array): Float64Array {
		this.u8(this.ex.vsx_detect_luma(), luma.length).set(luma);
		const n = this.ex.vsx_detect_frame();
		if (n < 0) throw new Error(`vid.stab motion detection failed: ${this.takeLog().join('; ')}`);
		return n === 0
			? new Float64Array(0)
			: new Float64Array(this.mem, this.ex.vsx_detect_motions(), n * LM_STRIDE).slice();
	}

	detectRestart(): void {
		this.ex.vsx_detect_restart();
	}

	detectFree(): void {
		this.ex.vsx_detect_free();
	}

	// --- camera path ---------------------------------------------------------------------------------------

	pathInit(width: number, height: number): void {
		if (this.ex.vsx_path_init(width, height) !== 0) throw new Error('vid.stab path init failed');
	}

	pathAdd(motions: Float64Array): void {
		const count = motions.length / LM_STRIDE;
		const ptr = this.ex.vsx_path_scratch(count);
		if (!ptr) throw new Error('vidstab.wasm: out of memory');
		new Float64Array(this.mem, ptr, motions.length).set(motions);
		if (this.ex.vsx_path_add(count) !== 0) throw new Error('vid.stab: adding local motions failed');
	}

	/** The per-frame correcting transforms (detection-resolution pixels) and the static zoom (percent). */
	pathCompute(o: VidstabPathOptions): { transforms: VsTransform[]; zoom: number } {
		const algo = o.algo === 'opt' ? 0 : o.algo === 'gauss' ? 1 : 2;
		const n = this.ex.vsx_path_compute(
			o.smoothing,
			algo,
			o.optZoom,
			o.zoom,
			o.zoomSpeed,
			Math.round(o.maxShift),
			o.maxAngle,
		);
		if (n < 0) throw new Error(`vid.stab camera path failed: ${this.takeLog().join('; ')}`);
		const r = new Float64Array(this.mem, this.ex.vsx_path_result(), n * 4);
		const transforms: VsTransform[] = [];
		for (let i = 0; i < n; i++) {
			transforms.push({ x: r[i * 4], y: r[i * 4 + 1], alpha: r[i * 4 + 2], zoom: r[i * 4 + 3] });
		}
		return { transforms, zoom: this.ex.vsx_path_zoom() };
	}

	pathFree(): void {
		this.ex.vsx_path_free();
	}

	// --- warp ----------------------------------------------------------------------------------------------

	/** Raw call of the SIMD warp on buffers inside this instance's memory (see glue.c vsx_warp_rgb48). */
	warpRaw(
		src: number,
		srcRow0: number,
		srcRows: number,
		dst: number,
		width: number,
		height: number,
		t: VsTransform,
		border: 0 | 1,
		y0: number,
		y1: number,
	): void {
		this.ex.vsx_warp_rgb48(
			src,
			srcRow0,
			srcRows,
			dst,
			width,
			height,
			t.x,
			t.y,
			t.alpha,
			t.zoom,
			border,
			y0,
			y1,
		);
	}

	// --- reference: vid.stab's own 8-bit transform -----------------------------------------------------------

	/** Applies vid.stab's transform (bicubic, crop=black by default) to an 8-bit gray frame. */
	referenceTransform(
		gray: Uint8Array,
		width: number,
		height: number,
		t: VsTransform,
		crop: 0 | 1 = 1,
	): Uint8Array {
		if (this.ex.vsx_ref_init(width, height, crop, 3) !== 0) throw new Error('vid.stab transform init failed');
		this.u8(this.ex.vsx_ref_src(), width * height).set(gray);
		if (this.ex.vsx_ref_apply(t.x, t.y, t.alpha, t.zoom) !== 0) throw new Error('vid.stab transform failed');
		const out = this.u8(this.ex.vsx_ref_dst(), width * height).slice();
		this.ex.vsx_ref_free();
		return out;
	}
}
