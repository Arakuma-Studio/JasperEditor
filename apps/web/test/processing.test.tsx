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
import { switchMediaVersionInteractive } from '../src/processing/actions.ts';
import { commitProcessed, type Notice, PROCESS_TX_LABEL, processWatcher } from '../src/processing/jobs.ts';
import { MediaVersionSection } from '../src/processing/MediaVersionSection.tsx';
import { versionLabel, versionsOf } from '../src/processing/model.ts';
import { ProcessingPreferencesPage } from '../src/processing/PreferencesPage.tsx';
import { ProcessDialog } from '../src/processing/ProcessDialog.tsx';
import { REPLACE_FOOTAGE_TX_LABEL, ReplaceFootageDialog } from '../src/processing/ReplaceFootageDialog.tsx';
import { planReplaceFootage, replaceFootageCommand } from '../src/processing/replace-footage.ts';
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

	it('offers Smooth path with its own options and explains when to use each method', async () => {
		const { session, mediaId, videoClip } = makeSession();
		const { client, calls } = fakeEngine();
		render(
			<EngineProvider client={client} connectEvents={false}>
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
		expect(screen.getByTestId('stabilize-method-help').textContent).toContain('handheld');
		const trigger = screen.getByRole('combobox', { name: 'Stabilize method' });
		await act(async () => {
			fireEvent.keyDown(trigger, { key: 'Enter' });
		});
		const option = await screen.findByRole('option', { name: 'Smooth path (one even move)' });
		await act(async () => {
			fireEvent.keyDown(option, { key: 'Enter' });
		});
		const help = screen.getByTestId('stabilize-method-help').textContent ?? '';
		expect(help).toContain('one sudden reframe or jerk');
		expect(help).toContain('one fixed zoom');
		expect(screen.getByTestId('stabilize-path-smoothing').textContent).toBe('30 frames');
		expect(screen.getByTestId('stabilize-max-zoom').textContent).toBe('112 %');
		expect(screen.queryByText('Also stabilize rotation (vid.stab)')).toBeNull();
		fireEvent.click(screen.getByRole('checkbox', { name: 'Vertical (no tilt)' }));
		fireEvent.click(
			within(screen.getByTestId('step-stabilize')).getByRole('button', { name: 'Keep (black edges)' }),
		);
		expect(screen.queryByTestId('stabilize-max-zoom')).toBeNull();
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
			<EngineProvider client={client} connectEvents={false}>
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

// ------------------------------------------------------------------ M3 source ranges (wp-m3-inpoint)

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
			<EngineProvider client={client} connectEvents={false}>
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
		expect(processWatcher.list()[0]?.range).toEqual({ startFrame: 46, endFrame: 84 });
		cleanup();
		processWatcher.reset();
		calls.length = 0;
		render(
			<EngineProvider client={client} connectEvents={false}>
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
		const doc = session.getCommitted();
		expect(versionLabel(doc, v.mediaId)).toBe('Denoised · frames 38–91');
		expect(versionLabel(doc, mediaId)).toBe('Original');
		expect(session.getState().history.entries.at(-1)?.label).toBe(PROCESS_TX_LABEL);
	});

	it('the Media Version section shows the range and the handles; an uncovering version asks to trim', async () => {
		const { session, mediaId, videoClip, shortClip, seqId } = withShortClip();
		const r = commitProcessed(session, {
			fromMediaId: mediaId,
			steps: [{ op: 'denoise', method: 'atadenoise', strength: 0.5 }],
			result: rangedResult(38, 92),
			replaceInClips: [shortClip],
		});
		const versionId = r.ok ? r.mediaId! : '';
		render(
			<SessionProvider session={session}>
				<MediaVersionSection
					session={session}
					clips={[clipOf(session, shortClip)]}
					frame={0}
					sequenceId={seqId}
				/>
			</SessionProvider>,
		);
		expect(screen.getByTestId('media-version-info').textContent).toContain('Denoised · frames 38–91');
		expect(screen.getByTestId('media-version-handles').textContent).toBe('Handles 12 / 12 frames');
		// The 150-frame clip does not fit in frames 38…91: declining keeps it, accepting trims it.
		const asks: string[] = [];
		const no = await switchMediaVersionInteractive(session, [videoClip], versionId, async (o) => {
			asks.push(String(o.body));
			return false;
		});
		expect(no).toBeNull();
		expect(asks[0]).toMatch(/holds frames 38–91 of clip-b\.mp4; clip clp_\w+ shows frames 0–149/);
		expect(clipOf(session, videoClip).mediaId).toBe(mediaId);
		const yes = await switchMediaVersionInteractive(session, [videoClip], versionId, async () => true);
		expect(yes).toMatchObject({ ok: true, changed: 1, trimmed: 1 });
		const c = clipOf(session, videoClip);
		expect([c.mediaId, c.start, c.duration, c.sourceIn]).toEqual([versionId, 38, 54, 0]);
	});

	it('Replace Footage: plan + command keep source timing from a sidecar and list clips the file does not hold', () => {
		const { session, mediaId, videoClip, shortClip } = withShortClip();
		const reg = {
			...result().registered,
			originalName: 'clip-b-grade.mov',
			probe: { ...probe(1920, 1080, 'prores'), durationFlicks: 54 * F25 },
		};
		const hint = {
			sidecar: 'clip-b-grade.json',
			sourceName: 'clip-b.mp4',
			firstFrame: 38,
			frames: 54,
			frameRate: null,
			handles: [12, 12] as [number, number],
		};
		const plan = planReplaceFootage(session.getCommitted(), mediaId, reg, hint, true);
		expect(plan.timing).toMatchObject({ ok: true, shiftFrames: -38, basis: 'range-of-current' });
		expect(plan.sourceRange).toMatchObject({ mediaId: null, sourceName: 'clip-b.mp4', firstFrame: 38 });
		// The whole-length clip and its linked audio need frames outside 38…91.
		expect(plan.uncovered.map((c) => c.clipId)).toContain(videoClip);
		expect(plan.uncovered.map((c) => c.clipId)).not.toContain(shortClip);
		expect(plan.clips.find((c) => c.clipId === shortClip)?.whole).toBe(true);
		const r = session.apply({
			label: 'Replace Footage',
			origin: 'user',
			commands: [
				replaceFootageCommand(mediaId, reg, {
					sourceRange: plan.sourceRange,
					keepSourceTiming: true,
					trim: true,
				}),
			],
		});
		expect(r.ok).toBe(true);
		expect(clipOf(session, shortClip).sourceIn).toBe(12 * F25);
		expect(clipOf(session, videoClip)).toMatchObject({ start: 38, duration: 54, sourceIn: 0 });
		expect(session.getCommitted().media[mediaId]?.originalName).toBe('clip-b-grade.mov');
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
				<EngineProvider client={client} connectEvents={false}>
					<ReplaceFootageDialog session={session} mediaId={mediaId} close={(r) => (closed = r)} />
				</EngineProvider>,
			);
			expect((screen.getByRole('button', { name: 'Replace' }) as HTMLButtonElement).disabled).toBe(true);
			await act(async () => {
				fireEvent.click(screen.getByTestId('replace-choose'));
			});
			await waitFor(() =>
				expect(screen.getByTestId('replace-sidecar').textContent).toBe(
					'clip-b-grade.json: starts at frame 10 of clip-b.mp4',
				),
			);
			expect(calls.find((c) => c.url === '/api/media/register')?.body).toEqual({
				projectId: 'prj_test',
				paths: ['/grades/clip-b-grade.mov'],
			});
			expect(screen.getByTestId('replace-timing').textContent).toContain('In-points move by -10 frames');
			// The 150-frame clip needs frames 0…9, which the render does not hold.
			expect(screen.getByTestId('replace-coverage').textContent).toMatch(
				/need frames the new file does\s*not hold/,
			);
			fireEvent.click(within(screen.getByTestId('replace-trim')).getByRole('checkbox'));
			const entries = session.getState().history.entries.length;
			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
			});
			expect(closed).toBe(true);
			expect(session.getState().history.entries.length).toBe(entries + 1);
			expect(session.getState().history.entries.at(-1)?.label).toBe(REPLACE_FOOTAGE_TX_LABEL);
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
				<EngineProvider client={client} connectEvents={false}>
					<ReplaceFootageDialog session={session} mediaId={mediaId} close={() => {}} />
				</EngineProvider>,
			);
			await act(async () => {
				fireEvent.click(screen.getByTestId('replace-choose'));
			});
			await waitFor(() => expect(screen.getByTestId('replace-new').textContent).toContain('a.mov'));
			// Choosing another file discards the first.
			await act(async () => {
				fireEvent.click(screen.getByTestId('replace-choose'));
			});
			await waitFor(() => expect(screen.getByTestId('replace-new').textContent).toContain('b.mov'));
			await waitFor(() => expect(deletes()).toEqual(['/api/media/mk_first0001']));
			// Closing (Cancel / Escape / ×) discards the current pick.
			view.unmount();
			await waitFor(() => expect(deletes()).toEqual(['/api/media/mk_first0001', '/api/media/mk_second001']));
			// A committed file is never discarded.
			calls.length = 0;
			let closed: unknown = 'open';
			const v2 = render(
				<EngineProvider client={client} connectEvents={false}>
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
			v2.unmount();
			await new Promise((r) => setTimeout(r, 20));
			expect(deletes()).toEqual([]);
			expect(session.getCommitted().media[mediaId]?.originalName).toBe('c.mov');
		} finally {
			delete (window as unknown as { jasperDesktop?: unknown }).jasperDesktop;
		}
	});
});
