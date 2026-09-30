// Local Remotion rendering (S04 §13 RR-001…006/011, ARCHITECTURE §9.5, §10.3): one bundle of
// `@jasper/compositions/remotion-entry` (prebuilt for packaged installs, otherwise bundled once and cached
// under `<appdir>/remotion/bundle/<sourceHash>`), `selectComposition('JasperSequence')`, then `renderMedia`
// or `renderStill` with the configured license key and a headless browser.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { appendFile, mkdir, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV } from '@jasper/config';
import { JobError } from '../jobs/types.ts';
import { selfCheck } from '../tools/ffmpeg.ts';
import { binaryNames, type RemotionBinaries } from '../tools/lgpl.ts';
import type { RemotionFfmpegInfo } from './export-plan.ts';

export const COMPOSITION_ID = 'JasperSequence';
export const REMOTION_VERSION = '4.0.499';
export const DELAY_RENDER_TIMEOUT_MS = 60_000;

export type RemotionState = 'ready' | 'needs-browser-download' | 'unavailable';

export type RemotionRenderInput = {
	inputProps: Record<string, unknown>;
	output: string;
	signal: AbortSignal;
	concurrency?: number;
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
};

export type RemotionFfmpegOverride = (info: {
	type: 'pre-stitcher' | 'stitcher';
	args: string[];
}) => string[];

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

export class RemotionService {
	private serveUrlPromise: Promise<string> | null = null;
	private rendererPromise: Promise<RendererModule> | null = null;

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

	/** Source hash of the composition bundle inputs (package versions + sources). */
	sourceHash(entry: string): string {
		const h = createHash('sha256').update(`remotion@${REMOTION_VERSION}\n`);
		const compositionsRoot = dirname(dirname(entry));
		const req = createRequire(entry);
		const roots = [compositionsRoot];
		for (const dep of ['@jasper/project', '@jasper/mg-templates']) {
			try {
				roots.push(dirname(req.resolve(`${dep}/package.json`)));
			} catch {
				// optional
			}
		}
		for (const r of roots) {
			h.update(`#${relative(dirname(compositionsRoot), r)}\n`);
			const pkg = join(r, 'package.json');
			if (existsSync(pkg)) h.update(readFileSync(pkg));
			hashTree(join(r, 'src'), h);
		}
		return h.digest('hex').slice(0, 16);
	}

	/** The Remotion serve URL: prebuilt bundle, or a cached bundle of the workspace sources. */
	serveUrl(): Promise<string> {
		this.serveUrlPromise ??= this.buildServeUrl().catch((e) => {
			this.serveUrlPromise = null;
			throw e;
		});
		return this.serveUrlPromise;
	}

	private async buildServeUrl(): Promise<string> {
		const prebuilt = this.prebuiltBundle();
		if (prebuilt) return prebuilt;
		const entry = this.entryPoint();
		if (!entry)
			throw new JobError('BINARY_MISSING', 'No Remotion bundle and no composition sources available', false);
		const hash = this.sourceHash(entry);
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

	private async recordUsage(kind: 'media' | 'still'): Promise<void> {
		if (!this.opts.usageLog) return;
		await mkdir(dirname(this.opts.usageLog), { recursive: true });
		await appendFile(this.opts.usageLog, `${JSON.stringify({ at: new Date().toISOString(), kind })}\n`).catch(
			() => undefined,
		);
	}

	private async composition(inputProps: Record<string, unknown>, signal: AbortSignal) {
		// Refuse before bundling or loading the renderer when the LGPL directory is missing (strict mode).
		const binaries = this.binariesOption();
		const r = await this.renderer();
		const serveUrl = await this.serveUrl();
		if (signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
		const browser = this.browserOptions();
		const composition = await r.selectComposition({
			serveUrl,
			id: COMPOSITION_ID,
			inputProps,
			timeoutInMilliseconds: DELAY_RENDER_TIMEOUT_MS,
			logLevel: 'error',
			...binaries,
			...browser,
		});
		return { r, serveUrl, composition, browser };
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
		const cores = availableParallelism();
		try {
			await this.recordUsage('media');
			await r.renderMedia({
				serveUrl,
				composition,
				inputProps: input.inputProps,
				...(input.intermediate
					? { codec: 'prores' as const, proResProfile: 'hq' as const, audioCodec: 'pcm-16' as const }
					: input.vp9
						? {
								codec: 'vp9' as const,
								audioCodec: 'opus' as const,
								pixelFormat: 'yuv420p' as const,
								crf: input.vp9.crf,
								...(input.vp9.colorSpace ? { colorSpace: input.vp9.colorSpace } : {}),
								...(input.vp9.ffmpegOverride ? { ffmpegOverride: input.vp9.ffmpegOverride } : {}),
								...(input.audioBitrateKbps ? { audioBitrate: `${input.audioBitrateKbps}k` } : {}),
							}
						: {
								codec: 'h264' as const,
								audioCodec: 'aac' as const,
								pixelFormat: 'yuv420p' as const,
								crf: input.crf ?? 18,
								x264Preset: input.x264Preset ?? 'medium',
							}),
				...this.binariesOption(),
				outputLocation: input.output,
				concurrency: input.concurrency ?? Math.max(1, Math.floor(cores / 2)),
				cancelSignal,
				timeoutInMilliseconds: DELAY_RENDER_TIMEOUT_MS,
				licenseKey: this.licenseKey,
				logLevel: 'error',
				overwrite: true,
				...(input.scale ? { scale: input.scale } : {}),
				...browser,
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
			});
			return { frames: composition.durationInFrames };
		} catch (e) {
			throw mapRenderError(e, input.signal);
		} finally {
			input.signal.removeEventListener('abort', onAbort);
		}
	}

	/** `renderStill` to PNG (S04:EX-030, ARCHITECTURE §9.2 stills). `frame` is composition-relative. */
	async renderStill(input: {
		inputProps: Record<string, unknown>;
		output: string;
		frame: number;
		scale?: number;
		signal: AbortSignal;
	}): Promise<void> {
		const { r, serveUrl, composition, browser } = await this.composition(input.inputProps, input.signal);
		const { cancelSignal, cancel } = r.makeCancelSignal();
		const onAbort = () => cancel();
		input.signal.addEventListener('abort', onAbort, { once: true });
		try {
			await this.recordUsage('still');
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
				...this.binariesOption(),
				...(input.scale ? { scale: input.scale } : {}),
				...browser,
			});
		} catch (e) {
			throw mapRenderError(e, input.signal);
		} finally {
			input.signal.removeEventListener('abort', onAbort);
		}
	}
}

function mapRenderError(e: unknown, signal: AbortSignal): Error {
	if (signal.aborted) return new JobError('JOB_CANCELLED', 'Cancelled');
	const msg = (e as Error)?.message ?? String(e);
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
