// The Review panel's Sound Check of the proposal (spec 12 §4 P6-E5; wp-note "Phase 6 → WP-E2") on a real session with
// the fake proposals engine: "Check proposal" runs the engine's check with the proposal and the items not rejected;
// "Sound Check of this proposal: fixes 1 · introduces 2" with each introduced finding linked to its item (click: that
// item), the badges per row and the item's findings in the details; a check an agent stored on the proposal
// (`report.check`) shows the same way; stale when the mix changes or a decision changes which items it covers; the
// pure helpers (items, status, per-item findings).
import type { SoundCheckProposal, SoundCheckProposalSummary, SoundCheckRequest } from '@jasper/api';
import { mixFingerprint, type Proposal, soundCheckMessage } from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { closeAllDialogs, DialogHost } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resultFixture } from '../../mcp/test/sound-check-report-fixture.ts';
import { registerAllCommands } from '../src/commands/index.ts';
import { ReviewPanel } from '../src/panels/review/ReviewPanel.tsx';
import {
	itemCheck,
	itemCheckText,
	proposalCheckItems,
	proposalCheckStatus,
	proposalCheckStore,
	storedProposalCheck,
} from '../src/proposals/sound-check.ts';
import { proposalFixture } from './proposal-helpers.ts';

beforeAll(() => registerAllCommands());
afterEach(() => {
	cleanup();
	closeAllDialogs();
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

function delta(proposalId: string, baseMixHash: string, itemIds: string[]): SoundCheckProposal {
	const finding = (key: string, code: string, severity: 'error' | 'warning', items: string[], frame?: number) => ({
		key,
		code: code as never,
		severity,
		...(frame !== undefined ? { frame, timecode: `00:00:0${Math.floor(frame / 30)}:00` } : {}),
		message: soundCheckMessage('repeat', 'Hit', '00:00:01:00', '00:00:06:20'),
		itemId: items[0] ?? null,
		itemIds: items,
	});
	return {
		proposalId,
		itemIds,
		skipped: [{ itemId: 'nope', state: 'invalid', reason: 'E_NOT_FOUND: Track not found: A9' }],
		base: 'kept',
		baseJobId: 'job_base',
		revision: 1,
		baseMixHash,
		delta: {
			verdict: { before: 'warn', after: 'fail' },
			counts: { MASKED: { before: 1, after: 0 }, REPEAT: { before: 0, after: 1 } },
			fixed: [{ ...finding('MASKED:clp_bed', 'MASKED', 'warning', ['hit'], 30), message: soundCheckMessage('maskedSupport', 'Hit', '00:00:01:00', 1.2, 1000, 1.5) }],
			introduced: [
				finding('REPEAT:clp_boom', 'REPEAT', 'warning', ['boom'], 200),
				{ ...finding('TRUE_PEAK:mix', 'TRUE_PEAK', 'error', []), message: soundCheckMessage('truePeak', -0.2, 'Web', -1) },
			],
			fixedCount: 1,
			introducedCount: 2,
			items: [
				{ itemId: 'hit', fixes: ['MASKED:clp_bed'], introduces: [] },
				{ itemId: 'boom', fixes: [], introduces: ['REPEAT:clp_boom'] },
			],
		},
	};
}

async function setup() {
	const f = await proposalFixture();
	const checks: SoundCheckRequest[] = [];
	const jobs = new Map<string, unknown>();
	// the engine's proposal check: a job whose result carries the delta (the fake engine of the session package has none)
	Object.assign(f.engine, {
		async soundCheck(req: SoundCheckRequest) {
			checks.push(req);
			const id = `job_${checks.length}`;
			const base = mixFingerprint(f.session.getCommitted(), f.seqId);
			jobs.set(id, {
				...resultFixture({ projectId: f.session.projectId, sequenceId: f.seqId }),
				proposal: delta(req.proposalId!, base, [...(req.itemIds ?? [])]),
			});
			return { id, kind: 'sound-check', state: 'running', progress: 0.3, stage: 'Proposal: Rendering the stems' };
		},
		async getJob(id: string) {
			return { id, kind: 'sound-check', state: 'succeeded', progress: 1, result: jobs.get(id) };
		},
		async cancelJob(id: string) {
			return { id, state: 'cancelled' };
		},
	});
	// the panel's engine is the session's when no engine provider is mounted
	(f.session as unknown as { engine: unknown }).engine = f.engine;
	render(
		<SessionProvider session={f.session}>
			<ReviewPanel instanceId="r1" visible />
			<DialogHost />
		</SessionProvider>,
	);
	await settle();
	const row = (id: string) => document.querySelector(`[data-review-row="${id}"]`) as HTMLElement;
	return { ...f, checks, row };
}

describe('Review panel: Sound Check of the proposal', () => {
	it('Check proposal runs the check of the items not rejected; the summary, the introduced findings by item, the row badges and the details', async () => {
		const t = await setup();
		proposalCheckStore(t.session).setState({ last: null, running: null, error: null });
		const bar = screen.getByTestId('review-check');
		expect(within(bar).getByTestId('review-check-summary').textContent).toBe(
			'Sound Check of this proposal: not run yet',
		);
		expect(bar.getAttribute('data-check-state')).toBe('none');
		// reject one: it is left out of the check
		t.c.setItemDecision(['move'], 'reject');
		await settle();
		await act(async () => {
			fireEvent.click(within(bar).getByTestId('review-check-run'));
		});
		await waitFor(() => expect(t.checks).toHaveLength(1));
		expect(t.checks[0]).toMatchObject({
			projectId: t.session.projectId,
			sequenceId: t.seqId,
			proposalId: t.p.id,
			itemIds: ['trk', 'hit', 'boom', 'cue'],
		});
		expect(t.checks[0]!.store).toBeUndefined();
		await waitFor(() =>
			expect(within(bar).getByTestId('review-check-summary').textContent).toContain(
				'Sound Check of this proposal: fixes 1 · introduces 2',
			),
		);
		expect(bar.getAttribute('data-check-state')).toBe('current');
		expect(within(bar).getByTestId('review-check-run').textContent).toBe('Check again');
		// the introduced findings, each linked to its item (the whole mix when none)
		const list = within(bar).getByTestId('review-check-introduced');
		expect(list.textContent).toContain('REPEAT');
		expect(list.textContent).toContain('the whole mix');
		await act(async () => {
			fireEvent.click(within(list).getByText('→ Boom'));
		});
		expect(t.c.getState().selection).toEqual(['boom']);
		// the rows: badges by shape and word
		expect(t.row('hit').querySelector('[data-review-check]')!.textContent).toBe('✓ fixes 1');
		expect(t.row('boom').querySelector('[data-review-check]')!.textContent).toBe('▲ introduces 1');
		expect(t.row('cue').querySelector('[data-review-check]')).toBeNull();
		expect(t.row('boom').getAttribute('aria-label')).toMatch(/Sound Check: introduces 1$/);
		// the details of the current item
		const details = screen.getByTestId('review-details');
		expect(within(details).getByTestId('review-item-check').textContent).toMatch(/^Introduces REPEAT/);
		expect(within(bar).getByText(/Not checked: /).textContent).toContain('nope');
		// a decision that changes what it would cover: stale
		t.c.setItemDecision(['move'], 'clear');
		await settle();
		expect(bar.getAttribute('data-check-state')).toBe('stale');
		expect(within(bar).getByTestId('review-check-stale').textContent).toContain(
			'your decisions changed which items it covers',
		);
	});

	it('a check an agent stored on the proposal shows; the mix changing makes it stale', async () => {
		const t = await setup();
		proposalCheckStore(t.session).setState({ last: null, running: null, error: null });
		const base = mixFingerprint(t.session.getCommitted(), t.seqId);
		const kept: SoundCheckProposalSummary = {
			...delta(t.p.id, base, ['trk', 'hit', 'boom', 'move', 'cue']),
			jobId: 'job_agent',
			at: '2026-10-18T10:00:00.000Z',
			sequenceId: t.seqId,
		};
		const stored = (t.engine as unknown as { proposals: Map<string, Proposal> }).proposals.get(t.p.id)!;
		await act(async () => {
			(t.engine as unknown as { put(p: Proposal, c: string): Proposal }).put(
				{ ...stored, report: { check: kept } },
				'checked',
			);
		});
		await settle();
		const bar = screen.getByTestId('review-check');
		await waitFor(() =>
			expect(within(bar).getByTestId('review-check-summary').textContent).toContain('fixes 1 · introduces 2'),
		);
		expect(bar.getAttribute('data-check-state')).toBe('current');
		// the bed clip's gain changes: the mix is not the one checked
		const r = t.session.apply({
			label: 'Gain',
			origin: 'user',
			sequenceId: t.seqId,
			commands: [{ type: 'audio.setGain', clipIds: [t.bed.id], mode: 'adjust', db: -3 } as never],
		});
		expect(r.ok).toBe(true);
		await settle();
		expect(bar.getAttribute('data-check-state')).toBe('stale');
		expect(within(bar).getByTestId('review-check-stale').textContent).toContain('the mix changed');
	});

	it('the helpers: the items a check covers, its status, per-item findings and badge text, the stored summary', async () => {
		const t = await setup();
		const items = t.c.getState().items;
		expect(proposalCheckItems(items)).toEqual(['trk', 'hit', 'boom', 'move', 'cue']);
		expect(proposalCheckItems(items.map((i) => (i.id === 'hit' ? { ...i, state: 'rejected' as const } : i)))).toEqual(
			['trk', 'boom', 'move', 'cue'],
		);
		const base = mixFingerprint(t.session.getCommitted(), t.seqId);
		const check: SoundCheckProposalSummary = {
			...delta(t.p.id, base, ['trk', 'hit', 'boom', 'move', 'cue']),
			jobId: 'j',
			at: 'x',
			sequenceId: t.seqId,
		};
		expect(proposalCheckStatus(check, t.session.getCommitted(), items)).toEqual({ state: 'current', reasons: [] });
		expect(proposalCheckStatus(null, t.session.getCommitted(), items).state).toBe('none');
		expect(itemCheck(check, 'hit').fixes.map((f) => f.key)).toEqual(['MASKED:clp_bed']);
		expect(itemCheckText(check, 'boom')).toBe('introduces 1');
		expect(itemCheckText(check, 'cue')).toBeNull();
		expect(storedProposalCheck({ report: { check } })).toEqual(check);
		expect(storedProposalCheck({ report: { check: { nope: 1 } } })).toBeNull();
		expect(storedProposalCheck({ report: undefined })).toBeNull();
	});
});
