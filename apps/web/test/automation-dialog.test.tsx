// Sequence ▸ Automate (spec 15 EA-040): the Automate submenu built from its entry list, the pass commands, and the
// pass dialog — defaults, the dry-run summary that follows the parameters (counts, coverage, skips, families, export
// cost, sounds, budget), Propose: the pass's job runs, review opens on the stored proposal and nothing is applied;
// Reroll of a review item through the session (the producer's next seed).
import type { AutomationPassResult, EngineJob, ProposalRefreshResponse } from '@jasper/api';
import { parsePassParams, passDraft, passItems, planDecorateCuts, type Proposal } from '@jasper/project';
import { proposalsFor } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeEngine } from '../../../packages/session/test/fake-proposals-engine.ts';
import { AutomationDialog, DryRunSummary, dialogParams } from '../src/automation/AutomationDialog.tsx';
import { AUTOMATE_MENU } from '../src/automation/menu.ts';
import { automationCommands } from '../src/commands/automation.ts';
import { proposalCommands } from '../src/commands/proposals.ts';
import { isRerollable, rerollReviewItem } from '../src/proposals/actions.ts';
import { buildGhostModel } from '../src/proposals/ghosts.ts';
import { buildReviewModel } from '../src/proposals/review.ts';
import { MENUBAR } from '../src/shell/menus/model.ts';
import { makeSession } from './timeline-helpers.ts';

afterEach(() => cleanup());

const settle = (ms = 300) => act(async () => new Promise((r) => setTimeout(r, ms)));

async function chooseOption(trigger: HTMLElement, name: string | RegExp) {
	await act(async () => {
		fireEvent.keyDown(trigger, { key: 'Enter' });
	});
	const option = await screen.findByRole('option', { name });
	await act(async () => {
		fireEvent.keyDown(option, { key: 'Enter' });
	});
}

function result(
	mode: 'propose' | 'dryRun',
	pass: AutomationPassResult['pass'],
	sequenceId: string,
	o: Partial<AutomationPassResult> & { count?: number } = {},
): AutomationPassResult {
	return {
		mode,
		pass,
		projectId: 'prj',
		sequenceId,
		summary: {
			pass,
			sequenceId,
			seed: 1,
			count: o.count ?? 2,
			considered: 3,
			coverage: (o.count ?? 2) / 3,
			skipped: {
				count: 1,
				byCode: { 'too-close': 1 },
				first: [{ frame: 20, timecode: '00:00:00:20', code: 'too-close', reason: 'too close' }],
			},
			...(pass === 'decorate-cuts' ? { families: { jolt: 1, whip: 1 } } : {}),
			cost:
				pass === 'decorate-cuts'
					? { class: 'remotion', frames: 60, effects: ['jasper.transform'] }
					: { class: 'native', frames: 60, effects: [] },
			...(pass === 'decorate-cuts' ? { track: 'new track FX' } : {}),
			warnings: [],
		},
		sfx:
			pass === 'ken-burns'
				? null
				: { enabled: true, type: 'whoosh', available: 4, placed: 2, sounds: 2, unsounded: 0 },
		budget: { fits: true, items: 3, commands: 9 },
		proposalId: null,
		revision: null,
		itemCount: 3,
		invalid: [],
		warnings: [],
		...o,
	};
}

function setup(pass: AutomationPassResult['pass'], initialParams?: Record<string, unknown>) {
	const { session, seqId } = makeSession();
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [1, 0, 0, 1] },
			{ type: 'clip.addSolid', at: 60, duration: 60, track: 'V1', color: [0, 1, 0, 1] },
			{ type: 'sequence.setInOut', in: 30, out: 90 },
		] as never[],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const proposals = new FakeEngine(() => session);
	const c = proposalsFor(session, { engine: proposals });
	const calls: { pass: string; req: { mode?: string; params?: Record<string, unknown> } }[] = [];
	let stored = '';
	let dry: AutomationPassResult = result('dryRun', pass, seqId);
	const engine = {
		async automationPass(_pid: string, p: string, req: { mode?: string; params?: Record<string, unknown> }) {
			calls.push({ pass: p, req });
			if (req.mode === 'dryRun') return dry;
			return { id: 'job_1', state: 'queued', kind: 'edit-automation', title: 'x' } as unknown as EngineJob;
		},
		async getJob() {
			stored = proposals.create(
				{
					feature: 'edit-automation',
					title: 'Decorate Cuts',
					sequenceId: seqId,
					items: [
						{
							id: 'kit:60',
							label: 'Jolt at 00:00:02:00',
							group: 'cut-kits',
							commands: [{ type: 'marker.add', frame: 60 }],
							meta: { group: 'cut-kits', frame: 60, rerollable: true, seed: 7 },
						},
					],
				},
				'user',
			).id;
			return {
				id: 'job_1',
				state: 'succeeded',
				kind: 'edit-automation',
				title: 'x',
				result: result('propose', pass, seqId, { proposalId: stored }),
			} as unknown as EngineJob;
		},
		async cancelJob() {},
	};
	const closed: unknown[] = [];
	const reviewed: number[] = [];
	const toasts: string[] = [];
	render(
		<SessionProvider session={session}>
			<AutomationDialog
				session={session}
				engine={engine as never}
				sequenceId={seqId}
				pass={pass}
				{...(initialParams ? { initialParams } : {})}
				close={(x) => closed.push(x)}
				toast={(t) => toasts.push(t.message)}
				onReview={() => reviewed.push(1)}
			/>
		</SessionProvider>,
	);
	return {
		session,
		seqId,
		c,
		calls,
		closed,
		reviewed,
		toasts,
		stored: () => stored,
		setDry: (d: AutomationPassResult) => {
			dry = d;
		},
		proposals,
	};
}

describe('Sequence ▸ Automate', () => {
	it('the submenu lists the pass commands from its entry list; every entry has a command', () => {
		const seq = MENUBAR.find((m) => m.id === 'sequence')!;
		const automate = seq.items.find((i) => i.type === 'submenu' && i.label === 'Automate') as {
			items: { command?: string; label: string }[];
		};
		expect(automate.items.map((i) => [i.command, i.label])).toEqual([
			['automation.decorateCuts', 'Decorate Cuts…'],
			['automation.punchIns', 'Punch-ins…'],
			['automation.kenBurns', 'Ken Burns…'],
		]);
		const ids = new Set(automationCommands.map((c) => c.id));
		for (const e of AUTOMATE_MENU) expect(ids.has(e.command)).toBe(true);
		for (const c of automationCommands) expect(c).toMatchObject({ agentExposed: true, capability: 'engine' });
		expect(proposalCommands.some((c) => c.id === 'proposals.rerollItem')).toBe(true);
	});
});

describe('the pass dialog', () => {
	it('Decorate Cuts: the dry run follows the parameters; Propose runs the pass, opens review, applies nothing', async () => {
		const t = setup('decorate-cuts');
		const dialog = await screen.findByTestId('automation-dialog-decorate-cuts');
		await settle();
		expect(t.calls[0]).toEqual({
			pass: 'decorate-cuts',
			req: { sequenceId: t.seqId, mode: 'dryRun', params: { seed: 1 } },
		});
		const summary = within(dialog).getByTestId('automation-summary');
		expect(within(summary).getByTestId('automation-summary-count').textContent).toBe(
			'2 of 3 cuts get a kit (67 %)',
		);
		expect(within(summary).getByTestId('automation-summary-families').textContent).toBe('Jolt 1 · Whip 1');
		expect(within(summary).getByTestId('automation-summary-skipped').textContent).toContain(
			'Too close to the previous kit 1',
		);
		expect(within(summary).getByTestId('automation-summary-cost').textContent).toContain('Remotion');
		expect(within(summary).getByTestId('automation-summary-sfx').textContent).toBe(
			'whoosh sounds: 2 placed from 4 available',
		);
		// another pack, the In to Out range: a new dry run with those parameters
		await chooseOption(screen.getByRole('combobox', { name: 'Kit pack' }), 'Shorts shake');
		await chooseOption(screen.getByRole('combobox', { name: 'Range' }), 'In to Out');
		await settle();
		expect(t.calls.at(-1)!.req.params).toEqual({
			seed: 1,
			pack: 'shorts-shake',
			range: { start: 30, end: 90 },
		});
		// the long-form pack shows its families and the repeat probability
		await chooseOption(screen.getByRole('combobox', { name: 'Kit pack' }), 'Long-form transition pack');
		expect(within(dialog).getByTestId('automation-families')).toBeTruthy();
		expect(within(dialog).getByTestId('automation-repeat').textContent).toContain('23 % same as previous');
		const rev = t.session.revision;
		vi.useFakeTimers();
		try {
			await act(async () => {
				fireEvent.click(within(dialog).getByRole('button', { name: 'Propose' }));
			});
			await act(async () => vi.runAllTimersAsync());
		} finally {
			vi.useRealTimers();
		}
		expect(t.calls.at(-1)!.req.mode).toBe('propose');
		expect(t.closed).toHaveLength(1);
		expect(t.reviewed).toEqual([1]);
		expect(t.toasts).toEqual(['Proposed 2 cut kits']);
		expect(t.c.getState().activeId).toBe(t.stored());
		expect(t.session.revision).toBe(rev);
		t.c.exit();
	});

	it('punch-ins: target point and method go into the parameters; starting values of a recipe are kept', async () => {
		const t = setup('punch-ins', { density: 0.5, seed: 9 });
		await screen.findByTestId('automation-dialog-punch-ins');
		await settle();
		expect(t.calls[0]!.req.params).toEqual({ density: 0.5, seed: 9 });
		await chooseOption(screen.getByRole('combobox', { name: 'Zooms toward' }), 'A point');
		await chooseOption(screen.getByRole('combobox', { name: 'Made with' }), /A Transform adjustment clip/);
		await settle();
		expect(t.calls.at(-1)!.req.params).toEqual({
			density: 0.5,
			seed: 9,
			target: { x: 0.5, y: 0.5 },
			method: 'adjustment',
		});
		expect(screen.getByRole('slider', { name: 'Point x' })).toBeTruthy();
	});

	it('a pass too big for one proposal says so and cannot be proposed; nothing to decorate disables Propose', async () => {
		const t = setup('ken-burns');
		t.setDry(
			result('dryRun', 'ken-burns', t.seqId, {
				budget: { fits: false, items: 2500, commands: 2500, suggestedRange: { start: 0, end: 4000 } },
			}),
		);
		const dialog = await screen.findByTestId('automation-dialog-ken-burns');
		await chooseOption(screen.getByRole('combobox', { name: 'Range' }), 'In to Out');
		await settle();
		expect(within(dialog).getByTestId('automation-summary-budget').textContent).toContain('frame 4000');
		expect((within(dialog).getByRole('button', { name: 'Propose' }) as HTMLButtonElement).disabled).toBe(
			true,
		);
	});

	it('dialogParams drops unset values and reads In to Out as the other range pickers do', () => {
		const { session, seqId } = makeSession();
		session.apply({
			label: 's',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{ type: 'clip.addSolid', at: 0, duration: 120, track: 'V1', color: [1, 0, 0, 1] },
				{ type: 'sequence.setInOut', in: 10, out: 50 },
			] as never[],
		});
		const seq = session.getCommitted().sequences[seqId]!;
		expect(dialogParams(seq, { a: 1, b: undefined, range: { start: 1, end: 2 } }, 'sequence')).toEqual({
			a: 1,
		});
		expect(dialogParams(seq, {}, 'inout')).toEqual({ range: { start: 10, end: 50 } });
	});

	it('the summary names warnings and a library without sounds', () => {
		render(
			<DryRunSummary
				result={result('dryRun', 'punch-ins', 's', {
					sfx: { enabled: true, type: 'whoosh', available: 0, placed: 0, sounds: 0, unsounded: 2 },
					warnings: [{ code: 'W_NO_SUBJECT', message: '2 punch-in(s) zoom to the centre' }],
				})}
			/>,
		);
		expect(screen.getByTestId('automation-summary-sfx').textContent).toContain('No whoosh sounds');
		expect(screen.getByText('! 2 punch-in(s) zoom to the centre')).toBeTruthy();
	});
});

describe('Reroll in review', () => {
	it('rerolls an item through the producer (next seed); only items marked rerollable', async () => {
		const { session, seqId } = makeSession();
		const proposals = new FakeEngine(() => session);
		const c = proposalsFor(session, { engine: proposals });
		const p: Proposal = proposals.create(
			{
				feature: 'edit-automation',
				title: 'Decorate Cuts',
				sequenceId: seqId,
				items: [
					{
						id: 'kit:60',
						label: 'Jolt at 00:00:02:00',
						group: 'cut-kits',
						commands: [{ type: 'marker.add', frame: 60 }],
						meta: { group: 'cut-kits', frame: 60, rerollable: true, seed: 7 },
					},
				],
			},
			'user',
		);
		const seen: unknown[] = [];
		(proposals as unknown as { refreshProposal: unknown }).refreshProposal = async (
			_pid: string,
			_id: string,
			req: unknown,
		): Promise<ProposalRefreshResponse> => {
			seen.push(req);
			return {
				proposal: {
					...p,
					updatedAt: '2999-01-01T00:00:00.000Z',
					items: p.items.map((it) => ({
						...it,
						label: 'Whip left at 00:00:02:00',
						meta: { ...(it.meta as object), seed: 8 },
					})),
				},
				refreshed: ['kit:60'],
				dropped: [],
				unchanged: [],
				stale: [],
				revision: 1,
			};
		};
		await c.setActive(p.id);
		const it = c.getState().items.find((x) => x.id === 'kit:60')!;
		expect(isRerollable(it)).toBe(true);
		expect(isRerollable({ meta: { rerollable: false } })).toBe(false);
		const r = await rerollReviewItem(session, 'kit:60');
		expect(r).toEqual({ ok: true, message: 'Rerolled: Whip left at 00:00:02:00' });
		expect(seen).toEqual([{ itemIds: ['kit:60'], reroll: true }]);
		c.exit();
	});
});

describe('review of a real Decorate Cuts proposal', () => {
	it('groups the kits under Cut kits and draws each kit’s adjustment clips and key bands at its range', async () => {
		const { session, seqId } = makeSession();
		session.apply({
			label: 'setup',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{ type: 'clip.addSolid', at: 0, duration: 90, track: 'V1', color: [1, 0, 0, 1] },
				{ type: 'clip.addSolid', at: 90, duration: 90, track: 'V1', color: [0, 0, 1, 1] },
				{ type: 'clip.addSolid', at: 180, duration: 90, track: 'V1', color: [0, 1, 0, 1] },
			] as never[],
		});
		const doc = session.getCommitted();
		const params = parsePassParams('decorate-cuts', { seed: 4 });
		const plan = planDecorateCuts(doc, seqId, params);
		const draft = passDraft(plan, passItems(doc, plan), params)!;
		const engine = new FakeEngine(() => session);
		const timers: (() => void)[] = [];
		const c = proposalsFor(session, { engine, setTimer: (fn) => timers.push(fn), clearTimer: () => undefined });
		const p = engine.create(draft as never, 'user');
		await c.setActive(p.id);
		while (timers.length) timers.shift()!();
		const st = c.getState();
		const model = buildReviewModel(st.items, null, 'edit-automation');
		expect(model.groups.map((g) => g.id)).toEqual(['cut-kits']);
		const m = buildGhostModel({
			preview: st.preview!,
			committed: st.preview!.base,
			sequenceId: seqId,
			items: st.items,
			agent: false,
		});
		for (const k of plan.kits) {
			const ghosts = m.clips.filter((x) => x.itemId === k.id);
			expect(ghosts.every((g) => g.kind === 'adjustment')).toBe(true);
			expect(Math.min(...ghosts.map((g) => g.start))).toBe(k.start);
			expect(Math.max(...ghosts.map((g) => g.start + g.duration))).toBe(k.end);
			expect(m.keys.some((b) => b.itemId === k.id)).toBe(true);
		}
		const kitItem = st.items.find((i) => i.id === plan.kits[0]!.id)!;
		expect((kitItem.meta as { why: string }).why).toContain('kit on the cut at');
		expect(isRerollable(kitItem)).toBe(true);
		c.exit();
	});
});
