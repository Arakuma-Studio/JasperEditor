import type { EngineJob, SpeechModel, TranscriptionResult } from '@jasper/api';
import { EngineClient } from '@jasper/engine-client';
import { mgRegistry } from '@jasper/mg-templates';
import {
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	mixFingerprint,
	sequenceWords,
} from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { toasts } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AutoTranscribeHost, saveAuto } from '../src/speech/auto.tsx';
import { GenerateTranscriptDialog } from '../src/speech/GenerateTranscriptDialog.tsx';
import { transcriptionWatcher } from '../src/speech/jobs.ts';
import { defaultOptions, mixAttach, requestOptions } from '../src/speech/model.ts';
import { EngineProvider } from '../src/state/engine.tsx';

const KEY = 'mk_speech_1';
const F = 705_600_000;

function makeSession() {
	const ids = createCounterIdSource(3);
	const document = createEmptyProject({ ids, name: 'Speech test', preset: 'hd-1080p-25' });
	const session = new EditorSession({
		projectId: 'prj_speech',
		document,
		ctx: { ids, now: () => '2026-10-07T10:00:00.000Z', registries: defaultRegistries(mgRegistry) },
		coalesceWindowMs: 0,
	});
	const seqId = Object.keys(document.sequences)[0]!;
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{
				type: 'media.register',
				asset: {
					kind: 'audio',
					fingerprint: `q1:${'ab'.repeat(32)}`,
					originalName: 'interview.flac',
					sizeBytes: 1000,
					container: 'flac',
					probe: {
						durationFlicks: 20 * F,
						startTimecode: null,
						streams: [
							{
								index: 0,
								type: 'audio',
								codec: 'flac',
								sampleRate: 16000,
								channels: 1,
								channelLayout: 'mono',
							},
						],
						rotationDegrees: 0,
						hasAlpha: false,
						variableFrameRate: false,
					},
					locators: [{ type: 'engine-store', engineId: 'local', key: KEY }],
				},
				ref: '$m',
			},
			{
				type: 'clip.place',
				source: { mediaId: '$m' },
				sourceRange: { in: { seconds: 5 }, out: { seconds: 15 } },
				at: 25,
			},
		] as never[],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return { session, mediaId: r.refs.$m!, seqId };
}

function model(id: string, installed: boolean, extra: Partial<SpeechModel> = {}): SpeechModel {
	return {
		id,
		name: id === 'whisper-base' ? 'Whisper base' : 'Whisper tiny (English)',
		parameters: id === 'whisper-base' ? 74 : 39,
		multilingual: !id.endsWith('.en'),
		default: id === 'whisper-base',
		description: 'test',
		license: 'MIT (OpenAI Whisper code and weights); Hugging Face release Apache-2.0',
		licenseUrl: 'https://github.com/openai/whisper/blob/main/LICENSE',
		attribution: 'OpenAI Whisper (MIT)',
		sourceUrl: 'https://huggingface.co/onnx-community/whisper-base_timestamped',
		revision: '608c49e61301901684bc36cac8f74b95ff6b5a8e',
		sizeBytes: 293_625_004,
		installed,
		missingBytes: installed ? 0 : 293_625_004,
		...extra,
	};
}

type Call = { method: string; url: string; body: unknown };

function fakeEngine(state: { models: SpeechModel[]; job?: () => EngineJob }) {
	const calls: Call[] = [];
	const json = (b: unknown, status = 200) =>
		new Response(JSON.stringify(b), { status, headers: { 'x-jasper-api': '1' } });
	const jobOf = (id: string, kind: EngineJob['kind']): EngineJob => ({
		id,
		kind,
		title: kind,
		origin: { type: 'user' },
		state: 'queued',
		progress: 0,
		createdAt: '2026-10-07T10:00:00.000Z',
		priority: 'user',
		cpuSlots: 4,
	});
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		const method = init?.method ?? 'GET';
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ method, url, body });
		if (url === '/health') return json({ ok: true, version: '0.1.0', apiVersion: 1 });
		if (url === '/api/capabilities')
			return json({
				engine: { version: '0.1.0', apiVersion: 1, mode: 'dev', pathRegistration: true },
				media: { ffmpegVersion: '7.1', ffprobeVersion: '7.1', encoders: [], filters: [] },
				render: {
					native: true,
					remotionLocal: 'ready',
					remotionBinaries: { source: 'vendor', lgpl: true, license: 'lgpl', ffmpegVersion: null },
					fframes: 'unavailable',
				},
				fonts: { bundledCatalog: true, systemFonts: false, customUpload: false },
				limits: { maxUploadBytes: null, freeDiskBytes: 1, cpuCount: 8, maxJsonBodyBytes: 1 },
				features: {
					speech: {
						status: 'ready',
						runtime: 'onnxruntime',
						modelsInstalled: 1,
						defaultModel: 'whisper-base',
					},
				},
			});
		if (url === '/api/speech/models') return json({ models: state.models });
		const install = /^\/api\/speech\/models\/([^/]+)\/install$/.exec(url);
		if (install) {
			state.models = state.models.map((m) =>
				m.id === install[1] ? { ...m, installed: true, missingBytes: 0 } : m,
			);
			return json(jobOf('job_dl', 'model-download'));
		}

		if (url === `/api/media/${KEY}/transcribe`) return json(jobOf('job_tr', 'transcription'), 202);
		if (url === '/api/speech/transcribe-sequence') return json(jobOf('job_mix', 'transcription'), 202);
		if (url === '/api/jobs/job_dl')
			return json({ ...jobOf('job_dl', 'model-download'), state: 'succeeded', progress: 1 });
		if (url.startsWith('/api/jobs/') && state.job) return json(state.job());
		return json({ code: 'NOT_FOUND', message: url }, 404);
	}) as unknown as typeof fetch;
	return { client: new EngineClient({ baseUrl: '', fetch: fetchImpl }), calls };
}

function result(
	words: Array<[string, number, number]>,
	extra: Partial<TranscriptionResult> = {},
): TranscriptionResult {
	return {
		target: { type: 'media', mediaKey: KEY, streamIndex: 0 },
		model: 'whisper-base',
		language: 'en',
		languageProbability: 0.99,
		task: 'transcribe',
		duration: 20 * F,
		words: words.map(([text, a, b]) => ({
			text,
			start: Math.round(a * F),
			end: Math.round(b * F),
			confidence: 0.9,
			speaker: 'S1',
		})),
		speakers: { S1: { name: 'Speaker 1' } },
		segments: [],
		timings: { decodeMs: 1, loadMs: 1, transcribeMs: 1 },
		...extra,
	};
}

beforeEach(() => {
	toasts.dismissAll();
	toasts.clearLog();
});
afterEach(() => cleanup());

async function chooseOption(trigger: HTMLElement, name: string) {
	await act(async () => {
		fireEvent.keyDown(trigger, { key: 'Enter' });
	});
	const option = await screen.findByRole('option', { name });
	await act(async () => {
		fireEvent.keyDown(option, { key: 'Enter' });
	});
}

describe('Generate Transcript dialog', () => {
	it('sends model, language, translate and speaker options for the media of a sequence', async () => {
		const { session, seqId } = makeSession();
		const { client, calls } = fakeEngine({
			models: [model('whisper-base', true), model('whisper-tiny.en', false)],
		});
		let closed: unknown = 'open';
		render(
			<EngineProvider client={client}>
				<GenerateTranscriptDialog
					session={session}
					target={{ kind: 'sequence', sequenceId: seqId }}
					close={(r) => (closed = r)}
				/>
			</EngineProvider>,
		);
		await screen.findByRole('combobox', { name: 'Language' });
		await chooseOption(screen.getByRole('combobox', { name: 'Language' }), 'German');
		fireEvent.click(screen.getByRole('checkbox', { name: 'Translate to English' }));
		await chooseOption(screen.getByRole('combobox', { name: 'Speaker labels' }), 'Yes, separate speakers');
		await chooseOption(screen.getByRole('combobox', { name: 'Number of speakers' }), '2 speakers');
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Transcribe' }));
		});
		await waitFor(() => expect(closed).toBe(true));
		const post = calls.find((c) => c.url === `/api/media/${KEY}/transcribe`);
		expect(post?.body).toEqual({
			model: 'whisper-base',
			language: 'de',
			task: 'translate',
			speakerLabels: true,
			speakerCount: 2,
			projectId: 'prj_speech',
		});
		expect(transcriptionWatcher.list().some((w) => w.jobId === 'job_tr')).toBe(true);
	});

	it('shows the licence of a missing model and downloads it before transcribing', async () => {
		const { session, mediaId } = makeSession();
		const { client, calls } = fakeEngine({ models: [model('whisper-base', false)] });
		render(
			<EngineProvider client={client}>
				<GenerateTranscriptDialog
					session={session}
					target={{ kind: 'media', mediaIds: [mediaId] }}
					close={() => {}}
				/>
			</EngineProvider>,
		);
		await screen.findByTestId('speech-download');
		expect(screen.getByTestId('speech-licence-whisper-base').textContent).toContain('MIT');
		expect((screen.getByRole('button', { name: 'Transcribe' }) as HTMLButtonElement).disabled).toBe(true);
		await act(async () => {
			fireEvent.click(screen.getByTestId('speech-download-button'));
		});
		await waitFor(() => expect(screen.queryByTestId('speech-download')).toBeNull());
		expect(
			calls.some((c) => c.method === 'POST' && c.url === '/api/speech/models/whisper-base/install'),
		).toBe(true);
		expect((screen.getByRole('button', { name: 'Transcribe' }) as HTMLButtonElement).disabled).toBe(false);
	});

	it('English-only models fix the language and cannot translate', () => {
		expect(
			requestOptions({ ...defaultOptions('whisper-tiny.en'), language: 'de', task: 'translate' }, false),
		).toEqual({
			model: 'whisper-tiny.en',
			language: 'en',
		});
	});
});

describe('finished transcription jobs', () => {
	it('commit one "Generate Transcript" step the sequence transcript reads; undo removes it', async () => {
		const { session, mediaId, seqId } = makeSession();
		let state: EngineJob['state'] = 'running';
		const { client } = fakeEngine({
			models: [model('whisper-base', true)],
			job: () => ({
				id: 'job_t2',
				kind: 'transcription',
				title: 't',
				origin: { type: 'user' },
				state,
				progress: state === 'succeeded' ? 1 : 0.4,
				createdAt: '2026-10-07T10:00:00.000Z',
				priority: 'user',
				cpuSlots: 4,
				...(state === 'succeeded'
					? {
							result: result([
								['Hello', 6, 6.5],
								['there.', 6.6, 7],
								['Outside', 18, 18.5],
							]),
						}
					: {}),
			}),
		});
		transcriptionWatcher.watch({
			jobId: 'job_t2',
			engine: client,
			session,
			target: { type: 'media', mediaId, name: 'interview.flac' },
			replace: true,
		});
		await transcriptionWatcher.tick();
		expect(transcriptionWatcher.list().find((w) => w.jobId === 'job_t2')?.progress).toBe(0.4);
		state = 'succeeded';
		await transcriptionWatcher.tick();
		const doc = session.getCommitted();
		const t = Object.values(doc.transcripts)[0]!;
		expect(t.words.map((w) => w.text)).toEqual(['Hello', 'there.', 'Outside']);
		expect(t.model).toBe('whisper-base');
		// the clip plays media 5–15 s from sequence 1 s: "Hello" at 6 s of media is heard at 2 s
		const words = sequenceWords(doc, doc.sequences[seqId]!);
		expect(words.map((w) => [w.text, w.start / F])).toEqual([
			['Hello', 2],
			['there.', 2.6],
		]);
		expect(session.getState().history.entries.at(-1)?.label).toBe('Generate Transcript');
		session.undo();
		expect(Object.keys(session.getCommitted().transcripts)).toEqual([]);
	});

	it('a sequence-mix result goes to the clip media in media time, and is refused after an edit', () => {
		const { session, mediaId, seqId } = makeSession();
		const doc = session.getCommitted();
		const res = result([['mixed', 1.5, 2]], {
			target: {
				type: 'sequence',
				sequenceId: seqId,
				range: { startFrame: 0, endFrame: 275 },
				mixHash: mixFingerprint(doc, seqId),
			},
		});
		const built = mixAttach(doc, res, true);
		if ('error' in built) throw new Error(built.error);
		expect(built.commands).toHaveLength(1);
		const cmd = built.commands[0] as unknown as {
			mediaId: string;
			words: Array<{ start: number }>;
			coverage: number[][];
		};
		expect(cmd.mediaId).toBe(mediaId);
		expect(cmd.words[0]!.start).toBe(5.5 * F);
		expect(cmd.coverage).toEqual([[5 * F, 15 * F]]);
		session.apply({
			label: 'move',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{ type: 'clip.move', clipIds: Object.keys(doc.sequences[seqId]!.clips), deltaFrames: 10 },
			] as never[],
		});
		const after = mixAttach(session.getCommitted(), res, true);
		expect('error' in after && after.error).toMatch(/changed/);
	});
});

describe('automatic transcription on import', () => {
	it('transcribes newly imported media with sound when enabled (not on undo/redo)', async () => {
		const { session, seqId } = makeSession();
		const { client, calls } = fakeEngine({ models: [model('whisper-base', true)] });
		saveAuto({ enabled: true, model: 'whisper-base', language: 'fr' });
		await act(async () => {
			render(
				<EngineProvider client={client}>
					<AutoTranscribeHost session={session} />
				</EngineProvider>,
			);
		});
		const asset = JSON.parse(JSON.stringify(Object.values(session.getCommitted().media)[0])) as Record<
			string,
			unknown
		>;
		delete asset.id;
		asset.fingerprint = `q1:${'cd'.repeat(32)}`;
		const r = session.apply({
			label: 'Import',
			origin: 'user',
			sequenceId: seqId,
			commands: [{ type: 'media.register', asset }] as never[],
		});
		expect(r.ok).toBe(true);
		await waitFor(() =>
			expect(
				calls.filter((c) => c.method === 'POST' && c.url === `/api/media/${KEY}/transcribe`),
			).toHaveLength(1),
		);
		const post = calls.find((c) => c.url === `/api/media/${KEY}/transcribe`)!;
		expect(post.body).toMatchObject({ model: 'whisper-base', language: 'fr' });
		await act(async () => {
			session.undo();
			session.redo();
		});
		expect(calls.filter((c) => c.url === `/api/media/${KEY}/transcribe`)).toHaveLength(1);
		saveAuto({ enabled: false, model: 'whisper-base', language: 'auto' });
	});
});
