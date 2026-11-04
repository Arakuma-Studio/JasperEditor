// Spec 18 AF-PROP-003 in the Review panel: a rough-cut proposal shows its strategy above the items; each row shows
// the beat chip, the quote and the reason, in the feature's groups (Selects, Removed, …); ghosts, decisions and Apply
// work unchanged — applying the cut is ONE undo step; the agent's card reads "<agent> proposes <title>: N edits".
import { RoughCutInputSchema, roughCutDraft, type Sequence } from '@jasper/project';
import { proposalsFor } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeEngine } from '../../../packages/session/test/fake-proposals-engine.ts';
import { ReviewPanel } from '../src/panels/review/ReviewPanel.tsx';
import { applyReview } from '../src/proposals/actions.ts';
import { makeSession } from './timeline-helpers.ts';

afterEach(cleanup);
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const row = (id: string) => document.querySelector(`[data-review-row="${id}"]`) as HTMLElement;
const STRATEGY = 'Open on the hook. Cut the weak middle take. Keep the ending as it is.';

async function fixture() {
	const { session, seqId } = makeSession();
	const setup = session.apply({
		label: 'setup',
		origin: 'user',
		sequenceId: seqId,
		commands: [0, 60, 120].map((at) => ({
			type: 'clip.addSolid',
			at,
			duration: 60,
			track: 'V1',
			color: [1, 1, 1, 1],
		})) as never[],
	});
	if (!setup.ok) throw new Error(JSON.stringify(setup.errors));
	const seq = () => session.getCommitted().sequences[seqId] as Sequence;
	const [a, b] = Object.values(seq().clips).sort((x, y) => x.start - y.start);
	const engine = new FakeEngine(() => session);
	const timers: (() => void)[] = [];
	const c = proposalsFor(session, {
		engine,
		setTimer: (fn) => timers.push(fn),
		clearTimer: () => undefined,
	});
	c.connect(engine.subscribe);
	const draft = roughCutDraft(
		RoughCutInputSchema.parse({
			sequenceId: seqId,
			title: 'Tight cut',
			strategy: STRATEGY,
			items: [
				{
					group: 'removed',
					beat: 'Middle take',
					quote: 'and then, uh, the thing',
					reason: 'Weaker read than the ending',
					commands: [{ type: 'clip.extract', clipIds: [b!.id] }],
				},
				{
					group: 'selects',
					beat: 'Hook',
					reason: 'Tighten the opening',
					commands: [{ type: 'clip.trim', clipId: a!.id, edge: 'out', deltaFrames: -10 }],
				},
			],
		}),
	);
	const p = engine.create(draft as never, { agent: 'cut-agent' });
	await c.setActive(p.id);
	while (timers.length) timers.shift()!();
	render(
		<SessionProvider session={session}>
			<ReviewPanel instanceId="r1" visible />
		</SessionProvider>,
	);
	await settle();
	return { session, seqId, seq, c, p, a: a!, b: b! };
}

describe('rough-cut review (AF-PROP-003)', () => {
	it('shows the strategy above the items and beat / quote / reason on each row, in the feature’s groups', async () => {
		await fixture();
		const strategy = screen.getByTestId('review-strategy');
		expect(strategy.textContent).toContain('Strategy');
		expect(strategy.textContent).toContain(STRATEGY);
		// above the list
		const list = screen.getByTestId('review-list');
		expect(strategy.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(list.textContent).toMatch(/Selects · 1[\s\S]*Removed · 1/);
		const cut = row('e0');
		expect(cut.querySelector('[data-review-beat]')?.textContent).toBe('Middle take');
		expect(cut.querySelector('[data-review-quote]')?.textContent).toBe('“and then, uh, the thing”');
		expect(cut.querySelector('[data-review-cut-reason]')?.textContent).toBe('Weaker read than the ending');
		expect(cut.getAttribute('aria-label')).toContain('Middle take');
		expect(cut.getAttribute('aria-label')).toContain('and then, uh, the thing');
		const hook = row('e1');
		expect(hook.querySelector('[data-review-beat]')?.textContent).toBe('Hook');
		expect(hook.querySelector('[data-review-quote]')).toBeNull();
		expect(hook.querySelector('[data-review-cut-reason]')?.textContent).toBe('Tighten the opening');
	});

	it('applies the accepted edits as ONE undo step', async () => {
		const t = await fixture();
		const before = t.session.getCommitted();
		await t.c.setItemDecision(['e0', 'e1'], 'accept');
		const r = await applyReview(t.session, { trusted: true, confirm: async () => true });
		expect(r).toMatchObject({ ok: true, applied: 2, total: 2 });
		expect(t.seq().clips[t.b.id]).toBeUndefined();
		expect(t.seq().clips[t.a.id]!.duration).toBe(50);
		act(() => void t.session.undo());
		expect(t.session.getCommitted().sequences[t.seqId]).toEqual(before.sequences[t.seqId]);
		t.c.exit();
	});

});
