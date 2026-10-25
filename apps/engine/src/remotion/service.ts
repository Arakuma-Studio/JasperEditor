// Local Remotion rendering (S04 §13 RR-001…006/011, ARCHITECTURE §9.5, §10.3): one bundle of
// `@jasper/compositions/remotion-entry` (prebuilt for packaged installs, otherwise bundled once and cached
// under `<appdir>/remotion/bundle/<sourceHash>`), `selectComposition('JasperSequence')`, then `renderMedia`
// or `renderStill` with the configured license key and a headless browser.
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { appendFile, mkdir, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPagesInOwnWindows } from '@jasper/compositions/render-host';
import { ENV } from '@jasper/config';
import { defaultEffectRegistry } from '@jasper/project';
import { animejsVersion } from '../anime/index.ts';
import { renderParallelism } from '../gaps/render-budget.ts';
import { JobError } from '../jobs/types.ts';
import { selfCheck } from '../tools/ffmpeg.ts';
import { binaryNames, type RemotionBinaries } from '../tools/lgpl.ts';
import type { RemotionFfmpegInfo } from './export-plan.ts';

const COMPOSITION_ID = 'JasperSequence';
export const REMOTION_VERSION = '4.0.499';
const DELAY_RENDER_TIMEOUT_MS = 60_000;
/**
 * M2 (S11:LBK-020): identity of a prebuilt compositions bundle, written next to it by `scripts/build-remotion.mjs`
 * (`bundleId` = content hash of the bundle files, `animejs` = the anime.js version inside it).
 */
const BUNDLE_STAMP_FILE = 'jasper-bundle.json';
export type BundleStamp = { bundleId: string; animejs: string; remotion: string };

/** Remotion's straight-alpha ProRes 4444 master settings (S08:MGC-030, S11:LBK-003): PNG frames, muted. */
const ALPHA_MASTER_OPTIONS = {
	codec: 'prores',
	proResProfile: '4444',
	pixelFormat: 'yuva444p10le',
	imageFormat: 'png',
	colorSpace: 'bt709',
	muted: true,
} as const;

/**
 * Lossless remux that stamps BT.709 colour tags on a Remotion master (Remotion leaves them unset; the pixels are
 * 709). Arguments for `Ffmpeg.run`.
 */
function bt709RemuxArgs(input: string, output: string): string[] {
	return [
		'-i',
		input,
		'-map',
		'0:v:0',
		'-c',
		'copy',
		'-color_primaries',
		'bt709',
		'-color_trc',
		'bt709',
		'-colorspace',
		'bt709',
		'-movflags',
		'+write_colr',
		'-f',
		'mov',
		output,
	];
}

/** What a Remotion call is for, in the usage log (S04:LC-004). */
export type RemotionUsagePurpose = 'export' | 'still' | 'layer-bake' | 'mg-prerender';

/** Runs ffmpeg (the engine's `Ffmpeg.run` shape; injected so this module stays free of process plumbing). */
type FfmpegRunner = {
	run(
		args: readonly string[],
		opts: { signal?: AbortSignal; onSpawn?(child: ChildProcess): void },
	): Promise<unknown>;
	countVideoFrames(file: string, opts: { signal?: AbortSignal }): Promise<number>;
};

/** Input of `renderAlphaMaster` (S11:LBK-003). */
type AlphaMasterInput = {
	/** `{doc, options}` with `transparentBackground: true` (and usually a `layerFilter`). */
	inputProps: Record<string, unknown>;
	/** Final master file (written atomically: rendered to `scratchDir`, remuxed, then renamed). */
	output: string;
	scratchDir: string;
	signal: AbortSignal;
	/** ffmpeg used for the BT.709 remux and the frame count (the LGPL directory's or the engine's). */
	ffmpeg: FfmpegRunner;
	concurrency?: number;
	/**
	 * Render in this browser (shared by several renders, S11:LBK-022) instead of opening one; it stays open. Default:
	 * a browser of its own, closed after the render.
	 */
	browser?: SharedRenderBrowser;
	onSpawn?(child: ChildProcess): void;
	onProgress?(p: { renderedFrames: number; totalFrames: number; progress: number }): void;
	/** Job log (the single-page retry after a timeout is noted there). */
	log?(line: string): void;
};

type RemotionState = 'ready' | 'needs-browser-download' | 'unavailable';

/**
 * `JASPER_REMOTION_BROWSER_LOG=1` (diagnostics): the render page's console on the engine's stderr (stills and
 * renders), e.g. to see why a composition draws nothing.
 */
function browserLogOption(): { onBrowserLog?: (log: { type: string; text: string }) => void } {
	if (process.env.JASPER_REMOTION_BROWSER_LOG !== '1') return {};
	return { onBrowserLog: (log) => process.stderr.write(`[remotion browser ${log.type}] ${log.text}\n`) };
}

/** `chromiumOptions.gl` values Remotion 4.0.499 accepts (null = Chrome's default). */
export type RemotionGl = 'angle' | 'swangle' | 'egl' | 'swiftshader' | 'vulkan' | 'angle-egl';
/** Order in which the start-up probe tries OpenGL back ends for WebGL2 (S06:CG-042). */
const WEBGL_GL_CANDIDATES: readonly (RemotionGl | null)[] = [null, 'angle', 'swangle', 'egl', 'swiftshader'];

/** WebGL2 in the Remotion render browser (colour stage, S06:CG-042). */
export type RemotionWebglStatus = {
	state: 'ok' | 'unavailable' | 'unknown';
	/** The `chromiumOptions.gl` that gave WebGL2 (null = Chrome's default). */
	gl: RemotionGl | null;
	/** `gl.RENDERER` of the probe context, e.g. "ANGLE (Google, Vulkan 1.3.0 (SwiftShader …))". */
	renderer?: string;
	message?: string;
};

type RemotionRenderInput = {
	inputProps: Record<string, unknown>;
	output: string;
	signal: AbortSignal;
	concurrency?: number;
	/** Job log (the single-page retry after a timeout is noted there). */
	log?(line: string): void;
	onProgress?(p: { progress: number; renderedFrames: number; encodedFrames: number; stage: string }): void;
	crf?: number;
	x264Preset?: 'veryfast' | 'medium' | 'slow';
	scale?: number;
	/**
	 * Render a ProRes 422 HQ + PCM `.mov` intermediate instead of H.264 (D-13): the engine then encodes it
	 * with its own selected encoder, so no GPL encoder (Remotion's x264/fdk-aac) is ever needed.
	 */
	intermediate?: boolean;
	/** Direct VP9/Opus WebM (LGPL components); see export-plan.ts. */
	vp9?: { crf: number; colorSpace: 'bt709' | null; ffmpegOverride?: RemotionFfmpegOverride };
	audioBitrateKbps?: number;
	/** audio-mix: render the picture only (exports mux the offline mixer's audio). */
	muted?: boolean;
};

type RemotionFfmpegOverride = (info: { type: 'pre-stitcher' | 'stitcher'; args: string[] }) => string[];

/** Remotion binaries directory + what its FFmpeg is (capabilities `render.remotionBinaries`). */
export type RemotionBinariesStatus = RemotionBinaries & {
	/** License of the directory's ffmpeg from its `-version` configuration (null: bundled / not probed). */
	license: 'lgpl' | 'gpl' | 'nonfree' | 'unknown' | null;
	ffmpegVersion: string | null;
};

const SYSTEM_BROWSERS = [
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

type RendererModule = typeof import('@remotion/renderer');
type RenderBrowser = Awaited<ReturnType<RendererModule['openBrowser']>>;

/**
 * A render browser opened once and used by several renders at the same time (S11:LBK-022 parallel bakes): with a full
 * Chrome every page gets its own window (`renderPagesInOwnWindows`), so pages of concurrent renders never hide each
 * other. `close` is idempotent.
 */
export type SharedRenderBrowser = { readonly instance: RenderBrowser; close(): Promise<void> };

function findRemotionHeadlessShell(): string | null {
	// Remotion's ensureBrowser() downloads into the nearest node_modules/.remotion folder.
	try {
		const req = createRequire(import.meta.url);
		let dir = dirname(req.resolve('@remotion/renderer/package.json'));
		for (let i = 0; i < 8; i++) {
			const cand = join(dir, 'node_modules', '.remotion', 'chrome-headless-shell');
			if (existsSync(cand)) {
				const stack = [cand];
				while (stack.length) {
					const d = stack.pop()!;
					for (const n of readdirSync(d)) {
						const p = join(d, n);
						const s = statSync(p);
						if (s.isDirectory()) stack.push(p);
						else if (n === 'chrome-headless-shell' || n === 'chrome-headless-shell.exe') return p;
					}
				}
			}
			const up = dirname(dir);
			if (up === dir) break;
			dir = up;
		}
	} catch {
		// renderer not installed
	}
	return null;
}

function hashTree(root: string, h: ReturnType<typeof createHash>): void {
	if (!existsSync(root)) return;
	const stack = [root];
	const files: string[] = [];
	while (stack.length) {
		const d = stack.pop()!;
		for (const n of readdirSync(d)) {
			if (n === 'node_modules' || n.startsWith('.')) continue;
			const p = join(d, n);
			if (statSync(p).isDirectory()) stack.push(p);
			else files.push(p);
		}
	}
	for (const f of files.sort()) {
		h.update(relative(root, f));
		h.update(readFileSync(f));
	}
}

/** Root directory of workspace package `name` as resolved from `fromPackageJson` (null when not installed). */
function packageRootOf(fromPackageJson: string, name: string): string | null {
	try {
		// Resolve the package entry: workspace packages do not export their package.json.
		let dir = dirname(createRequire(fromPackageJson).resolve(name));
		for (;;) {
			const pkg = join(dir, 'package.json');
			if (existsSync(pkg) && (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === name)
				return dir;
			const up = dirname(dir);
			if (up === dir) return null;
			dir = up;
		}
	} catch {
		return null;
	}
}

function findUp(dir: string, file: string): string | null {
	for (;;) {
		const p = join(dir, file);
		if (existsSync(p)) return p;
		const up = dirname(dir);
		if (up === dir) return null;
		dir = up;
	}
}

/** Workspace packages bundled with the compositions (their sources are part of the bundle hash). */
const BUNDLED_WORKSPACE_PACKAGES = ['@jasper/project', '@jasper/mg-templates', '@jasper/motion'] as const;

/**
 * Source hash of the composition bundle inputs: Remotion version, `package.json` + `src/` of the compositions and
 * of the workspace packages they bundle (incl. `@jasper/motion`), and the workspace `pnpm-lock.yaml` so a
 * lockfile-only dependency bump (e.g. anime.js) rebuilds the bundle (S11:FIX-009).
 */
function remotionSourceHash(entry: string): string {
	const h = createHash('sha256').update(`remotion@${REMOTION_VERSION}\n`);
	const compositionsRoot = dirname(dirname(entry));
	const roots = [compositionsRoot];
	for (const dep of BUNDLED_WORKSPACE_PACKAGES) {
		const r = packageRootOf(join(compositionsRoot, 'package.json'), dep);
		if (r) roots.push(r);
	}
	for (const r of roots) {
		h.update(`#${relative(dirname(compositionsRoot), r)}\n`);
		const pkg = join(r, 'package.json');
		if (existsSync(pkg)) h.update(readFileSync(pkg));
		hashTree(join(r, 'src'), h);
	}
	const lock = findUp(compositionsRoot, 'pnpm-lock.yaml');
	if (lock) {
		h.update('#pnpm-lock.yaml\n');
		h.update(readFileSync(lock));
	}
	return h.digest('hex').slice(0, 16);
}

export class RemotionService {
	private serveUrlPromise: Promise<string> | null = null;
	private rendererPromise: Promise<RendererModule> | null = null;
	/** Identity of the bundle this process renders with (S11:LBK-020), computed once like the serve URL. */
	private bundleIdValue: string | null = null;
	private stampValue: BundleStamp | null | undefined;

	constructor(
		private readonly opts: {
			/** `<appdir>/remotion/bundle` */
			bundleCacheDir: string;
			/** Usage log for license reporting (S04:LC-004). */
			usageLog: string | null;
			env?: Record<string, string | undefined>;
			/** A prebuilt bundle (packaged builds); default: `<engine dist>/remotion-bundle` when present. */
			prebuiltBundleDir?: string | null;
			/**
			 * The binaries directory (tools/lgpl.ts `resolveRemotionBinaries`). Absent: Remotion's bundled
			 * compositor package (dev/tests only).
			 */
			binaries?: RemotionBinaries;
			log?(msg: string): void;
		},
	) {
		const b = opts.binaries ?? { dir: null, source: 'bundled', lgpl: false, allowed: true };
		this.status = { ...b, license: null, ffmpegVersion: null };
	}

	private status: RemotionBinariesStatus;
	private webgl: RemotionWebglStatus = { state: 'unknown', gl: null };
	private webglPromise: Promise<RemotionWebglStatus> | null = null;
	private ffmpegInfoValue: RemotionFfmpegInfo = { lgpl: false, encoders: null, filters: null };

	/**
	 * Probes the binaries directory's ffmpeg (license, encoders, filters). A directory whose ffmpeg is not
	 * an LGPL build is refused in strict (packaged/server) mode and flagged in dev. Call once at startup.
	 */
	async init(strict: boolean): Promise<void> {
		const dir = this.status.dir;
		if (dir) {
			const n = binaryNames();
			const sc = await selfCheck({ ffmpeg: join(dir, n.ffmpeg), ffprobe: join(dir, n.ffprobe) });
			this.status.license = sc.license;
			this.status.ffmpegVersion = sc.ffmpegVersion;
			const lgpl = sc.license === 'lgpl';
			this.ffmpegInfoValue = {
				lgpl,
				encoders: sc.ffmpegVersion ? sc.encoders : null,
				filters: sc.ffmpegVersion ? sc.filters : null,
			};
			if (!sc.ffmpegVersion) {
				this.status = {
					...this.status,
					lgpl: false,
					allowed: !strict,
					message: `The Remotion binaries directory ${dir} has an ffmpeg that does not run: ${sc.errors.join('; ').slice(0, 300)}`,
				};
			} else if (!lgpl) {
				this.status = {
					...this.status,
					lgpl: false,
					allowed: !strict,
					message: `The Remotion binaries directory ${dir} has a ${sc.license} FFmpeg build, not LGPL${strict ? ': Remotion rendering is disabled' : ' (dev only)'}`,
				};
			}
		}
		if (this.status.message) this.opts.log?.(`[remotion] ${this.status.message}`);
		else this.opts.log?.(`[remotion] binaries directory (${this.status.source}): ${this.status.dir}`);
	}

	/** Binaries directory status for capabilities and logs. */
	get binaries(): RemotionBinariesStatus {
		return this.status;
	}

	/** What the Remotion-side FFmpeg can do (drives the export plan). */
	get ffmpegInfo(): RemotionFfmpegInfo {
		return this.ffmpegInfoValue;
	}

	private get env(): Record<string, string | undefined> {
		return this.opts.env ?? process.env;
	}

	/** `binariesDirectory` for Remotion (null = the bundled compositor package, dev only). */
	get binariesDirectory(): string | null {
		return this.status.dir;
	}

	private binariesOption(): { binariesDirectory?: string } {
		if (!this.status.allowed)
			throw new JobError('BINARY_MISSING', this.status.message ?? 'Remotion rendering is disabled', false);
		return this.status.dir ? { binariesDirectory: this.status.dir } : {};
	}

	get licenseKey(): string | null {
		return this.env[ENV.REMOTION_LICENSE_KEY] || null;
	}

	/** Browser executable passed to Remotion, or null to let Remotion use its own download. */
	browserExecutable(): string | null {
		const explicit = this.env[ENV.BROWSER_EXECUTABLE];
		if (explicit) return existsSync(explicit) ? explicit : null;
		if (findRemotionHeadlessShell()) return null;
		return SYSTEM_BROWSERS.find((p) => existsSync(p)) ?? null;
	}

	private prebuiltBundle(): string | null {
		if (this.opts.prebuiltBundleDir !== undefined) {
			return this.opts.prebuiltBundleDir && existsSync(join(this.opts.prebuiltBundleDir, 'index.html'))
				? this.opts.prebuiltBundleDir
				: null;
		}
		const fromEnv = this.env.JASPER_REMOTION_BUNDLE;
		if (fromEnv && existsSync(join(fromEnv, 'index.html'))) return fromEnv;
		try {
			const here = dirname(fileURLToPath(import.meta.url));
			// Packaged engine (dist/engine.mjs): the prebuilt bundle sits next to it. Dev engines (tsx, src/)
			// never use a prebuilt bundle, so composition edits are always picked up.
			const cand = join(here, 'remotion-bundle');
			if (existsSync(join(cand, 'index.html'))) return cand;
		} catch {
			// ignore
		}
		return null;
	}

	/** Entry file of the compositions package when the workspace sources are available (dev). */
	entryPoint(): string | null {
		try {
			return createRequire(import.meta.url).resolve('@jasper/compositions/remotion-entry');
		} catch {
			return null;
		}
	}

	private rendererAvailable(): boolean {
		try {
			createRequire(import.meta.url).resolve('@remotion/renderer');
			return true;
		} catch {
			return false;
		}
	}

	/** Capability `render.remotionLocal` (S04:RT-002, RR-010). */
	state(): RemotionState {
		if (!this.status.allowed) return 'unavailable';
		if (!this.rendererAvailable()) return 'unavailable';
		if (!this.prebuiltBundle() && !this.entryPoint()) return 'unavailable';
		if (this.env[ENV.BROWSER_EXECUTABLE])
			return existsSync(this.env[ENV.BROWSER_EXECUTABLE]!) ? 'ready' : 'needs-browser-download';
		if (findRemotionHeadlessShell() || SYSTEM_BROWSERS.some((p) => existsSync(p))) return 'ready';
		return 'needs-browser-download';
	}

	private renderer(): Promise<RendererModule> {
		this.rendererPromise ??= import('@remotion/renderer');
		return this.rendererPromise;
	}

	/** Source hash of the composition bundle inputs (see `remotionSourceHash`). */
	sourceHash(entry: string): string {
		return remotionSourceHash(entry);
	}

	/** The Remotion serve URL: prebuilt bundle, or a cached bundle of the workspace sources. */
	serveUrl(): Promise<string> {
		this.serveUrlPromise ??= this.buildServeUrl().catch((e) => {
			this.serveUrlPromise = null;
			throw e;
		});
		return this.serveUrlPromise;
	}

	/** The stamp of the prebuilt bundle (`jasper-bundle.json`), or null (dev bundles, unstamped builds). */
	private bundleStamp(): BundleStamp | null {
		if (this.stampValue !== undefined) return this.stampValue;
		const dir = this.prebuiltBundle();
		let stamp: BundleStamp | null = null;
		if (dir) {
			try {
				const raw = JSON.parse(readFileSync(join(dir, BUNDLE_STAMP_FILE), 'utf8')) as Partial<BundleStamp>;
				if (typeof raw.bundleId === 'string' && raw.bundleId)
					stamp = {
						bundleId: raw.bundleId,
						animejs: typeof raw.animejs === 'string' ? raw.animejs : animejsVersion(),
						remotion: typeof raw.remotion === 'string' ? raw.remotion : REMOTION_VERSION,
					};
			} catch {
				// no stamp: bundleId() hashes the bundle instead
			}
		}
		this.stampValue = stamp;
		return stamp;
	}

	/**
	 * Identity of the compositions bundle renders use (S11:LBK-020): the stamp of a prebuilt bundle (packaged), the
	 * content hash of an unstamped prebuilt bundle, or the dev source hash (the one that names the cached bundle).
	 * Computed once per process, like the serve URL.
	 */
	bundleId(): string {
		if (this.bundleIdValue) return this.bundleIdValue;
		const prebuilt = this.prebuiltBundle();
		if (prebuilt) {
			const stamp = this.bundleStamp();
			if (stamp) this.bundleIdValue = stamp.bundleId;
			else {
				const h = createHash('sha256');
				hashTree(prebuilt, h);
				this.bundleIdValue = `content-${h.digest('hex').slice(0, 16)}`;
			}
			return this.bundleIdValue;
		}
		const entry = this.entryPoint();
		this.bundleIdValue = entry ? this.sourceHash(entry) : 'none';
		return this.bundleIdValue;
	}

	/** anime.js version inside the bundle (S11:ANM-011): the stamp of a prebuilt bundle, else the workspace's. */
	animejsVersion(): string {
		return this.bundleStamp()?.animejs ?? animejsVersion();
	}

	/**
	 * Identity of the render browser (S11:LBK-020): the executable with its size and mtime (a browser update changes
	 * it), or Remotion's own download.
	 */
	browserIdentity(): string {
		const exe = this.browserExecutable() ?? findRemotionHeadlessShell();
		if (!exe) return 'remotion-download';
		try {
			const st = statSync(exe);
			return `${exe}|${st.size}|${Math.round(st.mtimeMs)}`;
		} catch {
			return exe;
		}
	}

	/** The `chromiumOptions.gl` renders use (awaits the WebGL probe once): `default`, a back end, or `none`. */
	async renderGl(): Promise<string> {
		const s = await this.probeWebgl().catch(() => this.webgl);
		return s.state === 'ok' ? (s.gl ?? 'default') : 'none';
	}

	private async buildServeUrl(): Promise<string> {
		const prebuilt = this.prebuiltBundle();
		if (prebuilt) return prebuilt;
		const entry = this.entryPoint();
		if (!entry)
			throw new JobError('BINARY_MISSING', 'No Remotion bundle and no composition sources available', false);
		const hash = this.sourceHash(entry);
		this.bundleIdValue = hash;
		const outDir = join(this.opts.bundleCacheDir, hash);
		if (existsSync(join(outDir, 'index.html'))) return outDir;
		await mkdir(this.opts.bundleCacheDir, { recursive: true });
		const tmp = `${outDir}.partial-${process.pid}`;
		await rm(tmp, { recursive: true, force: true });
		this.opts.log?.(`[remotion] bundling compositions (${hash})…`);
		const { bundle } = await import('@remotion/bundler');
		await bundle({ entryPoint: entry, outDir: tmp, enableCaching: true });
		await rm(outDir, { recursive: true, force: true });
		await rename(tmp, outDir);
		// Keep only the newest few bundles.
		const others = readdirSync(this.opts.bundleCacheDir)
			.filter((n) => n !== hash && !n.includes('.partial'))
			.map((n) => ({ n, t: statSync(join(this.opts.bundleCacheDir, n)).mtimeMs }))
			.sort((a, b) => b.t - a.t);
		for (const o of others.slice(2))
			await rm(join(this.opts.bundleCacheDir, o.n), { recursive: true, force: true });
		return outDir;
	}

	private browserOptions(): {
		browserExecutable?: string;
		chromeMode: 'headless-shell' | 'chrome-for-testing';
	} {
		const exe = this.browserExecutable();
		if (!exe) return { chromeMode: 'headless-shell' };
		// A full Chrome (not chrome-headless-shell) needs the new headless mode.
		return {
			browserExecutable: exe,
			chromeMode: /headless-shell/.test(exe) ? 'headless-shell' : 'chrome-for-testing',
		};
	}

	/** Current WebGL2 status of the render browser (`unknown` until `probeWebgl` finished). */
	get webglStatus(): RemotionWebglStatus {
		return this.webgl;
	}

	/**
	 * Finds a `chromiumOptions.gl` that gives WebGL2 in the headless render browser (S06:CG-042): opens the
	 * browser with each candidate (`JASPER_REMOTION_GL` forces one) and asks a blank page for a WebGL2
	 * context. Cached; the colour stage of the compositions needs it on the Remotion path.
	 */
	probeWebgl(): Promise<RemotionWebglStatus> {
		this.webglPromise ??= this.runWebglProbe().then((s) => {
			this.webgl = s;
			this.opts.log?.(
				`[remotion] WebGL2 ${s.state}${s.state === 'ok' ? ` (gl=${s.gl ?? 'default'}, ${s.renderer ?? '?'})` : s.message ? `: ${s.message}` : ''}`,
			);
			return s;
		});
		return this.webglPromise;
	}

	private async runWebglProbe(): Promise<RemotionWebglStatus> {
		const forced = this.env.JASPER_REMOTION_GL;
		if (forced === 'off')
			return { state: 'unavailable', gl: null, message: 'disabled by JASPER_REMOTION_GL=off' };
		if (this.state() !== 'ready')
			return { state: 'unknown', gl: null, message: `Remotion rendering is ${this.state()}` };
		const candidates: (RemotionGl | null)[] = forced
			? [forced === 'default' ? null : (forced as RemotionGl)]
			: [...WEBGL_GL_CANDIDATES];
		let r: RendererModule;
		try {
			r = await this.renderer();
		} catch (e) {
			return { state: 'unknown', gl: null, message: (e as Error).message };
		}
		const errors: string[] = [];
		for (const gl of candidates) {
			let browser: RenderBrowser | null = null;
			try {
				browser = await r.openBrowser('chrome', {
					...this.browserOptions(),
					chromiumOptions: { gl },
					logLevel: 'error',
				});
				const page = await browser.newPage({
					context: () => null,
					logLevel: 'error',
					indent: false,
					pageIndex: 0,
					onBrowserLog: null,
					onLog: () => undefined,
				});
				const renderer = (await page.evaluate(() => {
					const c = document.createElement('canvas');
					const ctx = c.getContext('webgl2');
					if (!ctx) return null;
					const dbg = ctx.getExtension('WEBGL_debug_renderer_info');
					return String(ctx.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : ctx.RENDERER));
				})) as string | null;
				if (renderer) return { state: 'ok', gl, renderer };
				errors.push(`${gl ?? 'default'}: no WebGL2 context`);
			} catch (e) {
				errors.push(`${gl ?? 'default'}: ${(e as Error).message.slice(0, 200)}`);
			} finally {
				await browser?.close({ silent: true }).catch(() => undefined);
			}
		}
		return { state: 'unavailable', gl: null, message: errors.join('; ') };
	}

	/** `chromiumOptions` for renders: the probed `gl` (awaits the probe once). */
	private async chromiumOptions(): Promise<{ chromiumOptions?: { gl: RemotionGl | null } }> {
		const s = await this.probeWebgl().catch(() => this.webgl);
		return s.state === 'ok' && s.gl ? { chromiumOptions: { gl: s.gl } } : {};
	}

	/**
	 * S06:CG-042: a document with colour effects needs WebGL2 in the render browser; without it the render
	 * fails with `WEBGL_UNAVAILABLE` (never silently ungraded). Wave 1 (fx framework): GPU shader effects too.
	 */
	private async assertWebglFor(inputProps: Record<string, unknown>): Promise<void> {
		if (!docHasColorEffects(inputProps.doc)) return;
		const s = await this.probeWebgl();
		if (s.state === 'unavailable')
			throw new JobError(
				'WEBGL_UNAVAILABLE',
				`Colour grading and GPU effects on the Remotion path need WebGL2 in the render browser, which is unavailable here${s.message ? ` (${s.message})` : ''}`,
				false,
			);
	}

	/**
	 * Remotion usage log for license reporting (S04:LC-004): one line per render call. M2 (S11:LBK-026): public so
	 * layer bakes and mg pre-renders (which drive `@remotion/renderer` themselves) log too; `purpose` says why.
	 */
	async recordUsage(kind: 'media' | 'still', purpose?: RemotionUsagePurpose): Promise<void> {
		if (!this.opts.usageLog) return;
		await mkdir(dirname(this.opts.usageLog), { recursive: true });
		await appendFile(
			this.opts.usageLog,
			`${JSON.stringify({ at: new Date().toISOString(), kind, ...(purpose ? { purpose } : {}) })}\n`,
		).catch(() => undefined);
	}

	private async composition(
		inputProps: Record<string, unknown>,
		signal: AbortSignal,
		shared?: SharedRenderBrowser,
	) {
		// Refuse before bundling or loading the renderer when the LGPL directory is missing (strict mode).
		const binaries = this.binariesOption();
		await this.assertWebglFor(inputProps);
		const r = await this.renderer();
		const serveUrl = await this.serveUrl();
		if (signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
		// The WebGL-capable `gl` of the start-up probe (S06:CG-042) applies to every page of the render.
		const browser = { ...this.browserOptions(), ...(await this.chromiumOptions()) };
		const composition = await r
			.selectComposition({
				serveUrl,
				id: COMPOSITION_ID,
				inputProps,
				timeoutInMilliseconds: DELAY_RENDER_TIMEOUT_MS,
				logLevel: 'error',
				...binaries,
				...browser,
				...(shared ? { puppeteerInstance: shared.instance } : {}),
			})
			.catch((e: unknown) => {
				throw mapRenderError(e, signal);
			});
		return { r, serveUrl, composition, browser };
	}

	/**
	 * S11:ANM-014: the browser of a render with `concurrency` pages, or null to let Remotion open its own. A full
	 * Chrome (`chrome-for-testing`, new headless mode) would open the pages as tabs of one window, hidden while
	 * another tab is in front, and Remotion captured a page's first frame right after showing it, before Chrome had
	 * painted it (a black or partial frame). Here every page gets its own window (`renderPagesInOwnWindows`).
	 * Remotion's chrome-headless-shell has no tabs: null.
	 */
	private async renderBrowser(
		r: RendererModule,
		browser: Awaited<ReturnType<RemotionService['composition']>>['browser'],
		concurrency: number,
	): Promise<RenderBrowser | null> {
		if (concurrency <= 1 || browser.chromeMode !== 'chrome-for-testing') return null;
		const instance = await r.openBrowser('chrome', { ...browser, logLevel: 'error' });
		if (!renderPagesInOwnWindows(instance)) {
			await instance.close({ silent: true }).catch(() => undefined);
			return null;
		}
		return instance;
	}

	/**
	 * S11:LBK-022: one render browser for several renders running at the same time (the bakes of an export): the probed
	 * `gl`, and with a full Chrome every page in its own window (S11:ANM-014). Pass it as `browser` to
	 * `renderAlphaMaster` / `renderStill`; the caller closes it.
	 */
	async openSharedBrowser(): Promise<SharedRenderBrowser> {
		this.binariesOption();
		const r = await this.renderer();
		const browser = { ...this.browserOptions(), ...(await this.chromiumOptions()) };
		const instance = await r.openBrowser('chrome', { ...browser, logLevel: 'error' });
		if (browser.chromeMode === 'chrome-for-testing' && !renderPagesInOwnWindows(instance)) {
			await instance.close({ silent: true }).catch(() => undefined);
			throw new JobError('RENDER_FAILED', 'The render browser does not expose its CDP connection', true);
		}
		let closed: Promise<void> | null = null;
		return {
			instance,
			close: () => {
				closed ??= instance.close({ silent: true }).catch(() => undefined);
				return closed;
			},
		};
	}

	/**
	 * `renderMedia` (S04:RR-001/004/005/006/011): a ProRes/PCM intermediate, a direct VP9/Opus WebM, or
	 * (dev with Remotion's GPL build only) H.264/AAC — see export-plan.ts.
	 */
	async renderMedia(input: RemotionRenderInput): Promise<{ frames: number }> {
		const { r, serveUrl, composition, browser } = await this.composition(input.inputProps, input.signal);
		const { cancelSignal, cancel } = r.makeCancelSignal();
		const onAbort = () => cancel();
		input.signal.addEventListener('abort', onAbort, { once: true });
		const concurrency = input.concurrency ?? renderParallelism();
		let instance: RenderBrowser | null = null;
		try {
			instance = await this.renderBrowser(r, browser, concurrency);
			await this.recordUsage('media', 'export');
			await withSinglePageRetry(concurrency, input.signal, input.log, (pages) =>
				r
					.renderMedia({
						serveUrl,
						composition,
						inputProps: input.inputProps,
						// Lossless frame capture: Remotion's default for videos is JPEG (quality 80), whose 4:2:0 chroma
						// and DCT ringing blur thin strokes and saturated edges well past what Program preview draws.
						imageFormat: 'png' as const,
						...(input.intermediate
							? {
									codec: 'prores' as const,
									proResProfile: 'hq' as const,
									...(input.muted ? {} : { audioCodec: 'pcm-16' as const }),
								}
							: input.vp9
								? {
										codec: 'vp9' as const,
										...(input.muted ? {} : { audioCodec: 'opus' as const }),
										pixelFormat: 'yuv420p' as const,
										crf: input.vp9.crf,
										...(input.vp9.colorSpace ? { colorSpace: input.vp9.colorSpace } : {}),
										...(input.vp9.ffmpegOverride ? { ffmpegOverride: input.vp9.ffmpegOverride } : {}),
										...(input.audioBitrateKbps ? { audioBitrate: `${input.audioBitrateKbps}k` } : {}),
									}
								: {
										codec: 'h264' as const,
										...(input.muted ? {} : { audioCodec: 'aac' as const }),
										pixelFormat: 'yuv420p' as const,
										crf: input.crf ?? 18,
										x264Preset: input.x264Preset ?? 'medium',
									}),
						...this.binariesOption(),
						outputLocation: input.output,
						...(input.muted ? { muted: true } : {}),
						concurrency: pages,
						cancelSignal,
						timeoutInMilliseconds: DELAY_RENDER_TIMEOUT_MS,
						licenseKey: this.licenseKey,
						logLevel: 'error',
						overwrite: true,
						...(input.scale ? { scale: input.scale } : {}),
						...browser,
						...(instance ? { puppeteerInstance: instance } : {}),
						onProgress: (p) =>
							input.onProgress?.({
								progress: p.progress,
								renderedFrames: p.renderedFrames,
								encodedFrames: p.encodedFrames,
								stage:
									p.stitchStage === 'muxing'
										? 'Muxing'
										: p.renderedFrames < composition.durationInFrames
											? 'Rendering frames'
											: 'Encoding',
							}),
					})
					.then(() => undefined),
			);
			return { frames: composition.durationInFrames };
		} catch (e) {
			throw mapRenderError(e, input.signal);
		} finally {
			input.signal.removeEventListener('abort', onAbort);
			await instance?.close({ silent: true }).catch(() => undefined);
		}
	}

	/**
	 * M2 (S11:LBK-003): a straight-alpha ProRes 4444 master of `inputProps` (`yuva444p10le`, PNG frames, muted,
	 * BT.709 tags stamped by a lossless remux, frame count verified) — what the layer bake overlays natively.
	 * Returns the frame count.
	 */
	async renderAlphaMaster(input: AlphaMasterInput): Promise<{ frames: number }> {
		const { r, serveUrl, composition, browser } = await this.composition(
			input.inputProps,
			input.signal,
			input.browser,
		);
		const { cancelSignal, cancel } = r.makeCancelSignal();
		const onAbort = () => cancel();
		input.signal.addEventListener('abort', onAbort, { once: true });
		const total = composition.durationInFrames;
		const raw = join(input.scratchDir, `alpha-${process.pid}-${Date.now().toString(36)}-raw.mov`);
		const tagged = `${raw.slice(0, -'-raw.mov'.length)}.mov`;
		const concurrency = input.concurrency ?? renderParallelism();
		// Own browser (closed below) unless the caller shares one.
		let instance: RenderBrowser | null = null;
		try {
			if (!input.browser) instance = await this.renderBrowser(r, browser, concurrency);
			const puppeteer = input.browser?.instance ?? instance;
			await this.recordUsage('media', 'layer-bake');
			await withSinglePageRetry(concurrency, input.signal, input.log, (pages) =>
				r
					.renderMedia({
						serveUrl,
						composition,
						inputProps: input.inputProps,
						...ALPHA_MASTER_OPTIONS,
						...this.binariesOption(),
						outputLocation: raw,
						concurrency: pages,
						cancelSignal,
						timeoutInMilliseconds: DELAY_RENDER_TIMEOUT_MS,
						licenseKey: this.licenseKey,
						logLevel: 'error',
						overwrite: true,
						...browser,
						...(puppeteer ? { puppeteerInstance: puppeteer } : {}),
						onProgress: (p) =>
							input.onProgress?.({
								renderedFrames: p.renderedFrames,
								totalFrames: total,
								progress: p.progress,
							}),
					})
					.then(() => undefined),
			);
		} catch (e) {
			throw mapRenderError(e, input.signal);
		} finally {
			input.signal.removeEventListener('abort', onAbort);
			await instance?.close({ silent: true }).catch(() => undefined);
		}
		await input.ffmpeg.run(bt709RemuxArgs(raw, tagged), {
			signal: input.signal,
			...(input.onSpawn ? { onSpawn: input.onSpawn } : {}),
		});
		await rm(raw, { force: true });
		const frames = await input.ffmpeg.countVideoFrames(tagged, { signal: input.signal });
		if (frames !== total)
			throw new JobError('FRAME_COUNT_MISMATCH', `The master has ${frames} frames, expected ${total}`, true, {
				expected: total,
				actual: frames,
			});
		await mkdir(dirname(input.output), { recursive: true });
		await rename(tagged, input.output);
		return { frames };
	}

	/** `renderStill` to PNG (S04:EX-030, ARCHITECTURE §9.2 stills). `frame` is composition-relative. */
	async renderStill(input: {
		inputProps: Record<string, unknown>;
		output: string;
		frame: number;
		scale?: number;
		signal: AbortSignal;
		/**
		 * Usage-log purpose (default `still`). Layer bakes render with `transparentBackground`: the PNG keeps the
		 * straight alpha of the page.
		 */
		purpose?: RemotionUsagePurpose;
		/** Render in this shared browser (S11:LBK-022; it stays open) instead of a browser of its own. */
		browser?: SharedRenderBrowser;
	}): Promise<void> {
		const { r, serveUrl, composition, browser } = await this.composition(
			input.inputProps,
			input.signal,
			input.browser,
		);
		const { cancelSignal, cancel } = r.makeCancelSignal();
		const onAbort = () => cancel();
		input.signal.addEventListener('abort', onAbort, { once: true });
		try {
			await this.recordUsage('still', input.purpose ?? 'still');
			await r.renderStill({
				serveUrl,
				composition,
				inputProps: input.inputProps,
				frame: Math.max(0, Math.min(composition.durationInFrames - 1, input.frame)),
				output: input.output,
				imageFormat: 'png',
				cancelSignal,
				timeoutInMilliseconds: DELAY_RENDER_TIMEOUT_MS,
				licenseKey: this.licenseKey,
				logLevel: 'error',
				overwrite: true,
				...browserLogOption(),
				...this.binariesOption(),
				...(input.scale ? { scale: input.scale } : {}),
				...browser,
				...(input.browser ? { puppeteerInstance: input.browser.instance } : {}),
			});
		} catch (e) {
			throw mapRenderError(e, input.signal);
		} finally {
			input.signal.removeEventListener('abort', onAbort);
		}
	}
}

/** True when a render doc (RenderSnapshot) has an enabled colour effect (registry `color` op). */
function docHasColorEffects(doc: unknown): boolean {
	const tracks = (
		doc as { videoTracks?: { clips?: { effects?: { effectId: string; enabled: boolean }[] }[] }[] }
	)?.videoTracks;
	if (!Array.isArray(tracks)) return false;
	for (const t of tracks)
		for (const c of t.clips ?? [])
			for (const fx of c.effects ?? [])
				if (
					fx.enabled &&
					(defaultEffectRegistry.get(fx.effectId)?.color || defaultEffectRegistry.get(fx.effectId)?.gpu)
				)
					return true;
	return false;
}

/**
 * Concurrent heavy compositions can time out under software GL or host contention even when one page
 * succeeds. Retry RENDER_TIMEOUT once on a single page; a repeated timeout retains the typed error.
 */
async function withSinglePageRetry(
	concurrency: number,
	signal: AbortSignal,
	log: ((line: string) => void) | undefined,
	render: (concurrency: number) => Promise<void>,
): Promise<void> {
	try {
		await render(concurrency);
	} catch (e) {
		const mapped = mapRenderError(e, signal);
		if (concurrency <= 1 || signal.aborted || (mapped as JobError).code !== 'RENDER_TIMEOUT') throw mapped;
		log?.(`remotion: ${mapped.message.slice(0, 300)} — rendering again on one page (was ${concurrency})`);
		try {
			await render(1);
		} catch (e2) {
			throw mapRenderError(e2, signal);
		}
	}
}

function mapRenderError(e: unknown, signal: AbortSignal): Error {
	if (signal.aborted) return new JobError('JOB_CANCELLED', 'Cancelled');
	if (e instanceof JobError) return e;
	const msg = (e as Error)?.message ?? String(e);
	// The compositions' colour stage cancels the render with this code when WebGL2 is missing (S06:CG-042).
	if (/WEBGL_UNAVAILABLE/.test(msg)) return new JobError('WEBGL_UNAVAILABLE', msg.slice(0, 1500), false);
	// Wave 1 (fx framework): a GPU effect whose shader does not compile, or that a layer kind cannot run.
	// color-mgmt: a scope drawn through HTML-in-Canvas inside another one (the browser cannot nest them).
	const fx = /\b(FX_SHADER_ERROR|FX_LAYER_UNSUPPORTED|CANVAS_NESTED)\b/.exec(msg)?.[1];
	if (fx) return new JobError(fx, msg.slice(0, 1500), false);
	const frame = /frame[^\d]{0,12}(\d+)/i.exec(msg)?.[1];
	if (/delayRender|timeout|timed out/i.test(msg)) {
		return new JobError(
			'RENDER_TIMEOUT',
			`Render timed out${frame ? ` at frame ${frame}` : ''}: ${msg.slice(0, 600)}`,
			true,
			{
				frame: frame ? Number(frame) : undefined,
			},
		);
	}
	return new JobError('RENDER_FAILED', msg.slice(0, 1500), true, {
		frame: frame ? Number(frame) : undefined,
	});
}
