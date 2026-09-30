import type { EngineJob, RenderPlan } from '@jasper/api';
import type { EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
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
	it('lists engine projects, creates one with a preset through the New Project dialog and opens it', async () => {
		const engine = new ScriptedEngine();
		const created: unknown[] = [];
		engine.on((r) => {
			if (r.path === '/api/projects' && r.method === 'GET')
				return {
					body: {
						projects: [
							{
								projectId: 'prj_A',
								name: 'Old',
								modifiedAt: '2026-09-01T00:00:00.000Z',
								thumbnail: null,
								schemaVersion: 1,
								sizeBytes: 1,
								revision: 3,
							},
							{
								projectId: 'prj_B',
								name: 'Newer',
								modifiedAt: '2026-09-29T00:00:00.000Z',
								thumbnail: null,
								schemaVersion: 1,
								sizeBytes: 1,
								revision: 9,
							},
						],
					},
				};
			if (r.path === '/api/projects' && r.method === 'POST') {
				created.push(r.body);
				return { body: { projectId: 'prj_NEW' } };
			}
			return undefined;
		});
		render(
			<EngineProvider client={engine.client()} connectEvents={false}>
				<MemoryRouter initialEntries={['/']}>
					<Routes>
						<Route path="/" element={<Home />} />
						<Route path="/project/:id" element={<p data-testid="opened">opened</p>} />
					</Routes>
				</MemoryRouter>
			</EngineProvider>,
		);
		await waitFor(() => expect(screen.getAllByTestId('project-card')).toHaveLength(2));
		expect(screen.getAllByTestId('project-card').map((c) => c.textContent)).toEqual([
			expect.stringContaining('Newer'),
			expect.stringContaining('Old'),
		]);
		fireEvent.click(screen.getByTestId('home-new'));
		fireEvent.change(screen.getByTestId('new-project-name'), { target: { value: 'My Film' } });
		fireEvent.change(screen.getByTestId('new-project-preset'), { target: { value: 'hd-1080p-25' } });
		fireEvent.click(screen.getByTestId('new-project-create'));
		await waitFor(() => expect(screen.getByTestId('opened')).toBeTruthy());
		expect(created).toEqual([{ name: 'My Film', preset: 'hd-1080p-25' }]);
	});

	it('shows the three-step empty state when the engine has no projects, and deletes with confirmation', async () => {
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
		fireEvent.click(screen.getByTestId('confirm-delete-project'));
		await waitFor(() => expect(screen.getByTestId('home-empty')).toBeTruthy());
		expect(screen.getByTestId('home-empty').textContent).toMatch(/Create.*Import.*Edit/);
	});
});

describe('Project panel (S05:PRJ-001…010)', () => {
	it('lists media with derived columns, supports bins, breadcrumb navigation and search', async () => {
		const { session } = await memorySession();
		importMedia(session, 'clip-a.mp4', { key: 'mk_CLIPA0001' });
		importMedia(session, 'tone.wav', { kind: 'audio', seconds: 4 });
		const engine = new ScriptedEngine();
		render(
			wrap(
				engine,
				session,
				<>
					<ProjectPanel instanceId="project-1" visible />
					<ProjectDialogHost />
				</>,
			),
		);
		const rows = () => screen.getAllByTestId('project-row');
		// Default project has one sequence item + two media items.
		expect(rows()).toHaveLength(3);
		const clip = rows().find((r) => r.textContent?.includes('clip-a.mp4'))!;
		expect(clip.textContent).toContain('30 fps');
		expect(clip.textContent).toContain('1920 x 1080 (1.0)');
		expect(clip.textContent).toContain('48000 Hz - Stereo');
		expect(clip.textContent).toContain('00:00:10:00');
		expect(screen.getByTestId('project-count').textContent).toBe('3 items');

		// New Bin → inline rename → Enter
		fireEvent.click(screen.getByTestId('project-new-bin'));
		const input = await screen.findByTestId('project-rename');
		fireEvent.change(input, { target: { value: 'Footage' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		const doc = session.getCommitted();
		const bin = Object.values(doc.items).find((i) => i.kind === 'bin')!;
		expect(bin.name).toBe('Footage');
		expect(
			session
				.getState()
				.history.entries.map((e) => e.label)
				.slice(-2),
		).toEqual(['New Bin', 'Rename']);

		// Drag clip onto the bin row → item.move
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
		expect((session.getCommitted().items[bin.id] as { children: string[] }).children).toEqual([clipItem.id]);
		expect(rows()).toHaveLength(3); // sequence, wav, bin

		// Double-click the bin → breadcrumb shows project ▸ Footage
		fireEvent.doubleClick(rows().find((r) => r.getAttribute('data-item-id') === bin.id)!);
		await waitFor(() => expect(screen.getByTestId('project-breadcrumb').textContent).toContain('Footage'));
		expect(rows().map((r) => r.getAttribute('data-item-id'))).toEqual([clipItem.id]);
		fireEvent.click(within(screen.getByTestId('project-breadcrumb')).getByText('Film'));

		// Search is flat across bins
		fireEvent.change(screen.getByTestId('project-search'), { target: { value: 'clip' } });
		expect(rows().map((r) => r.getAttribute('data-item-id'))).toEqual([clipItem.id]);
		fireEvent.change(screen.getByTestId('project-search'), { target: { value: '' } });
		fireEvent.change(screen.getByTestId('project-filter'), { target: { value: 'audio' } });
		expect(rows()).toHaveLength(1);
		expect(rows()[0]!.textContent).toContain('tone.wav');
	});

	it('writes the shared DragPayload when items are dragged out', async () => {
		const { session } = await memorySession();
		const { itemId } = importMedia(session, 'clip-a.mp4');
		render(wrap(new ScriptedEngine(), session, <ProjectPanel instanceId="p" visible />));
		const row = screen.getAllByTestId('project-row').find((r) => r.getAttribute('data-item-id') === itemId)!;
		const data: Record<string, string> = {};
		fireEvent.dragStart(row, {
			dataTransfer: { setData: (t: string, v: string) => (data[t] = v), effectAllowed: '' },
		});
		expect(JSON.parse(data[PROJECT_ITEMS_MIME]!)).toEqual({
			type: 'jasper/project-items',
			itemIds: [itemId],
		});
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
		expect(dialog.textContent).toMatch(/2 clips in 1 sequences use this media/);
		expect(session.getCommitted().items[itemId]).toBeTruthy();
		fireEvent.click(screen.getByTestId('confirm-ok'));
		expect(session.getCommitted().items[itemId]).toBeUndefined();
		expect(Object.keys(session.getCommitted().sequences[seqId]!.clips)).toHaveLength(0);
	});

	it('icon view shows engine posters, durations, status and a New Sequence dialog with presets', async () => {
		const { session } = await memorySession();
		const { mediaId } = importMedia(session, 'clip-a.mp4', { key: 'mk_CLIPA0001' });
		session.setMediaRuntime(mediaId, { availability: 'online', posterUrl: '/media/mk_CLIPA0001/poster.jpg' });
		const off = importMedia(session, 'gone.mp4', { key: 'mk_GONE00001' });
		session.setMediaRuntime(off.mediaId, { availability: 'offline' });
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
		fireEvent.click(screen.getByTestId('project-icon-view'));
		const tiles = screen.getAllByTestId('project-tile');
		const tile = tiles.find((t) => t.textContent?.includes('clip-a.mp4'))!;
		expect(tile.querySelector('img')!.getAttribute('src')).toBe('/media/mk_CLIPA0001/poster.jpg');
		expect(tile.textContent).toContain('00:00:10:00');
		expect(tiles.find((t) => t.textContent?.includes('gone.mp4'))!.textContent).toContain('Media Offline');

		fireEvent.click(screen.getByTestId('project-new-item'));
		fireEvent.click(screen.getByTestId('new-item-sequence'));
		fireEvent.change(screen.getByTestId('new-sequence-preset'), {
			target: { value: 'vertical-1080x1920-30' },
		});
		fireEvent.click(screen.getByTestId('new-sequence-ok'));
		const seqs = Object.values(session.getCommitted().sequences);
		expect(seqs).toHaveLength(2);
		expect(seqs[1]!.settings).toMatchObject({ width: 1080, height: 1920 });
		expect(session.getState().activeSequenceId).toBe(seqs[1]!.id);
	});
});

describe('media runtime sync (S01:LIFE-050)', () => {
	it('resolves engine status and applies derivative.ready / job events', async () => {
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
		await waitFor(() => expect(session.getState().media[mediaId]?.peaks.state).toBe('running'));
		expect(session.getState().media[mediaId]).toMatchObject({
			availability: 'online',
			playbackUrl: '/media/mk_CLIPA0001',
		});
		const emit = (e: unknown) => {
			for (const l of listeners) (l as (e: unknown) => void)(e);
		};
		emit({
			id: 1,
			type: 'derivative.ready',
			createdAt: 't',
			payload: { mediaKey: 'mk_CLIPA0001', kind: 'poster', url: '/media/mk_CLIPA0001/poster.jpg' },
		});
		emit({
			id: 2,
			type: 'derivative.ready',
			createdAt: 't',
			payload: { mediaKey: 'mk_CLIPA0001', kind: 'sprite', url: '/media/mk_CLIPA0001/sprite.json' },
		});
		const job: Partial<EngineJob> = {
			id: 'j1',
			kind: 'proxy',
			state: 'running',
			progress: 0.25,
			assetId: 'mk_CLIPA0001',
		};
		emit({ id: 3, type: 'job.updated', createdAt: 't', payload: job });
		const rt = session.getState().media[mediaId]!;
		expect(rt.posterUrl).toBe('/media/mk_CLIPA0001/poster.jpg');
		expect(rt.thumbs.state).toBe('ready');
		expect(rt.spriteUrl).toBe('/media/mk_CLIPA0001/sprite.json');
		expect(rt.proxy).toMatchObject({ state: 'running', progress: 0.25 });
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
	it('groups jobs, shows progress, cancels, and offers Download for finished exports', async () => {
		const { session } = await memorySession();
		const engine = new ScriptedEngine();
		engine.jobs = [
			job({
				id: 'e1',
				kind: 'export',
				state: 'running',
				progress: 0.4,
				etaSec: 30,
				stage: 'Encoding',
				projectId: session.projectId,
				title: 'Export – Sequence 01',
			}),
			job({
				id: 'e2',
				kind: 'export',
				state: 'succeeded',
				progress: 1,
				projectId: session.projectId,
				title: 'Export – Done',
			}),
			job({ id: 'p1', kind: 'poster', state: 'succeeded', progress: 1, projectId: session.projectId }),
		];
		engine.on((r) =>
			r.path === '/api/jobs/e1/cancel' ? { body: { ...engine.jobs[0], state: 'cancelling' } } : undefined,
		);
		clientJobs.add({ kind: 'upload', title: 'Upload – clip-a.mp4', progress: 0.5 });
		render(wrap(engine, session, <JobsPanel instanceId="jobs" visible />));
		await waitFor(() => expect(screen.getAllByTestId('job-row').length).toBe(3));
		expect(screen.getByTestId('jobs-group-exports')).toBeTruthy();
		expect(screen.getByTestId('jobs-group-uploads')).toBeTruthy();
		// Media analysis is collapsed by default.
		expect(within(screen.getByTestId('jobs-group-media')).queryAllByTestId('job-row')).toHaveLength(0);
		const running = screen.getAllByTestId('job-row').find((r) => r.getAttribute('data-job-id') === 'e1')!;
		expect(running.textContent).toContain('Running 40%');
		expect(running.textContent).toContain('Encoding');
		expect(running.textContent).toContain('30s left');
		fireEvent.click(within(running).getByTestId('job-cancel'));
		await waitFor(() =>
			expect(engine.requests.some((r) => r.path === '/api/jobs/e1/cancel' && r.method === 'POST')).toBe(true),
		);
		const done = screen.getAllByTestId('job-row').find((r) => r.getAttribute('data-job-id') === 'e2')!;
		expect(within(done).getByTestId('job-download').getAttribute('href')).toBe('/renders/e2/output');
		expect(screen.getByTestId('jobs-summary').textContent).toContain('2 running');
	});

	it('shows running engine jobs as Stalled when the engine is disconnected (JOB-005)', async () => {
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
	async function setupExport(plan: RenderPlan = PLAN_REMOTION) {
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

	it('plans with the committed envelope and shows path, blockers, warnings and estimates', async () => {
		const { planned, seqId, session } = await setupExport();
		await waitFor(() =>
			expect(screen.getByTestId('plan-path').textContent).toContain(
				'Auto → Remotion: text layer requires graphics rendering',
			),
		);
		const body = planned[0] as {
			envelope: { format: string; document: { projectId: string } };
			sequenceId: string;
			settings: Record<string, unknown>;
		};
		expect(body.envelope.format).toBe('jasper-project');
		expect(body.envelope.document.projectId).toBe(session.projectId);
		expect(body.sequenceId).toBe(seqId);
		expect(body.settings).toMatchObject({
			container: 'mp4',
			engine: 'auto',
			range: { type: 'entire' },
			video: { codec: 'h264', width: 1920, height: 1080 },
		});
		expect(screen.getByTestId('plan-blockers').textContent).toContain(
			'text layer requires graphics rendering',
		);
		expect(screen.getByTestId('plan-warnings').textContent).toContain('variable frame rate');
		expect(screen.getByTestId('plan-summary').textContent).toContain('Size depends on content (~12 MB)');
		expect((screen.getByTestId('export-start') as HTMLButtonElement).disabled).toBe(false);
	});

	it('forcing Native with native blockers disables Export (S04:RP-012, S05:EX-022)', async () => {
		await setupExport();
		await waitFor(() => expect(screen.getByTestId('plan-path')).toBeTruthy());
		fireEvent.change(screen.getByTestId('export-engine'), { target: { value: 'native' } });
		await waitFor(() => expect(screen.getByTestId('plan-blocking')).toBeTruthy());
		expect((screen.getByTestId('export-start') as HTMLButtonElement).disabled).toBe(true);
	});

	it('Export starts a job, leaves Export mode and remembers the choices (EX-013/014)', async () => {
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
		expect(exportMode.get().open).toBe(false);
		await waitFor(() =>
			expect(notices.getAll().some((n) => n.message.startsWith('Export started'))).toBe(true),
		);
		expect(localStorage.getItem(`jasper.export.${session.projectId}.${seqId}`)).toContain('"engine":"auto"');
	});
});
