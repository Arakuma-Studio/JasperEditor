// Workstream ui-perf in the built app: the editor UI at scale. Scripted gestures on generated projects (the same
// scenarios as `pnpm perf --sections ui`, scripts/perf/ui-scenarios.ts), measured from a Chrome trace: main-thread
// work per frame and the frame rate. Budgets (docs/performance.md §1) scale with the host's load like every timing
// budget (scripts/perf/budget.ts; the browser is another process, so `parallel`); PERF=1 enforces them exactly.
import { expect, type Page, test } from '@playwright/test';
import { budgetMs, budgetReport, loadFactor, PERF_STRICT } from '../scripts/perf/budget.ts';
import { cachedFixture } from '../scripts/perf/ui-run.ts';
import {
	dragScenario,
	effectControlsScenario,
	frameStats,
	openProject,
	scrollContainerScenario,
	settle,
	Tracer,
	uploadProject,
	wheelScenario,
} from '../scripts/perf/ui-scenarios.ts';
import { serverInfo } from './support.ts';

test.describe.configure({ mode: 'serial' });

const base = () => `http://127.0.0.1:${serverInfo().port}`;
/** Frame-rate floor at this load (the budget divided by the factor a time budget is multiplied by). */
const fpsFloor = (fps: number) => (PERF_STRICT ? fps : fps / (budgetMs(1000, { parallel: true }) / 1000));

async function open(page: Page, fixture: string): Promise<number> {
	const projectId = await uploadProject(base(), await cachedFixture(fixture));
	const ms = await openProject(page, base(), projectId);
	await settle(page, 1500);
	return ms;
}

async function traced<T>(page: Page, id: string, fn: (w: { id: string }) => Promise<T>) {
	const tracer = new Tracer(page);
	await tracer.start();
	const extra = await fn({ id });
	return { ...frameStats(await tracer.stop(), id), extra };
}

test.beforeAll(() => {
	console.info(`[ui-perf] host load factor ${loadFactor().toFixed(2)}${PERF_STRICT ? ' (strict)' : ''}`);
});

test('a 30-step drag of 11 clips on a 1 000-clip sequence keeps frames short', async ({ page }) => {
	test.setTimeout(300_000);
	await page.setViewportSize({ width: 1600, height: 960 });
	const openMs = await open(page, 'timeline:1000');
	const starts = () =>
		page.evaluate(() => {
			const s = (
				window as unknown as {
					__jasperMonitor: {
						session: {
							getCommitted(): { sequences: Record<string, { clips: Record<string, { start: number }> }> };
							getState(): { activeSequenceId: string };
						};
					};
				}
			).__jasperMonitor.session;
			const clips = s.getCommitted().sequences[s.getState().activeSequenceId]!.clips;
			return Object.fromEntries(Object.entries(clips).map(([id, c]) => [id, c.start]));
		});
	const before = await starts();
	const r = await traced(page, 'drag', (w) => dragScenario(page, w));
	expect(r.extra.committed).toBe(true);
	const after = await starts();
	const moved = Object.keys(after).filter((id) => after[id] !== before[id]);
	expect(moved.length).toBeGreaterThanOrEqual(r.extra.clips);
	expect(moved.every((id) => after[id]! > before[id]!)).toBe(true);
	console.info(
		`[ui-perf] drag of ${r.extra.clips} clips on 1 000 (opened in ${openMs} ms): ${r.frames} frames, work per frame p50 ${r.p50} / p95 ${r.p95} / mean ${r.mean} ms, ${r.extra.dragWallMs} ms wall; Program monitor drew ${r.extra.programFrames} gesture frames (≈ ${r.extra.programCostMs} ms each)`,
	);
	console.info(budgetReport('drag: mean work per frame', r.mean, 16, { parallel: true }));
	console.info(budgetReport('drag: wall time', r.extra.dragWallMs, 1500, { parallel: true }));
	await page.screenshot({ path: 'test-results/ui-perf-drag.png' });
	expect(r.mean).toBeLessThanOrEqual(budgetMs(16, { parallel: true }));
	expect(r.extra.dragWallMs).toBeLessThanOrEqual(budgetMs(1500, { parallel: true }));
});

test('scrolling and zooming a 5 000-clip timeline stay above 50 fps', async ({ page }) => {
	test.setTimeout(400_000);
	await page.setViewportSize({ width: 1600, height: 960 });
	await open(page, 'timeline:5000');
	await page.getByTestId('timeline-timecode').click();
	await page.keyboard.press('Escape');
	await page.keyboard.press('Minus');
	await settle(page, 500);
	const scroll = await traced(page, 'scroll', (w) => wheelScenario(page, w, 'scroll'));
	await settle(page, 500);
	await page.screenshot({ path: 'test-results/ui-perf-scroll.png' });
	const zoom = await traced(page, 'zoom', (w) => wheelScenario(page, w, 'zoom'));
	for (const [name, r] of [
		['scroll', scroll],
		['zoom', zoom],
	] as const)
		console.info(
			`[ui-perf] ${name} 5 000 clips: ${r.fps} fps (floor ${fpsFloor(50).toFixed(1)} at this load), work per frame p50 ${r.p50} / p95 ${r.p95} / mean ${r.mean} ms`,
		);
	// Clips are drawn where the model puts them after scrolling (the clip layer moves, the clips do not).
	const placement = await page.evaluate(() => {
		const area = document.querySelector('[data-testid="timeline-clip-area"]')!.getBoundingClientRect();
		const s = (
			window as unknown as {
				__jasperMonitor: {
					session: {
						getCommitted(): {
							sequences: Record<string, { clips: Record<string, { start: number }> }>;
						};
						getState(): {
							activeSequenceId: string;
							views: Record<string, { scrollFrame: number; pxPerFrame: number }>;
						};
					};
				};
			}
		).__jasperMonitor.session;
		const st = s.getState();
		const v = st.views[st.activeSequenceId]!;
		const clips = s.getCommitted().sequences[st.activeSequenceId]!.clips;
		const out: number[] = [];
		for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-track-id] [data-clip-id]'))) {
			const r = el.getBoundingClientRect();
			if (r.right < area.left || r.left > area.right) continue;
			const c = clips[el.dataset.clipId!];
			if (c) out.push(Math.abs(r.left - (area.left + (c.start - v.scrollFrame) * v.pxPerFrame)));
		}
		return { n: out.length, worst: Math.max(0, ...out) };
	});
	expect(placement.n).toBeGreaterThan(10);
	expect(placement.worst).toBeLessThanOrEqual(1.01);
	expect(scroll.fps).toBeGreaterThanOrEqual(fpsFloor(50));
	expect(zoom.fps).toBeGreaterThanOrEqual(fpsFloor(50));
});

test('the Project panel with 2 000 items scrolls smoothly and renders only what is in view', async ({ page }) => {
	test.setTimeout(300_000);
	await page.setViewportSize({ width: 1600, height: 960 });
	const openMs = await open(page, 'items:2000');
	await expect(page.getByTestId('project-count')).toHaveText(/\d{4} items/);
	const rendered = await page.getByTestId('project-row').count();
	expect(rendered).toBeGreaterThan(5);
	expect(rendered).toBeLessThan(400);
	const r = await traced(page, 'project', (w) =>
		scrollContainerScenario(page, w, '[data-testid="project-body"]'),
	);
	console.info(
		`[ui-perf] Project panel, 2 000 items (opened in ${openMs} ms): ${r.fps} fps (floor ${fpsFloor(50).toFixed(1)}), work per frame p50 ${r.p50} / p95 ${r.p95} / mean ${r.mean} ms, ${await page.getByTestId('project-row').count()} rows rendered`,
	);
	// The last item is reachable: scroll to the bottom and find it.
	await page.getByTestId('project-body').evaluate((el) => {
		el.scrollTop = el.scrollHeight;
	});
	await expect(page.getByTestId('project-row').filter({ hasText: 'still-1999.png' })).toBeVisible();
	await page.screenshot({ path: 'test-results/ui-perf-project.png' });
	expect(r.fps).toBeGreaterThanOrEqual(fpsFloor(50));
});

test('Effect Controls with 200 keyframes per parameter follow a scrub', async ({ page }) => {
	test.setTimeout(300_000);
	await page.setViewportSize({ width: 1600, height: 960 });
	await open(page, 'keyframes:200');
	const r = await traced(page, 'ec', (w) => effectControlsScenario(page, w));
	console.info(
		`[ui-perf] Effect Controls, 200 keyframes × 9 parameters, scrub: ${r.fps} fps, work per frame p50 ${r.p50} / p95 ${r.p95} / mean ${r.mean} ms`,
	);
	await expect(page.getByTestId('effect-controls-panel')).toBeVisible();
	await page.screenshot({ path: 'test-results/ui-perf-effect-controls.png' });
	expect(r.mean).toBeLessThanOrEqual(budgetMs(33, { parallel: true }));
});
