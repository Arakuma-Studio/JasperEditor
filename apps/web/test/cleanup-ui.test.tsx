// Text panel ▸ Transcript ▸ Clean Up (spec 14 TC-040…TC-044, TC-070): Analyze runs the engine job (progress, cancel,
// failures shown), the review lists findings by kind and marks the transcript, decisions and settings re-plan the live
// statistics, Play result plays a derived timeline (never committed, never in History), Apply is ONE undo step labelled
// "Clean Up Voice: N cuts" that remembers rejections, Undo restores the sequence, an edit of the analysed clips makes
// the review stale; the review keys are enabled only during a review and never while typing; Sequence ▸ Clean Up Voice…
// opens the mode; Apply cuts hard unless Settings ▸ Joins ▸ Fade joins is on.
import { derivedPreviewFor } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCommand, isCommandEnabled, registerAllCommands } from '../src/commands/index.ts';
import { DEFAULT_KEYMAP } from '../src/commands/keymap-defaults.ts';
import type { CommandCtx } from '../src/commands/types.ts';
import { CleanupMode } from '../src/panels/text/cleanup/CleanupMode.tsx';
import { type CleanupController, cleanupFor } from '../src/panels/text/cleanup/controller.ts';
import { KIND_ORDER } from '../src/panels/text/cleanup/model.ts';
import { textPanelRequests } from '../src/panels/text/state.ts';
import { cleanupSession, fakeCleanupEngine, seqLength, seqOf } from './cleanup-helpers.ts';

beforeAll(() => registerAllCommands());
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const settle = () => act(async () => vi.runAllTimersAsync());

function setup(opts: { script?: boolean } = {}) {
	const engine = fakeCleanupEngine();
	const s = cleanupSession(engine.client, opts);
	const c = cleanupFor(s.session);
	c.setMode('cleanup');
	const ui = render(
		<SessionProvider session={s.session}>
			<CleanupMode session={s.session} seq={seqOf(s.session, s.seqId)} />
		</SessionProvider>,
	);
	return { ...s, engine, c, ui };
}

const ctxOf = (session: CommandCtx['session']): CommandCtx =>
	({
		session,
		focus: { panel: 'text', instanceId: null },
		capabilities: new Set(),
		services: { get: () => undefined },
		ui: { toast() {}, openDialog() {} },
	}) as never;

async function analyze(c: CleanupController) {
	fireEvent.click(screen.getByTestId('text.cleanup.analyze'));
	await settle();
	expect(c.getState().phase).toBe('review');
	screen.getByTestId('text.cleanup.review');
}

describe('Clean Up mode', () => {
	it('analyses through the engine job and shows statistics, findings by kind and the marked transcript', async () => {
		const { c, engine } = setup();
		expect(screen.getByTestId('text.cleanup.intro')).toBeTruthy();
		await analyze(c);
		const a = c.getState().analysis!;
		expect(engine.calls.some((x) => x.startsWith('analyze'))).toBe(true);
		expect(engine.calls.some((x) => x.startsWith('voice '))).toBe(true);
		expect(c.getState().planner).toBe('main');
		expect(screen.getByTestId('text.cleanup.stat.cuts').textContent).toBe(String(a.plan.ranges.length));
		expect(screen.getByTestId('text.cleanup.apply').textContent).toContain(String(a.plan.ranges.length));
		// grouped by kind with counts
		// (the list is virtualised: the first group is in view, the others below it)
		const firstKind = KIND_ORDER.find((k) => a.findings.some((f) => f.kind === k))!;
		const count = screen.getByTestId(`text.cleanup.kind.${firstKind}.count`).textContent!;
		const n = a.findings.filter((f) => f.kind === firstKind).length;
		expect(count).toContain(String(n));
		// transcript view: struck words carry their kind
		fireEvent.click(screen.getByTestId('text.cleanup.view.transcript'));
		const struck = screen.getByTestId('text.cleanup.transcript').querySelectorAll('[data-removed="true"]');
		expect(struck.length).toBeGreaterThan(3);
		expect([...struck].every((el) => el.getAttribute('data-kind'))).toBe(true);
		// retake groups side by side, the kept take ticked
		fireEvent.click(screen.getByTestId('text.cleanup.view.retakes'));
		const g = a.groups[0]!;
		expect(screen.getByTestId(`text.cleanup.group.${g.id}.take.${g.chosen}`).getAttribute('data-kept')).toBe(
			'true',
		);
	});

	it('Repeats at cuts: the toggle asks the engine to check the cuts, the review reports it, re-plans keep its findings', async () => {
		const { c, engine } = setup();
		fireEvent.click(within(screen.getByTestId('text.cleanup.checkCuts')).getByRole('switch'));
		expect(c.getState().checkCuts).toBe(true);
		await analyze(c);
		expect(engine.calls.find((x) => x.startsWith('analyze'))).toContain('"editRepeats":"spans"');
		expect(screen.getByTestId('text.cleanup.notes').textContent).toContain(
			'1 found, 1 suggested for removal',
		);
		const restart = () => c.getState().analysis!.findings.find((f) => f.reason.params?.cut === 1);
		expect(restart()?.suggested).toBe('remove');
		// a decision re-plans (worker or main thread): the repeat at the cut is still there
		const other = c.getState().analysis!.findings.find((x) => x.suggested === 'remove' && x.words)!;
		act(() => {
			c.decide('reject', other.id);
		});
		await settle();
		expect(c.getState().planning).toBe(false);
		expect(restart()).toBeTruthy();
		c.setCheckCuts(false);
	});

	it('decisions, retake choices and settings re-plan the live statistics', async () => {
		const { c, session, seqId } = setup();
		await analyze(c);
		const before = c.getState().analysis!.plan.stats.outputDuration;
		const f = c.getState().analysis!.findings.find((x) => x.suggested === 'remove' && x.words)!;
		act(() => {
			c.decide('reject', f.id);
		});
		await settle();
		expect(c.getState().planning).toBe(false);
		expect(c.getState().analysis!.plan.stats.outputDuration).toBeGreaterThan(before);
		expect(c.isAccepted(f.id)).toBe(false);
		// per kind from the list header
		fireEvent.click(screen.getByTestId('text.cleanup.view.findings'));
		const kind = c.getState().analysis!.findings.find((x) => x.kind === 'pause')!.kind;
		fireEvent.click(screen.getByTestId(`text.cleanup.kind.${kind}.reject`));
		expect(c.getState().decisions.rejectKinds).toContain('pause');
		await settle();
		expect(c.getState().planning).toBe(false);
		// retake choice: keep the first take instead of the last
		const g = c.getState().analysis!.groups[0]!;
		act(() => {
			c.chooseTake(g.id, 0);
		});
		await settle();
		expect(c.getState().analysis!.groups[0]!.chosen).toBe(0);
		// a settings change re-plans without a new analysis (no staleness)
		const out1 = c.getState().analysis!.plan.stats.outputDuration;
		act(() => {
			c.configure({ settings: { overrides: { gaps: { maxGapS: 2 } } }, mergeOverrides: true });
		});
		await settle();
		expect(c.getState().analysis!.settings.gaps.maxGapS).toBe(2);
		expect(c.getState().stale).toBe(false);
		expect(c.getState().analysis!.plan.stats.outputDuration).not.toBe(out1);
		expect(seqOf(session, seqId).cleanup).toMatchObject({
			settings: { overrides: { gaps: { maxGapS: 2 } } },
		});
	});

	it('Play result plays a derived timeline without touching the document; Stop maps the playhead back', async () => {
		const { c, session, seqId } = setup();
		await analyze(c);
		const doc = session.getCommitted();
		const history = session.getState().history.entries.length;
		fireEvent.click(screen.getByTestId('text.cleanup.playResult'));
		const dp = derivedPreviewFor(session).getState().active!;
		expect(dp.kind).toBe('cleanup.result');
		const removedFrames = c.getState().analysis!.plan.ranges.reduce((sum, r) => sum + r.end - r.start, 0);
		const originalLength = seqLength(doc.sequences[seqId]!);
		expect(seqLength(dp.document.sequences[seqId]!)).toBe(originalLength - removedFrames);
		expect(session.getCommitted()).toBe(doc);
		expect(session.transport.getState().playing).toBe(true);
		expect(screen.getByTestId('text.cleanup.stop')).toBeTruthy();
		act(() => session.transport.reportFrame(40));
		fireEvent.click(screen.getByTestId('text.cleanup.stop'));
		expect(derivedPreviewFor(session).getState().active).toBeNull();
		expect(session.transport.getState().playing).toBe(false);
		expect(session.transport.getState().frame).toBeGreaterThanOrEqual(40);
		expect(session.getState().history.entries.length).toBe(history);
		// Play removed: only the removed parts
		expect(c.playRemoved().ok).toBe(true);
		const removed = derivedPreviewFor(session).getState().active!;
		expect(removed.kind).toBe('cleanup.removed');
		expect(seqLength(removed.document.sequences[seqId]!)).toBe(removedFrames);
		c.stopPreview();
	});

	it('Apply is one undo step labelled with the cuts, remembers rejections; Undo restores the sequence', async () => {
		const { c, session, seqId } = setup();
		await analyze(c);
		const f = c.getState().analysis!.findings.find((x) => x.suggested === 'remove')!;
		act(() => {
			c.decide('reject', f.id);
		});
		await settle();
		expect(c.getState().planning).toBe(false);
		expect(c.applyBlocker()).toBeNull();
		const seq0 = seqOf(session, seqId);
		const cuts = c.getState().analysis!.plan.ranges.length;
		const removed = c.getState().analysis!.plan.ranges.reduce((n, r) => n + r.end - r.start, 0);
		const entries = session.getState().history.entries.length;
		fireEvent.click(screen.getByTestId('text.cleanup.apply'));
		const h = session.getState().history;
		expect(h.entries.length).toBe(entries + 1);
		expect(h.entries.at(-1)!.label).toBe(`Clean Up Voice: ${cuts} cuts`);
		const seq1 = seqOf(session, seqId);
		expect(seqLength(seq0) - seqLength(seq1)).toBe(removed);
		expect((seq1.cleanup as { rejected?: string[] }).rejected).toEqual([f.fingerprint]);
		expect(c.getState().phase).toBe('idle');
		session.undo();
		expect(seqOf(session, seqId)).toEqual(seq0);
		session.redo();
		expect(seqLength(seqOf(session, seqId))).toBe(seqLength(seq1));
	});

	it('Apply cuts hard by default; Settings ▸ Fade joins stores 4 ms, shows the value, and Apply fades the joins', async () => {
		const edgeFades = (session: ReturnType<typeof setup>['session'], seqId: string) =>
			Object.values(seqOf(session, seqId).clips).flatMap((x) => {
				const f = (x as { edgeFades?: Record<string, number> }).edgeFades;
				return f ? [f] : [];
			});
		// default (Fast, nothing stored): hard cuts
		const a = setup();
		await analyze(a.c);
		expect(a.c.getState().analysis!.plan.ranges.length).toBeGreaterThan(1);
		fireEvent.click(screen.getByTestId('text.cleanup.apply'));
		expect(edgeFades(a.session, a.seqId)).toEqual([]);
		cleanup();

		const { c, session, seqId, ui } = setup();
		// the drawer shows the sequence it is given: render it again with the live one after a settings edit
		const live = () =>
			ui.rerender(
				<SessionProvider session={session}>
					<CleanupMode session={session} seq={seqOf(session, seqId)} />
				</SessionProvider>,
			);
		await analyze(c);
		fireEvent.click(screen.getByTestId('text.cleanup.settings'));
		const box = within(screen.getByTestId('text.cleanup.setting.joins.fadeMs.toggle')).getByRole('checkbox');
		expect(box.getAttribute('aria-checked')).toBe('false');
		expect(screen.queryByTestId('text.cleanup.setting.joins.fadeMs')).toBeNull();
		fireEvent.click(box);
		await settle();
		live();
		expect(seqOf(session, seqId).cleanup).toMatchObject({
			settings: { overrides: { joins: { fadeMs: 4 } } },
		});
		expect(c.getState().analysis!.plan.fadeMs).toBe(4);
		expect((screen.getByTestId('text.cleanup.setting.joins.fadeMs') as HTMLInputElement).value).toBe('4');
		const seq0 = seqOf(session, seqId);
		fireEvent.click(screen.getByTestId('text.cleanup.apply'));
		const got = edgeFades(session, seqId);
		expect(got.length).toBeGreaterThan(1);
		for (const f of got) for (const ms of Object.values(f)) expect(ms).toBe(4);
		session.undo();
		expect(seqOf(session, seqId)).toEqual(seq0);
		live();
		// unchecking is its own undoable settings edit back to hard cuts
		fireEvent.click(
			within(screen.getByTestId('text.cleanup.setting.joins.fadeMs.toggle')).getByRole('checkbox'),
		);
		expect(seqOf(session, seqId).cleanup).toMatchObject({
			settings: { overrides: { joins: { fadeMs: 0 } } },
		});
	});

	it('an edit of the analysed clips makes the review stale: Apply and the previews refuse with a reason', async () => {
		const { c, session, seqId } = setup();
		await analyze(c);
		act(() => {
			session.apply({
				label: 'cut',
				origin: 'user',
				sequenceId: seqId,
				commands: [{ type: 'range.extract', from: 0, to: 3 }] as never[],
			});
		});
		expect(c.getState().stale).toBe(true);
		expect(screen.getByTestId('text.cleanup.stale')).toBeTruthy();
		expect(c.apply()).toMatchObject({ ok: false });
		expect(c.playResult()).toMatchObject({ ok: false });
		expect(screen.getByTestId('text.cleanup.apply').getAttribute('aria-disabled')).toBe('true');
	});

	it('shows engine failures and refusals without crashing; Cancel cancels the job', async () => {
		const { c, engine, session } = setup();
		engine.failNext = { code: 'E_UNSUPPORTED', message: 'Clean Up works on clips at 100 % speed' };
		fireEvent.click(screen.getByTestId('text.cleanup.analyze'));
		await act(async () => {});
		screen.getByTestId('text.cleanup.error');
		expect(screen.getByTestId('text.cleanup.error').textContent).toContain('100 % speed');
		expect(c.getState().phase).toBe('idle');
		// cancel while running
		engine.hold = true;
		const run = c.analyze();
		await act(async () => {});
		expect(c.getState().jobId).not.toBeNull();
		await act(async () => {
			fireEvent.click(screen.getByTestId('text.cleanup.cancel'));
		});
		await settle();
		await run;
		expect(c.getState().phase).toBe('idle');
		expect(engine.calls.some((x) => x.startsWith('cancel'))).toBe(true);
		// a scope that needs a selection refuses with a reason
		c.setScopeChoice('clips');
		session.select('timeline', [], 'replace');
		const r = await c.analyze();
		expect(r).toMatchObject({ ok: false });
		expect(c.getState().error?.message).toMatch(/Select clips/);
	});

	it('review keys: bound in the Text panel scope, enabled only during a review, never while typing', async () => {
		const { c, session } = setup();
		const ids = [
			'cleanup.nextFinding',
			'cleanup.prevFinding',
			'cleanup.acceptFinding',
			'cleanup.rejectFinding',
			'cleanup.clearFinding',
			'cleanup.acceptKind',
			'cleanup.rejectKind',
			'cleanup.previewFinding',
			'cleanup.playResult',
			'cleanup.apply',
		];
		for (const id of ids)
			expect(
				DEFAULT_KEYMAP.some((b) => b.command === id && b.scope === 'text'),
				id,
			).toBe(true);
		const ctx = ctxOf(session);
		const enabled = (id: string) => isCommandEnabled(getCommand(id)!, ctx);
		expect(enabled('cleanup.nextFinding')).toBe(false);
		await analyze(c);
		expect(enabled('cleanup.nextFinding')).toBe(true);
		const first = c.getState().current;
		getCommand('cleanup.nextFinding')!.run(ctx);
		expect(c.getState().current).not.toBe(first);
		const cur = c.getState().current!;
		getCommand('cleanup.rejectFinding')!.run(ctx);
		expect(c.getState().decisions.reject).toContain(cur);
		// auto-advance moved on
		expect(c.getState().current).not.toBe(cur);
		// typing in a field suspends them
		const input = document.createElement('input');
		document.body.appendChild(input);
		input.focus();
		expect(enabled('cleanup.acceptFinding')).toBe(false);
		input.remove();
		expect(enabled('cleanup.acceptFinding')).toBe(true);
		// in Edit mode they are off
		c.setMode('edit');
		expect(enabled('cleanup.nextFinding')).toBe(false);
	});

	it('Sequence ▸ Clean Up Voice… opens the Text panel in Clean Up mode', () => {
		const engine = fakeCleanupEngine();
		const { session } = cleanupSession(engine.client);
		const focused: string[] = [];
		const ctx = {
			...ctxOf(session),
			engine: engine.client,
			services: {
				get: (k: string) => (k === 'shell' ? { focusPanel: (p: string) => focused.push(p) } : undefined),
			},
		} as never as CommandCtx;
		const cmd = getCommand('transcript.cleanUpVoice')!;
		expect(isCommandEnabled(cmd, ctx)).toBe(true);
		const seq0 = textPanelRequests.get().seq;
		cmd.run(ctx);
		expect(cleanupFor(session).getState().mode).toBe('cleanup');
		expect(textPanelRequests.get()).toMatchObject({ tab: 'transcript', tool: 'cleanup', seq: seq0 + 1 });
		expect(focused).toEqual(['text']);
	});
});
