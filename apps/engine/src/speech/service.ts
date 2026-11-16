// Speech-to-text on the engine (wp speech, spec 16): `transcription` jobs run the `jasper-speech` child process
// (Whisper on ONNX Runtime, worker/) on one audio stream of a media, or on the mixed audio of a sequence (the
// export's offline mixer, `renderMixdown`, mono 16 kHz). Results carry words in flicks (media time / sequence time);
// the client commits them with `transcript.attach` (one undo step). Models come from the processing-model catalogue
// (`speech`) and install through its `model-download` job.
//
// Spec 16: a cached execution-provider probe (run in the worker, SG-001) decides where each model part runs
// (providers.ts, SG-002); a GPU failure mid-job runs the job again on the CPU (SG-003); the device, fallbacks,
// calibration and measured speed are kept (state.ts) and reported in results, capabilities and the model list;
// the NVIDIA CUDA provider downloads on request on Linux x64 (cuda.ts, SG-006).
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, arch as osArch, platform as osPlatform, totalmem } from 'node:os';
import { join } from 'node:path';
import {
	type EngineJob,
	type M2Features,
	type SpeechCudaStatus,
	type SpeechDeviceReport,
	type SpeechFallback,
	type SpeechModel,
	type SpeechModelFallback,
	type SpeechProbe,
	type SpeechScoreRequest,
	SpeechScoreRequestSchema,
	type SpeechScoreResult,
	type SpeechSettings,
	type TranscribeMediaRequest,
	type TranscribeOptions,
	type TranscribeSequenceRequest,
	type TranscriptionResult,
} from '@jasper/api';
import {
	type AudioStream,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	mixFingerprint,
	type ProjectDocument,
} from '@jasper/project';
import { renderMixdown } from '../audio/mixdown.ts';
import { PlanError, type PlannedExport } from '../export/planner.ts';
import { type JobContext, JobError } from '../jobs/types.ts';
import type { MediaRecord } from '../media/registry.ts';
import type { ProcessingService } from '../processing/service.ts';
import { DownloadError } from '../tools/download.ts';
import { ortPackageDir, ortVersion, type ProviderId, shortReason } from '../tools/ort.ts';
import { terminateTree } from '../tools/process.ts';
import type { CoreServices } from '../tools/services.ts';
import type { VoiceAnalysisService } from '../voice/service.ts';
import { normalizeGlossary } from './core/glossary.ts';
import { CudaError, CudaProvider } from './cuda.ts';
import { speechCommand } from './entry.ts';
import type { SpanTranscriptionRequest, SpanTranscriptionResult } from './kept-spans.ts';
import { type SpeechCatalogEntry, SpeechModelError, type SpeechModelStore } from './models.ts';
import {
	bestGpu,
	type DevicePlan,
	deviceLabel,
	estimateRtf,
	gpuCandidates,
	PROVIDER_LABEL,
	type ProviderStatus,
	planDevices,
	policyExcluded,
	recommendModel,
	threadCap,
} from './providers.ts';
import { SpeechStateStore, type StoredProbe } from './state.ts';
import type { ProbeResponse } from './worker/probe.ts';
import type { SpeechJobOutput, SpeechJobSpec } from './worker/run.ts';
import type { ScoreJobOutput, ScoreJobSpec } from './worker/score.ts';

/** Flicks per 16 kHz sample (exact). */
export const FLICKS_PER_SAMPLE = FLICKS_PER_SECOND / 16_000;
/** A probe that has not answered by then is killed (a hung GPU driver must not hang the engine). */
const PROBE_TIMEOUT_MS = 60_000;

type MediaInput = {
	target: 'media';
	mediaKey: string;
	streamIndex: number | null;
	options: TranscribeOptions;
	durationSec?: number;
	modelFallback?: SpeechModelFallback;
};
type SequenceInput = {
	target: 'sequence';
	request: TranscribeSequenceRequest;
	modelFallback?: SpeechModelFallback;
};

type WorkerRun<T> = {
	out: T | null;
	error: string | null;
	/** Exit 4: the worker refused the input (`SPEECH_*` code; never retried on another device). */
	code: string | null;
	/** The last `device` event (providers really used). */
	device: { encoder: ProviderId; decoder: ProviderId; attempt: number } | null;
};

/** What a worker run reports to (a job context, or a `score` caller). */
type WorkerHost = {
	signal: AbortSignal;
	progress(fraction: number, stage: string): void;
	log(text: string): void;
	trackChild?(child: ChildProcess): void;
	/** Kill the worker this many ms after cancellation at the latest (scoring, SC-036). */
	killGraceMs?: number;
};

/** Spec 17 SC-092: how `SpeechService.score` reports and where it keeps its files. */
export type SpeechScoreOptions = {
	/** 0..1 and a stage line (per scored reading). */
	onProgress?(fraction: number, stage: string): void;
	log?(text: string): void;
	/** An engine job's `ctx.trackChild` (its cancellation kills the worker too). */
	trackChild?(child: ChildProcess): void;
	/** Directory for the spec and result files (an engine job's scratch dir); default a temporary one, removed. */
	scratchDir?: string;
	/** CPU threads (an engine job's slots); capped by the speech thread cap. */
	threads?: number;
	/** Readings per decoder pass (default 8, capped by memory in the worker). */
	batch?: number;
};

/** SC-036: a cancelled scoring worker is killed this long after the request at the latest. */
const SCORE_KILL_GRACE_MS = 1000;

type Machine = { ramBytes: number; cores: number; performanceCores: number | null };

export class SpeechService {
	private ortOk: boolean | null = null;
	readonly state: SpeechStateStore;
	readonly cuda: CudaProvider;
	private memProbe: StoredProbe | null = null;
	private probing: Promise<StoredProbe> | null = null;
	private machineInfo: Machine | null = null;
	private settingsCache: SpeechSettings | null = null;

	constructor(
		private readonly core: CoreServices,
		private readonly processing: ProcessingService,
		private readonly env: Record<string, string | undefined> = process.env,
		private readonly platform: string = osPlatform(),
		private readonly arch: string = osArch(),
		/** Spec 14 TC-001 voice analysis (registered after the speech routes, so read lazily). */
		private readonly voice: () => VoiceAnalysisService | undefined = () => undefined,
	) {
		const paths = core.config.paths;
		this.state = new SpeechStateStore(join(paths.engineDir, 'speech.json'));
		this.cuda = new CudaProvider(paths.root, env, platform as NodeJS.Platform, arch as NodeJS.Architecture);
		this.models.setRecommendation(() => this.recommendation());
	}

	get models(): SpeechModelStore {
		return this.processing.speechModels;
	}

	registerRunners(): void {
		this.core.queue.registerRunner('transcription', (ctx) => this.run(ctx));
		this.core.queue.registerRunner('runtime-download', (ctx) => this.runCudaInstall(ctx));
	}

	/** Loads the stored probe and settings (no worker is started). */
	async init(): Promise<void> {
		this.settingsCache = await this.state.settings();
		const stored = await this.state.probe();
		if (stored && stored.key === (await this.probeKey(this.settingsCache))) this.memProbe = stored;
	}

	/** ONNX Runtime is installed (the worker loads the same module). */
	ortAvailable(): boolean {
		if (this.ortOk === null) this.ortOk = ortPackageDir({}) !== null;
		return this.ortOk;
	}

	// ---------------------------------------------------------------- machine, settings, probe

	machine(): Machine {
		if (this.machineInfo) return this.machineInfo;
		let performanceCores: number | null = null;
		try {
			if (this.platform === 'darwin') {
				const out = execFileSync('sysctl', ['-n', 'hw.perflevel0.physicalcpu'], {
					encoding: 'utf8',
					timeout: 3000,
					stdio: ['ignore', 'pipe', 'ignore'],
				});
				performanceCores = Number(out.trim()) || null;
			} else if (this.platform === 'linux' && existsSync('/sys/devices/cpu_core/cpus')) {
				// Intel hybrid CPUs: the performance cores' logical CPUs, e.g. "0-11"
				const list = readFileSync('/sys/devices/cpu_core/cpus', 'utf8').trim();
				let n = 0;
				for (const part of list.split(',')) {
					const [a, b] = part.split('-').map(Number);
					n += b !== undefined ? b - a + 1 : 1;
				}
				performanceCores = n || null;
			}
		} catch {
			performanceCores = null;
		}
		const cores = Math.max(
			1,
			typeof availableParallelism === 'function' ? availableParallelism() : cpus().length,
		);
		this.machineInfo = { ramBytes: totalmem(), cores, performanceCores };
		return this.machineInfo;
	}

	threads(): number {
		const m = this.machine();
		return threadCap({ performanceCores: m.performanceCores, logicalCores: m.cores });
	}

	async settings(): Promise<SpeechSettings> {
		this.settingsCache = await this.state.settings();
		return this.settingsCache;
	}

	async updateSettings(patch: Partial<SpeechSettings>): Promise<SpeechSettings> {
		const next = await this.state.setSettings(patch);
		this.settingsCache = next;
		// the NVIDIA setting changes which providers the probe may use
		if (patch.nvidiaGpu !== undefined) this.memProbe = null;
		this.core.capabilities.changed();
		return next;
	}

	private async probeKey(s: SpeechSettings): Promise<string> {
		return [
			ortVersion({}) ?? 'none',
			this.platform,
			this.arch,
			`cuda:${await this.cuda.state()}`,
			`nvidia:${s.nvidiaGpu}`,
			'v1',
		].join('|');
	}

	/** Whether the CUDA provider may be used, and the worker environment for it. */
	private async cudaUse(
		s: SpeechSettings,
	): Promise<{ env: Record<string, string> | null; blocked: string | null }> {
		if (!this.cuda.supported)
			return { env: null, blocked: 'the CUDA provider of ONNX Runtime ships for Linux x64 only' };
		if (!s.nvidiaGpu)
			return {
				env: null,
				blocked: 'NVIDIA GPU support is off (Preferences ▸ Transcription ▸ Enable NVIDIA GPU)',
			};
		const st = await this.cuda.state();
		if (st !== 'installed')
			return {
				env: null,
				blocked:
					st === 'damaged'
						? 'the downloaded CUDA provider is damaged (download it again)'
						: 'the CUDA provider is not downloaded (Preferences ▸ Transcription ▸ Enable NVIDIA GPU)',
			};
		const rt = this.cuda.runtime();
		if (!rt.ok) return { env: null, blocked: `the NVIDIA runtime is missing: ${rt.missing.join(', ')}` };
		return { env: this.cuda.workerEnv(rt), blocked: null };
	}

	/** GPU name for labels: NVIDIA via nvidia-smi, Apple silicon via the chip name. */
	private gpuName(provider: ProviderId): string {
		try {
			if (this.platform === 'darwin') {
				const chip = execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], {
					encoding: 'utf8',
					timeout: 3000,
					stdio: ['ignore', 'pipe', 'ignore'],
				}).trim();
				return chip ? `${chip} GPU` : 'Apple GPU';
			}
			if (provider === 'cuda' || this.platform === 'linux' || this.platform === 'win32') {
				const out = execFileSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
					encoding: 'utf8',
					timeout: 5000,
					stdio: ['ignore', 'pipe', 'ignore'],
				});
				const n = out.split('\n')[0]?.trim();
				if (n) return n;
			}
		} catch {
			// unknown device
		}
		return 'GPU';
	}

	/**
	 * SG-001: the provider probe — cached in memory and in `speech.json` until the ORT version, platform, CUDA provider
	 * or NVIDIA setting changes; `force` probes again (Preferences, `POST /api/speech/probe`).
	 */
	async probe(force = false): Promise<StoredProbe> {
		const s = await this.settings();
		const key = await this.probeKey(s);
		if (!force && this.memProbe?.key === key) return this.memProbe;
		if (!force && !this.probing) {
			const stored = await this.state.probe();
			if (stored?.key === key) {
				this.memProbe = stored;
				return stored;
			}
		}
		if (this.probing) return this.probing;
		this.probing = (async () => {
			try {
				const p = await this.runProbe(s, key);
				await this.state.setProbe(p).catch(() => undefined);
				if (force) await this.state.clearCalibrations().catch(() => undefined);
				this.memProbe = p;
				this.core.capabilities.changed();
				return p;
			} finally {
				this.probing = null;
			}
		})();
		return this.probing;
	}

	private async runProbe(s: SpeechSettings, key: string): Promise<StoredProbe> {
		const candidates = gpuCandidates(this.platform, this.arch);
		const cuda = await this.cudaUse(s);
		const blocked: Partial<Record<ProviderId, string>> = {};
		if (candidates.includes('cuda') && cuda.blocked) blocked.cuda = cuda.blocked;
		let res: ProbeResponse;
		try {
			res = await this.spawnProbe({ candidates, blocked }, cuda.env ?? {});
		} catch (e) {
			const reason = `the provider probe failed: ${e instanceof Error ? e.message : String(e)}`;
			res = {
				ortVersion: null,
				providers: [
					...candidates.map((id) => ({ id, available: false, reason })),
					{ id: 'cpu' as const, available: this.ortAvailable(), ...(this.ortAvailable() ? {} : { reason }) },
				],
				error: reason,
			};
		}
		const providers: ProviderStatus[] = res.providers.map((p) => ({ ...p }));
		const gpu = bestGpu(providers, candidates);
		let gpuInfo: StoredProbe['gpu'] = null;
		if (gpu) {
			const rt = gpu.id === 'cuda' ? this.cuda.runtime() : null;
			const name = rt?.gpu ?? this.gpuName(gpu.id);
			gpu.device = name;
			let vramMb = rt?.vramMb ?? null;
			if (vramMb === null && this.platform !== 'darwin') vramMb = this.nvidiaVram();
			gpuInfo = { name, provider: gpu.id, vramMb };
		}
		return {
			key,
			providers,
			gpu: gpuInfo,
			probedAt: new Date().toISOString(),
			...(res.error ? { error: res.error } : {}),
		};
	}

	private nvidiaVram(): number | null {
		try {
			const out = execFileSync('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], {
				encoding: 'utf8',
				timeout: 5000,
				stdio: ['ignore', 'pipe', 'ignore'],
			});
			const v = Number(out.split('\n')[0]?.trim());
			return Number.isFinite(v) && v > 0 ? v : null;
		} catch {
			return null;
		}
	}

	private async spawnProbe(req: unknown, extraEnv: Record<string, string>): Promise<ProbeResponse> {
		const dir = join(this.core.config.paths.tmpDir, `speech-probe-${process.pid}-${Date.now()}`);
		const { mkdir, rm } = await import('node:fs/promises');
		await mkdir(dir, { recursive: true });
		try {
			const reqPath = join(dir, 'request.json');
			const outPath = join(dir, 'probe.json');
			await writeFile(reqPath, JSON.stringify(req));
			const cmd = speechCommand(this.env);
			const child = spawn(cmd.command, [...cmd.args, 'probe', reqPath, outPath], {
				stdio: ['ignore', 'pipe', 'pipe'],
				env: { ...process.env, ...extraEnv },
			});
			let stderr = '';
			child.stderr.on('data', (c: Buffer) => {
				if (stderr.length < 4000) stderr += c.toString();
			});
			child.stdout.resume();
			const code = await new Promise<number | null>((resolve, reject) => {
				const t = setTimeout(() => {
					child.kill('SIGKILL');
					reject(new Error(`no answer after ${PROBE_TIMEOUT_MS / 1000} s`));
				}, PROBE_TIMEOUT_MS);
				child.on('error', (e) => {
					clearTimeout(t);
					reject(e);
				});
				child.on('close', (c, sig) => {
					clearTimeout(t);
					resolve(sig ? -1 : c);
				});
			});
			if (code !== 0)
				throw new Error(
					stderr.trim().split('\n').pop() || `the worker exited with ${code === -1 ? 'a signal' : code}`,
				);
			const parsed = JSON.parse(await readFile(outPath, 'utf8')) as ProbeResponse;
			if (!parsed || !Array.isArray(parsed.providers)) throw new Error('the worker wrote no probe result');
			return parsed;
		} finally {
			await rm(dir, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	/** The probe as the API reports it (policy exclusions included). */
	async probeReport(p?: StoredProbe): Promise<SpeechProbe> {
		const probe = p ?? (await this.probe());
		const s = await this.settings();
		const calibrations = await this.state.calibrations();
		const order = gpuCandidates(this.platform, this.arch);
		const plan = planDevices({
			providers: probe.providers,
			order,
			request: s.processor,
			beamSize: s.accuracy === 'best' ? 5 : 1,
			modelId: this.models.defaultId(),
			calibrations,
		});
		const providers = [...probe.providers];
		for (const ex of policyExcluded(this.platform, this.arch))
			if (!providers.some((x) => x.id === ex.id)) providers.push(ex);
		const m = this.machine();
		return {
			platform: this.platform,
			arch: this.arch,
			ortVersion: ortVersion({}) ?? 'none',
			providers,
			chosen: { encoder: plan.encoder, decoder: plan.calibrate ? 'cpu' : plan.decoder },
			threads: this.threads(),
			gpu: probe.gpu,
			ramBytes: m.ramBytes,
			cores: m.cores,
			calibrations,
			probedAt: probe.probedAt,
			cuda: await this.cuda.status(),
			...(probe.error ? { error: probe.error } : {}),
		};
	}

	/** SG-021: the model recommended for this computer (sync: uses the cached probe; CPU rules without one). */
	recommendation(): string | null {
		const m = this.machine();
		const g = this.memProbe?.gpu ?? null;
		const s = this.settingsCache;
		// Processor: CPU → recommend for the CPU
		const gpu = g && s?.processor !== 'cpu' ? { provider: g.provider, vramMb: g.vramMb } : null;
		return recommendModel({ entries: this.models.entries, gpu, ramBytes: m.ramBytes, cores: m.cores });
	}

	async features(): Promise<NonNullable<M2Features['speech']>> {
		const installed = (await this.models.list()).filter((m) => m.installed).length;
		const reasons: string[] = [];
		if (!this.ortAvailable()) reasons.push('ONNX Runtime (onnxruntime-node) is not installed');
		if (!this.core.ffmpeg.bins.ffmpeg) reasons.push('ffmpeg was not found');
		if (!this.models.entries.length) reasons.push('the model catalogue has no speech models');
		if (this.models.catalogErrors.length)
			reasons.push(`refused catalogue entries: ${this.models.catalogErrors.slice(0, 3).join('; ')}`);
		const probe = this.memProbe;
		const rec = this.recommendation();
		const ready = this.ortAvailable() && !!this.core.ffmpeg.bins.ffmpeg && this.models.entries.length > 0;
		let chosen: { encoder: string; decoder: string } | undefined;
		if (probe) {
			const s = this.settingsCache ?? (await this.settings());
			const plan = planDevices({
				providers: probe.providers,
				order: gpuCandidates(this.platform, this.arch),
				request: s.processor,
				beamSize: s.accuracy === 'best' ? 5 : 1,
				modelId: this.models.defaultId(),
				calibrations: await this.state.calibrations(),
			});
			chosen = { encoder: plan.encoder, decoder: plan.calibrate ? 'cpu' : plan.decoder };
		}
		return {
			status: ready ? 'ready' : 'unavailable',
			...(reasons.length ? { reason: reasons.join('; ') } : {}),
			runtime: 'onnxruntime',
			modelsInstalled: installed,
			defaultModel: this.models.defaultId(),
			...(probe ? { providers: probe.providers.map((p) => ({ ...p })), ...(chosen ? { chosen } : {}) } : {}),
			threads: this.threads(),
			...(rec ? { recommendedModel: rec } : {}),
			cuda: await this.cuda.state(),
		};
	}

	/** The catalogue with "Runs on" and speed for the current settings (SG-030); probes when needed. */
	async listModels(): Promise<SpeechModel[]> {
		const list = await this.models.list();
		let probe: StoredProbe | null = null;
		try {
			probe = await this.probe();
		} catch {
			probe = null;
		}
		const s = await this.settings();
		const calibrations = await this.state.calibrations();
		const measurements = await this.state.measurements();
		const threads = this.threads();
		const order = gpuCandidates(this.platform, this.arch);
		return list.map((m) => {
			const e = this.models.entry(m.id) as SpeechCatalogEntry;
			const plan = planDevices({
				providers: probe?.providers ?? [{ id: 'cpu', available: true }],
				order,
				request: s.processor,
				beamSize: s.accuracy === 'best' ? 5 : 1,
				modelId: m.id,
				calibrations,
			});
			const decoder = plan.calibrate ? 'cpu' : plan.decoder;
			const meas = measurements.find(
				(x) => x.modelId === m.id && x.encoder === plan.encoder && x.accuracy === s.accuracy,
			);
			const rtf =
				meas?.rtf ??
				estimateRtf({
					modelId: m.id,
					parameters: e.parameters,
					precision: e.precision ?? 'fp32',
					encoder: plan.encoder,
					accuracy: s.accuracy,
					threads,
				});
			return {
				...m,
				runsOn: {
					encoder: plan.encoder,
					decoder,
					device: deviceLabel({ encoder: plan.encoder, decoder }, probe?.gpu?.name ?? null),
					threads,
				},
				speed: {
					minutesPer10Min: Math.round(rtf * 100) / 10,
					basis: meas ? 'measured' : 'estimated',
					...(meas ? { at: meas.at } : {}),
					accuracy: s.accuracy,
				},
			};
		});
	}

	/** SG-008: the upscaler's providers from this probe (`probe`: run it when none is cached). */
	async upscalerProviders(probe: boolean): Promise<{ providers: string[]; env: Record<string, string> }> {
		const p = probe ? await this.probe() : this.memProbe;
		if (!p) return { providers: this.ortAvailable() ? ['cpu'] : [], env: {} };
		const cuda = !!p.providers.find((x) => x.id === 'cuda')?.available;
		const cpu = p.providers.find((x) => x.id === 'cpu')?.available ?? this.ortAvailable();
		const env = cuda ? ((await this.cudaUse(await this.settings())).env ?? {}) : {};
		return { providers: [...(cuda ? ['cuda'] : []), ...(cpu ? ['cpu'] : [])], env };
	}

	// ---------------------------------------------------------------- CUDA provider (SG-006)

	cudaStatus(): Promise<SpeechCudaStatus> {
		return this.cuda.status();
	}

	submitCudaInstall(origin: EngineJob['origin'] = { type: 'user' }): EngineJob {
		if (!this.cuda.supported)
			throw new JobError('UNSUPPORTED_PLATFORM', 'The CUDA provider is available for Linux x64 only', false);
		return this.core.queue.submit({
			kind: 'runtime-download',
			title: 'Install the NVIDIA GPU (CUDA) provider',
			priority: 'user',
			cpuSlots: 0,
			origin,
			dedupeKey: 'runtime:onnxruntime-cuda',
			input: {},
		});
	}

	private async runCudaInstall(ctx: JobContext): Promise<{ state: string; freedBytes?: number }> {
		try {
			await this.cuda.install({
				signal: ctx.signal,
				onProgress: (done, total, stage) =>
					ctx.progress(total ? Math.min(0.99, done / total) : null, { stage }),
			});
		} catch (e) {
			if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
			if (e instanceof DownloadError)
				throw new JobError(
					e.code === 'CHECKSUM' ? 'DOWNLOAD_CHECKSUM' : 'DOWNLOAD_FAILED',
					e.message,
					e.code !== 'CHECKSUM',
				);
			if (e instanceof CudaError) throw new JobError(e.code, e.message, false);
			throw e;
		}
		// enabling implies using it
		await this.updateSettings({ nvidiaGpu: true });
		await this.probe(true).catch(() => undefined);
		return { state: await this.cuda.state() };
	}

	async removeCuda(): Promise<{ freedBytes: number }> {
		const r = await this.cuda.remove();
		this.memProbe = null;
		this.core.capabilities.changed();
		return r;
	}

	// ---------------------------------------------------------------- jobs

	/**
	 * Validates the model choice (sync errors become HTTP 4xx). A model the caller named must be installed; when the
	 * caller named none and the default is not installed, the best installed model that fits is used instead
	 * (`SpeechModelStore.fallbackFor`) and reported as `fallback`.
	 */
	private async checkModel(o: TranscribeOptions): Promise<{ id: string; fallback?: SpeechModelFallback }> {
		const id = o.model ?? this.models.defaultId();
		const e = this.models.entry(id);
		if (!e) throw new JobError('SPEECH_MODEL_UNKNOWN', `Unknown speech model ${id}`, false);
		if (o.task === 'translate' && !e.multilingual)
			throw new JobError('INVALID_SPEC', `${e.name} is English-only and cannot translate`, false);
		if (o.language && o.language !== 'auto' && !e.multilingual && o.language !== 'en')
			throw new JobError(
				'INVALID_SPEC',
				`${e.name} is English-only; choose a multilingual model for "${o.language}"`,
				false,
			);
		if (await this.models.installed(e)) return { id };
		if (!o.model) {
			// an English-only model only for English speech; translation needs a multilingual one
			const fits = (x: SpeechCatalogEntry) =>
				x.multilingual || (o.language === 'en' && o.task !== 'translate');
			const alt = await this.models.fallbackFor(id, fits);
			if (alt)
				return {
					id: alt.id,
					fallback: {
						requested: id,
						reason: `the default model ${e.name} is not downloaded; used ${alt.name}, the best installed one`,
					},
				};
		}
		throw new JobError(
			'SPEECH_MODEL_NOT_INSTALLED',
			`The speech model ${e.name} is not downloaded. Download it in Preferences ▸ Transcription (or install_speech_model).`,
			false,
		);
	}

	private audioStreamOf(record: MediaRecord, streamIndex: number | undefined): number {
		const streams = record.probe.streams.filter((s) => s.type === 'audio');
		const s = streamIndex !== undefined ? streams.find((x) => x.index === streamIndex) : streams[0];
		if (!s) throw new JobError('NO_AUDIO', 'The media has no such audio stream', false);
		return s.index;
	}

	async submitMedia(
		mediaKey: string,
		req: TranscribeMediaRequest,
		origin: EngineJob['origin'] = { type: 'user' },
	): Promise<EngineJob> {
		const record = this.core.registry.get(mediaKey);
		if (!record) throw new JobError('ASSET_NOT_FOUND', 'Unknown media key', false);
		const stream = this.audioStreamOf(record, req.streamIndex);
		const { id: model, fallback } = await this.checkModel(req);
		const options: TranscribeOptions = { ...pickOptions(req), model };
		const duration = Number((record.probe as { duration?: unknown }).duration);
		const input: MediaInput = {
			target: 'media',
			mediaKey,
			streamIndex: stream,
			options,
			...(Number.isFinite(duration) && duration > 0 ? { durationSec: duration } : {}),
			...(fallback ? { modelFallback: fallback } : {}),
		};
		return this.core.queue.submit({
			kind: 'transcription',
			title: `Transcribe – ${record.originalName}`,
			priority: 'user',
			cpuSlots: this.threads(),
			minSlots: 1,
			origin,
			assetId: mediaKey,
			...(req.projectId ? { projectId: req.projectId } : {}),
			dedupeKey: `transcribe:${mediaKey}:${stream}:${hashOf(options)}`,
			input,
			stage: 'Queued',
		});
	}

	async submitSequence(
		req: TranscribeSequenceRequest,
		origin: EngineJob['origin'] = { type: 'user' },
	): Promise<EngineJob> {
		const planned = await this.plan(req); // plan errors surface synchronously
		const { id: model, fallback } = await this.checkModel(req);
		const doc = req.envelope.document as {
			projectId?: string;
			sequences?: Record<string, { name?: string }>;
		};
		const projectId = req.projectId ?? (typeof doc.projectId === 'string' ? doc.projectId : undefined);
		const name = doc.sequences?.[req.sequenceId]?.name ?? req.sequenceId;
		const request = { ...req, model };
		return this.core.queue.submit({
			kind: 'transcription',
			title: `Transcribe sequence mix – ${name}`,
			priority: 'user',
			cpuSlots: this.threads(),
			minSlots: 1,
			origin,
			...(projectId ? { projectId } : {}),
			dedupeKey: `transcribe-seq:${req.sequenceId}:${mixFingerprint(planned.document, planned.sequenceId)}:${planned.range.start}-${planned.range.end}:${hashOf(pickOptions(request))}`,
			input: {
				target: 'sequence',
				request,
				...(fallback ? { modelFallback: fallback } : {}),
			} satisfies SequenceInput,
			stage: 'Queued',
		});
	}

	private async plan(req: TranscribeSequenceRequest): Promise<PlannedExport> {
		try {
			// the sound alone (an audio-only deliverable): an offline picture never refuses the transcription; offline
			// sound does
			return await this.core.exports.plan({
				envelope: req.envelope as never,
				sequenceId: req.sequenceId,
				settings: {
					sequenceId: req.sequenceId,
					range: req.range === 'in-out' ? { type: 'in-out' } : { type: 'entire' },
					container: 'wav',
					engine: 'auto',
					destination: { type: 'download' },
				},
			});
		} catch (e) {
			if (e instanceof PlanError) throw new JobError(e.code, e.message, false, e.detail);
			throw e;
		}
	}

	/** Accuracy, beam and device request of a job (job options over the Transcription preferences). */
	private async decodingOf(o: TranscribeOptions): Promise<{
		accuracy: 'standard' | 'best';
		beamSize: number;
		request: 'auto' | 'cpu' | 'gpu';
	}> {
		const s = await this.settings();
		const accuracy = o.accuracy ?? s.accuracy;
		const beamSize = o.beamSize ?? (accuracy === 'best' ? 5 : 1);
		const request = o.device && o.device !== 'auto' ? o.device : s.processor;
		return { accuracy, beamSize, request };
	}

	private async devicePlan(
		modelId: string,
		request: 'auto' | 'cpu' | 'gpu',
		beamSize: number,
	): Promise<{ plan: DevicePlan; env: Record<string, string>; gpuName: string | null }> {
		const probe = request === 'cpu' ? null : await this.probe().catch(() => null);
		const plan = planDevices({
			providers: probe?.providers ?? [{ id: 'cpu', available: true }],
			order: gpuCandidates(this.platform, this.arch),
			request,
			beamSize,
			modelId,
			calibrations: await this.state.calibrations(),
		});
		if (probe === null && request === 'gpu') plan.unavailableReason = 'the provider probe failed';
		const usesCuda = [plan.encoder, plan.decoder, plan.calibrate].includes('cuda');
		const env = usesCuda ? ((await this.cudaUse(await this.settings())).env ?? {}) : {};
		return { plan, env, gpuName: probe?.gpu?.name ?? null };
	}

	private async run(ctx: JobContext): Promise<TranscriptionResult> {
		const input = ctx.input as MediaInput | SequenceInput;
		const options = input.target === 'media' ? input.options : pickOptions(input.request);
		const modelId = options.model ?? this.models.defaultId();
		let modelDir: string;
		let entry: SpeechCatalogEntry;
		try {
			const r = await this.models.resolve(modelId);
			modelDir = r.dir;
			entry = r.entry;
		} catch (e) {
			if (e instanceof SpeechModelError) throw new JobError(e.code, e.message, false);
			throw e;
		}
		const ffmpeg = this.core.ffmpeg.bins.ffmpeg;
		if (!ffmpeg) throw new JobError('BINARY_MISSING', 'ffmpeg was not found', false);
		const scratch = await ctx.scratchDir();
		const { accuracy, beamSize, request } = await this.decodingOf(options);
		ctx.progress(0, { stage: 'Choosing the processor' });
		const { plan, env, gpuName } = await this.devicePlan(modelId, request, beamSize);
		const threads = Math.max(1, Math.min(ctx.slots, this.threads()));
		let target: TranscriptionResult['target'];
		let offsetFlicks = 0;
		let span: [number, number] = [0, 1];
		let source: SpeechJobSpec['input'];
		let durationSec: number | undefined;
		let voiceAnalysis: SpeechJobSpec['voiceAnalysis'];
		if (input.target === 'media') {
			const record = this.core.registry.get(input.mediaKey);
			if (!record) throw new JobError('ASSET_NOT_FOUND', 'The media is no longer registered', false);
			const file = await this.core.registry.resolvePath(input.mediaKey);
			if (!file) throw new JobError('MEDIA_OFFLINE', 'The media file is not available on the engine', false);
			source = { path: file, ffmpeg, ...(input.streamIndex !== null ? { stream: input.streamIndex } : {}) };
			durationSec = input.durationSec;
			voiceAnalysis = await this.voiceAnalysisFor(record, input.mediaKey, input.streamIndex, ctx);
			target = { type: 'media', mediaKey: input.mediaKey, streamIndex: input.streamIndex };
		} else {
			const req = input.request;
			ctx.progress(0, { stage: 'Mixing the sequence audio' });
			const planned = await this.plan(req).catch((e) => {
				throw e instanceof JobError ? e : new JobError('PLAN_FAILED', String((e as Error).message), false);
			});
			const snap = planned.snapshot;
			const mix = await renderMixdown({
				ff: this.core.ffmpeg,
				snapshot: snap,
				media: (id: string) => {
					const m = planned.media[id];
					if (!m) return null;
					return {
						path: m.path,
						streams: m.record.probe.streams.filter((x) => x.type === 'audio') as AudioStream[],
						container: m.record.container,
					};
				},
				range: planned.range,
				outputLayout: 'mono',
				withoutLoudness: true,
				scratchDir: scratch,
				signal: ctx.signal,
				onSpawn: ctx.trackChild,
				onProgress: (f, stage) => ctx.progress(f * 0.15, { stage: `Mix · ${stage}` }),
			});
			if (!mix.path) throw new JobError('MIX_FAILED', 'The sequence mix produced no audio', false);
			const fps = snap.settings.fps;
			offsetFlicks = planned.range.start * flicksPerFrame(fps);
			durationSec = Math.max(
				0,
				((planned.range.end - planned.range.start) * flicksPerFrame(fps)) / FLICKS_PER_SECOND,
			);
			span = [0.15, 1];
			source = { path: mix.path, ffmpeg };
			target = {
				type: 'sequence',
				sequenceId: planned.sequenceId,
				range: { startFrame: planned.range.start, endFrame: planned.range.end },
				// the fingerprint of the document the client sent, so it can tell whether the sequence changed since
				mixHash: mixFingerprint(req.envelope.document as ProjectDocument, req.sequenceId),
			};
		}
		const spec: SpeechJobSpec = {
			modelDir,
			modelId,
			input: source,
			...specOptions(options),
			beamSize,
			threads,
			device: { encoder: plan.encoder, decoder: plan.decoder, calibrate: plan.calibrate },
			...(entry.encoderFile || entry.decoderFile
				? {
						files: {
							...(entry.encoderFile ? { encoder: entry.encoderFile } : {}),
							...(entry.decoderFile ? { decoder: entry.decoderFile } : {}),
						},
					}
				: {}),
			scratch,
			...(durationSec ? { durationSec } : {}),
			...(voiceAnalysis ? { voiceAnalysis } : {}),
		};
		const fallbacks: SpeechDeviceReport['fallbacks'] = [];
		if (plan.unavailableReason)
			fallbacks.push({
				stage: 'unavailable',
				part: 'both',
				from: 'cpu',
				to: 'cpu',
				reason: plan.unavailableReason,
			});
		const host: WorkerHost = {
			signal: ctx.signal,
			progress: (f, stage) => ctx.progress(f, { stage }),
			log: (t) => ctx.log(t),
			trackChild: (c) => ctx.trackChild(c),
		};
		let run = await this.runWorker<SpeechJobOutput>(host, 'transcribe', spec, scratch, span, env, gpuName);
		if (!run.out) {
			// SG-003: a GPU failure the worker could not handle itself (it crashed, or failed before its own CPU
			// retry) → the job once more on the CPU; the original error when that fails too
			const original = new JobError('TRANSCRIPTION_FAILED', run.error ?? 'jasper-speech failed', false);
			const from = gpuOfFailedRun(run, plan);
			if (!from || ctx.signal.aborted) throw original;
			ctx.log(`GPU attempt failed (${run.error}); running again on the CPU`);
			const cpuSpec: SpeechJobSpec = { ...spec, device: { encoder: 'cpu', decoder: 'cpu', calibrate: null } };
			run = await this.runWorker<SpeechJobOutput>(host, 'transcribe', cpuSpec, scratch, span, {}, gpuName);
			if (!run.out) throw original;
			fallbacks.push({ stage: 'job', part: 'both', from, to: 'cpu', reason: shortReason(original.message) });
		}
		const out = run.out;
		fallbacks.push(...out.device.fallbacks);
		if (out.calibration) {
			await this.state
				.addCalibration({ modelId, ...out.calibration, at: new Date().toISOString() })
				.catch(() => undefined);
		}
		const audioSec = out.samples / 16_000;
		if (audioSec > 0)
			await this.state
				.addMeasurement({
					modelId,
					encoder: out.device.encoder,
					decoder: out.device.decoder,
					accuracy,
					rtf: out.timings.transcribeMs / 1000 / audioSec,
					audioSec,
					at: new Date().toISOString(),
				})
				.catch(() => undefined);
		const speakers: Record<string, { name: string }> = {};
		for (let i = 0; i < out.speakers; i++) speakers[`S${i + 1}`] = { name: `Speaker ${i + 1}` };
		const offsetSec = offsetFlicks / FLICKS_PER_SECOND;
		const device: SpeechDeviceReport = {
			encoder: out.device.encoder,
			decoder: out.device.decoder,
			label: deviceLabel(out.device, gpuName),
			threads: out.device.threads,
			fallbacks,
		};
		return {
			target,
			model: modelId,
			...(input.modelFallback ? { modelFallback: input.modelFallback } : {}),
			language: out.language,
			languageProbability: out.languageProbability,
			task: out.task,
			duration: Math.round(out.samples * FLICKS_PER_SAMPLE),
			words: out.words.map((w) => ({
				text: w.text,
				start: offsetFlicks + Math.round(w.start * FLICKS_PER_SAMPLE),
				end: offsetFlicks + Math.round(w.end * FLICKS_PER_SAMPLE),
				confidence: Math.min(1, Math.max(0, w.confidence)),
				speaker: w.speaker === null ? null : `S${w.speaker + 1}`,
			})),
			speakers,
			segments: out.segments.map((s) => ({
				start: s.start + offsetSec,
				end: s.end + offsetSec,
				text: s.text,
				avgLogprob: s.avgLogprob,
				noSpeechProb: s.noSpeechProb,
				compressionRatio: s.compressionRatio,
				temperature: s.temperature,
			})),
			timings: {
				...out.timings,
				...(audioSec > 0
					? { rtf: Math.round((out.timings.transcribeMs / 1000 / audioSec) * 1000) / 1000 }
					: {}),
			},
			device,
			guard: {
				skippedWindows: out.guard.skippedWindows,
				droppedWords: out.guard.droppedWords,
				removed: out.guard.removed
					.slice(0, 200)
					.map((r) => ({ ...r, start: r.start + offsetSec, end: r.end + offsetSec })),
				frames: out.guard.frames,
				...(out.guard.glossary ? { glossary: out.guard.glossary } : {}),
				...(out.guard.recovered
					? {
							recovered: {
								...out.guard.recovered,
								ranges: out.guard.recovered.ranges.map((r) => ({
									...r,
									start: r.start + offsetSec,
									end: r.end + offsetSec,
								})),
							},
						}
					: {}),
				...(out.guard.chunked ? { chunked: out.guard.chunked } : {}),
				...(out.guard.redecoded
					? {
							redecoded: {
								...out.guard.redecoded,
								ranges: out.guard.redecoded.ranges.map((r) => ({
									...r,
									start: r.start + offsetSec,
									end: r.end + offsetSec,
								})),
							},
						}
					: {}),
			},
			accuracy,
			beamSize,
		};
	}

	/**
	 * Spec 17 SC-092: teacher-forced scores of alternative readings of the same audio windows of a media, with forced
	 * word times (SC-032, SC-040). Engine-internal (the `transcript-fix` job calls it with its context); one worker
	 * run decodes the media once, loads the model once and encodes each distinct window once. Device plan as
	 * transcription (SC-035): encoder on the best GPU, decoder where the transcription calibration put it, session
	 * fallbacks, a GPU failure → one more run on the CPU with the reason recorded. Cancelling `signal` ends the call
	 * within ≈ 1 s (SC-036). Failures are `JobError {code, message, retryable, detail?}`: `INVALID_SPEC`,
	 * `ASSET_NOT_FOUND`, `NO_AUDIO`, `MEDIA_OFFLINE`, `SPEECH_MODEL_*`, `BINARY_MISSING`, the worker's refusals
	 * (`SPEECH_TOKENIZER_CANNOT_ENCODE`, `SPEECH_READING_TOO_LONG`, `SPEECH_WINDOW_TOO_LONG`,
	 * `SPEECH_WINDOW_OUT_OF_RANGE`, `SPEECH_LANGUAGE_UNKNOWN`, `SPEECH_LANGUAGE_UNSUPPORTED`), `SPEECH_SCORE_FAILED`
	 * and `JOB_CANCELLED`.
	 */
	async score(
		request: SpeechScoreRequest,
		signal: AbortSignal,
		opts: SpeechScoreOptions = {},
	): Promise<SpeechScoreResult> {
		const parsed = SpeechScoreRequestSchema.safeParse(request);
		if (!parsed.success) {
			const i = parsed.error.issues[0];
			throw new JobError(
				'INVALID_SPEC',
				`Invalid scoring request: ${i ? `${i.path.join('.') || '(root)'}: ${i.message}` : 'invalid'}`,
				false,
				{ issues: parsed.error.issues.slice(0, 10) },
			);
		}
		const req = parsed.data;
		if (req.language === 'auto')
			throw new JobError('INVALID_SPEC', 'Scoring needs the language of the speech (not "auto")', false);
		if (signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
		const record = this.core.registry.get(req.mediaId);
		if (!record) throw new JobError('ASSET_NOT_FOUND', 'Unknown media key', false);
		const stream = this.audioStreamOf(record, req.streamIndex);
		const { id: modelId } = await this.checkModel({
			...(req.model ? { model: req.model } : {}),
			language: req.language,
		});
		let modelDir: string;
		let entry: SpeechCatalogEntry;
		try {
			const r = await this.models.resolve(modelId);
			modelDir = r.dir;
			entry = r.entry;
		} catch (e) {
			if (e instanceof SpeechModelError) throw new JobError(e.code, e.message, false);
			throw e;
		}
		const file = await this.core.registry.resolvePath(req.mediaId);
		if (!file) throw new JobError('MEDIA_OFFLINE', 'The media file is not available on the engine', false);
		const ffmpeg = this.core.ffmpeg.bins.ffmpeg;
		if (!ffmpeg) throw new JobError('BINARY_MISSING', 'ffmpeg was not found', false);
		const { request: processor } = await this.decodingOf({ ...(req.device ? { device: req.device } : {}) });
		const { plan, env, gpuName } = await this.devicePlan(modelId, processor, 1);
		const threads = Math.max(1, Math.min(opts.threads ?? this.threads(), this.threads()));
		const owned = !opts.scratchDir;
		const scratch =
			opts.scratchDir ?? join(this.core.config.paths.tmpDir, `speech-score-${process.pid}-${randomUUID()}`);
		await mkdir(scratch, { recursive: true });
		const host: WorkerHost = {
			signal,
			progress: (f, stage) => opts.onProgress?.(Math.min(1, Math.max(0, f)), stage),
			log: (t) => opts.log?.(t),
			...(opts.trackChild ? { trackChild: opts.trackChild } : {}),
			killGraceMs: SCORE_KILL_GRACE_MS,
		};
		try {
			const duration = Number((record.probe as { duration?: unknown }).duration);
			const voiceAnalysis = await this.existingVoiceAnalysis(record, stream);
			const spec: ScoreJobSpec = {
				modelDir,
				modelId,
				input: { path: file, ffmpeg, stream },
				language: req.language,
				threads,
				// scoring runs no greedy steps, so no decoder calibration: the decoder stays where it was calibrated
				device: { encoder: plan.encoder, decoder: plan.calibrate ? 'cpu' : plan.decoder, calibrate: null },
				...(entry.encoderFile || entry.decoderFile
					? {
							files: {
								...(entry.encoderFile ? { encoder: entry.encoderFile } : {}),
								...(entry.decoderFile ? { decoder: entry.decoderFile } : {}),
							},
						}
					: {}),
				scratch,
				...(Number.isFinite(duration) && duration > 0 ? { durationSec: duration } : {}),
				...(voiceAnalysis ? { voiceAnalysis } : {}),
				...(opts.batch ? { batch: Math.max(1, Math.min(32, Math.floor(opts.batch))) } : {}),
				windows: req.windows.map((w) => {
					const start = Math.floor(w.start / FLICKS_PER_SAMPLE);
					// ≤ 30 s after rounding too (the request allows exactly 30 s of flicks)
					const end = Math.min(
						start + 30 * 16_000,
						Math.max(start + 1, Math.ceil(w.end / FLICKS_PER_SAMPLE)),
					);
					// SC-030 muted gaps, rounded inwards (never into the audio around them), inside the window
					const mute = (w.mute ?? [])
						.map((m) => ({
							start: Math.max(start, Math.ceil(m.start / FLICKS_PER_SAMPLE)),
							end: Math.min(end, Math.floor(m.end / FLICKS_PER_SAMPLE)),
						}))
						.filter((m) => m.end > m.start);
					return {
						id: w.id,
						start,
						end,
						readings: w.readings.map((r) => ({ id: r.id, words: r.words })),
						...(mute.length ? { mute } : {}),
					};
				}),
			};
			const fallbacks: SpeechFallback[] = [];
			if (plan.unavailableReason)
				fallbacks.push({
					stage: 'unavailable',
					part: 'both',
					from: 'cpu',
					to: 'cpu',
					reason: plan.unavailableReason,
				});
			const refused = (run: WorkerRun<ScoreJobOutput>) =>
				new JobError(
					run.code ?? 'SPEECH_REFUSED',
					run.error ?? 'The speech worker refused the request',
					false,
				);
			let run = await this.runWorker<ScoreJobOutput>(host, 'score', spec, scratch, [0, 1], env, gpuName);
			if (!run.out) {
				if (run.code) throw refused(run);
				const original = new JobError('SPEECH_SCORE_FAILED', run.error ?? 'jasper-speech failed', false);
				const from = gpuOfFailedRun(run, spec.device ?? plan);
				if (!from || signal.aborted) throw original;
				host.log(`GPU attempt failed (${run.error}); scoring again on the CPU`);
				const cpuSpec: ScoreJobSpec = {
					...spec,
					device: { encoder: 'cpu', decoder: 'cpu', calibrate: null },
				};
				run = await this.runWorker<ScoreJobOutput>(host, 'score', cpuSpec, scratch, [0, 1], {}, gpuName);
				if (!run.out) {
					if (run.code) throw refused(run);
					throw original;
				}
				fallbacks.push({
					stage: 'job',
					part: 'both',
					from,
					to: 'cpu',
					reason: shortReason(original.message),
				});
			}
			const out = run.out;
			if (!validScoreOutput(out, spec))
				throw new JobError('SPEECH_SCORE_FAILED', 'The speech worker wrote an invalid scoring result', false);
			fallbacks.push(...out.device.fallbacks);
			const fallback =
				fallbacks.find((f) => f.stage === 'job') ??
				fallbacks.find((f) => f.stage === 'session') ??
				fallbacks.find((f) => f.stage === 'unavailable');
			const flicks = (samples: number) => Math.round(samples * FLICKS_PER_SAMPLE);
			return {
				device: {
					encoder: out.device.encoder,
					decoder: out.device.decoder,
					label: deviceLabel(out.device, gpuName),
					threads: out.device.threads,
					fallbacks,
				},
				model: modelId,
				...(fallback ? { fallback } : {}),
				windows: out.windows.map((w) => ({
					id: w.id,
					readings: w.readings.map((r) => ({
						id: r.id,
						logprob: r.logprob,
						tokens: r.tokens,
						words: r.words.map((x) => ({
							text: x.text,
							tokens: x.tokens,
							logprob: x.logprob,
							probability: Math.min(1, Math.max(0, x.probability)),
							start: flicks(x.start),
							end: flicks(Math.max(x.start, x.end)),
						})),
					})),
				})),
				timings: {
					...out.timings,
					encoderMs: out.profile.encoderMs,
					decoderMs: out.profile.decoderMs,
					encoderPasses: out.profile.encoderPasses,
					decoderRuns: out.profile.decoderRuns,
					readings: out.profile.readings,
					windowSec: out.profile.windowSec,
				},
			};
		} finally {
			if (owned) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	/**
	 * Media ranges transcribed in one worker run (`speech/kept-spans.ts`): each range the `chunking: "vad"` way, best
	 * accuracy unless asked otherwise, no safety passes; the words whose midpoint lies inside a range, in media flicks.
	 * Engine-internal (a job calls it with its context, like `score`): device plan and GPU → CPU fallback as
	 * transcription, cancellation through `signal`, failures as `JobError` (`ASSET_NOT_FOUND`, `NO_AUDIO`,
	 * `MEDIA_OFFLINE`, `SPEECH_MODEL_*`, `BINARY_MISSING`, `INVALID_SPEC`, `TRANSCRIPTION_FAILED`, `JOB_CANCELLED`).
	 */
	async transcribeSpans(
		req: SpanTranscriptionRequest,
		signal: AbortSignal,
		opts: SpeechScoreOptions = {},
	): Promise<SpanTranscriptionResult> {
		if (signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
		const ranges = (req.ranges ?? []).filter(
			(r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start && r.start >= 0,
		);
		if (!ranges.length) throw new JobError('INVALID_SPEC', 'No range to transcribe', false);
		const record = this.core.registry.get(req.mediaKey);
		if (!record) throw new JobError('ASSET_NOT_FOUND', 'Unknown media key', false);
		const stream = this.audioStreamOf(record, req.streamIndex);
		const language = req.language && req.language !== 'auto' ? req.language : undefined;
		const { id: modelId } = await this.checkModel({
			...(req.model ? { model: req.model } : {}),
			...(language ? { language } : {}),
		});
		let modelDir: string;
		let entry: SpeechCatalogEntry;
		try {
			const r = await this.models.resolve(modelId);
			modelDir = r.dir;
			entry = r.entry;
		} catch (e) {
			if (e instanceof SpeechModelError) throw new JobError(e.code, e.message, false);
			throw e;
		}
		const file = await this.core.registry.resolvePath(req.mediaKey);
		if (!file) throw new JobError('MEDIA_OFFLINE', 'The media file is not available on the engine', false);
		const ffmpeg = this.core.ffmpeg.bins.ffmpeg;
		if (!ffmpeg) throw new JobError('BINARY_MISSING', 'ffmpeg was not found', false);
		const { beamSize, request: processor } = await this.decodingOf({
			accuracy: req.accuracy ?? 'best',
			...(req.device ? { device: req.device } : {}),
		});
		const { plan, env, gpuName } = await this.devicePlan(modelId, processor, beamSize);
		const threads = Math.max(1, Math.min(opts.threads ?? this.threads(), this.threads()));
		const owned = !opts.scratchDir;
		const scratch =
			opts.scratchDir ?? join(this.core.config.paths.tmpDir, `speech-spans-${process.pid}-${randomUUID()}`);
		await mkdir(scratch, { recursive: true });
		const host: WorkerHost = {
			signal,
			progress: (f, stage) => opts.onProgress?.(Math.min(1, Math.max(0, f)), stage),
			log: (t) => opts.log?.(t),
			...(opts.trackChild ? { trackChild: opts.trackChild } : {}),
		};
		try {
			const duration = Number((record.probe as { duration?: unknown }).duration);
			const voiceAnalysis = await this.existingVoiceAnalysis(record, stream);
			const spec: SpeechJobSpec = {
				modelDir,
				modelId,
				input: { path: file, ffmpeg, stream },
				language: language ?? null,
				task: 'transcribe',
				beamSize,
				threads,
				device: { encoder: plan.encoder, decoder: plan.decoder, calibrate: plan.calibrate },
				...(entry.encoderFile || entry.decoderFile
					? {
							files: {
								...(entry.encoderFile ? { encoder: entry.encoderFile } : {}),
								...(entry.decoderFile ? { decoder: entry.decoderFile } : {}),
							},
						}
					: {}),
				scratch,
				chunking: 'vad',
				redecode: false,
				conditionOnPreviousText: false,
				spans: ranges.map((r) => ({
					start: Math.floor(r.start / FLICKS_PER_SAMPLE),
					end: Math.ceil(r.end / FLICKS_PER_SAMPLE),
				})),
				...(Number.isFinite(duration) && duration > 0 ? { durationSec: duration } : {}),
				...(voiceAnalysis ? { voiceAnalysis } : {}),
			};
			let run = await this.runWorker<SpeechJobOutput>(
				host,
				'transcribe',
				spec,
				scratch,
				[0, 1],
				env,
				gpuName,
			);
			if (!run.out) {
				const original = new JobError('TRANSCRIPTION_FAILED', run.error ?? 'jasper-speech failed', false);
				const from = gpuOfFailedRun(run, plan);
				if (!from || signal.aborted)
					throw signal.aborted ? new JobError('JOB_CANCELLED', 'Cancelled') : original;
				host.log(`GPU attempt failed (${run.error}); transcribing again on the CPU`);
				const cpuSpec: SpeechJobSpec = {
					...spec,
					device: { encoder: 'cpu', decoder: 'cpu', calibrate: null },
				};
				run = await this.runWorker<SpeechJobOutput>(
					host,
					'transcribe',
					cpuSpec,
					scratch,
					[0, 1],
					{},
					gpuName,
				);
				if (!run.out) throw original;
			}
			const out = run.out;
			return {
				model: modelId,
				language: out.language,
				words: out.words
					.filter((w) => typeof w.text === 'string' && Number.isFinite(w.start) && Number.isFinite(w.end))
					.map((w) => ({
						text: w.text,
						start: Math.round(w.start * FLICKS_PER_SAMPLE),
						end: Math.round(Math.max(w.start, w.end) * FLICKS_PER_SAMPLE),
						confidence: Number.isFinite(w.confidence) ? Math.min(1, Math.max(0, w.confidence)) : null,
					})),
				device: {
					encoder: out.device.encoder,
					decoder: out.device.decoder,
					label: deviceLabel(out.device, gpuName),
					threads: out.device.threads,
				},
				timings: out.timings,
				chunked: out.guard.chunked ?? null,
			};
		} finally {
			if (owned) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	/** The stream's voice analysis when it already exists (scoring does not start one). */
	private async existingVoiceAnalysis(
		record: MediaRecord,
		stream: number,
	): Promise<ScoreJobSpec['voiceAnalysis']> {
		const voice = this.voice();
		if (!voice) return undefined;
		try {
			if (!(await voice.readBytes(record, stream))) return undefined;
			return { path: voice.path(record, stream), fingerprint: record.fingerprint, stream };
		} catch {
			return undefined;
		}
	}

	/**
	 * Spec 14 TC-004: the voice analysis the worker refines word bounds against. When the stream has none yet, a
	 * `voice-analysis` job starts next to this one (≈ 9 s per hour of audio, so it is ready long before recognition
	 * ends); without the voice service the worker's energy VAD is used.
	 */
	private async voiceAnalysisFor(
		record: MediaRecord,
		mediaKey: string,
		streamIndex: number | null,
		ctx: JobContext,
	): Promise<SpeechJobSpec['voiceAnalysis']> {
		const voice = this.voice();
		if (!voice) return undefined;
		try {
			const stream = streamIndex ?? voice.target(mediaKey).streamIndex;
			if (!(await voice.readBytes(record, stream)))
				voice.submit(mediaKey, { streamIndex: stream }, ctx.job.origin);
			return { path: voice.path(record, stream), fingerprint: record.fingerprint, stream };
		} catch (e) {
			ctx.log(`voice analysis unavailable: ${e instanceof Error ? e.message : String(e)}`);
			return undefined;
		}
	}

	private async runWorker<T>(
		host: WorkerHost,
		mode: 'transcribe' | 'score',
		spec: SpeechJobSpec | ScoreJobSpec,
		scratch: string,
		span: [number, number],
		extraEnv: Record<string, string>,
		gpuName: string | null,
	): Promise<WorkerRun<T>> {
		const tag = mode === 'score' ? `score-${randomUUID().slice(0, 8)}` : 'speech';
		const specPath = join(scratch, `${tag}-spec.json`);
		const outPath = join(scratch, `${tag}-out.json`);
		await writeFile(specPath, JSON.stringify(spec));
		const cmd = speechCommand(this.env);
		const child = spawn(
			cmd.command,
			[...cmd.args, ...(mode === 'score' ? ['score'] : []), specPath, outPath],
			{
				stdio: ['ignore', 'pipe', 'pipe'],
				env: { ...process.env, ...extraEnv, OMP_NUM_THREADS: String(spec.threads ?? 1) },
			},
		);
		host.trackChild?.(child);
		const onAbort = () => void terminateTree(child, host.killGraceMs);
		if (host.killGraceMs !== undefined) {
			if (host.signal.aborted) onAbort();
			else host.signal.addEventListener('abort', onAbort, { once: true });
		}
		let stderr = '';
		let failure: string | null = null;
		let failureCode: string | null = null;
		let device: WorkerRun<T>['device'] = null;
		let deviceText = '';
		let buf = '';
		child.stdout.on('data', (c: Buffer) => {
			buf += c.toString();
			let nl = buf.indexOf('\n');
			while (nl >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				nl = buf.indexOf('\n');
				if (!line) continue;
				try {
					const ev = JSON.parse(line) as {
						type: string;
						fraction?: number;
						stage?: string;
						message?: string;
						code?: string;
						encoder?: ProviderId;
						decoder?: ProviderId;
						attempt?: number;
					};
					if (ev.type === 'progress' && typeof ev.fraction === 'number')
						host.progress(
							span[0] + (span[1] - span[0]) * ev.fraction,
							`${ev.stage ?? (mode === 'score' ? 'Scoring' : 'Transcribing')}${deviceText}`,
						);
					else if (ev.type === 'device' && ev.encoder && ev.decoder) {
						device = { encoder: ev.encoder, decoder: ev.decoder, attempt: ev.attempt ?? 1 };
						deviceText = ` · ${deviceLabel(device, gpuName)}`;
						host.log(
							`device: encoder ${PROVIDER_LABEL[ev.encoder]}, decoder ${PROVIDER_LABEL[ev.decoder]} (attempt ${device.attempt})`,
						);
					} else if (ev.type === 'error') {
						failure = ev.message ?? 'failed';
						if (typeof ev.code === 'string') failureCode = ev.code.slice(0, 64);
					}
				} catch {
					host.log(line);
				}
			}
		});
		child.stderr.on('data', (c: Buffer) => {
			const t = c.toString();
			if (stderr.length < 8000) stderr += t;
			host.log(t.trimEnd());
		});
		const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
			(resolve, reject) => {
				child.on('error', reject);
				child.on('close', (c, s) => resolve({ code: c, signal: s }));
			},
		).finally(() => host.signal.removeEventListener('abort', onAbort));
		if (host.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
		if (code !== 0)
			return {
				out: null,
				device,
				code: code === 4 ? (failureCode ?? 'SPEECH_REFUSED') : null,
				error:
					failure ??
					(stderr.trim().split('\n').pop() ||
						(signal ? `jasper-speech was killed (${signal})` : `jasper-speech exited with ${code}`)),
			};
		let out: T;
		try {
			out = JSON.parse(await readFile(outPath, 'utf8')) as T;
		} catch (e) {
			return {
				out: null,
				device,
				code: null,
				error: `jasper-speech wrote no readable result: ${e instanceof Error ? e.message : String(e)}`,
			};
		}
		return { out, device, error: null, code: null };
	}
}

/**
 * SG-003: the GPU provider of a failed first attempt that is worth one more run on the CPU, or null (CPU only, or
 * the worker's own CPU retry failed).
 */
function gpuOfFailedRun(
	run: { device: { encoder: ProviderId; decoder: ProviderId; attempt: number } | null },
	plan: { encoder: ProviderId; decoder: ProviderId; calibrate?: ProviderId | null },
): ProviderId | null {
	const gpuUsed = run.device
		? run.device.attempt === 1 && (run.device.encoder !== 'cpu' || run.device.decoder !== 'cpu')
		: [plan.encoder, plan.decoder, plan.calibrate ?? 'cpu'].some((p) => p !== 'cpu');
	if (!gpuUsed) return null;
	if (run.device && run.device.encoder !== 'cpu') return run.device.encoder;
	if (run.device && run.device.decoder !== 'cpu') return run.device.decoder;
	return plan.encoder !== 'cpu' ? plan.encoder : (plan.calibrate ?? plan.decoder);
}

/** The worker's scoring result has one entry per window and reading of the spec, with finite numbers. */
function validScoreOutput(out: ScoreJobOutput, spec: ScoreJobSpec): boolean {
	if (!out || !Array.isArray(out.windows) || out.windows.length !== spec.windows.length) return false;
	if (!out.device || !Array.isArray(out.device.fallbacks) || !out.profile || !out.timings) return false;
	return out.windows.every((w, i) => {
		const sw = spec.windows[i]!;
		if (!w || w.id !== sw.id || !Array.isArray(w.readings) || w.readings.length !== sw.readings.length)
			return false;
		return w.readings.every((r, j) => {
			const sr = sw.readings[j]!;
			return (
				r &&
				r.id === sr.id &&
				Number.isFinite(r.logprob) &&
				Number.isInteger(r.tokens) &&
				Array.isArray(r.words) &&
				r.words.length === sr.words.length &&
				r.words.every(
					(x) =>
						Number.isFinite(x.logprob) &&
						Number.isFinite(x.probability) &&
						Number.isInteger(x.tokens) &&
						Number.isFinite(x.start) &&
						Number.isFinite(x.end) &&
						x.start >= 0,
				)
			);
		});
	});
}

function pickOptions(o: TranscribeOptions): TranscribeOptions {
	const out: TranscribeOptions = {};
	if (o.model) out.model = o.model;
	if (o.language && o.language !== 'auto') out.language = o.language;
	if (o.task) out.task = o.task;
	if (o.speakerLabels) out.speakerLabels = true;
	if (o.speakerCount) out.speakerCount = o.speakerCount;
	if (o.maxSpeakers) out.maxSpeakers = o.maxSpeakers;
	if (o.beamSize) out.beamSize = o.beamSize;
	if (o.accuracy) out.accuracy = o.accuracy;
	if (o.device && o.device !== 'auto') out.device = o.device;
	if (o.verbatim) out.verbatim = true;
	if (o.initialPrompt?.trim()) out.initialPrompt = o.initialPrompt.trim();
	if (o.conditionOnPreviousText === false) out.conditionOnPreviousText = false;
	if (o.redecode === false) out.redecode = false;
	if (o.chunking === 'vad') out.chunking = 'vad';
	// SC-074: the glossary is part of the dedupe key (normalised, order kept: most frequent first)
	const glossary = normalizeGlossary(o.glossary);
	if (glossary.length) out.glossary = glossary;
	return out;
}

function specOptions(
	o: TranscribeOptions,
): Pick<
	SpeechJobSpec,
	| 'language'
	| 'task'
	| 'speakers'
	| 'verbatim'
	| 'initialPrompt'
	| 'conditionOnPreviousText'
	| 'redecode'
	| 'chunking'
	| 'glossary'
> {
	const glossary = normalizeGlossary(o.glossary);
	return {
		language: o.language && o.language !== 'auto' ? o.language : null,
		task: o.task ?? 'transcribe',
		speakers: {
			enabled: !!o.speakerLabels || !!o.speakerCount,
			...(o.speakerCount ? { count: o.speakerCount } : {}),
			...(o.maxSpeakers ? { max: o.maxSpeakers } : {}),
		},
		...(o.verbatim ? { verbatim: true } : {}),
		...(o.initialPrompt?.trim() ? { initialPrompt: o.initialPrompt.trim() } : {}),
		...(o.conditionOnPreviousText === false ? { conditionOnPreviousText: false } : {}),
		...(o.redecode === false ? { redecode: false } : {}),
		...(o.chunking === 'vad' ? { chunking: 'vad' as const } : {}),
		...(glossary.length ? { glossary } : {}),
	};
}

function hashOf(x: unknown): string {
	return createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 12);
}
