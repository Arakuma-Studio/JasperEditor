// The Review panel with an overflowing proposal (Phase 3 verification; WP3.3b limit "the panel renders every row"): the list is
// virtualised — only the rows in view (plus the current one) are in the DOM, every option says its place
// (aria-posinset / aria-setsize), groups stay labelled, End reaches the last item (rendered, aria-activedescendant
// valid, scrolled into view), scrolling renders the rows there, and a decision re-renders without rebuilding the
// preview. Render times are written to REVIEW_VIRTUAL_OUT when set (the wp-note's measurement).
import { writeFileSync } from 'node:fs';
import { proposalsFor } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeEngine } from '../../../packages/session/test/fake-proposals-engine.ts';
import { registerAllCommands } from '../src/commands/index.ts';
import { reviewListMetrics } from '../src/panels/review/list-layout.ts';
import { ReviewPanel } from '../src/panels/review/ReviewPanel.tsx';
import { storeProposal } from './review-helpers.ts';
import { makeSession } from './timeline-helpers.ts';

// Enough rows for offscreen middle/end navigation and the session's sliced preview path.
const N = 96;

beforeAll(() => registerAllCommands());
afterEach(() => cleanup());

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

describe(`Review panel with ${N} items`, () => {
	it('renders only the rows in view, keeps them reachable by keyboard and scrolling', async () => {
		const { session, seqId } = makeSession();
		session.apply({
			label: 'setup',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{ type: 'clip.addSolid', at: 0, duration: N * 6 + 60, track: 'V1', color: [0, 0, 1, 1] },
			] as never[],
		});
		const engine = new FakeEngine(() => session);
		const timers: (() => void)[] = [];
		const c = proposalsFor(session, {
			engine,
			setTimer: (fn) => timers.push(fn),
			clearTimer: () => undefined,
		});
		const flush = () => {
			while (timers.length) timers.shift()!();
		};
		const frames = Array.from({ length: N }, (_, i) => 10 + i * 6);
		const p = storeProposal(engine, seqId, 'Big pass', frames);
		await c.setActive(p.id);
		flush();
		const t0 = performance.now();
		render(
			<SessionProvider session={session}>
				<ReviewPanel instanceId="rv" visible />
			</SessionProvider>,
		);
		await settle();
		const firstRenderMs = performance.now() - t0;
		const list = screen.getByTestId('review-list');
		expect(list.getAttribute('data-review-rows')).toBe(String(N));
		const options = () => within(list).getAllByRole('option');
		// jsdom has no layout: an unmeasured list shows 480 px + the overscan
		expect(options().length).toBeGreaterThan(5);
		expect(options().length).toBeLessThan(40);
		for (const o of options()) {
			expect(o.getAttribute('aria-setsize')).toBe(String(N));
			expect(Number(o.getAttribute('aria-posinset'))).toBeGreaterThan(0);
		}
		expect(within(list).getAllByRole('group')[0]!.getAttribute('aria-label')).toBe(`Support · ${N}`);
		// End: the last item is current, rendered and named by aria-activedescendant, and scrolled to
		await act(async () => {
			fireEvent.keyDown(list, { key: 'End', code: 'End' });
		});
		await settle();
		const last = p.items.at(-1)!.id;
		expect(c.getState().selection.at(-1)).toBe(last);
		const active = list.getAttribute('aria-activedescendant')!;
		expect(document.getElementById(active)?.getAttribute('data-review-row')).toBe(last);
		expect(document.getElementById(active)?.getAttribute('aria-posinset')).toBe(String(N));
		const m = reviewListMetrics(Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 12);
		expect(list.scrollTop).toBeGreaterThan((N - 30) * m.row);
		// scroll to the middle: the rows there are rendered, the first ones are not
		const mid = m.header + Math.floor(N / 2) * m.row;
		await act(async () => {
			list.scrollTop = mid;
			fireEvent.scroll(list);
		});
		const midId = p.items[Math.floor(N / 2)]!.id;
		expect(list.querySelector(`[data-review-row="${midId}"]`)).not.toBeNull();
		expect(list.querySelector(`[data-review-row="${p.items[0]!.id}"]`)).toBeNull();
		// the label of the group scrolled under the top stays pinned
		expect(list.querySelector('[data-review-pinned-group]')?.textContent).toBe(`Support · ${N}`);
		// a decision on a row there: accepted at once, the preview is not rebuilt (same object)
		const before = c.getState().preview;
		const t1 = performance.now();
		await act(async () => {
			fireEvent.pointerDown(list.querySelector(`[data-review-row="${midId}"]`)!, { button: 0 });
		});
		await act(async () => {
			fireEvent.keyDown(list, { key: 'Enter', code: 'Enter' });
		});
		flush();
		await settle();
		const decisionMs = performance.now() - t1;
		expect(c.getState().items.find((it) => it.id === midId)?.state).toBe('accepted');
		expect(c.getState().preview?.result).toBe(before?.result);
		expect(list.querySelector(`[data-review-row="${midId}"]`)?.getAttribute('data-review-state')).toBe(
			'accepted',
		);
		// A document change keeps the previous preview visible while the next one is built in slices.
		// Advance the clock on each observation so this does not depend on the host taking at least 8 ms.
		let now = performance.now();
		const clock = vi.spyOn(performance, 'now').mockImplementation(() => (now += 10));
		try {
			await act(async () => {
				session.apply({
					label: 'edit',
					origin: 'user',
					sequenceId: seqId,
					commands: [{ type: 'marker.add', frame: 3, name: 'x' }] as never[],
				});
				timers.shift()?.();
			});
			expect(c.getState().previewing).toBe(true);
			expect(screen.getByTestId('review-previewing').textContent).toBe('Updating the preview…');
			const stalePreview = c.getState().preview;
			await act(async () => flush());
			expect(c.getState().previewing).toBe(false);
			expect(screen.queryByTestId('review-previewing')).toBeNull();
			expect(c.getState().preview).not.toBe(stalePreview);
		} finally {
			clock.mockRestore();
		}
		if (process.env.REVIEW_VIRTUAL_OUT)
			writeFileSync(
				process.env.REVIEW_VIRTUAL_OUT,
				`${JSON.stringify({ items: N, firstRenderMs: Math.round(firstRenderMs), decisionMs: Math.round(decisionMs), domOptions: options().length })}\n`,
			);
		c.dispose();
	});
});
