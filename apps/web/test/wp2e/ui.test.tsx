import type { EncoderChoice, EngineCapabilities, EngineJob, RenderPlan } from '@jasper/api';
import type { EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { ExportMode } from '../../src/export/ExportMode.tsx';
import { exportMode } from '../../src/export/mode.ts';
import { Home } from '../../src/home/Home.tsx';
import { notices } from '../../src/home/notices.tsx';
import { buildMediaAsset } from '../../src/import/assets.ts';
import { clientJobs } from '../../src/import/client-jobs.ts';
import { createMediaRuntimeSync } from '../../src/import/media-runtime.ts';
import { JobsPanel } from '../../src/panels/jobs/JobsPanel.tsx';
import { ProjectDialogHost } from '../../src/panels/project/dialogs.tsx';
import { ProjectPanel } from '../../src/panels/project/ProjectPanel.tsx';
import { EngineProvider } from '../../src/state/engine.tsx';
import { PROJECT_ITEMS_MIME } from '../../src/state/services.ts';
import { memorySession, registered, ScriptedEngine } from './helpers.ts';

afterEach(() => {
	cleanup();
	for (const n of notices.getAll()) notices.dismiss(n.id);
	for (const j of clientJobs.getAll()) clientJobs.remove(j.id);
	exportMode.close();
	localStorage.clear();
});

function wrap(engine: ScriptedEngine, session: EditorSession | null, children: ReactNode) {
	return (
		<EngineProvider client={engine.client()} connectEvents={false}>
			<MemoryRouter initialEntries={['/']}>
				<SessionProvider session={session}>{children}</SessionProvider>
			</MemoryRouter>
		</EngineProvider>
	);
}

function importMedia(session: EditorSession, name: string, opts: Parameters<typeof registered>[1] = {}) {
	const reg = registered(name, opts);
	const r = session.apply({
		label: 'Import 1 file',
		origin: 'user',
		commands: [
			{
				type: 'media.register',
				asset: buildMediaAsset(reg, { id: session.ctx.ids.next('med'), now: 't' }),
				name,
			},
		],
	});
	if (!r.ok) throw new Error(r.errors[0]!.message);
	return r.results[0] as { mediaId: string; itemId: string };
}

describe('Home screen (S05:HD-020)', () => {
	it('requires confirmation before deleting a project', async () => {
		const engine = new ScriptedEngine();
		let projects = [
			{
				projectId: 'prj_A',
				name: 'Doomed',
				modifiedAt: '2026-09-01T00:00:00.000Z',
				thumbnail: null,
				schemaVersion: 1,
				sizeBytes: 1,
				revision: 0,
			},
		];
		engine.on((r) => {
			if (r.path === '/api/projects' && r.method === 'GET') return { body: { projects } };
			if (r.path === '/api/projects/prj_A' && r.method === 'DELETE') {
				projects = [];
				return { body: { ok: true } };
			}
			return undefined;
		});
		render(wrap(engine, null, <Home />));
		await waitFor(() => expect(screen.getAllByTestId('project-card')).toHaveLength(1));
		fireEvent.click(screen.getByTestId('project-delete'));
		expect(engine.requests.some((r) => r.method === 'DELETE')).toBe(false);
		fireEvent.click(screen.getByTestId('confirm-delete-project'));
		await waitFor(() =>
			expect(engine.requests.some((r) => r.path === '/api/projects/prj_A' && r.method === 'DELETE')).toBe(
				true,
			),
		);
	});
});

describe('Project panel (S05:PRJ-001…010)', () => {
	it('moves media into a bin and finds it from the project root', async () => {
		const { session } = await memorySession();
		importMedia(session, 'clip-a.mp4', { key: 'mk_CLIPA0001' });
		render(
			wrap(
				new ScriptedEngine(),
				session,
				<>
					<ProjectPanel instanceId="project-1" visible />
					<ProjectDialogHost />
				</>,
			),
		);
		const rows = () => screen.getAllByTestId('project-row');
		fireEvent.click(screen.getByTestId('project-new-bin'));
		const input = await screen.findByTestId('project-rename');
		fireEvent.change(input, { target: { value: 'Footage' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		const doc = session.getCommitted();
		const bin = Object.values(doc.items).find((i) => i.kind === 'bin')!;
		const clipItem = Object.values(doc.items).find((i) => i.name === 'clip-a.mp4')!;
		const binRow = rows().find((r) => r.getAttribute('data-item-id') === bin.id)!;
		const dt = {
			types: [PROJECT_ITEMS_MIME],
			getData: () => JSON.stringify({ type: 'jasper/project-items', itemIds: [clipItem.id] }),
			files: [],
			dropEffect: 'none',
		};
		fireEvent.dragOver(binRow, { dataTransfer: dt });
		fireEvent.drop(binRow, { dataTransfer: dt });
		expect((session.getCommitted().items[bin.id] as { children: string[] }).children).toContain(clipItem.id);
		fireEvent.doubleClick(rows().find((r) => r.getAttribute('data-item-id') === bin.id)!);
		await waitFor(() => expect(screen.getByTestId('project-breadcrumb').textContent).toContain('Footage'));
		fireEvent.click(within(screen.getByTestId('project-breadcrumb')).getByText('Film'));
		fireEvent.change(screen.getByTestId('project-search'), { target: { value: 'clip' } });
		expect(rows().some((r) => r.getAttribute('data-item-id') === clipItem.id)).toBe(true);
	});

	it('warns before deleting media that is used in a sequence and deletes with force on confirm', async () => {
		const { session } = await memorySession();
		const { mediaId, itemId } = importMedia(session, 'clip-a.mp4');
		const seqId = Object.keys(session.getCommitted().sequences)[0]!;
		session.apply({
			label: 'Overwrite',
			origin: 'user',
			commands: [{ type: 'clip.place', sequenceId: seqId, source: { mediaId }, at: 0 }],
		});
		render(
			wrap(
				new ScriptedEngine(),
				session,
				<>
					<ProjectPanel instanceId="p" visible />
					<ProjectDialogHost />
				</>,
			),
		);
		fireEvent.click(
			screen.getAllByTestId('project-row').find((r) => r.getAttribute('data-item-id') === itemId)!,
		);
		fireEvent.click(screen.getByTestId('project-clear'));
		const dialog = await screen.findByTestId('dialog-confirm');
		expect(dialog.textContent).toMatch(/clips.*use this media/);
		expect(session.getCommitted().items[itemId]).toBeTruthy();
		fireEvent.click(screen.getByTestId('confirm-ok'));
		expect(session.getCommitted().items[itemId]).toBeUndefined();
		expect(Object.keys(session.getCommitted().sequences[seqId]!.clips)).toHaveLength(0);
	});

	it('creates a sequence from the selected preset', async () => {
		const { session } = await memorySession();
		render(
			wrap(
				new ScriptedEngine(),
				session,
				<>
					<ProjectPanel instanceId="icons" visible />
					<ProjectDialogHost />
				</>,
			),
		);
		fireEvent.click(screen.getByTestId('project-new-item'));
		fireEvent.click(screen.getByTestId('new-item-sequence'));
		fireEvent.change(screen.getByTestId('new-sequence-preset'), {
			target: { value: 'vertical-1080x1920-30' },
		});
		fireEvent.click(screen.getByTestId('new-sequence-ok'));
		const seqs = Object.values(session.getCommitted().sequences);
		expect(seqs[1]!.settings).toMatchObject({ width: 1080, height: 1920 });
		expect(session.getState().activeSequenceId).toBe(seqs[1]!.id);
	});
});

describe('media runtime sync (S01:LIFE-050)', () => {
	it('keeps a ready 720 proxy when the 540 tier was never made (LIFE-050)', async () => {
		const { session } = await memorySession();
		const engine = new ScriptedEngine();
		engine.on((r) =>
			r.path === '/api/media/mk_CLIPA0001'
				? {
						body: {
							mediaKey: 'mk_CLIPA0001',
							status: 'processing',
							// zod 4 records keyed by an enum are exhaustive: the engine reports every kind.
							derivatives: {
								keyframes: { state: 'ready', progress: 1 },
								poster: { state: 'queued', progress: 0 },
								sprite: { state: 'queued', progress: 0 },
								peaks: { state: 'running', progress: 0.5 },
								'proxy-720': { state: 'none', progress: 0 },
								'proxy-540': { state: 'none', progress: 0 },
							},
						},
					}
				: undefined,
		);
		const listeners = new Set<(e: never) => void>();
		const sync = createMediaRuntimeSync(session, engine.client(), (l) => {
			listeners.add(l as never);
			return () => listeners.delete(l as never);
		});
		const { mediaId } = importMedia(session, 'clip-a.mp4', { key: 'mk_CLIPA0001' });
		await waitFor(() => expect(session.getState().media[mediaId]?.availability).toBe('online'));
		const emit = (e: unknown) => {
			for (const l of listeners) (l as (e: unknown) => void)(e);
		};
		emit({
			id: 1,
			type: 'media.updated',
			createdAt: 't',
			payload: {
				mediaKey: 'mk_CLIPA0001',
				status: 'online',
				derivatives: {
					'proxy-720': { state: 'ready', progress: 1, url: '/media/mk_CLIPA0001/proxy/720?v=abc' },
					'proxy-540': { state: 'none', progress: 0 },
				},
			},
		});
		expect(session.getState().media[mediaId]).toMatchObject({
			proxy: { state: 'ready' },
			proxyUrl: '/media/mk_CLIPA0001/proxy/720?v=abc',
		});
		sync.dispose();
	});
});

function job(p: Partial<EngineJob> & Pick<EngineJob, 'id' | 'kind' | 'state'>): EngineJob {
	return {
		title: `${p.kind} job`,
		origin: { type: 'user' },
		progress: null,
		createdAt: '2026-09-30T10:00:00.000Z',
		priority: 'user',
		cpuSlots: 1,
		...p,
	};
}

describe('Jobs panel (S05:JOB-001…005)', () => {
	it('cancels a running export job through the engine (JOB-003)', async () => {
		const { session } = await memorySession();
		const engine = new ScriptedEngine();
		engine.jobs = [
			job({
				id: 'e1',
				kind: 'export',
				state: 'running',
				progress: 0.4,
				projectId: session.projectId,
			}),
		];
		engine.on((r) =>
			r.path === '/api/jobs/e1/cancel' ? { body: { ...engine.jobs[0], state: 'cancelling' } } : undefined,
		);
		render(wrap(engine, session, <JobsPanel instanceId="jobs" visible />));
		const running = await screen.findByTestId('job-row');
		fireEvent.click(within(running).getByTestId('job-cancel'));
		await waitFor(() =>
			expect(engine.requests.some((r) => r.path === '/api/jobs/e1/cancel' && r.method === 'POST')).toBe(true),
		);
	});

	it('keeps client uploads running when the engine is disconnected (JOB-005)', async () => {
		const engine = new ScriptedEngine();
		engine.handlers = [() => ({ status: 503, body: { code: 'INTERNAL', message: 'down', retryable: true } })];
		clientJobs.add({ kind: 'upload', title: 'Upload – x.mp4', progress: 0.1 });
		render(wrap(engine, null, <JobsPanel instanceId="jobs" visible />));
		await waitFor(() => expect(screen.getByTestId('jobs-disconnected')).toBeTruthy());
		expect(screen.getAllByTestId('job-row')[0]!.getAttribute('data-status')).toBe('Running');
	});
});

const PLAN_REMOTION: RenderPlan = {
	planId: 'plan_1',
	documentRevision: 0,
	path: 'remotion',
	segments: [{ startFrame: 0, endFrame: 300, mode: 'remotion', graphicsGroups: [] }],
	audio: { mode: 'remotion' },
	blockers: [{ itemId: 'clp_TEXT', path: 'native', reason: 'text layer requires graphics rendering' }],
	warnings: [{ code: 'VFR', message: 'clip-b.mp4 has a variable frame rate' }],
	estimate: { seconds: 42, bytes: 12_000_000 },
};

describe('Export mode (S05:EX-001…031, S04:EX-005)', () => {
	async function setupExport(plan: RenderPlan = PLAN_REMOTION, caps?: EngineCapabilities) {
		const { session } = await memorySession();
		const { mediaId } = importMedia(session, 'clip-a.mp4', { key: 'mk_CLIPA0001' });
		const seqId = Object.keys(session.getCommitted().sequences)[0]!;
		session.apply({
			label: 'Overwrite',
			origin: 'user',
			commands: [{ type: 'clip.place', sequenceId: seqId, source: { mediaId }, at: 0 }],
		});
		const engine = new ScriptedEngine();
		const planned: unknown[] = [];
		const started: unknown[] = [];
		engine.on((r) => {
			if (caps && r.path === '/api/capabilities') return { body: caps };
			if (r.path === '/api/exports/plan') {
				planned.push(r.body);
				return { body: plan };
			}
			if (r.path === '/api/exports') {
				started.push(r.body);
				return { body: job({ id: 'exp1', kind: 'export', state: 'queued', title: 'Export – Sequence 01' }) };
			}
			return undefined;
		});
		exportMode.open(seqId);
		render(wrap(engine, session, <ExportMode sequenceId={seqId} />));
		return { session, engine, planned, started, seqId };
	}

	it('sends the committed project envelope when requesting an export plan', async () => {
		const { planned, seqId, session } = await setupExport();
		await waitFor(() => expect(planned.length).toBeGreaterThan(0));
		const body = planned[0] as {
			envelope: { format: string; document: { projectId: string } };
			sequenceId: string;
			settings: Record<string, unknown>;
		};
		expect(body.envelope.format).toBe('jasper-project');
		expect(body.envelope.document.projectId).toBe(session.projectId);
		expect(body.sequenceId).toBe(seqId);
		expect(body.settings).toMatchObject({ engine: 'auto', range: { type: 'entire' } });
	});

	it('forcing Native with native blockers disables Export (S04:RP-012, S05:EX-022)', async () => {
		await setupExport();
		await waitFor(() => expect(screen.getByTestId('plan-path')).toBeTruthy());
		fireEvent.change(screen.getByTestId('export-engine'), { target: { value: 'native' } });
		await waitFor(() => expect(screen.getByTestId('plan-blocking')).toBeTruthy());
		expect((screen.getByTestId('export-start') as HTMLButtonElement).disabled).toBe(true);
	});

	it('starts export without a stale plan ID and remembers settings (EX-013/014, RP-011)', async () => {
		const { started, session, seqId } = await setupExport();
		await waitFor(() =>
			expect((screen.getByTestId('export-start') as HTMLButtonElement).disabled).toBe(false),
		);
		await act(async () => {
			fireEvent.click(screen.getByTestId('export-start'));
		});
		await waitFor(() => expect(started).toHaveLength(1));
		// The plan was computed for revision 0; the document is at revision 2, so the engine re-plans (RP-011).
		expect(started[0]).toMatchObject({ sequenceId: seqId });
		expect(started[0]).not.toHaveProperty('planId');
		expect(localStorage.getItem(`jasper.export.${session.projectId}.${seqId}`)).toContain('"engine":"auto"');
	});

	it('uses an available codec when H.264 is unavailable (ARCHITECTURE D-13)', async () => {
		const av1: EncoderChoice = {
			codec: 'av1',
			encoder: 'libsvtav1',
			label: 'AV1 · SVT-AV1 (software)',
			hardware: false,
			container: 'mp4',
			audioEncoder: 'aac',
			rateControl: 'crf',
			gpl: false,
			message: 'H.264 is unavailable (no usable hardware encoder, no OpenH264): exporting AV1 (MP4)',
		};
		const caps: EngineCapabilities = {
			engine: { version: '0.1.0', apiVersion: 1, mode: 'dev', pathRegistration: true },
			media: {
				ffmpegVersion: '6.1.1',
				ffprobeVersion: '6.1.1',
				encoders: ['libx264', 'h264_nvenc', 'libsvtav1', 'libvpx-vp9', 'aac', 'libopus', 'prores_ks'],
				filters: ['overlay'],
				encoding: {
					license: 'gpl',
					lgplOnly: true,
					hwaccels: ['cuda'],
					hardware: [{ encoder: 'h264_nvenc', usable: false, reason: 'Cannot load libcuda.so.1' }],
					codecs: { h264: [], vp9: ['libvpx-vp9'], av1: ['libsvtav1'] },
					audio: { aac: true, opus: true },
					prores: true,
					export: av1,
					proxy: { ...av1, codec: 'vp9', encoder: 'libvpx-vp9', label: 'VP9 · libvpx (software)' },
					message: av1.message,
				},
			},
			render: { native: true, remotionLocal: 'ready', fframes: 'unavailable' },
			fonts: { bundledCatalog: true, systemFonts: false, customUpload: false },
			limits: { maxUploadBytes: null, freeDiskBytes: 1, cpuCount: 12, maxJsonBodyBytes: 20_971_520 },
		};
		const { planned } = await setupExport({ ...PLAN_REMOTION, encoder: av1 }, caps);
		const codec = screen.getByTestId('export-codec') as HTMLSelectElement;
		await waitFor(() => expect(codec.value).toBe('av1'));
		const h264 = [...codec.options].find((o) => o.value === 'h264')!;
		expect(h264.disabled).toBe(true);
		await waitFor(() =>
			expect((planned.at(-1) as { settings: { video: { codec: string } } }).settings.video.codec).toBe('av1'),
		);
	});

	it('disables unusable hardware and GPL encoders in LGPL-only mode (ARCHITECTURE D-13)', async () => {
		const { encoderOptions } = await import('../../src/export/settings.ts');
		const opts = encoderOptions(
			{
				license: 'gpl',
				lgplOnly: true,
				hwaccels: [],
				hardware: [{ encoder: 'h264_nvenc', usable: false, reason: 'Cannot load libcuda.so.1' }],
				codecs: { h264: ['libopenh264'], vp9: [], av1: [] },
				audio: { aac: true, opus: false },
				prores: true,
				export: null,
				proxy: null,
			},
			['h264_nvenc', 'libopenh264', 'libx264'],
			'h264',
		);
		expect(opts.find((o) => o.value === 'h264_nvenc')).toMatchObject({
			available: false,
			reason: expect.stringMatching(/Cannot load libcuda/),
		});
		expect(opts.find((o) => o.value === 'libx264')).toMatchObject({
			available: false,
			reason: expect.stringMatching(/GPL/),
		});
		expect(opts.find((o) => o.value === 'libopenh264')?.available).toBe(true);
	});
});
