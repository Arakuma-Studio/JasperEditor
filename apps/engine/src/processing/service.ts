// Clip processing on the engine (S07 §3, §5; ARCHITECTURE §19.4): `process` jobs run jasper-proc locally or on
// a remote host over SSH and register the output as a processed version (`MediaService.registerDerived`);
// `model-download` installs super-resolution models; `remote-setup` prepares a remote host.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';

import { basename, dirname, extname, join } from 'node:path';
import type {
	EngineJob,
	M2Features,
	ProcessingSettings,
	ProcessRequest,
	ProcessResult,
	RemoteProbeResult,
} from '@jasper/api';
import type { ProcessStep } from '@jasper/project';
import { type JobContext, JobError } from '../jobs/types.ts';
import { fingerprintHex } from '../media/fingerprint.ts';
import type { MediaRecord } from '../media/registry.ts';
import { VisionModelStore, visionModelsDir } from '../roto/models.ts';
import { SpeechModelError, SpeechModelStore, speechModelsDir } from '../speech/models.ts';
import { safeFileName, sha256File } from '../tools/fs.ts';
import type { CoreServices } from '../tools/services.ts';
import { createEventParser, ProgressTracker } from './events.ts';
import { loadCatalog, ModelError, ModelStore } from './models.ts';
import { RECIPE_VERSION, recipeHash, recipeLabel } from './proc/recipe.ts';
import type { ProcEvent, ProcSpec } from './proc/types.ts';
import { procBundle, procCommand } from './proc-entry.ts';
import { checkIdentity, RemoteError, SshRemote, shq } from './remote.ts';
import { ProcessingSettingsStore, type StoredProbe } from './settings.ts';
import { VIDSTAB_PIN } from './vidstab-pin.ts';

type ProcessJobInput = {
	mediaKey: string;
	steps: ProcessStep[];
	executor: 'local' | 'remote';
	range?: { startFrame: number; endFrame: number };
	projectId?: string;
};

type Env = Record<string, string | undefined>;

export class ProcessingService {
	readonly settings: ProcessingSettingsStore;
	readonly models: ModelStore;
	/** wp speech: the catalogue's speech models (`<appdir>/models/speech/<id>/`), installed by the same job kind. */
	readonly speechModels: SpeechModelStore;
	/** parity (roto): segmentation and face models (`<appdir>/models/vision/<id>/`), installed by the same job kind. */
	readonly visionModels: VisionModelStore;
	private filters: Set<string> | null = null;
	private wasmOk: boolean | null = null;

	constructor(
		private readonly core: CoreServices,
		private readonly env: Env = process.env,
	) {
		const paths = core.config.paths;
		this.settings = new ProcessingSettingsStore(paths.engineConfig);
		const { entries, bundledDir, speech, vision } = loadCatalog(env);
		this.models = new ModelStore({ modelsDir: join(paths.root, 'models'), entries, bundledDir });
		this.speechModels = new SpeechModelStore(speechModelsDir(paths.root), speech);
		this.visionModels = new VisionModelStore(visionModelsDir(paths.root), vision);
	}

	registerRunners(): void {
		const q = this.core.queue;
		q.registerRunner('process', (ctx) => this.runProcess(ctx));
		q.registerRunner('model-download', (ctx) => this.runInstall(ctx));
		q.registerRunner('remote-setup', (ctx) => this.runSetup(ctx));
	}

	// ------------------------------------------------------------------ capabilities

	private get ffmpegPath(): string {
		const f = this.core.ffmpeg.bins.ffmpeg;
		if (!f) throw new JobError('BINARY_MISSING', 'ffmpeg was not found', false);
		return f;
	}

	private get ffprobePath(): string {
		const f = this.core.ffmpeg.bins.ffprobe;
		if (!f) throw new JobError('BINARY_MISSING', 'ffprobe was not found', false);
		return f;
	}

	async ffmpegFilters(): Promise<Set<string>> {
		if (this.filters) return this.filters;
		const f = this.core.ffmpeg.bins.ffmpeg;
		if (!f) return new Set();
		const out = await new Promise<string>((resolve) => {
			const c = spawn(f, ['-hide_banner', '-filters'], { stdio: ['ignore', 'pipe', 'ignore'] });
			let s = '';
			c.stdout.on('data', (d: Buffer) => {
				s += d.toString();
			});
			c.on('close', () => resolve(s));
			c.on('error', () => resolve(''));
		});
		const set = new Set<string>();
		for (const line of out.split('\n')) {
			const m = /^\s*[A-Z.|]{2,4}\s+(\S+)\s+\S+->\S+/.exec(line);
			if (m) set.add(m[1]);
		}
		this.filters = set;
		return set;
	}

	/**
	 * FFmpeg's own vid.stab filters are used only when the engine's FFmpeg directory records the pinned
	 * relicensed vid.stab in BUILDINFO.json (S07:PST-003) — never a system (GPL) build.
	 */
	async nativeVidstabAllowed(): Promise<boolean> {
		const f = this.core.ffmpeg.bins.ffmpeg;
		if (!f) return false;
		const info = join(dirname(f), 'BUILDINFO.json');
		if (!existsSync(info)) return false;
		try {
			const rec = JSON.parse(readFileSync(info, 'utf8')).libvidstab as { commit?: string; license?: string };
			if (rec?.commit !== VIDSTAB_PIN.commit || rec.license !== 'LGPL-2.1-or-later') return false;
		} catch {
			return false;
		}
		const filters = await this.ffmpegFilters();
		return filters.has('vidstabdetect') && filters.has('vidstabtransform');
	}

	async vidstabWasmAvailable(): Promise<boolean> {
		if (this.wasmOk !== null) return this.wasmOk;
		try {
			const m = await import('./proc/vidstab/index.ts');
			this.wasmOk = await m.vidstabWasmAvailable();
		} catch {
			this.wasmOk = false;
		}
		return this.wasmOk;
	}

	/**
	 * Which vid.stab engine jasper-proc should use: the WASM module (16-bit, as fast or faster than FFmpeg's
	 * filters in our measurements); FFmpeg's filters only when asked (`JASPER_VIDSTAB_ENGINE=ffmpeg`) AND the
	 * engine's FFmpeg is our LGPL build with the pinned vid.stab.
	 */
	async vidstabEngine(): Promise<'wasm' | 'ffmpeg'> {
		if (this.env.JASPER_VIDSTAB_ENGINE === 'ffmpeg' && (await this.nativeVidstabAllowed())) return 'ffmpeg';
		return 'wasm';
	}

	async features(): Promise<NonNullable<M2Features['processing']>> {
		const filters = await this.ffmpegFilters();
		const native = await this.nativeVidstabAllowed();
		const wasm = await this.vidstabWasmAvailable();
		const providers: string[] = await import('./proc/upscale.ts')
			.then((m) => m.ortProviders())
			.catch(() => []);
		const s = await this.settings.get();
		const probe = await this.settings.lastProbe();
		const installed = (await this.models.list()).filter((m) => m.installed).length;
		let dejudder: 'ready' | 'unavailable' = 'unavailable';
		try {
			await import('./proc/dejudder/step.ts');
			dejudder = 'ready';
		} catch {
			dejudder = 'unavailable';
		}
		return {
			stabilize: native || wasm ? 'vidstab' : filters.has('deshake') ? 'deshake' : 'none',
			smoothPath: dejudder === 'ready' ? 'ready' : 'unavailable',
			denoise: (['atadenoise', 'fftdnoiz', 'nlmeans'] as const).filter((f) => filters.has(f)),
			deblock: filters.has('deblock'),
			dejudder,
			upscale: { runtime: providers.length ? 'onnxruntime' : 'none', providers, modelsInstalled: installed },
			remote: {
				configured: !!s.remote?.enabled,
				lastProbe: probe ? { ok: probe.ok, at: probe.at, gpu: probe.gpu, message: probe.message } : null,
			},
		};
	}

	// ------------------------------------------------------------------ submit

	/** PRM-007: `auto` → remote when enabled, probed OK and a step is in `useFor`; never silently local. */
	async chooseExecutor(
		req: ProcessRequest['executor'],
		steps: readonly ProcessStep[],
	): Promise<'local' | 'remote'> {
		const s = await this.settings.get();
		if (req === 'local') return 'local';
		if (req === 'remote') {
			if (!s.remote)
				throw new JobError('REMOTE_NOT_CONFIGURED', 'The remote executor is not configured', false);
			return 'remote';
		}
		if (!s.remote?.enabled) return 'local';
		const probe = await this.settings.lastProbe();
		if (!probe?.ok) return 'local';
		const useFor = new Set<string>(s.remote.useFor.length ? s.remote.useFor : ['upscale', 'dejudder']);
		return steps.some((st) => useFor.has(st.op)) ? 'remote' : 'local';
	}

	localSlots(s: ProcessingSettings): number {
		const total = this.core.queue.totalSlots;
		return Math.max(1, Math.min(total, s.localSlots ?? Math.max(1, Math.floor(total / 2))));
	}

	async submitProcess(
		mediaKey: string,
		req: ProcessRequest,
		origin: EngineJob['origin'] = { type: 'user' },
	): Promise<EngineJob> {
		const r = this.core.registry.get(mediaKey);
		if (!r) throw new JobError('ASSET_NOT_FOUND', 'Unknown media key', false);
		if (r.kind !== 'video')
			throw new JobError('UNSUPPORTED_MEDIA', 'Only video media can be processed', false);
		for (const st of req.steps)
			if (st.op === 'upscale') {
				const e = this.models.entry(st.model);
				if (!e) throw new JobError('MODEL_UNKNOWN', `Unknown model ${st.model}`, false);
				if (!(await this.models.installed(e)))
					throw new JobError('MODEL_NOT_INSTALLED', `Model ${e.name} is not installed`, false);
			}
		const executor = await this.chooseExecutor(req.executor, req.steps);
		const s = await this.settings.get();
		const hash = recipeHash(req.steps, RECIPE_VERSION, req.range ?? null);
		return this.core.queue.submit({
			kind: 'process',
			title: `Process – ${r.originalName} [${recipeLabel(req.steps)}${req.range ? ` · frames ${req.range.startFrame}–${req.range.endFrame - 1}` : ''}]`,
			priority: 'user',
			cpuSlots: executor === 'remote' ? 1 : this.localSlots(s),
			minSlots: 1,
			origin,
			assetId: mediaKey,
			...(req.projectId ? { projectId: req.projectId } : {}),
			dedupeKey: `process:${fingerprintHex(r.fingerprint)}:${hash}`,
			stage: executor === 'remote' ? 'Queued (remote)' : 'Queued',
			input: {
				mediaKey,
				steps: req.steps,
				executor,
				...(req.range ? { range: req.range } : {}),
				...(req.projectId ? { projectId: req.projectId } : {}),
			} satisfies ProcessJobInput,
		});
	}

	// ------------------------------------------------------------------ process job

	/** Content-addressed output location: `<appdir>/media/processed/<fingerprint>/<recipeHash>/<name>.mov`. */
	outputPath(
		r: MediaRecord,
		hash: string,
		steps: readonly ProcessStep[],
		range?: { startFrame: number; endFrame: number },
	): { file: string; name: string } {
		const stem = basename(r.originalName, extname(r.originalName));
		const frames = range ? ` · frames ${range.startFrame}–${range.endFrame - 1}` : '';
		const name = `${stem} [${recipeLabel(steps)}${frames}].mov`;
		const dir = join(
			this.core.config.paths.mediaDir,
			'processed',
			fingerprintHex(r.fingerprint).slice(0, 32),
			hash.slice(0, 24),
		);
		return { file: join(dir, safeFileName(`${stem}.processed.mov`, 'processed.mov')), name };
	}

	private async reusable(file: string, hash: string): Promise<{ notes: string[] } | null> {
		try {
			const [st, side] = await Promise.all([stat(file), readFile(`${file}.json`, 'utf8')]);
			const sc = JSON.parse(side) as { recipeHash?: string; output?: { bytes?: number }; notes?: string[] };
			if (sc.recipeHash === hash && sc.output?.bytes === st.size) return { notes: sc.notes ?? [] };
		} catch {
			// not there
		}
		return null;
	}

	private async runProcess(ctx: JobContext): Promise<ProcessResult> {
		const input = ctx.input as ProcessJobInput;
		const r = this.core.registry.get(input.mediaKey);
		if (!r) throw new JobError('ASSET_NOT_FOUND', `Unknown media ${input.mediaKey}`, false);
		const src = await this.core.registry.resolvePath(r.mediaKey);
		if (!src) throw new JobError('ASSET_NOT_FOUND', `Media ${r.originalName} is offline`, true);
		const hash = recipeHash(input.steps, RECIPE_VERSION, input.range ?? null);
		const out = this.outputPath(r, hash, input.steps, input.range);
		await mkdir(dirname(out.file), { recursive: true });
		let notes: string[];
		const reuse = await this.reusable(out.file, hash);
		if (reuse) {
			notes = [...reuse.notes, 'reused an existing processed file with the same recipe'];
			ctx.progress(1, { stage: 'Reused' });
		} else {
			const partial = join(dirname(out.file), `.partial-${ctx.job.id}.mov`);
			ctx.addPartial(partial);
			ctx.addPartial(`${partial}.json`);
			notes =
				input.executor === 'remote'
					? await this.runRemote(ctx, input, r, src, partial)
					: await this.runLocal(ctx, input, src, partial);
			await rename(`${partial}.json`, `${out.file}.json`);
			await rename(partial, out.file);
		}
		ctx.progress(1, { stage: 'Registering' });
		const registered = await this.core.media.registerDerived(out.file, {
			fromMediaKey: r.mediaKey,
			recipeHash: hash,
			name: out.name,
			...(input.projectId ? { projectId: input.projectId } : {}),
			...(input.range ? { range: input.range } : {}),
		});
		return {
			registered,
			fromMediaKey: r.mediaKey,
			recipeVersion: RECIPE_VERSION,
			recipeHash: hash,
			executor: input.executor,
			notes,
			...(input.range
				? { range: { startFrame: input.range.startFrame, endFrame: input.range.endFrame } }
				: {}),
		};
	}

	private async modelSpecs(steps: readonly ProcessStep[]): Promise<ProcSpec['models']> {
		const models: ProcSpec['models'] = {};
		for (const st of steps)
			if (st.op === 'upscale') {
				try {
					const m = await this.models.resolve(st.model);
					models[st.model] = { path: m.path, sha256: m.sha256, scale: m.scale };
				} catch (e) {
					if (e instanceof ModelError) throw new JobError(e.code, e.message, false);
					throw e;
				}
			}
		return models;
	}

	private async runLocal(
		ctx: JobContext,
		input: ProcessJobInput,
		src: string,
		output: string,
	): Promise<string[]> {
		const scratch = await ctx.scratchDir();
		const spec: ProcSpec = {
			input: src,
			output,
			steps: input.steps,
			...(input.range ? { range: input.range } : {}),
			ffmpeg: this.ffmpegPath,
			ffprobe: this.ffprobePath,
			models: await this.modelSpecs(input.steps),
			threads: Math.max(1, ctx.slots),
			device: 'cpu',
			scratch: join(scratch, 'proc'),
			vidstabEngine: input.steps.some((s) => s.op === 'stabilize') ? await this.vidstabEngine() : 'auto',
		};
		const specFile = join(scratch, 'spec.json');
		await writeFile(specFile, JSON.stringify(spec, null, 2));
		ctx.log(`jasper-proc spec: ${JSON.stringify(spec)}`);
		const cmd = procCommand(this.env);
		const tracker = new ProgressTracker(input.steps.length, (p, stage) => ctx.progress(p, { stage }));
		const code = await new Promise<number>((resolve, reject) => {
			const child = spawn(cmd.command, [...cmd.args, 'run', '--spec', specFile], {
				stdio: ['ignore', 'pipe', 'pipe'],
				detached: process.platform !== 'win32',
				windowsHide: true,
				env: { ...process.env, ...this.procEnv() },
			});
			ctx.trackChild(child);
			const parse = createEventParser(
				(e: ProcEvent) => tracker.handle(e),
				(line) => ctx.log(line),
			);
			child.stderr.on('data', (d: Buffer) => parse(d.toString()));
			child.stdout.on('data', (d: Buffer) => ctx.log(d.toString().trim()));
			child.on('error', reject);
			child.on('close', (c, sig) => resolve(c ?? (sig ? 3 : 1)));
		});
		if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
		if (code !== 0) {
			const err = tracker.error;
			if (code === 3) throw new JobError('JOB_CANCELLED', 'Cancelled');
			throw new JobError(
				err?.code ?? (code === 2 ? 'INVALID_SPEC' : 'PROCESS_FAILED'),
				err?.message ?? `jasper-proc exited with ${code}`,
				code !== 2 &&
					!['MODEL_NOT_INSTALLED', 'ALPHA_UNSUPPORTED', 'INVALID_RANGE'].includes(err?.code ?? ''),
			);
		}
		if (!tracker.done) throw new JobError('PROCESS_FAILED', 'jasper-proc finished without a result');
		return tracker.notes;
	}

	/** Environment for jasper-proc children (locations of WASM/worker files when running from a bundle). */
	private procEnv(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const k of ['JASPER_VIDSTAB_WASM', 'JASPER_DEJUDDER_WORKER'])
			if (this.env[k]) out[k] = this.env[k] as string;
		return out;
	}

	// ------------------------------------------------------------------ remote

	private async remote(): Promise<SshRemote> {
		const s = await this.settings.get();
		if (!s.remote)
			throw new JobError('REMOTE_NOT_CONFIGURED', 'The remote executor is not configured', false);
		checkIdentity(s.remote);
		return new SshRemote(s.remote, join(this.core.config.paths.tmpDir, 'ssh'), this.env);
	}

	private async runRemote(
		ctx: JobContext,
		input: ProcessJobInput,
		r: MediaRecord,
		src: string,
		output: string,
	): Promise<string[]> {
		const remote = await this.remote();
		const probe = await this.settings.lastProbe();
		const L = remote.layout;
		const wrap = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
			try {
				return await fn();
			} catch (e) {
				if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
				if (e instanceof RemoteError) throw new JobError(e.code, `${what}: ${e.message}`, e.retryable);
				throw e;
			}
		};
		// 1. Input, content-addressed (PRM-005): skipped when the remote cache already has it.
		const ext = extname(src).toLowerCase() || '.bin';
		const cached = `${L.cache}/${fingerprintHex(r.fingerprint).slice(0, 40)}${ext}`;
		const localSize = (await stat(src)).size;
		ctx.progress(0.01, { stage: 'Remote · checking cache' });
		const have = await wrap('cache check', () => remote.size(cached, ctx.signal));
		if (have !== localSize) {
			ctx.progress(0.02, { stage: 'Remote · uploading source' });
			await wrap('upload', () =>
				remote.upload(src, cached, { signal: ctx.signal, onSpawn: (c) => ctx.trackChild(c) }),
			);
		}
		await wrap('touch', () => remote.execOk(`touch ${shq(cached)}`, 'touch', { signal: ctx.signal }));
		// 2. Models the job needs.
		const models: ProcSpec['models'] = {};
		for (const [id, m] of Object.entries(await this.modelSpecs(input.steps))) {
			const rp = `${L.models}/${basename(m.path)}`;
			const sz = await wrap('model check', () => remote.size(rp, ctx.signal));
			if (sz !== (await stat(m.path)).size) {
				ctx.progress(0.1, { stage: `Remote · uploading model ${id}` });
				await wrap('model upload', () => remote.upload(m.path, rp, { signal: ctx.signal }));
			}
			models[id] = { path: rp, sha256: m.sha256, scale: m.scale };
		}
		// 3. Spec + run (setsid + pid file, PRM-005/006).
		const jobDir = `${L.jobs}/${ctx.job.id}`;
		const ffmpegRemote = probe?.ffmpegPath ?? 'ffmpeg';
		const ffprobeRemote = ffmpegRemote.endsWith('/ffmpeg')
			? `${ffmpegRemote.slice(0, -6)}ffprobe`
			: 'ffprobe';
		const cuda = !!probe?.gpu && (probe.onnxProviders ?? []).includes('cuda');
		const spec: ProcSpec = {
			input: cached,
			output: `${jobDir}/out.mov`,
			steps: input.steps,
			...(input.range ? { range: input.range } : {}),
			ffmpeg: ffmpegRemote,
			ffprobe: ffprobeRemote,
			models,
			threads: Math.max(1, probe?.cpus ?? 4),
			device: cuda ? 'cuda' : 'cpu',
			scratch: `${jobDir}/scratch`,
			vidstabEngine: 'wasm',
		};
		await wrap('spec', () =>
			remote.execOk(`mkdir -p ${shq(jobDir)} && cat > ${shq(`${jobDir}/spec.json`)}`, 'write spec', {
				stdin: JSON.stringify(spec),
				signal: ctx.signal,
			}),
		);
		const tracker = new ProgressTracker(
			input.steps.length,
			(p, stage) => ctx.progress(p, { stage: `Remote · ${stage}` }),
			0.15,
			0.7,
		);
		const parse = createEventParser(
			(e) => tracker.handle(e),
			(line) => ctx.log(`[remote] ${line}`),
		);
		const inner = `echo $$ > pid; exec node ${shq(`${L.bin}/jasper-proc.mjs`)} run --spec spec.json`;
		const cleanupRemote = async () => {
			await remote
				.exec(
					`cd ${shq(jobDir)} 2>/dev/null && [ -f pid ] && kill -TERM -- -"$(cat pid)" 2>/dev/null; sleep 1; rm -rf ${shq(jobDir)}`,
					{
						timeoutMs: 20_000,
					},
				)
				.catch(() => undefined);
		};
		let res: Awaited<ReturnType<SshRemote['exec']>>;
		try {
			res = await remote.exec(`cd ${shq(jobDir)} && exec setsid -w sh -c ${shq(inner)}`, {
				signal: ctx.signal,
				onStderr: parse,
				onSpawn: (c) => ctx.trackChild(c),
			});
		} catch (e) {
			await cleanupRemote();
			throw e;
		}
		if (ctx.signal.aborted) {
			await cleanupRemote();
			throw new JobError('JOB_CANCELLED', 'Cancelled');
		}
		if (res.code !== 0) {
			if (res.code === 255 && !tracker.error) {
				throw new JobError(
					'REMOTE_CONNECTION_LOST',
					`Lost the connection to ${remote.target} while processing`,
					true,
				);
			}
			await cleanupRemote();
			const err = tracker.error;
			throw new JobError(
				err?.code ?? 'REMOTE_PROCESS_FAILED',
				err?.message ?? `remote jasper-proc exited with ${res.code}`,
				true,
			);
		}
		// 4. Download + verify (sha256 from the sidecar, frame count).
		ctx.progress(0.86, { stage: 'Remote · downloading result' });
		await wrap('download', () =>
			remote.download(`${jobDir}/out.mov.json`, `${output}.json`, { signal: ctx.signal }),
		);
		await wrap('download', () =>
			remote.download(`${jobDir}/out.mov`, output, { signal: ctx.signal, onSpawn: (c) => ctx.trackChild(c) }),
		);
		const side = JSON.parse(await readFile(`${output}.json`, 'utf8')) as {
			output: { sha256: string; frames: number };
			executor?: unknown;
		};
		const got = await sha256File(output);
		if (got !== side.output.sha256)
			throw new JobError('DOWNLOAD_CORRUPT', 'The downloaded file does not match the remote checksum', true);
		const n = await countPackets(this.ffprobePath, output);
		if (n !== side.output.frames)
			throw new JobError(
				'FRAME_COUNT_MISMATCH',
				`downloaded ${n} frames, expected ${side.output.frames}`,
				true,
			);
		// Record where it ran, then clean the remote job directory (the input cache stays, LRU-trimmed).
		side.executor = { type: 'remote', host: remote.target, gpu: probe?.gpu ?? null };
		await writeFile(`${output}.json`, `${JSON.stringify(side, null, 2)}\n`);
		await remote.exec(`rm -rf ${shq(jobDir)}`).catch(() => undefined);
		await remote.trimCache().catch(() => undefined);
		ctx.progress(0.99, { stage: 'Remote · done' });
		return tracker.notes;
	}

	/** PRM-003: probe the configured remote and remember the result (capabilities). */
	async probeRemote(): Promise<RemoteProbeResult> {
		const s = await this.settings.get();
		if (!s.remote)
			throw new JobError(
				'REMOTE_NOT_CONFIGURED',
				'The remote executor is not configured (Preferences ▸ Processing)',
				false,
			);
		const remote = await this.remote();
		const p = await remote.probe();
		const stored: StoredProbe = { ...p, at: new Date().toISOString(), host: remote.target };
		await this.settings.setLastProbe(stored);
		this.core.capabilities.changed();
		const { cpus: _c, ffmpegPath: _f, ...pub } = p;
		return pub;
	}

	async submitSetup(origin: EngineJob['origin'] = { type: 'user' }): Promise<EngineJob> {
		const s = await this.settings.get();
		if (!s.remote)
			throw new JobError(
				'REMOTE_NOT_CONFIGURED',
				'The remote executor is not configured (Preferences ▸ Processing)',
				false,
			);
		return this.core.queue.submit({
			kind: 'remote-setup',
			title: `Set up remote – ${s.remote.user}@${s.remote.host}`,
			priority: 'user',
			cpuSlots: 0,
			origin,
			dedupeKey: `remote-setup:${s.remote.host}:${s.remote.port}:${s.remote.remoteDir}`,
			input: {},
		});
	}

	/** A directory with the jasper-proc bundle (dist, or built on demand from the checkout). */
	private async bundleDir(ctx: JobContext): Promise<string> {
		const existing = procBundle(this.env);
		const script = join(dirname(new URL(import.meta.url).pathname), '..', '..', 'scripts', 'build-proc.mjs');
		// Like the local CLI, a checkout must use current source: dist may predate a recipe/runtime bump.
		if (
			existing &&
			existsSync(join(dirname(existing), 'jasper-proc.package.json')) &&
			(this.env.JASPER_PROC || !existsSync(script))
		)
			return dirname(existing);
		if (!existsSync(script))
			throw new JobError(
				'PROC_BUNDLE_MISSING',
				'The jasper-proc bundle is missing from this installation',
				false,
			);
		const out = join(this.core.config.paths.cacheDir, 'jasper-proc-bundle');
		ctx.progress(0.05, { stage: 'Building the jasper-proc bundle' });
		const code = await new Promise<number>((resolve) => {
			const c = spawn(process.execPath, [script, '--out', out], { stdio: ['ignore', 'pipe', 'pipe'] });
			ctx.trackChild(c);
			c.stderr.on('data', (d: Buffer) => ctx.log(d.toString()));
			c.on('close', (x) => resolve(x ?? 1));
		});
		if (code !== 0) throw new JobError('PROC_BUNDLE_FAILED', 'Building the jasper-proc bundle failed');
		return out;
	}

	private async runSetup(ctx: JobContext): Promise<RemoteProbeResult> {
		const remote = await this.remote();
		const L = remote.layout;
		const wrap = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
			try {
				return await fn();
			} catch (e) {
				if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
				if (e instanceof RemoteError) throw new JobError(e.code, `${what}: ${e.message}`, e.retryable);
				throw e;
			}
		};
		ctx.progress(0.02, { stage: 'Connecting' });
		await wrap('connect', () =>
			remote.execOk(
				`mkdir -p ${[L.bin, L.models, L.jobs, L.cache].map(shq).join(' ')}`,
				'create directories',
				{ signal: ctx.signal },
			),
		);
		const dir = await this.bundleDir(ctx);
		ctx.progress(0.15, { stage: 'Uploading jasper-proc' });
		const files: Array<[string, string]> = [
			['jasper-proc.mjs', 'jasper-proc.mjs'],
			['jasper-proc.package.json', 'package.json'],
		];
		for (const f of [
			'dejudder-worker.mjs',
			'vidstab.wasm',
			'VIDSTAB-WASM.json',
			'LICENSE-vidstab.txt',
			'NOTICE-vidstab.txt',
		])
			if (existsSync(join(dir, f))) files.push([f, f]);
		for (const [local, remoteName] of files)
			await wrap('upload', () =>
				remote.upload(join(dir, local), `${L.bin}/${remoteName}`, { signal: ctx.signal }),
			);
		ctx.progress(0.35, { stage: 'Installing the runtime (npm install)' });
		const npm = this.env.JASPER_REMOTE_NPM ?? 'npm install --omit=dev --no-audit --no-fund --loglevel=error';
		await wrap('npm install', () =>
			remote.execOk(`cd ${shq(L.bin)} && ${npm}`, 'npm install', { signal: ctx.signal }),
		);
		// Models the remote lacks (by sha256).
		ctx.progress(0.6, { stage: 'Uploading models' });
		for (const e of this.models.entries) {
			if (!(await this.models.installed(e))) continue;
			const path = this.models.pathOf(e);
			const rp = `${L.models}/${basename(path)}`;
			const sum = await remote.exec(`sha256sum ${shq(rp)} 2>/dev/null | cut -d' ' -f1`).catch(() => null);
			if (sum?.stdout.trim() !== e.sha256)
				await wrap('model upload', () => remote.upload(path, rp, { signal: ctx.signal }));
		}
		// FFmpeg: upload our LGPL linux-x64 build when the remote has none.
		let probe = await remote.probe();
		if (!probe.ffmpeg) {
			const local = this.core.ffmpeg.bins.ffmpeg;
			const srcDir = local ? dirname(local) : null;
			if (
				process.platform === 'linux' &&
				process.arch === 'x64' &&
				srcDir &&
				existsSync(join(srcDir, 'BUILDINFO.json'))
			) {
				ctx.progress(0.75, { stage: 'Uploading the LGPL FFmpeg' });
				const { readdir } = await import('node:fs/promises');
				for (const f of await readdir(srcDir)) {
					if (f === 'remotion' || f.endsWith('.partial')) continue;
					const p = join(srcDir, f);
					if ((await stat(p)).isFile())
						await wrap('ffmpeg upload', () => remote.upload(p, `${L.ffmpeg}/${f}`, { signal: ctx.signal }));
				}
				await wrap('chmod', () =>
					remote.execOk(`chmod +x ${shq(`${L.ffmpeg}/ffmpeg`)} ${shq(`${L.ffmpeg}/ffprobe`)}`, 'chmod'),
				);
				probe = await remote.probe();
			}
		}
		ctx.progress(0.95, { stage: 'Checking' });
		const stored: StoredProbe = { ...probe, at: new Date().toISOString(), host: remote.target };
		await this.settings.setLastProbe(stored);
		this.core.capabilities.changed();
		if (!probe.ok) throw new JobError('REMOTE_SETUP_INCOMPLETE', probe.message, true);
		const { cpus: _c, ffmpegPath: _f, ...pub } = probe;
		return pub;
	}

	// ------------------------------------------------------------------ models

	submitInstall(modelId: string, origin: EngineJob['origin'] = { type: 'user' }): EngineJob {
		const e = this.models.entry(modelId) ?? this.speechModels.entry(modelId) ?? this.visionModels.entry(modelId);
		if (!e) throw new JobError('MODEL_UNKNOWN', `Unknown model ${modelId}`, false);
		return this.core.queue.submit({
			kind: 'model-download',
			title: `Install model – ${e.name}`,
			priority: 'user',
			cpuSlots: 0,
			origin,
			dedupeKey: `model:${modelId}`,
			input: { modelId },
		});
	}

	private async runInstall(
		ctx: JobContext,
	): Promise<{ modelId: string; path: string; alreadyInstalled: boolean }> {
		const { modelId } = ctx.input as { modelId: string };
		if (!this.models.entry(modelId) && this.visionModels.entry(modelId)) {
			// parity (roto): a multi-file vision model (verified file by file)
			try {
				const r = await this.visionModels.install(modelId, {
					signal: ctx.signal,
					onProgress: (done, total, file) =>
						ctx.progress(total ? done / total : null, { stage: `Downloading ${file}` }),
				});
				this.core.capabilities.changed();
				return { modelId, path: r.dir, alreadyInstalled: r.alreadyInstalled };
			} catch (e) {
				if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
				if (e instanceof SpeechModelError)
					throw new JobError(e.code.replace('SPEECH_', ''), e.message, e.code === 'DOWNLOAD_FAILED');
				throw e;
			}
		}
		if (!this.models.entry(modelId) && this.speechModels.entry(modelId)) {
			// wp speech: a multi-file speech model (verified file by file)
			try {
				const r = await this.speechModels.install(modelId, {
					signal: ctx.signal,
					onProgress: (done, total, file) =>
						ctx.progress(total ? done / total : null, { stage: `Downloading ${file}` }),
				});
				this.core.capabilities.changed();
				return { modelId, path: r.dir, alreadyInstalled: r.alreadyInstalled };
			} catch (e) {
				if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
				if (e instanceof SpeechModelError)
					throw new JobError(e.code, e.message, e.code === 'DOWNLOAD_FAILED');
				throw e;
			}
		}
		try {
			const r = await this.models.install(modelId, {
				signal: ctx.signal,
				onProgress: (done, total) => ctx.progress(total ? done / total : null, { stage: 'Downloading' }),
			});
			this.core.capabilities.changed();
			return { modelId, ...r };
		} catch (e) {
			if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
			if (e instanceof ModelError) throw new JobError(e.code, e.message, e.code === 'DOWNLOAD_FAILED');
			throw e;
		}
	}
}

function countPackets(ffprobe: string, file: string): Promise<number> {
	return new Promise((resolve) => {
		const c = spawn(
			ffprobe,
			[
				'-v',
				'error',
				'-select_streams',
				'v:0',
				'-count_packets',
				'-show_entries',
				'stream=nb_read_packets',
				'-of',
				'csv=p=0',
				file,
			],
			{
				stdio: ['ignore', 'pipe', 'ignore'],
			},
		);
		let s = '';
		c.stdout.on('data', (d: Buffer) => {
			s += d.toString();
		});
		c.on('close', () => resolve(Number(s.trim()) || 0));
		c.on('error', () => resolve(0));
	});
}
