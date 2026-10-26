// NVIDIA GPUs on Linux x64 (spec 16 SG-006). onnxruntime-node ships its CUDA execution provider as separate
// libraries that its install script downloads from NuGet — a step pnpm never runs (not in
// `onlyBuiltDependencies`, and we do not change that). "Enable NVIDIA GPU" downloads the pinned NuGet package
// `Microsoft.ML.OnnxRuntime.Gpu.Linux` (MIT) on request — never bundled, never in git — verifies its sha256
// (resumable download, tools/download.ts), extracts the provider libraries and places them next to a copy of the
// installed onnxruntime-node package in the app directory (ONNX Runtime loads providers from its own library's
// directory; tools/ort.ts `JASPER_ORT_DIR`). The NVIDIA runtime (driver ≥ 580, CUDA 13, cuDNN 9) is proprietary and
// large: it is detected, never shipped, and the user is told what to install when it is missing.
import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { cp, mkdir, open, rm, stat, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import type { SpeechCudaStatus } from '@jasper/api';
import { z } from 'zod';
import { downloadVerified } from '../tools/download.ts';
import { atomicWriteJson, readJsonOrNull, sha256File } from '../tools/fs.ts';
import { ORT_DIR_ENV, ortBinDir, ortPackageDir, ortVersion } from '../tools/ort.ts';

/** The pinned provider package (matches onnxruntime-node 1.30.0's own install metadata). */
export const ORT_CUDA_PACKAGE = {
	ortVersion: '1.30.0',
	name: 'Microsoft.ML.OnnxRuntime.Gpu.Linux',
	url: 'https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime.gpu.linux/1.30.0/microsoft.ml.onnxruntime.gpu.linux.1.30.0.nupkg',
	sha256: '77ca23682fc164789e67cd0fa4ce022b1b1c94e1978046c6446eee5fb0a3a3d6',
	sizeBytes: 236_037_232,
	license: 'MIT (ONNX Runtime, Microsoft); the NVIDIA libraries it loads are not included',
	/** Package entries → file names next to libonnxruntime. */
	files: {
		'runtimes/linux-x64/native/libonnxruntime_providers_cuda.so': 'libonnxruntime_providers_cuda.so',
		'runtimes/linux-x64/native/libonnxruntime_providers_shared.so': 'libonnxruntime_providers_shared.so',
		LICENSE: 'LICENSE-onnxruntime-gpu.txt',
		'ThirdPartyNotices.txt': 'ThirdPartyNotices-onnxruntime-gpu.txt',
	} as Record<string, string>,
} as const;

/** NVIDIA libraries the provider needs (`readelf -d` + cuDNN loaded at run time). */
export const CUDA_RUNTIME_LIBS = [
	'libcuda.so.1',
	'libcudart.so.13',
	'libcublas.so.13',
	'libcublasLt.so.13',
	'libcurand.so.10',
	'libcudnn.so.9',
];
const MIN_DRIVER_MAJOR = 580;

/**
 * What to install when the NVIDIA runtime is incomplete. The CUDA provider of ONNX Runtime 1.30 is built for CUDA 13:
 * a CUDA 12 toolkit (common on GPU hosts) does not satisfy it, so that case is named explicitly. Package names are
 * those of NVIDIA's apt repository (`cuda-cudart-13-0`, `libcublas-13-0`, `libcurand-13-0`, `libcudnn9-cuda-13`) and
 * NVIDIA's pip wheels (`nvidia-cuda-runtime`, `nvidia-cublas` 13.x, found through `LD_LIBRARY_PATH`).
 */
export function cudaGuidance(rt: Pick<CudaRuntime, 'missing' | 'olderCuda'>): string {
	const parts: string[] = [];
	if (rt.olderCuda !== null && rt.missing.some((m) => /\.so\.13$/.test(m)))
		parts.push(
			`CUDA ${rt.olderCuda} is installed, but ONNX Runtime ${ORT_CUDA_PACKAGE.ortVersion}'s CUDA provider needs the CUDA 13 runtime libraries (they can be installed next to CUDA ${rt.olderCuda}).`,
		);
	parts.push(
		`Install the NVIDIA driver 580 or newer, the CUDA 13 runtime with cuBLAS and cuRAND, and cuDNN 9 for CUDA 13 — from NVIDIA's apt repository (cuda-cudart-13-0, libcublas-13-0, libcurand-13-0, libcudnn9-cuda-13) or NVIDIA's pip wheels (nvidia-cuda-runtime and nvidia-cublas 13.x, with their lib directory in LD_LIBRARY_PATH) — then check the GPUs again. JasperEditor does not ship them (NVIDIA licence).`,
	);
	if (rt.missing.length) parts.push(`Missing: ${rt.missing.join(', ')}.`);
	return parts.join(' ');
}

const InstallSchema = z.object({
	ortVersion: z.string(),
	packageSha256: z.string(),
	files: z.record(z.string(), z.object({ sha256: z.string(), sizeBytes: z.number() })),
	installedAt: z.string(),
});

export type CudaRuntime = SpeechCudaStatus['runtime'] & {
	libDirs: string[];
	/** Major version of an older CUDA runtime found instead (`libcudart.so.12` → 12), else null. */
	olderCuda: number | null;
};

export class CudaProvider {
	constructor(
		private readonly appRoot: string,
		private readonly env: Record<string, string | undefined> = process.env,
		private readonly platform = process.platform,
		private readonly arch = process.arch,
		/** Where the pinned package is fetched from (tests serve a local copy; the sha256 pin is unchanged). */
		private readonly packageUrl: string = ORT_CUDA_PACKAGE.url,
	) {}

	get supported(): boolean {
		return this.platform === 'linux' && this.arch === 'x64';
	}

	/** `<appdir>/runtimes/onnxruntime-cuda/<version>` — `JASPER_ORT_DIR` of the workers. */
	get dir(): string {
		return join(this.appRoot, 'runtimes', 'onnxruntime-cuda', ORT_CUDA_PACKAGE.ortVersion);
	}

	private get downloadPath(): string {
		return join(
			this.appRoot,
			'runtimes',
			'downloads',
			`onnxruntime-gpu-linux-${ORT_CUDA_PACKAGE.ortVersion}.nupkg`,
		);
	}

	private get binDir(): string | null {
		return ortBinDir(join(this.dir, 'node_modules', 'onnxruntime-node'));
	}

	async state(): Promise<SpeechCudaStatus['state']> {
		if (!this.supported) return 'unsupported';
		if (!existsSync(this.dir)) return 'not-installed';
		const rec = InstallSchema.safeParse(
			await readJsonOrNull(join(this.dir, 'install.json')).catch(() => null),
		);
		if (!rec.success || rec.data.ortVersion !== ORT_CUDA_PACKAGE.ortVersion) return 'damaged';
		const bin = this.binDir;
		if (!bin) return 'damaged';
		for (const [name, f] of Object.entries(rec.data.files)) {
			const s = await stat(join(bin, name)).catch(() => null);
			if (!s || s.size !== f.sizeBytes) return 'damaged';
		}
		if (!existsSync(join(this.dir, 'node_modules', 'onnxruntime-node', 'package.json'))) return 'damaged';
		return 'installed';
	}

	/** Detects the NVIDIA runtime (libraries on the loader path and the driver/GPU from nvidia-smi). */
	runtime(): CudaRuntime {
		const dirs = this.librarySearchDirs();
		const found = new Map<string, string>();
		for (const lib of CUDA_RUNTIME_LIBS)
			for (const d of dirs)
				if (existsSync(join(d, lib))) {
					found.set(lib, d);
					break;
				}
		const missing = CUDA_RUNTIME_LIBS.filter((l) => !found.has(l));
		let olderCuda: number | null = null;
		for (const v of [12, 11])
			if (olderCuda === null && dirs.some((d) => existsSync(join(d, `libcudart.so.${v}`)))) olderCuda = v;
		let driverVersion: string | null = null;
		let gpu: string | null = null;
		let vramMb: number | null = null;
		try {
			const out = execFileSync(
				'nvidia-smi',
				['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'],
				{ encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
			);
			const [name, mem, drv] = (out.split('\n')[0] ?? '').split(',').map((s) => s.trim());
			gpu = name || null;
			vramMb = Number.isFinite(Number(mem)) && mem ? Number(mem) : null;
			driverVersion = drv || null;
		} catch {
			// no NVIDIA driver / no nvidia-smi
		}
		const driverOk = driverVersion !== null && Number(driverVersion.split('.')[0]) >= MIN_DRIVER_MAJOR;
		if (driverVersion && !driverOk)
			missing.push(`NVIDIA driver ≥ ${MIN_DRIVER_MAJOR} (found ${driverVersion})`);
		if (!gpu && !missing.includes('libcuda.so.1')) missing.push('an NVIDIA GPU (nvidia-smi found none)');
		return {
			ok: missing.length === 0,
			missing,
			driverVersion,
			gpu,
			vramMb,
			libDirs: [...new Set(found.values())],
			olderCuda,
		};
	}

	private librarySearchDirs(): string[] {
		const dirs: string[] = [];
		for (const d of (this.env.LD_LIBRARY_PATH ?? '').split(delimiter)) if (d) dirs.push(d);
		try {
			const out = execFileSync('ldconfig', ['-p'], {
				encoding: 'utf8',
				timeout: 5000,
				stdio: ['ignore', 'pipe', 'ignore'],
				env: { ...process.env, PATH: `${this.env.PATH ?? ''}:/sbin:/usr/sbin` },
			});
			for (const line of out.split('\n')) {
				const m = /=>\s*(\S+)$/.exec(line.trim());
				if (m && /lib(cuda|cudart|cublas|curand|cudnn)/.test(m[1])) dirs.push(dirname(m[1]));
			}
		} catch {
			// no ldconfig
		}
		const roots = ['/usr/local/cuda', '/usr/local/cuda-13', '/opt/cuda'];
		try {
			for (const n of readdirSync('/usr/local')) if (/^cuda-13/.test(n)) roots.push(join('/usr/local', n));
		} catch {
			// no /usr/local
		}
		for (const r of roots) dirs.push(join(r, 'lib64'), join(r, 'targets', 'x86_64-linux', 'lib'));
		dirs.push('/usr/lib/x86_64-linux-gnu', '/usr/lib64', '/usr/lib/wsl/lib');
		return [...new Set(dirs)];
	}

	async status(): Promise<SpeechCudaStatus> {
		const state = await this.state();
		const rt: CudaRuntime = this.supported
			? this.runtime()
			: {
					ok: false,
					missing: [],
					driverVersion: null,
					gpu: null,
					vramMb: null,
					libDirs: [],
					olderCuda: null,
				};
		return {
			state,
			ortVersion: ORT_CUDA_PACKAGE.ortVersion,
			downloadBytes: ORT_CUDA_PACKAGE.sizeBytes,
			runtime: {
				ok: rt.ok,
				missing: rt.missing,
				driverVersion: rt.driverVersion,
				gpu: rt.gpu,
				vramMb: rt.vramMb,
			},
			...(this.supported && !rt.ok ? { guidance: cudaGuidance(rt) } : {}),
			license: ORT_CUDA_PACKAGE.license,
		};
	}

	/** Environment of a worker that should use the CUDA provider (installed copy + NVIDIA library directories). */
	workerEnv(rt: CudaRuntime): Record<string, string> {
		const ld = [...rt.libDirs, ...(this.env.LD_LIBRARY_PATH ?? '').split(delimiter).filter(Boolean)];
		return { [ORT_DIR_ENV]: this.dir, LD_LIBRARY_PATH: [...new Set(ld)].join(delimiter) };
	}

	/**
	 * Downloads (resumably) and installs the provider. Refuses when the installed onnxruntime-node is not the pinned
	 * version (the provider must match the runtime exactly).
	 */
	async install(
		opts: { signal?: AbortSignal; onProgress?(done: number, total: number, stage: string): void } = {},
	): Promise<void> {
		if (!this.supported)
			throw new CudaError('UNSUPPORTED_PLATFORM', 'The CUDA provider is available for Linux x64 only');
		const pkgDir = ortPackageDir({});
		const version = ortVersion({});
		if (!pkgDir || version !== ORT_CUDA_PACKAGE.ortVersion)
			throw new CudaError(
				'ORT_VERSION_MISMATCH',
				`The CUDA provider ${ORT_CUDA_PACKAGE.ortVersion} needs onnxruntime-node ${ORT_CUDA_PACKAGE.ortVersion} (found ${version ?? 'none'})`,
			);
		const total = ORT_CUDA_PACKAGE.sizeBytes;
		await downloadVerified({ ...ORT_CUDA_PACKAGE, url: this.packageUrl }, this.downloadPath, {
			...(opts.signal ? { signal: opts.signal } : {}),
			onProgress: (b) => opts.onProgress?.(b, total, 'Downloading the CUDA provider'),
		});
		opts.onProgress?.(total, total, 'Installing');
		const staging = `${this.dir}.staging`;
		await rm(staging, { recursive: true, force: true });
		try {
			// a copy of the installed runtime package (+ its onnxruntime-common dependency)
			const nm = join(staging, 'node_modules');
			await mkdir(nm, { recursive: true });
			await cp(pkgDir, join(nm, 'onnxruntime-node'), {
				recursive: true,
				dereference: true,
				filter: (src) => {
					const rel = src.slice(pkgDir.length);
					if (rel.startsWith('/node_modules')) return false;
					const m = /^\/bin\/napi-v\d+\/([^/]+)\/([^/]+)/.exec(rel);
					return !m || (m[1] === 'linux' && m[2] === 'x64');
				},
			});
			const commonDir = packageRoot(
				(await import('node:module'))
					.createRequire(join(pkgDir, 'package.json'))
					.resolve('onnxruntime-common'),
				'onnxruntime-common',
			);
			await cp(commonDir, join(nm, 'onnxruntime-common'), { recursive: true, dereference: true });
			await writeFile(join(staging, 'package.json'), '{"private":true,"name":"jasper-onnxruntime-cuda"}\n');
			const bin = ortBinDir(join(nm, 'onnxruntime-node'));
			if (!bin) throw new CudaError('INSTALL_FAILED', 'onnxruntime-node has no Linux x64 binding');
			const entries = await listZipEntries(this.downloadPath);
			const files: Record<string, { sha256: string; sizeBytes: number }> = {};
			for (const [entry, name] of Object.entries(ORT_CUDA_PACKAGE.files)) {
				const e = entries.get(entry);
				if (!e) throw new CudaError('INSTALL_FAILED', `the package has no ${entry}`);
				const dest = name.endsWith('.so') ? join(bin, name) : join(staging, name);
				await extractEntry(this.downloadPath, e, dest);
				if (name.endsWith('.so')) files[name] = { sha256: await sha256File(dest), sizeBytes: e.size };
			}
			await atomicWriteJson(
				join(staging, 'install.json'),
				{
					ortVersion: ORT_CUDA_PACKAGE.ortVersion,
					packageSha256: ORT_CUDA_PACKAGE.sha256,
					files,
					installedAt: new Date().toISOString(),
				},
				true,
			);
			await rm(this.dir, { recursive: true, force: true });
			await mkdir(dirname(this.dir), { recursive: true });
			const { rename } = await import('node:fs/promises');
			await rename(staging, this.dir);
			await rm(this.downloadPath, { force: true });
		} catch (e) {
			await rm(staging, { recursive: true, force: true });
			throw e;
		}
	}

	async remove(): Promise<{ freedBytes: number }> {
		let freed = 0;
		const walk = async (d: string) => {
			for (const n of readdirSync(d, { withFileTypes: true })) {
				const p = join(d, n.name);
				if (n.isDirectory()) await walk(p);
				else freed += (await stat(p).catch(() => null))?.size ?? 0;
			}
		};
		if (existsSync(this.dir)) await walk(this.dir);
		await rm(this.dir, { recursive: true, force: true });
		for (const p of [this.downloadPath, `${this.downloadPath}.partial`]) {
			freed += (await stat(p).catch(() => null))?.size ?? 0;
			await rm(p, { force: true });
		}
		return { freedBytes: freed };
	}
}

export class CudaError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'CudaError';
	}
}

/** The directory of the package `name` that contains `file` (its `exports` may hide `package.json`). */
function packageRoot(file: string, name: string): string {
	let d = dirname(file);
	for (let i = 0; i < 12; i++) {
		const pj = join(d, 'package.json');
		if (existsSync(pj)) {
			try {
				if ((JSON.parse(readFileSync(pj, 'utf8')) as { name?: string }).name === name) return d;
			} catch {
				// not a package manifest
			}
		}
		const up = dirname(d);
		if (up === d) break;
		d = up;
	}
	throw new CudaError('INSTALL_FAILED', `cannot find the ${name} package`);
}

type Entry = { method: number; compressedSize: number; size: number; offset: number };

/**
 * The central directory of a ZIP file (the NuGet package), read from the end of the file without loading the
 * archive (PKWARE APPNOTE; stored and deflated entries; ZIP64 refused like imports/zip.ts).
 */
export async function listZipEntries(path: string): Promise<Map<string, Entry>> {
	const fh = await open(path, 'r');
	try {
		const size = (await fh.stat()).size;
		const tailLen = Math.min(size, 22 + 0xffff);
		const tail = Buffer.alloc(tailLen);
		await fh.read(tail, 0, tailLen, size - tailLen);
		let eocd = -1;
		for (let i = tailLen - 22; i >= 0; i--)
			if (tail.readUInt32LE(i) === 0x06054b50) {
				eocd = i;
				break;
			}
		if (eocd < 0) throw new CudaError('INSTALL_FAILED', 'not a ZIP archive');
		const count = tail.readUInt16LE(eocd + 10);
		const cdSize = tail.readUInt32LE(eocd + 12);
		const cdOffset = tail.readUInt32LE(eocd + 16);
		if (count === 0xffff || cdOffset === 0xffffffff)
			throw new CudaError('INSTALL_FAILED', 'ZIP64 is not supported');
		if (cdOffset + cdSize > size || cdSize > 16 * 1024 * 1024)
			throw new CudaError('INSTALL_FAILED', 'corrupt ZIP');
		const cd = Buffer.alloc(cdSize);
		await fh.read(cd, 0, cdSize, cdOffset);
		const out = new Map<string, Entry>();
		let p = 0;
		for (let n = 0; n < count; n++) {
			if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50)
				throw new CudaError('INSTALL_FAILED', 'corrupt ZIP');
			const method = cd.readUInt16LE(p + 10);
			const compressedSize = cd.readUInt32LE(p + 20);
			const usize = cd.readUInt32LE(p + 24);
			const nameLen = cd.readUInt16LE(p + 28);
			const extraLen = cd.readUInt16LE(p + 30);
			const commentLen = cd.readUInt16LE(p + 32);
			const offset = cd.readUInt32LE(p + 42);
			const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
			out.set(name, { method, compressedSize, size: usize, offset });
			p += 46 + nameLen + extraLen + commentLen;
		}
		return out;
	} finally {
		await fh.close();
	}
}

/** Streams one entry to `dest` (inflating deflated entries), checking the uncompressed size. */
async function extractEntry(zip: string, e: Entry, dest: string): Promise<void> {
	const fh = await open(zip, 'r');
	let dataStart: number;
	try {
		const head = Buffer.alloc(30);
		await fh.read(head, 0, 30, e.offset);
		if (head.readUInt32LE(0) !== 0x04034b50) throw new CudaError('INSTALL_FAILED', 'corrupt ZIP entry');
		dataStart = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
	} finally {
		await fh.close();
	}
	if (e.method !== 0 && e.method !== 8)
		throw new CudaError('INSTALL_FAILED', `unsupported ZIP method ${e.method}`);
	await mkdir(dirname(dest), { recursive: true });
	const src = createReadStream(zip, { start: dataStart, end: dataStart + e.compressedSize - 1 });
	const out = createWriteStream(dest);
	if (e.method === 8) await pipeline(src, createInflateRaw(), out);
	else await pipeline(src, out);
	const got = (await stat(dest)).size;
	if (got !== e.size) throw new CudaError('INSTALL_FAILED', `${dest}: ${got} bytes, expected ${e.size}`);
}
