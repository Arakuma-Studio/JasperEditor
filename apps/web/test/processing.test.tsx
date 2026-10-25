import type { EngineJob, ProcessResult } from '@jasper/api';
import { EngineClient } from '@jasper/engine-client';
import { mgRegistry } from '@jasper/mg-templates';
import {
	type Clip,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type MediaAsset,
} from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { toasts } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/commands/process.ts';
import { switchMediaVersionInteractive } from '../src/processing/actions.ts';
import { commitProcessed, processWatcher, startProcessing } from '../src/processing/jobs.ts';
import { MediaVersionSection } from '../src/processing/MediaVersionSection.tsx';
import { ProcessingPreferencesPage } from '../src/processing/PreferencesPage.tsx';
import { ProcessDialog } from '../src/processing/ProcessDialog.tsx';
import { ReplaceFootageDialog } from '../src/processing/ReplaceFootageDialog.tsx';
import { EngineProvider } from '../src/state/engine.tsx';

const KEY = 'mk_source_1';
const FP = `q1:${'ab'.repeat(32)}`;

function probe(width: number, height: number, codec = 'h264') {
	return {
		durationFlicks: 6 * 705_600_000,
		startTimecode: null,
		streams: [
			{
				index: 0,
				type: 'video' as const,
				codec,
				width,
				height,
				pixelAspect: { num: 1, den: 1 },
				frameRate: { num: 25, den: 1 },
				pixelFormat: 'yuv420p',
				bitDepth: 8,
				color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' as const },
				browserDecodable: true,
			},
			{
				index: 1,
				type: 'audio' as const,
				codec: 'aac',
				sampleRate: 48000,
				channels: 2,
				channelLayout: 'stereo',
			},
		],
		rotationDegrees: 0 as const,
		hasAlpha: false,
		variableFrameRate: false,
	};
}

function makeSession(): { session: EditorSession; mediaId: string; videoClip: string; audioClip: string } {
	const ids = createCounterIdSource(7);
	const document = createEmptyProject({ ids, name: 'Processing test', preset: 'hd-1080p-25' });
	const session = new EditorSession({
		projectId: 'prj_test',
		document,
		ctx: { ids, now: () => '2026-10-01T10:00:00.000Z', registries: defaultRegistries(mgRegistry) },
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
					kind: 'video',
					fingerprint: FP,
					originalName: 'clip-b.mp4',
					sizeBytes: 1000,
					container: 'mov,mp4',
					probe: probe(1280, 720),
					locators: [{ type: 'engine-store', engineId: 'local', key: KEY }],
				},
				ref: '$m',
			},
			{ type: 'clip.place', source: { mediaId: '$m' }, at: 0 },
		] as never[],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const mediaId = r.refs.$m!;
	const clips = Object.values(session.getCommitted().sequences[seqId]!.clips) as Clip[];
	return {
		session,
		mediaId,
		videoClip: clips.find((c) => c.kind === 'video')!.id,
		audioClip: clips.find((c) => c.kind === 'audio')!.id,
	};
}

function result(): ProcessResult {
	return {
		registered: {
			mediaKey: 'mk_processed_1',
			fingerprint: `q1:${'cd'.repeat(32)}`,
			kind: 'video',
			originalName: 'clip-b [Denoised].mov',
			sizeBytes: 5000,
			container: 'mov,mp4,m4a,3gp,3g2,mj2',
			probe: probe(1280, 720, 'prores'),
			locators: [{ type: 'path', path: '/tmp/clip-b.processed.mov', relativeToProject: null }],
			browserPlayable: 'no',
		} as unknown as ProcessResult['registered'],
		fromMediaKey: KEY,
		recipeVersion: 1,
		recipeHash: 'f'.repeat(64),
		executor: 'local',
		notes: [],
	};
}

const PROCESSING_FEATURES = {
	stabilize: 'vidstab',
	smoothPath: 'ready',
	denoise: ['atadenoise', 'fftdnoiz', 'nlmeans'],
	deblock: true,
	dejudder: 'ready',
	upscale: { runtime: 'onnxruntime', providers: ['cpu'], modelsInstalled: 1 },
	remote: { configured: false, lastProbe: null },
};

const MODEL = {
	id: 'span-2x',
	name: 'SPAN 2×',
	scale: 2,
	architecture: 'SPAN',
	license: 'CC-BY-4.0',
	attribution: 'weights by Philip Hofmann (CC BY 4.0)',
	sourceUrl: 'https://example.invalid/span',
	downloadUrl: null,
	sha256: '0'.repeat(64),
	sizeBytes: 1_656_884,
	installed: true,
};

type Call = { method: string; url: string; body: unknown };

function fakeEngine(over: { onCall?(c: Call): Response | undefined; job?: () => EngineJob } = {}) {
	const calls: Call[] = [];
	const json = (b: unknown, status = 200) =>
		new Response(JSON.stringify(b), { status, headers: { 'x-jasper-api': '1' } });
	let settings: unknown = { remote: null };
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		const method = init?.method ?? 'GET';
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		const call = { method, url, body };
		calls.push(call);
		const custom = over.onCall?.(call);
		if (custom) return custom;
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
				features: { processing: PROCESSING_FEATURES },
			});
		if (url === '/api/processing/models') return json({ models: [MODEL] });
		if (url === '/api/settings/processing' && method === 'GET') return json(settings);
		if (url === '/api/settings/processing' && method === 'PUT') {
			settings = body;
			return json(body);
		}
		if (url === `/api/media/${KEY}/process`)
			return json({
				id: 'job_1',
				kind: 'process',
				title: 'Process',
				origin: { type: 'user' },
				state: 'queued',
				progress: 0,
				createdAt: '2026-10-01T10:00:00.000Z',
				priority: 'user',
				cpuSlots: 4,
			});
		if (url.startsWith('/api/jobs/') && over.job) return json(over.job());
		return json({ code: 'NOT_FOUND', message: url }, 404);
	}) as unknown as typeof fetch;
	return { client: new EngineClient({ baseUrl: '', fetch: fetchImpl }), calls };
}

function job(state: EngineJob['state'], extra: Partial<EngineJob> = {}): EngineJob {
	return {
		id: 'job_1',
		kind: 'process',
		title: 'Process',
		origin: { type: 'user' },
		state,
		progress: state === 'succeeded' ? 1 : 0.5,
		createdAt: '2026-10-01T10:00:00.000Z',
		priority: 'user',
		cpuSlots: 4,
		dedupeKey: 'process:abc:fff',
		...extra,
	};
}

beforeEach(() => {
	toasts.dismissAll();
	toasts.clearLog();
});
afterEach(async () => {
	cleanup();
	// Finish outstanding HTTP jobs and expire retry memory through the production polling path.
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
	await processWatcher.tick();
	vi.useRealTimers();
});

describe('Process Clip dialog (PRU-001)', () => {
	it('builds the ProcessRequest from the checked steps and queues the job with the projectId', async () => {
		const { session, mediaId, videoClip } = makeSession();
		const { client, calls } = fakeEngine();
		let closed: unknown = 'open';
		render(
			<EngineProvider client={client}>
				<ProcessDialog
					session={session}
					mediaId={mediaId}
					clipIds={[videoClip]}
					replaceDefault
					origin="clip"
					close={(r) => {
						closed = r;
					}}
				/>
			</EngineProvider>,
		);
		await waitFor(() => expect(calls.some((c) => c.url === '/api/processing/models')).toBe(true));
		const start = screen.getByRole('button', { name: 'Start' });
		expect((start as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(screen.getByRole('checkbox', { name: 'Denoise' }));
		fireEvent.click(within(screen.getByTestId('step-denoise')).getByRole('button', { name: 'Strong' }));
		fireEvent.click(screen.getByRole('checkbox', { name: 'Deblock' }));

		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Start' }));
		});
		await waitFor(() => expect(closed).toBe(true));
		const post = calls.find((c) => c.method === 'POST' && c.url === `/api/media/${KEY}/process`);
		expect(post?.body).toEqual({
			projectId: 'prj_test',
			steps: [
				{ op: 'deblock', filter: 'weak' },
				{ op: 'denoise', method: 'atadenoise', strength: 0.8 },
			],
			executor: 'auto',
		});
	});

	it('sends Smooth path locks and keep-borders options to the engine', async () => {
		const { session, mediaId, videoClip } = makeSession();
		const { client, calls } = fakeEngine();
		render(
			<EngineProvider client={client}>
				<ProcessDialog
					session={session}
					mediaId={mediaId}
					clipIds={[videoClip]}
					replaceDefault
					origin="clip"
					close={() => {}}
				/>
			</EngineProvider>,
		);
		await waitFor(() => expect(calls.some((c) => c.url === '/api/processing/models')).toBe(true));
		fireEvent.click(screen.getByRole('checkbox', { name: 'Stabilize' }));
		const trigger = screen.getByRole('combobox', { name: 'Stabilize method' });
		await act(async () => {
			fireEvent.keyDown(trigger, { key: 'Enter' });
		});
		const option = await screen.findByRole('option', { name: 'Smooth path (one even move)' });
		await act(async () => {
			fireEvent.keyDown(option, { key: 'Enter' });
		});
		fireEvent.click(screen.getByRole('checkbox', { name: 'Vertical (no tilt)' }));
		fireEvent.click(
			within(screen.getByTestId('step-stabilize')).getByRole('button', { name: 'Keep (black edges)' }),
		);
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Start' }));
		});
		const post = calls.find((c) => c.method === 'POST' && c.url === `/api/media/${KEY}/process`);
		expect((post?.body as { steps?: unknown[] } | undefined)?.steps).toEqual([
			{
				op: 'stabilize',
				method: 'smoothpath',
				smoothing: 30,
				borders: 'keep',
				lockVertical: true,
				lockRotation: false,
			},
		]);
	});

	it('Smooth path keeps the frame cropped by default and sends its zoom cap and locks (S07:PST-005)', async () => {
		const { session, mediaId, videoClip } = makeSession();
		const { client, calls } = fakeEngine();
		render(
			<EngineProvider client={client}>
				<ProcessDialog
					session={session}
					mediaId={mediaId}
					clipIds={[videoClip]}
					replaceDefault
					origin="clip"
					close={() => {}}
				/>
			</EngineProvider>,
		);
		await waitFor(() => expect(calls.some((c) => c.url === '/api/processing/models')).toBe(true));
		fireEvent.click(screen.getByRole('checkbox', { name: 'Stabilize' }));
		await act(async () => {
			fireEvent.keyDown(screen.getByRole('combobox', { name: 'Stabilize method' }), { key: 'Enter' });
		});
		const option = await screen.findByRole('option', { name: 'Smooth path (one even move)' });
		await act(async () => {
			fireEvent.keyDown(option, { key: 'Enter' });
		});
		fireEvent.click(screen.getByRole('checkbox', { name: 'Vertical (no tilt)' }));
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Start' }));
		});
		const post = calls.find((c) => c.method === 'POST' && c.url === `/api/media/${KEY}/process`);
		expect((post?.body as { steps?: unknown[] } | undefined)?.steps).toEqual([
			{
				op: 'stabilize',
				method: 'smoothpath',
				smoothing: 30,
				borders: 'crop',
				lockVertical: true,
				lockRotation: false,
				maxZoom: 112,
			},
		]);
	});

	it('shows the model licence and attribution for upscale', async () => {
		const { session, mediaId } = makeSession();
		const { client } = fakeEngine();
		render(
			<EngineProvider client={client}>
				<ProcessDialog
					session={session}
					mediaId={mediaId}
					clipIds={[]}
					replaceDefault={false}
					origin="project"
					close={() => {}}
				/>
			</EngineProvider>,
		);
		await act(async () => {
			fireEvent.click(screen.getByRole('checkbox', { name: 'Upscale' }));
		});
		await waitFor(() =>
			expect(screen.getByTestId('process-model-license').textContent).toContain('CC-BY-4.0'),
		);
		expect(screen.getByTestId('process-model-license').textContent).toContain('Philip Hofmann');
	});
});

describe('finished process jobs (PRU-002)', () => {
	it('commits media.derive with replaceInClips as ONE "Process Clip" entry; one undo restores the original', async () => {
		const { session, mediaId, videoClip, audioClip } = makeSession();
		const { client } = fakeEngine({ job: () => job('succeeded', { result: result() }) });
		const before = session.getState().history.entries.length;
		await startProcessing({
			engine: client,
			session,
			mediaId,
			steps: [{ op: 'denoise', method: 'atadenoise', strength: 0.5 }],
			executor: 'auto',
			replaceInClips: [videoClip, audioClip],
		});
		await processWatcher.tick();
		const h = session.getState().history;
		expect(h.entries.length).toBe(before + 1);
		const doc = session.getCommitted();
		const seq = Object.values(doc.sequences)[0]!;
		const v = seq.clips[videoClip] as Clip & { mediaId: string };
		expect(v.mediaId).not.toBe(mediaId);
		const processed = doc.media[v.mediaId] as MediaAsset;
		expect(processed.derivation).toMatchObject({
			fromMediaId: mediaId,
			recipe: { op: 'process', steps: [{ op: 'denoise' }] },
			recipeHash: 'f'.repeat(64),
		});
		expect(processed.locators[0]).toEqual({ type: 'engine-store', engineId: 'local', key: 'mk_processed_1' });
		expect((seq.clips[audioClip] as Clip & { mediaId: string }).mediaId).toBe(mediaId);
		expect(toasts.getState().log.at(-1)).toMatchObject({ kind: 'success' });

		act(() => {
			session.undo();
		});
		const after = session.getCommitted();
		expect((Object.values(after.sequences)[0]!.clips[videoClip] as Clip & { mediaId: string }).mediaId).toBe(
			mediaId,
		);
		expect(Object.keys(after.media)).toEqual([mediaId]);
	});

	it('a failed remote job preserves the clip and requires explicit local retry', async () => {
		const { session, mediaId, videoClip } = makeSession();
		const { client, calls } = fakeEngine({
			job: () =>
				job('failed', {
					stage: 'Remote · processing',
					error: { code: 'REMOTE_CONNECTION_LOST', message: 'Lost the connection to gpu', retryable: true },
				}),
		});
		await startProcessing({
			engine: client,
			session,
			mediaId,
			steps: [{ op: 'upscale', model: 'span-2x', scale: 2 }],
			executor: 'remote',
			replaceInClips: [videoClip],
		});
		await processWatcher.tick();
		const n = toasts.getState().log.at(-1)!;
		expect(n.kind).toBe('error');
		expect(
			session.getCommitted().sequences[session.getState().activeSequenceId!]!.clips[videoClip],
		).toMatchObject({ mediaId });
		expect(n.detail).toContain('REMOTE_CONNECTION_LOST');
		expect(
			calls.filter((c) => c.url.endsWith('/process')).map((c) => (c.body as { executor: string }).executor),
		).toEqual(['remote']);
		n.actions!.find((action) => action.label === 'Run on This Computer')!.run!();
		await waitFor(() =>
			expect(
				calls.filter((c) => c.url.endsWith('/process')).map((c) => (c.body as { executor: string }).executor),
			).toEqual(['remote', 'local']),
		);
	});
});

describe('Media Version section and processed badges (PRU-003)', () => {
	function withVersion() {
		const s = makeSession();
		const r = commitProcessed(s.session, {
			fromMediaId: s.mediaId,
			steps: [{ op: 'denoise', method: 'atadenoise', strength: 0.5 }],
			result: result(),
			replaceInClips: [],
		});
		if (!r.ok) throw new Error(r.message);
		return { ...s, processedId: r.mediaId! };
	}

	it('switches to a processed version through Media Version and restores it with one undo', async () => {
		const { session, videoClip, mediaId, processedId } = withVersion();
		const clip = () =>
			Object.values(session.getCommitted().sequences)[0]!.clips[videoClip] as Clip & { mediaId: string };
		const seqId = Object.keys(session.getCommitted().sequences)[0]!;
		const { rerender } = render(
			<SessionProvider session={session}>
				<MediaVersionSection session={session} clips={[clip()]} frame={0} sequenceId={seqId} />
			</SessionProvider>,
		);
		const trigger = screen.getByRole('combobox', { name: 'Media version' });
		const entries = session.getState().history.entries.length;
		await act(async () => {
			fireEvent.keyDown(trigger, { key: 'Enter' });
		});
		const option = await screen.findByRole('option', { name: 'Denoised' });
		await act(async () => {
			fireEvent.keyDown(option, { key: 'Enter' });
		});
		expect(clip().mediaId).toBe(processedId);
		expect(session.getState().history.entries.length).toBe(entries + 1);
		rerender(
			<SessionProvider session={session}>
				<MediaVersionSection session={session} clips={[clip()]} frame={0} sequenceId={seqId} />
			</SessionProvider>,
		);
		act(() => {
			session.undo();
		});
		expect(clip().mediaId).toBe(mediaId);
	});
});

describe('Preferences ▸ Processing (PRU-004)', () => {
	it('saves the remote settings, shows engine validation errors and renders a probe result', async () => {
		const { client, calls } = fakeEngine({
			onCall: (c) => {
				const json = (b: unknown, status = 200) =>
					new Response(JSON.stringify(b), { status, headers: { 'x-jasper-api': '1' } });
				if (
					c.url === '/api/settings/processing' &&
					c.method === 'PUT' &&
					(c.body as { remote?: { identityFile?: string } }).remote?.identityFile
				)
					return json(
						{ code: 'INVALID_SETTINGS', message: 'The identity file /nope does not exist', retryable: false },
						400,
					);
				if (c.url === '/api/processing/remote/probe') {
					return json({
						ok: false,
						message: 'Cannot connect to me@gpu-box: Connection refused',
						node: null,
						ffmpeg: null,
						gpu: null,
						onnxProviders: [],
						runtimeReady: false,
					});
				}
				return undefined;
			},
		});
		render(
			<EngineProvider client={client}>
				<ProcessingPreferencesPage />
			</EngineProvider>,
		);
		await waitFor(() => expect((screen.getByTestId('remote-host') as HTMLInputElement).disabled).toBe(false));
		fireEvent.change(screen.getByTestId('remote-host'), { target: { value: 'gpu-box' } });
		fireEvent.change(screen.getByTestId('remote-user'), { target: { value: 'me' } });
		fireEvent.change(screen.getByTestId('remote-dir'), { target: { value: '/home/me/jasper' } });
		fireEvent.change(screen.getByTestId('remote-identity'), { target: { value: '/nope' } });
		await act(async () => {
			fireEvent.click(screen.getByTestId('prefs-processing-save'));
		});
		await waitFor(() =>
			expect(screen.getByTestId('prefs-processing-status').textContent).toContain(
				'identity file /nope does not exist',
			),
		);
		fireEvent.change(screen.getByTestId('remote-identity'), { target: { value: '' } });
		await act(async () => {
			fireEvent.click(screen.getByTestId('prefs-processing-save'));
		});
		await waitFor(() =>
			expect(screen.getByTestId('prefs-processing-status').getAttribute('role')).toBe('status'),
		);
		const put = calls.filter((c) => c.method === 'PUT').at(-1);
		expect(put?.body).toEqual({
			remote: {
				enabled: false,
				host: 'gpu-box',
				port: 22,
				user: 'me',
				identityFile: null,
				remoteDir: '/home/me/jasper',
				useFor: ['dejudder', 'upscale'],
				strictHostKeyChecking: 'accept-new',
			},
		});
		await act(async () => {
			fireEvent.click(screen.getByTestId('remote-test'));
		});
		await waitFor(() => expect(screen.getByTestId('probe-result').getAttribute('data-ok')).toBe('false'));
		expect(screen.getByTestId('probe-message').textContent).toContain('Connection refused');
	});
});

describe('source ranges in the UI (S07:PRU-005, PRC-015…018)', () => {
	const F25 = 28_224_000;

	/** makeSession + a second clip showing source frames 50…79 at frame 200 (the first shows all 150). */
	function withShortClip() {
		const s = makeSession();
		const seqId = Object.keys(s.session.getCommitted().sequences)[0]!;
		const r = s.session.apply({
			label: 'place short',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{
					type: 'clip.place',
					source: { mediaId: s.mediaId },
					at: 200,
					sourceRange: { in: { sourceFrames: 50 }, out: { sourceFrames: 80 } },
					tracks: { video: 'V1' },
					audio: false,
					ref: '$c',
				},
			] as never[],
		});
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		return { ...s, seqId, shortClip: r.refs.$c! };
	}

	const clipOf = (session: EditorSession, id: string) =>
		Object.values(session.getCommitted().sequences)[0]!.clips[id] as Clip & { mediaId: string };

	function rangedResult(start: number, end: number): ProcessResult {
		const r = result();
		const p = probe(1280, 720, 'prores');
		p.durationFlicks = (end - start) * F25;
		return {
			...r,
			registered: {
				...r.registered,
				probe: p,
				originalName: `clip-b [Denoised · frames ${start}–${end - 1}].mov`,
			},
			range: { startFrame: start, endFrame: end },
		};
	}

	it('Process Clip… defaults to the clip range + 12 handles and POSTs it; Whole media does not', async () => {
		const { session, mediaId, shortClip } = withShortClip();
		const { client, calls } = fakeEngine();
		render(
			<EngineProvider client={client}>
				<ProcessDialog
					session={session}
					mediaId={mediaId}
					clipIds={[shortClip]}
					replaceDefault
					origin="clip"
					close={() => {}}
				/>
			</EngineProvider>,
		);
		await waitFor(() => expect(calls.some((c) => c.url === '/api/processing/models')).toBe(true));
		expect(screen.getByTestId('process-range-info').textContent).toContain('Source frames 38–91 (54 frames)');
		fireEvent.change(screen.getByTestId('process-handles'), { target: { value: '4' } });
		expect(screen.getByTestId('process-range-info').textContent).toContain('Source frames 46–83 (38 frames)');
		fireEvent.click(screen.getByRole('checkbox', { name: 'Deblock' }));
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Start' }));
		});
		const post = calls.find((c) => c.method === 'POST' && c.url === `/api/media/${KEY}/process`);
		expect((post!.body as { range?: unknown }).range).toEqual({ startFrame: 46, endFrame: 84 });
		cleanup();
		calls.length = 0;
		render(
			<EngineProvider client={client}>
				<ProcessDialog
					session={session}
					mediaId={mediaId}
					clipIds={[shortClip]}
					replaceDefault
					origin="clip"
					close={() => {}}
				/>
			</EngineProvider>,
		);
		await waitFor(() => expect(calls.some((c) => c.url === '/api/processing/models')).toBe(true));
		fireEvent.click(within(screen.getByTestId('process-range')).getByRole('button', { name: 'Whole media' }));
		fireEvent.click(screen.getByRole('checkbox', { name: 'Deblock' }));
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Start' }));
		});
		const whole = calls.find((c) => c.method === 'POST' && c.url === `/api/media/${KEY}/process`);
		expect((whole!.body as { range?: unknown }).range).toBeUndefined();
	});

	it('a finished ranged job swaps the clip onto the same source frames; a clip it does not cover stays', () => {
		const { session, mediaId, videoClip, shortClip } = withShortClip();
		const r = commitProcessed(session, {
			fromMediaId: mediaId,
			steps: [{ op: 'denoise', method: 'atadenoise', strength: 0.5 }],
			result: rangedResult(38, 92),
			replaceInClips: [shortClip, videoClip],
		});
		expect(r).toMatchObject({ ok: true, replaced: [shortClip], skipped: [videoClip] });
		const v = clipOf(session, shortClip);
		expect(v.mediaId).toBe(r.ok ? r.mediaId : '');
		expect(v.sourceIn).toBe(12 * F25);
		expect(clipOf(session, videoClip).mediaId).toBe(mediaId);
	});

	it('switching to a version that cannot cover the clip requires consent to trim', async () => {
		const { session, mediaId, videoClip, shortClip } = withShortClip();
		const r = commitProcessed(session, {
			fromMediaId: mediaId,
			steps: [{ op: 'denoise', method: 'atadenoise', strength: 0.5 }],
			result: rangedResult(38, 92),
			replaceInClips: [shortClip],
		});
		const versionId = r.ok ? r.mediaId! : '';
		// The 150-frame clip does not fit in frames 38…91: declining keeps it, accepting trims it.
		const asks: string[] = [];
		const no = await switchMediaVersionInteractive(session, [videoClip], versionId, async (o) => {
			asks.push(String(o.body));
			return false;
		});
		expect(no).toBeNull();
		expect(asks).toHaveLength(1);
		expect(clipOf(session, videoClip).mediaId).toBe(mediaId);
		const yes = await switchMediaVersionInteractive(session, [videoClip], versionId, async () => true);
		expect(yes).toMatchObject({ ok: true, changed: 1, trimmed: 1 });
		const c = clipOf(session, videoClip);
		expect([c.mediaId, c.start, c.duration, c.sourceIn]).toEqual([versionId, 38, 54, 0]);
	});

	it('Replace Footage dialog: desktop pick → sidecar and timing shown → Replace is one undo entry', async () => {
		const { session, mediaId, shortClip } = withShortClip();
		const reg = {
			...result().registered,
			mediaKey: 'mk_grade_1',
			originalName: 'clip-b-grade.mov',
			probe: { ...probe(1920, 1080, 'prores'), durationFlicks: 200 * F25 },
			sourceHint: {
				sidecar: 'clip-b-grade.json',
				sourceName: 'clip-b.mp4',
				firstFrame: 10,
				frames: 200,
				frameRate: null,
				handles: null,
			},
		};
		const { client, calls } = fakeEngine({
			onCall: (c) =>
				c.url === '/api/media/register'
					? new Response(JSON.stringify({ items: [reg], errors: [] }), { headers: { 'x-jasper-api': '1' } })
					: undefined,
		});
		(window as unknown as { jasperDesktop?: unknown }).jasperDesktop = {
			runtime: 'desktop',
			pickMedia: async () => ['/grades/clip-b-grade.mov'],
		};
		try {
			let closed: unknown = 'open';
			render(
				<EngineProvider client={client}>
					<ReplaceFootageDialog session={session} mediaId={mediaId} close={(r) => (closed = r)} />
				</EngineProvider>,
			);
			expect((screen.getByRole('button', { name: 'Replace' }) as HTMLButtonElement).disabled).toBe(true);
			await act(async () => {
				fireEvent.click(screen.getByTestId('replace-choose'));
			});
			await waitFor(() =>
				expect(screen.getByTestId('replace-sidecar').textContent).toContain('clip-b-grade.json'),
			);
			expect(calls.find((c) => c.url === '/api/media/register')?.body).toEqual({
				projectId: 'prj_test',
				paths: ['/grades/clip-b-grade.mov'],
			});
			fireEvent.click(within(screen.getByTestId('replace-trim')).getByRole('checkbox'));
			const entries = session.getState().history.entries.length;
			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
			});
			expect(closed).toBe(true);
			expect(session.getState().history.entries.length).toBe(entries + 1);
			expect(clipOf(session, shortClip).sourceIn).toBe(40 * F25);
			const m = session.getCommitted().media[mediaId]!;
			expect(m.locators).toEqual([
				{ type: 'engine-store', engineId: 'local', key: 'mk_grade_1' },
				{ type: 'path', path: '/tmp/clip-b.processed.mov', relativeToProject: null },
				{ type: 'path', path: '/grades/clip-b-grade.mov', relativeToProject: null },
			]);
		} finally {
			delete (window as unknown as { jasperDesktop?: unknown }).jasperDesktop;
		}
	});

	it('Replace Footage discards an uncommitted file (another pick, closing the dialog), never a committed one', async () => {
		const { session, mediaId } = withShortClip();
		const mk = (key: string, name: string) => ({
			...result().registered,
			mediaKey: key,
			fingerprint: `q1:${key.padEnd(64, '0').slice(0, 64)}`,
			originalName: name,
			probe: { ...probe(1920, 1080, 'prores'), durationFlicks: 200 * F25 },
		});
		const regs = [mk('mk_first0001', 'a.mov'), mk('mk_second001', 'b.mov'), mk('mk_third0001', 'c.mov')];
		let n = 0;
		const { client, calls } = fakeEngine({
			onCall: (c) => {
				if (c.url === '/api/media/register')
					return new Response(JSON.stringify({ items: [regs[n++]], errors: [] }), {
						headers: { 'x-jasper-api': '1' },
					});
				if (c.method === 'DELETE' && c.url.startsWith('/api/media/'))
					return new Response(JSON.stringify({ deleted: true, reason: 'deleted' }), {
						headers: { 'x-jasper-api': '1' },
					});
				return undefined;
			},
		});
		const deletes = () => calls.filter((c) => c.method === 'DELETE').map((c) => c.url);
		(window as unknown as { jasperDesktop?: unknown }).jasperDesktop = {
			runtime: 'desktop',
			pickMedia: async () => [`/grades/${regs[n]?.originalName ?? 'x.mov'}`],
		};
		try {
			const view = render(
				<EngineProvider client={client}>
					<ReplaceFootageDialog session={session} mediaId={mediaId} close={() => {}} />
				</EngineProvider>,
			);
			await act(async () => {
				fireEvent.click(screen.getByTestId('replace-choose'));
			});
			await waitFor(() => expect(screen.getByTestId('replace-new').textContent).toContain('a.mov'));
			await act(async () => {
				fireEvent.click(screen.getByTestId('replace-choose'));
			});
			await waitFor(() => expect(screen.getByTestId('replace-new').textContent).toContain('b.mov'));
			await waitFor(() => expect(deletes()).toEqual(['/api/media/mk_first0001']));
			view.unmount();
			await waitFor(() => expect(deletes()).toEqual(['/api/media/mk_first0001', '/api/media/mk_second001']));
			calls.length = 0;
			let closed: unknown = 'open';
			const v2 = render(
				<EngineProvider client={client}>
					<ReplaceFootageDialog session={session} mediaId={mediaId} close={(r) => (closed = r)} />
				</EngineProvider>,
			);
			await act(async () => {
				fireEvent.click(screen.getByTestId('replace-choose'));
			});
			await waitFor(() => expect(screen.getByTestId('replace-new').textContent).toContain('c.mov'));
			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
			});
			expect(closed).toBe(true);
			await act(async () => v2.unmount());
			expect(deletes()).toEqual([]);
			expect(session.getCommitted().media[mediaId]?.originalName).toBe('c.mov');
		} finally {
			delete (window as unknown as { jasperDesktop?: unknown }).jasperDesktop;
		}
	});
});
