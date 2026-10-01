// Clip processing UI (S07 §6, PRU-001…004): the Process Clip dialog builds the ProcessRequest, a finished job
// commits ONE `media.derive` transaction (with replaceInClips) labelled "Process Clip", the Media Version
// section swaps with `clip.replaceSource`, and Preferences ▸ Processing saves settings and renders a probe.
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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../src/commands/process.ts';
import { commitProcessed, type Notice, PROCESS_TX_LABEL, processWatcher } from '../src/processing/jobs.ts';
import { MediaVersionSection } from '../src/processing/MediaVersionSection.tsx';
import { versionsOf } from '../src/processing/model.ts';
import { ProcessingPreferencesPage } from '../src/processing/PreferencesPage.tsx';
import { ProcessDialog } from '../src/processing/ProcessDialog.tsx';
import { PreferencesDialog } from '../src/shell/preferences/index.ts';
import { EngineProvider } from '../src/state/engine.tsx';

// ------------------------------------------------------------------ fixtures

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
				dedupeKey: 'process:abc:fff',
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

const notices: Notice[] = [];
beforeEach(() => {
	notices.length = 0;
	processWatcher.reset();
	processWatcher.configure({ notify: (n) => notices.push(n), pollMs: 60_000 });
});
afterEach(() => {
	cleanup();
	processWatcher.reset();
});

// ------------------------------------------------------------------ dialog

describe('Process Clip dialog (PRU-001)', () => {
	it('builds the ProcessRequest from the checked steps and queues the job with the projectId', async () => {
		const { session, mediaId, videoClip } = makeSession();
		const { client, calls } = fakeEngine();
		let closed: unknown = 'open';
		render(
			<EngineProvider client={client} connectEvents={false}>
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
		expect(screen.getByTestId('process-source').textContent).toContain('1280×720 · 150 frames');
		const start = screen.getByRole('button', { name: 'Start' });
		expect((start as HTMLButtonElement).disabled).toBe(true); // no step yet
		fireEvent.click(screen.getByRole('checkbox', { name: 'Denoise' }));
		fireEvent.click(within(screen.getByTestId('step-denoise')).getByRole('button', { name: 'Strong' }));
		fireEvent.click(screen.getByRole('checkbox', { name: 'Deblock' }));
		expect(screen.getByTestId('process-estimate').textContent).toMatch(
			/≈ .* \(rough estimate, this computer\)/,
		);
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
		// Followed at module level with the clip to replace.
		expect(processWatcher.list().map((w) => [w.jobId, w.replaceInClips])).toEqual([['job_1', [videoClip]]]);
	});

	it('shows the model licence line for upscale and the remote option disabled without settings', async () => {
		const { session, mediaId } = makeSession();
		const { client } = fakeEngine();
		render(
			<EngineProvider client={client} connectEvents={false}>
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
		fireEvent.click(screen.getByRole('checkbox', { name: 'Upscale' }));
		await waitFor(() =>
			expect(screen.getByTestId('process-model-license').textContent).toContain('CC-BY-4.0'),
		);
		expect(screen.getByTestId('process-model-license').textContent).toContain('Philip Hofmann');
		expect(screen.getByTestId('process-remote-status').textContent).toContain('Preferences ▸ Processing');
		// No clip uses it from the Project panel entry → no replace checkbox.
		expect(screen.queryByText(/Replace in/)).toBeNull();
	});
});

// ------------------------------------------------------------------ job → media.derive

describe('finished process jobs (PRU-002)', () => {
	it('commits media.derive with replaceInClips as ONE "Process Clip" entry; one undo restores the original', async () => {
		const { session, mediaId, videoClip, audioClip } = makeSession();
		const { client } = fakeEngine({ job: () => job('succeeded', { result: result() }) });
		const before = session.getState().history.entries.length;
		processWatcher.watch({
			jobId: 'job_1',
			engine: client,
			session,
			fromMediaId: mediaId,
			mediaKey: KEY,
			steps: [{ op: 'denoise', method: 'atadenoise', strength: 0.5 }],
			executor: 'auto',
			replaceInClips: [videoClip, audioClip],
		});
		await processWatcher.tick();
		const h = session.getState().history;
		expect(h.entries.length).toBe(before + 1);
		expect(h.entries.at(-1)?.label).toBe(PROCESS_TX_LABEL);
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
		// Linked audio keeps the original (PRC-007).
		expect((seq.clips[audioClip] as Clip & { mediaId: string }).mediaId).toBe(mediaId);
		expect(versionsOf(doc, mediaId)).toEqual([mediaId, v.mediaId]);
		expect(notices.at(-1)).toMatchObject({ kind: 'success' });
		expect(processWatcher.list()).toEqual([]);

		act(() => {
			session.undo();
		});
		const after = session.getCommitted();
		expect((Object.values(after.sequences)[0]!.clips[videoClip] as Clip & { mediaId: string }).mediaId).toBe(
			mediaId,
		);
		expect(Object.keys(after.media)).toEqual([mediaId]);
	});

	it('without replace it only adds the processed version (Processed bin)', () => {
		const { session, mediaId, videoClip } = makeSession();
		const r = commitProcessed(session, {
			fromMediaId: mediaId,
			steps: [{ op: 'deblock', filter: 'weak' }],
			result: result(),
			replaceInClips: [],
		});
		expect(r.ok).toBe(true);
		const doc = session.getCommitted();
		expect((Object.values(doc.sequences)[0]!.clips[videoClip] as Clip & { mediaId: string }).mediaId).toBe(
			mediaId,
		);
		const bin = Object.values(doc.items).find((i) => i.kind === 'bin' && i.name === 'Processed');
		expect(bin).toBeTruthy();
		expect(session.getState().history.entries.at(-1)?.label).toBe(PROCESS_TX_LABEL);
	});

	it('a failed remote job shows the error with Retry and Run on This Computer (no silent fallback)', async () => {
		const { session, mediaId, videoClip } = makeSession();
		const { client, calls } = fakeEngine({
			job: () =>
				job('failed', {
					stage: 'Remote · processing',
					error: { code: 'REMOTE_CONNECTION_LOST', message: 'Lost the connection to gpu', retryable: true },
				}),
		});
		processWatcher.watch({
			jobId: 'job_1',
			engine: client,
			session,
			fromMediaId: mediaId,
			mediaKey: KEY,
			steps: [{ op: 'upscale', model: 'span-2x', scale: 2 }],
			executor: 'remote',
			replaceInClips: [videoClip],
			dedupeKey: 'process:abc:fff',
		});
		await processWatcher.tick();
		const n = notices.at(-1)!;
		expect(n.kind).toBe('error');
		expect(n.detail).toContain('REMOTE_CONNECTION_LOST: Lost the connection to gpu');
		expect(n.actions?.map((a) => a.label)).toEqual(['Retry', 'Run on This Computer']);
		// Nothing was committed and no local job was started on its own.
		expect(session.getState().history.entries.at(-1)?.label).toBe('setup');
		expect(calls.filter((c) => c.url.endsWith('/process'))).toEqual([]);
	});
});

// ------------------------------------------------------------------ Media Version + badges

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

	it('is registered for video clips and lists Original + processed versions; switching is one undo entry', async () => {
		const { session, videoClip, mediaId, processedId } = withVersion();
		const clip = () =>
			Object.values(session.getCommitted().sequences)[0]!.clips[videoClip] as Clip & { mediaId: string };
		const seqId = Object.keys(session.getCommitted().sequences)[0]!;
		const { rerender } = render(
			<SessionProvider session={session}>
				<MediaVersionSection session={session} clips={[clip()]} frame={0} sequenceId={seqId} />
			</SessionProvider>,
		);
		expect(screen.getByTestId('media-version-info').textContent).toContain('1 processed version available');
		const trigger = screen.getByRole('combobox', { name: 'Media version' });
		expect(trigger.textContent).toContain('Original');
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
		expect(session.getState().history.entries.at(-1)?.label).toBe('Use Processed Version');
		rerender(
			<SessionProvider session={session}>
				<MediaVersionSection session={session} clips={[clip()]} frame={0} sequenceId={seqId} />
			</SessionProvider>,
		);
		expect(screen.getByTestId('media-version-info').textContent).toContain('Denoised');
		act(() => {
			session.undo();
		});
		expect(clip().mediaId).toBe(mediaId);
	});
});

// ------------------------------------------------------------------ Preferences

describe('Preferences ▸ Processing (PRU-004)', () => {
	it('the dialog shell lists registered pages and opens the requested one', async () => {
		const { client } = fakeEngine();
		render(
			<EngineProvider client={client} connectEvents={false}>
				<PreferencesDialog page="processing" close={() => {}} />
			</EngineProvider>,
		);
		expect(screen.getByTestId('prefs-page-general')).toBeTruthy();
		expect(screen.getByTestId('prefs-page-processing').getAttribute('aria-current')).toBe('page');
		await waitFor(() => expect(screen.getByTestId('prefs-processing')).toBeTruthy());
		fireEvent.click(screen.getByTestId('prefs-page-general'));
		expect(screen.getByTestId('prefs-general')).toBeTruthy();
	});

	it('saves the remote settings, shows engine validation errors and renders a probe result', async () => {
		let probeCalls = 0;
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
					probeCalls++;
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
			<EngineProvider client={client} connectEvents={false}>
				<ProcessingPreferencesPage />
			</EngineProvider>,
		);
		await waitFor(() => expect((screen.getByTestId('remote-host') as HTMLInputElement).disabled).toBe(false));
		expect(screen.queryByLabelText(/password/i)).toBeNull();
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
			expect(screen.getByTestId('prefs-processing-status').textContent).toBe('Settings saved'),
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
		expect(probeCalls).toBe(1);
		expect(screen.getByTestId('probe-message').textContent).toContain('Connection refused');
		expect(screen.getByTestId('probe-runtime').textContent).toContain('not installed');
		expect(screen.getByTestId('model-span-2x-state').textContent).toBe('Bundled');
	});
});
