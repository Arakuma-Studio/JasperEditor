// The Review panel with 500 items (Phase 3 verification; WP3.3b limit "the panel renders every row"): the list is
// virtualised — only the rows in view (plus the current one) are in the DOM, every option says its place
// (aria-posinset / aria-setsize), groups stay labelled, End reaches the last item (rendered, aria-activedescendant
// valid, scrolled into view), scrolling renders the rows there, and a decision re-renders without rebuilding the
// preview. Render times are written to REVIEW_VIRTUAL_OUT when set (the wp-note's measurement).
import { writeFileSync } from 'node:fs';
import { proposalsFor } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FakeEngine } from '../../../packages/session/test/fake-proposals-engine.ts';
import { registerAllCommands } from '../src/commands/index.ts';
import { reviewListLayout, reviewListMetrics, visibleEntries } from '../src/panels/review/list-layout.ts';
import { ReviewPanel } from '../src/panels/review/ReviewPanel.tsx';
import { buildReviewModel } from '../src/proposals/review.ts';
import { storeProposal } from './review-helpers.ts';
import { makeSession } from './timeline-helpers.ts';

const N = Number(process.env.REVIEW_VIRTUAL_ITEMS ?? 500);

beforeAll(() => registerAllCommands());
afterEach(() => cleanup());

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

describe(`Review panel with ${N} items`, { timeout: 300_000 }, () => {
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
		// a document change: the preview is rebuilt in slices; meanwhile the panel says so, then the new one replaces it
		await act(async () => {
			session.apply({
				label: 'edit',
				origin: 'user',
				sequenceId: seqId,
				commands: [{ type: 'marker.add', frame: 3, name: 'x' }] as never[],
			});
			timers.shift()?.(); // the debounce: the build starts, its first slice runs
		});
		expect(c.getState().previewing).toBe(true);
		expect(screen.getByTestId('review-previewing').textContent).toBe('Updating the preview…');
		const stalePreview = c.getState().preview;
		await act(async () => flush());
		expect(c.getState().previewing).toBe(false);
		expect(screen.queryByTestId('review-previewing')).toBeNull();
		expect(c.getState().preview).not.toBe(stalePreview);
		if (process.env.REVIEW_VIRTUAL_OUT)
			writeFileSync(
				process.env.REVIEW_VIRTUAL_OUT,
				`${JSON.stringify({ items: N, firstRenderMs: Math.round(firstRenderMs), decisionMs: Math.round(decisionMs), domOptions: options().length })}\n`,
			);
		c.dispose();
	});

	it('the list geometry: stacked groups, the visible range, rows with setup lines', () => {
		const items = Array.from({ length: 300 }, (_, i) => ({
			id: `i${i}`,
			label: `Item ${i}`,
			group: i % 3 === 0 ? 'hero' : 'support',
			requires: [],
			setup: false,
			state: 'pending' as const,
			engineState: 'pending' as const,
			alternatives: 1,
			selectedAlternative: 0,
			alternativeLabels: [`Item ${i}`],
			meta: { frame: i * 10 },
		}));
		const model = buildReviewModel(items, null);
		const m = reviewListMetrics(12);
		// at 12 px: a 1.25 rem first line + a 1.375 rem small-text line + py-0.5 + a 1 px border; the larger UI scales it
		expect(m).toEqual({ header: 15, row: 35.5, line: 16.5 });
		expect(reviewListMetrics(14).row).toBeCloseTo(41.25, 6);
		const layout = reviewListLayout(model, new Set(), m);
		expect(layout.rows).toBe(300);
		expect(layout.total).toBe(model.groups.length * m.header + 300 * m.row);
		// entries are stacked without gaps
		for (let i = 1; i < layout.entries.length; i++)
			expect(layout.entries[i]!.top).toBe(layout.entries[i - 1]!.top + layout.entries[i - 1]!.height);
		const { start, end } = visibleEntries(layout, 5000, 400, 0);
		expect(layout.entries[start]!.top).toBeLessThanOrEqual(5000);
		expect(layout.entries[start]!.top + layout.entries[start]!.height).toBeGreaterThan(5000);
		expect(layout.entries[end - 1]!.top).toBeLessThan(5400);
		expect(end - start).toBeLessThanOrEqual(Math.ceil(400 / m.header) + 1);
		expect(visibleEntries(layout, 1e9, 400, 0)).toEqual({
			start: layout.entries.length,
			end: layout.entries.length,
		});
	});
});
