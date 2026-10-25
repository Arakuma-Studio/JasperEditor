// Export mode ▸ SOUND ▸ Credits (spec 12 §2.11; wp-note sound-design "Phase 6 → WP6.4"): the control defaults to the
// sequence's sound design setting, else Markdown when a sound needs a credit; the choice reaches the plan and the
// export; the plan's sound warnings (W_SOUND_CREDITS, W_SOUND_CHECK_STALE as information) are shown in the SOUND
// section and not twice in the summary; the finished export's notice and the Jobs panel name the credits file.
import type { EngineJob, ExportSettings, RenderPlan } from '@jasper/api';
import type { EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { ExportMode } from '../src/export/ExportMode.tsx';
import { exportMode } from '../src/export/mode.ts';
import { notices } from '../src/home/notices.tsx';
import { exportResultDetail } from '../src/home/ProjectLifecycle.tsx';
import { buildMediaAsset } from '../src/import/assets.ts';
import { JobsPanel } from '../src/panels/jobs/JobsPanel.tsx';
import { EngineProvider } from '../src/state/engine.tsx';
import { memorySession, registered, ScriptedEngine } from './wp2e/helpers.ts';

afterEach(() => {
	cleanup();
	for (const n of notices.getAll()) notices.dismiss(n.id);
	exportMode.close();
	localStorage.clear();
});

function wrap(engine: ScriptedEngine, session: EditorSession | null, children: ReactNode) {
	return (
		<EngineProvider client={engine.client()}>
			<MemoryRouter initialEntries={['/']}>
				<SessionProvider session={session}>{children}</SessionProvider>
			</MemoryRouter>
		</EngineProvider>
	);
}

const job = (p: Partial<EngineJob> & Pick<EngineJob, 'id' | 'kind' | 'state'>): EngineJob => ({
	title: `${p.kind} job`,
	origin: { type: 'user' },
	progress: null,
	createdAt: '2026-10-17T10:00:00.000Z',
	priority: 'user',
	cpuSlots: 1,
	...p,
});

const plan = (s: ExportSettings): RenderPlan => ({
	planId: 'plan_1',
	documentRevision: 0,
	path: 'native',
	segments: [{ startFrame: 0, endFrame: 30, mode: 'native', graphicsGroups: [] }],
	audio: { mode: 'native-mix' },
	blockers: [],
	warnings: [
		...(s.credits?.sidecar
			? []
			: [
					{
						code: 'W_SOUND_CREDITS',
						message:
							'1 sound heard in this export needs a credit (CC-BY-4.0: "Whoosh") and no credits file is written: choose a Credits format or credit it yourself',
					},
				]),
		{
			code: 'W_SOUND_CHECK_STALE',
			level: 'info',
			message: 'The last Sound Check of this sequence is out of date (the mix changed since)',
		},
	],
	estimate: { seconds: 2, bytes: 1000 },
});

async function setup(opts: { license?: string; credits?: 'txt' | 'md' | 'csv' | null } = {}) {
	const { session } = await memorySession();
	const reg = registered('whoosh.wav', { key: 'mk_WHOOSH001', kind: 'audio', seconds: 1 });
	const seqId = Object.keys(session.getCommitted().sequences)[0]!;
	const r = session.apply({
		label: 'Insert sound',
		origin: 'user',
		commands: [
			{
				type: 'media.register',
				asset: {
					...buildMediaAsset(reg, { id: session.ctx.ids.next('med'), now: 't' }),
					library: {
						soundId: 'snd_00000000000000a1',
						title: 'Whoosh',
						types: ['whoosh'],
						source: { type: 'folder', rootId: 'root_1', relPath: 'whoosh.wav' },
						license: opts.license ?? 'CC-BY-4.0',
						author: 'Ana',
						attribution: '"Whoosh" by Ana (CC BY 4.0)',
					},
				},
				ref: '$m',
			},
			{ type: 'clip.place', sequenceId: seqId, source: { mediaId: '$m' }, at: 0, tracks: { audio: 'A1' } },
			...(opts.credits !== undefined
				? [{ type: 'soundDesign.setSettings' as const, sequenceId: seqId, credits: opts.credits }]
				: []),
		],
	});
	if (!r.ok) throw new Error(r.errors[0]!.message);
	const engine = new ScriptedEngine();
	const planned: { settings: ExportSettings }[] = [];
	const started: { settings: ExportSettings }[] = [];
	engine.on((q) => {
		if (q.path === '/api/exports/plan') {
			const body = q.body as { settings: ExportSettings };
			planned.push(body);
			return { body: plan(body.settings) };
		}
		if (q.path === '/api/exports') {
			started.push(q.body as { settings: ExportSettings });
			return { body: job({ id: 'exp1', kind: 'export', state: 'queued' }) };
		}
		return undefined;
	});
	exportMode.open(seqId);
	render(wrap(engine, session, <ExportMode sequenceId={seqId} />));
	return { session, engine, planned, started, seqId };
}

describe('Export mode ▸ Sound credits (spec 12 §2.11)', () => {
	it('defaults to Markdown when a used sound needs a credit; Off brings the warning, CSV goes to the export', async () => {
		const { planned, started } = await setup();
		const select = (await screen.findByTestId('export-credits')) as HTMLSelectElement;
		expect(select.value).toBe('md');
		await waitFor(() => expect(planned.at(-1)?.settings.credits).toEqual({ sidecar: 'md' }));
		// the stale Sound Check is information; no credits warning with a file chosen
		const sound = await screen.findByTestId('export-sound-warnings');
		await waitFor(() =>
			expect(
				within(sound)
					.getAllByRole('listitem')
					.map((li) => li.getAttribute('data-code')),
			).toEqual(['W_SOUND_CHECK_STALE']),
		);
		fireEvent.change(select, { target: { value: 'off' } });
		await waitFor(() => expect(planned.at(-1)?.settings.credits).toBeUndefined());
		await within(screen.getByTestId('export-sound-warnings')).findByText(/needs a credit/);
		// shown once: not repeated in the summary's warning list
		expect(
			screen.queryByTestId('plan-warnings')
				? within(screen.getByTestId('plan-warnings')).queryByText(/needs a credit/)
				: null,
		).toBeNull();
		fireEvent.change(select, { target: { value: 'csv' } });
		await waitFor(() => expect(planned.at(-1)?.settings.credits).toEqual({ sidecar: 'csv' }));
		await waitFor(() =>
			expect((screen.getByTestId('export-start') as HTMLButtonElement).disabled).toBe(false),
		);
		await act(async () => {
			fireEvent.click(screen.getByTestId('export-start'));
		});
		await waitFor(() => expect(started).toHaveLength(1));
		expect(started[0]!.settings.credits).toEqual({ sidecar: 'csv' });
	});

	it('follows the sequence setting (Text; null = Off) and is Off for CC0 sounds', async () => {
		await setup({ credits: 'txt' });
		expect(((await screen.findByTestId('export-credits')) as HTMLSelectElement).value).toBe('txt');
		cleanup();
		await setup({ credits: null });
		expect(((await screen.findByTestId('export-credits')) as HTMLSelectElement).value).toBe('off');
		cleanup();
		const { planned } = await setup({ license: 'CC0-1.0' });
		expect(((await screen.findByTestId('export-credits')) as HTMLSelectElement).value).toBe('off');
		await waitFor(() => expect(planned.length).toBeGreaterThan(0));
		expect(planned.at(-1)!.settings.credits).toBeUndefined();
	});

	it('the finished export names the credits file (notice detail, Jobs panel link)', async () => {
		const detail = exportResultDetail({
			credits: { format: 'md', count: 2, name: 'output.credits.md' },
			warnings: [
				{ code: 'W_SOUND_CHECK_STALE', message: 'Stale check.' },
				{ code: 'X', message: 'other' },
			],
		});
		expect(detail).toContain('2');
		expect(detail).toContain('Stale check.');
		expect(detail).not.toContain('other');
		expect(exportResultDetail({ credits: { format: 'md', count: 0 } })).toMatch(/no credits file/i);
		expect(exportResultDetail({})).toBeUndefined();
		expect(exportResultDetail(null)).toBeUndefined();
		const { session } = await memorySession();
		const engine = new ScriptedEngine();
		engine.jobs = [
			job({
				id: 'e1',
				kind: 'export',
				state: 'succeeded',
				projectId: session.projectId,
				result: {
					downloadUrl: '/renders/e1/output',
					byteSize: 1,
					durationSec: 1,
					frames: 30,
					credits: { format: 'md', scope: 'all', count: 1, name: 'output.credits.md', url: '/x' },
				},
			}),
		];
		render(wrap(engine, session, <JobsPanel instanceId="jobs" visible />));
		const row = await screen.findByTestId('job-row');
		const link = await within(row).findByText('credits.md');
		expect(link.getAttribute('href')).toContain('/renders/e1/credits/output.credits.md');
	});
});
