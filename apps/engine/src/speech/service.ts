// Speech-to-text on the engine (wp speech): `transcription` jobs run the `jasper-speech` child process (Whisper on
// ONNX Runtime, worker/) on one audio stream of a media, or on the mixed audio of a sequence (the export's offline
// mixer, `renderMixdown`, mono 16 kHz). Results carry words in flicks (media time / sequence time); the client
// commits them with `transcript.attach` (one undo step). Models come from the processing-model catalogue (`speech`)
// and install through its `model-download` job.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type {
	EngineJob,
	M2Features,
	TranscribeMediaRequest,
	TranscribeOptions,
	TranscribeSequenceRequest,
	TranscriptionResult,
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
import type { CoreServices } from '../tools/services.ts';
import { speechCommand } from './entry.ts';
import { SpeechModelError, type SpeechModelStore } from './models.ts';
import type { SpeechJobOutput, SpeechJobSpec } from './worker/run.ts';

/** Flicks per 16 kHz sample (exact). */
export const FLICKS_PER_SAMPLE = FLICKS_PER_SECOND / 16_000;

type MediaInput = {
	target: 'media';
	mediaKey: string;
	streamIndex: number | null;
	options: TranscribeOptions;
};
type SequenceInput = { target: 'sequence'; request: TranscribeSequenceRequest };

export class SpeechService {
	private ortOk: boolean | null = null;

	constructor(
		private readonly core: CoreServices,
		private readonly processing: ProcessingService,
		private readonly env: Record<string, string | undefined> = process.env,
	) {}

	get models(): SpeechModelStore {
		return this.processing.speechModels;
	}

	registerRunners(): void {
		this.core.queue.registerRunner('transcription', (ctx) => this.run(ctx));
	}

	/** ONNX Runtime loads in this installation (the worker uses the same module). */
	ortAvailable(): boolean {
		if (this.ortOk === null) {
			try {
				createRequire(import.meta.url).resolve('onnxruntime-node');
				this.ortOk = true;
			} catch {
				this.ortOk = false;
			}
		}
		return this.ortOk;
	}

	async features(): Promise<NonNullable<M2Features['speech']>> {
		const installed = (await this.models.list()).filter((m) => m.installed).length;
		const reasons: string[] = [];
		if (!this.ortAvailable()) reasons.push('ONNX Runtime (onnxruntime-node) is not installed');
		if (!this.core.ffmpeg.bins.ffmpeg) reasons.push('ffmpeg was not found');
		if (!this.models.entries.length) reasons.push('the model catalogue has no speech models');
		return {
			status: reasons.length ? 'unavailable' : 'ready',
			...(reasons.length ? { reason: reasons.join('; ') } : {}),
			runtime: 'onnxruntime',
			modelsInstalled: installed,
			defaultModel: this.models.defaultId(),
		};
	}

	// ------------------------------------------------------------------ submit

	/** Validates the model choice (sync errors become HTTP 4xx). */
	private async checkModel(o: TranscribeOptions): Promise<string> {
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
		if (!(await this.models.installed(e)))
			throw new JobError(
				'SPEECH_MODEL_NOT_INSTALLED',
				`The speech model ${e.name} is not downloaded. Download it in Preferences ▸ Transcription (or install_speech_model).`,
				false,
			);
		return id;
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
		const model = await this.checkModel(req);
		const options: TranscribeOptions = { ...pickOptions(req), model };
		const input: MediaInput = { target: 'media', mediaKey, streamIndex: stream, options };
		return this.core.queue.submit({
			kind: 'transcription',
			title: `Transcribe – ${record.originalName}`,
			priority: 'user',
			cpuSlots: 4,
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
		const model = await this.checkModel(req);
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
			cpuSlots: 4,
			minSlots: 1,
			origin,
			...(projectId ? { projectId } : {}),
			dedupeKey: `transcribe-seq:${req.sequenceId}:${mixFingerprint(planned.document, planned.sequenceId)}:${planned.range.start}-${planned.range.end}:${hashOf(pickOptions(request))}`,
			input: { target: 'sequence', request } satisfies SequenceInput,
			stage: 'Queued',
		});
	}

	private async plan(req: TranscribeSequenceRequest): Promise<PlannedExport> {
		try {
			return await this.core.exports.plan({
				envelope: req.envelope as never,
				sequenceId: req.sequenceId,
				settings: {
					sequenceId: req.sequenceId,
					range: req.range === 'in-out' ? { type: 'in-out' } : { type: 'entire' },
					container: 'mp4',
					engine: 'auto',
					destination: { type: 'download' },
				},
			});
		} catch (e) {
			if (e instanceof PlanError) throw new JobError(e.code, e.message, false, e.detail);
			throw e;
		}
	}

	// ------------------------------------------------------------------ run

	private async run(ctx: JobContext): Promise<TranscriptionResult> {
		const input = ctx.input as MediaInput | SequenceInput;
		const options = input.target === 'media' ? input.options : pickOptions(input.request);
		const modelId = options.model ?? this.models.defaultId();
		let modelDir: string;
		try {
			modelDir = (await this.models.resolve(modelId)).dir;
		} catch (e) {
			if (e instanceof SpeechModelError) throw new JobError(e.code, e.message, false);
			throw e;
		}
		const ffmpeg = this.core.ffmpeg.bins.ffmpeg;
		if (!ffmpeg) throw new JobError('BINARY_MISSING', 'ffmpeg was not found', false);
		const scratch = await ctx.scratchDir();
		let spec: SpeechJobSpec;
		let target: TranscriptionResult['target'];
		let offsetFlicks = 0;
		let span: [number, number] = [0, 1];
		if (input.target === 'media') {
			const record = this.core.registry.get(input.mediaKey);
			if (!record) throw new JobError('ASSET_NOT_FOUND', 'The media is no longer registered', false);
			const file = await this.core.registry.resolvePath(input.mediaKey);
			if (!file) throw new JobError('MEDIA_OFFLINE', 'The media file is not available on the engine', false);
			spec = {
				modelDir,
				modelId,
				input: { path: file, ffmpeg, ...(input.streamIndex !== null ? { stream: input.streamIndex } : {}) },
				...specOptions(options),
				threads: Math.max(1, ctx.slots),
			};
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
			span = [0.15, 1];
			spec = {
				modelDir,
				modelId,
				input: { path: mix.path, ffmpeg },
				...specOptions(options),
				threads: Math.max(1, ctx.slots),
			};
			target = {
				type: 'sequence',
				sequenceId: planned.sequenceId,
				range: { startFrame: planned.range.start, endFrame: planned.range.end },
				// the fingerprint of the document the client sent, so it can tell whether the sequence changed since
				mixHash: mixFingerprint(req.envelope.document as ProjectDocument, req.sequenceId),
			};
		}
		const out = await this.runWorker(ctx, spec, scratch, span);
		const speakers: Record<string, { name: string }> = {};
		for (let i = 0; i < out.speakers; i++) speakers[`S${i + 1}`] = { name: `Speaker ${i + 1}` };
		return {
			target,
			model: modelId,
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
				start: s.start + offsetFlicks / FLICKS_PER_SECOND,
				end: s.end + offsetFlicks / FLICKS_PER_SECOND,
				text: s.text,
			})),
			timings: out.timings,
		};
	}

	private async runWorker(
		ctx: JobContext,
		spec: SpeechJobSpec,
		scratch: string,
		span: [number, number],
	): Promise<SpeechJobOutput> {
		const specPath = join(scratch, 'speech-spec.json');
		const outPath = join(scratch, 'speech-out.json');
		await writeFile(specPath, JSON.stringify(spec));
		const cmd = speechCommand(this.env);
		const child = spawn(cmd.command, [...cmd.args, specPath, outPath], {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, OMP_NUM_THREADS: String(spec.threads ?? 1) },
		});
		ctx.trackChild(child);
		let stderr = '';
		let failure: string | null = null;
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
					};
					if (ev.type === 'progress' && typeof ev.fraction === 'number')
						ctx.progress(span[0] + (span[1] - span[0]) * ev.fraction, { stage: ev.stage ?? 'Transcribing' });
					else if (ev.type === 'error') failure = ev.message ?? 'failed';
				} catch {
					ctx.log(line);
				}
			}
		});
		child.stderr.on('data', (c: Buffer) => {
			const t = c.toString();
			if (stderr.length < 8000) stderr += t;
			ctx.log(t.trimEnd());
		});
		const code = await new Promise<number | null>((resolve, reject) => {
			child.on('error', reject);
			child.on('close', (c) => resolve(c));
		});
		if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
		if (code !== 0)
			throw new JobError(
				'TRANSCRIPTION_FAILED',
				failure ?? (stderr.trim().split('\n').pop() || `jasper-speech exited with ${code}`),
				false,
			);
		return JSON.parse(await readFile(outPath, 'utf8')) as SpeechJobOutput;
	}
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
	return out;
}

function specOptions(
	o: TranscribeOptions,
): Pick<SpeechJobSpec, 'language' | 'task' | 'speakers' | 'beamSize'> {
	return {
		...(o.beamSize ? { beamSize: o.beamSize } : {}),
		language: o.language && o.language !== 'auto' ? o.language : null,
		task: o.task ?? 'transcribe',
		speakers: {
			enabled: !!o.speakerLabels || !!o.speakerCount,
			...(o.speakerCount ? { count: o.speakerCount } : {}),
			...(o.maxSpeakers ? { max: o.maxSpeakers } : {}),
		},
	};
}

function hashOf(x: unknown): string {
	return createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 12);
}
