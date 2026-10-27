// Fix Transcript… (spec 17 SC-081) against a fake engine: disabled with the reason (no script and no glossary; no
// speech model — the dry run still counts), the dry run summary (alignment, candidates by group and category, the
// estimate with its basis, subtitles a fix cannot update), settings saved with the sequence in one coalesced undo
// step and followed by a new dry run, Run with progress → the proposal opens in Review, Cancel cancels the job, and
// every refusal code of the route and the job shown in words.
import type { EngineJob, TranscriptFixResult } from '@jasper/api';
import { readSequenceScriptFix } from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { closeAllDialogs, DialogHost, openDialog } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	FIX_TRANSCRIPT_DIALOG,
	registerFixTranscriptDialog,
} from '../src/script-fix/FixTranscriptDialog.tsx';
import { fixSession } from './script-fix-helpers.ts';

const openReview = vi.fn(async () => true);
vi.mock('../src/proposals/actions.ts', async (orig) => ({
	...((await orig()) as Record<string, unknown>),
	openReview: (...a: unknown[]) => openReview(...(a as [])),
}));

beforeAll(() => registerFixTranscriptDialog());
afterEach(() => {
	closeAllDialogs();
	cleanup();
	openReview.mockClear();
});

async function chooseOption(trigger: HTMLElement, name: string) {
	await act(async () => {
		fireEvent.keyDown(trigger, { key: 'Enter' });
	});
	const option = await screen.findByRole('option', { name });
	await act(async () => {
		fireEvent.keyDown(option, { key: 'Enter' });
	});
}

function result(mode: 'dryRun' | 'propose', extra: Partial<TranscriptFixResult> = {}): TranscriptFixResult {
	return {
		mode,
		projectId: 'p',
		sequenceId: 's',
		proposalId: mode === 'propose' ? 'prp_1' : null,
		itemCount: mode === 'propose' ? 3 : 0,
		revision: 3,
		report: {
			settings: {
				sources: ['script', 'glossary'],
				scope: 'recordings',
				strictness: 'standard',
				showRejected: false,
			},
			sourcesUsed: ['script', 'glossary'],
			perMedia: [
				{
					mediaId: 'm',
					transcriptId: 't',
					name: 'take.wav',
					language: 'es',
					words: 10,
					wordsInScope: 10,
					alignment: {
						transcriptTokens: 10,
						scriptTokens: 12,
						alignedShare: 0.8,
						offScriptShare: 0.1,
						retakeJumps: 0,
						unusedLines: [],
					},
					candidates: 3,
					windows: 1,
					readings: 3,
				},
			],
			candidates: {
				total: 3,
				byGroup: mode === 'dryRun' ? { spelling: 1, pending: 2 } : { fix: 1, spelling: 1, maybe: 1 },
				byCategory: { proper: 2, function: 1 },
				byKind: { merge: 1, join: 1, sub: 1 },
			},
			decisions: [],
			decisionsTruncated: false,
			skipped: {},
			unusedLines: [],
			patch: {
				edits: 3,
				patched: 1,
				skipped: [{ clipId: 'c1', sequenceId: 's', kind: 'subtitle', reason: 'edited' }],
				stale: 0,
			},
			speech: { model: 'whisper-tiny' },
			device: null,
			estimate: { seconds: 42, windows: 1, readings: 3, basis: 'reference', note: '' },
			timings: { readMs: 1, alignMs: 1, scoreMs: 0, decideMs: 1, totalMs: 3, speechSeconds: 3 },
			warnings: [],
		},
		...extra,
	} as TranscriptFixResult;
}

const job = (state: EngineJob['state'], over: Partial<EngineJob> = {}): EngineJob => ({
	id: 'job_1',
	kind: 'transcript-fix',
	title: 'Fix transcript',
	origin: { type: 'user' },
	state,
	progress: null,
	createdAt: '2026-10-27T00:00:00.000Z',
	priority: 'user',
	cpuSlots: 1,
	...over,
});

type Req = { body: Record<string, unknown>; opts?: { wait?: boolean } };

function fakeEngine(o: {
	models?: { id: string; installed: boolean }[];
	glossary?: number;
	refuse?: { dryRun?: string; propose?: string };
}) {
	const requests: Req[] = [];
	const cancelled: string[] = [];
	let polls = 0;
	const engine = {
		async transcriptFix(_p: string, _s: string, body: Record<string, unknown>, opts?: { wait?: boolean }) {
			requests.push({ body, opts });
			const refusal = body.mode === 'dryRun' ? o.refuse?.dryRun : o.refuse?.propose;
			if (refusal) throw Object.assign(new Error(`refused ${refusal}`), { code: refusal });
			if (body.mode === 'dryRun') return job('succeeded', { result: result('dryRun') });
			polls = 0;
			return job('running', { progress: 0.1, stage: 'Checking against the audio' });
		},
		async getJob() {
			polls++;
			return polls < 2
				? job('running', { progress: 0.5, stage: 'Checking against the audio' })
				: job('succeeded', { progress: 1, result: result('propose') });
		},
		async cancelJob(id: string) {
			cancelled.push(id);
			return job('cancelled');
		},
		async call() {
			return {
				models: (o.models ?? [{ id: 'whisper-tiny', installed: true }]).map((m) => ({
					...m,
					multilingual: true,
				})),
			};
		},
		async listGlossary() {
			return { entries: Array.from({ length: o.glossary ?? 0 }, (_, i) => ({ id: `g${i}` })) };
		},
	};
	return { engine, requests, cancelled };
}

function setup(opts: { script?: boolean; engine: ReturnType<typeof fakeEngine> }) {
	const f = fixSession();
	if (opts.script) {
		const r = f.session.apply({
			label: 'script',
			origin: 'user',
			sequenceId: f.seqId,
			commands: [
				{
					type: 'cleanup.configure',
					sequenceId: f.seqId,
					script: { name: 'Guion', text: 'INTRO\nHoy probamos Glimmerbox en NovaPlay y una demo.' },
				},
			] as never[],
		});
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
	}
	render(
		<SessionProvider session={f.session}>
			<DialogHost />
		</SessionProvider>,
	);
	act(() => {
		void openDialog(FIX_TRANSCRIPT_DIALOG, {
			session: f.session,
			engine: opts.engine.engine as never,
			sequenceId: f.seqId,
		});
	});
	const dialog = () => screen.getByTestId('fix-transcript-dialog');
	const run = () => within(dialog()).getByRole('button', { name: 'Fix Transcript' }) as HTMLButtonElement;
	return { ...f, dialog, run };
}

describe('Fix Transcript dialog (SC-081)', () => {
	it('is disabled with the reason when there is no script and no glossary', async () => {
		const e = fakeEngine({ glossary: 0 });
		const { run } = setup({ engine: e });
		await waitFor(() =>
			expect(screen.getByTestId('fix-blocker').textContent).toMatch(/Attach the video script/),
		);
		expect(run().disabled).toBe(true);
		expect(e.requests).toEqual([]);
	});

	it('runs the dry run and shows its summary; without a speech model Run is disabled with the reason', async () => {
		const e = fakeEngine({ glossary: 2, models: [{ id: 'whisper-tiny', installed: false }] });
		const { run } = setup({ script: true, engine: e });
		await screen.findByTestId('fix-dry-summary', {}, { timeout: 3000 });
		expect(e.requests[0]!.body).toEqual({
			sources: ['script', 'glossary'],
			scope: 'recordings',
			strictness: 'standard',
			showRejected: false,
			mode: 'dryRun',
		});
		expect(e.requests[0]!.opts?.wait).toBe(true);
		expect(screen.getByTestId('fix-dry-alignment').textContent).toContain(
			'80 % of the transcript follows the script',
		);
		expect(screen.getByTestId('fix-dry-candidates').textContent).toBe(
			'3 possible fixes: Spelling 1 · To check against the audio 2',
		);
		expect(screen.getByTestId('fix-dry-categories').textContent).toBe('Names 2 · Short words 1');
		expect(screen.getByTestId('fix-dry-estimate').textContent).toMatch(
			/≈ 42 s .*estimated from a reference machine/,
		);
		expect(screen.getByTestId('fix-dry-skipped').textContent).toMatch(
			/1 subtitles? could not be updated.*edited by hand/,
		);
		expect(screen.getByTestId('fix-script-summary').textContent).toMatch(/headings? skipped/);
		expect(screen.getByTestId('fix-blocker').textContent).toMatch(/No speech model is installed/);
		expect(run().disabled).toBe(true);
	});

	it('saves the settings with the sequence in one undo step and dry-runs again', async () => {
		const e = fakeEngine({ glossary: 2 });
		const { session, seq } = setup({ script: true, engine: e });
		await screen.findByTestId('fix-dry-summary', {}, { timeout: 3000 });
		const entries = session.getState().history.entries.length;
		await chooseOption(
			screen.getByRole('combobox', { name: 'Strictness' }),
			'Careful: only fixes the audio clearly supports',
		);
		act(() => {
			fireEvent.click(screen.getByRole('checkbox', { name: 'Personal glossary (2 entries)' }));
		});
		expect(readSequenceScriptFix(seq()).settings).toEqual({
			strictness: 'careful',
			sources: ['script'],
			scope: 'recordings',
		});
		expect(session.getState().history.entries.length).toBe(entries + 1);
		await waitFor(
			() => expect(e.requests.at(-1)!.body).toMatchObject({ strictness: 'careful', sources: ['script'] }),
			{
				timeout: 3000,
			},
		);
		act(() => session.undo());
		expect(readSequenceScriptFix(seq()).settings).toBeUndefined();
	});

	it('Run follows the job with progress and opens the proposal in Review', async () => {
		const e = fakeEngine({ glossary: 2 });
		const { run } = setup({ script: true, engine: e });
		await screen.findByTestId('fix-dry-summary', {}, { timeout: 3000 });
		await waitFor(() => expect(run().disabled).toBe(false));
		act(() => {
			fireEvent.click(run());
		});
		await screen.findByTestId('fix-progress');
		expect(screen.getByTestId('fix-progress-text').textContent).toMatch(/Checking against the audio/);
		await waitFor(() => expect(openReview).toHaveBeenCalledWith(expect.anything(), 'prp_1'), {
			timeout: 3000,
		});
		expect(e.requests.at(-1)!.body.mode).toBe('propose');
		await waitFor(() => expect(screen.queryByTestId('fix-transcript-dialog')).toBeNull());
	});

	it('Cancel while running cancels the job', async () => {
		const e = fakeEngine({ glossary: 2 });
		const { run, dialog } = setup({ script: true, engine: e });
		await screen.findByTestId('fix-dry-summary', {}, { timeout: 3000 });
		await waitFor(() => expect(run().disabled).toBe(false));
		act(() => {
			fireEvent.click(run());
		});
		await screen.findByTestId('fix-progress');
		act(() => {
			fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
		});
		await waitFor(() => expect(e.cancelled).toEqual(['job_1']), { timeout: 3000 });
		expect(openReview).not.toHaveBeenCalled();
	});

	it('shows a refusal of the run without blanking the dialog', async () => {
		const e = fakeEngine({ glossary: 2, refuse: { propose: 'E_NO_SPEECH_MODEL' } });
		const { run } = setup({ script: true, engine: e });
		await screen.findByTestId('fix-dry-summary', {}, { timeout: 3000 });
		await waitFor(() => expect(run().disabled).toBe(false));
		act(() => {
			fireEvent.click(run());
		});
		expect((await screen.findByTestId('fix-message')).textContent).toMatch(/No installed speech model fits/);
	});

	it('shows a dry-run refusal in words', async () => {
		const e = fakeEngine({ glossary: 2, refuse: { dryRun: 'E_NO_TRANSCRIPT' } });
		setup({ script: true, engine: e });
		expect((await screen.findByTestId('fix-dry-error', {}, { timeout: 3000 })).textContent).toMatch(
			/No transcribed words in the chosen scope/,
		);
	});
});
