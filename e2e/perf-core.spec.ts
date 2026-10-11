import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clipBox,
	clipElement,
	clips,
	createProject,
	enableAgentBridge,
	focusTimeline,
	pointerDrag,
	serverInfo,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

let page: Page;
let projectId = '';

async function ui<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
	const { port } = serverInfo();
	const r = await page.request.post(`http://127.0.0.1:${port}/api/agent/ui`, {
		data: { projectId, action, args },
	});
	const body = await r.json();
	expect(r.ok(), `${action}: ${JSON.stringify(body)}`).toBe(true);
	return body.result as T;
}

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
	await enableAgentBridge(page);
	projectId = await createProject(page, 'E2E Perf core');
});
test.afterAll(async () => {
	await page?.close();
});

test('a multi-clip drag on a 1 000-clip sequence is one incremental gesture', async () => {
	test.setTimeout(300_000);
	const r = await transact(page, [
		{ type: 'track.add', kind: 'video', count: 1 },
		...Array.from({ length: 1000 }, (_, i) => ({
			type: 'clip.addSolid' as const,
			at: Math.floor(i / 4) * 40,
			duration: 30,
			track: `V${(i % 4) + 1}`,
			color: [((i % 7) + 1) / 8, 0.3, 0.6, 1] as [number, number, number, number],
		})),
	]);
	expect(r.ok).toBe(true);
	expect((await clips(page)).length).toBe(1000);

	// One edit in the page: apply and its invariant check, timed where it runs.
	const ms = await page.evaluate(async () => {
		const api = window.jasper!;
		const { clips: list } = (await api.query('sequence.clipsInRange', { from: 0, to: 100 })) as {
			clips: { id: string }[];
		};
		const times: number[] = [];
		for (let i = 0; i < 10; i++) {
			const t0 = performance.now();
			await api.transact({
				protocol: 'jasper.tx/1',
				label: 'Opacity',
				commands: [{ type: 'param.set', target: ['clip', list[0]!.id, 'opacity'], value: 40 + i }],
			});
			times.push(performance.now() - t0);
		}
		return Math.min(...times);
	});
	console.info(`[perf-core] one edit on 1 000 clips through the agent bridge: ${ms.toFixed(1)} ms`);
	expect(ms).toBeLessThan(250);

	await focusTimeline(page);
	await page.keyboard.press('Minus');
	const v1 = (await clips(page)).filter((c) => c.track === 'V1');
	const picked: string[] = [];
	await page.keyboard.down('Shift');
	for (const c of v1) {
		if (picked.length >= 50) break;
		if ((await clipElement(page, c.id).count()) === 0) break; // virtualized: off screen from here on
		const box = await clipBox(page, c.id);
		if (box.x + box.width > 1150) break;
		if (box.width < 16) continue;
		await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
		picked.push(c.id);
	}
	await page.keyboard.up('Shift');
	expect(picked.length).toBeGreaterThanOrEqual(8);
	const before = await appliedLabels(page);
	const first = await clipBox(page, picked[0]!);
	const from = { x: first.x + first.width / 2, y: first.y + first.height / 2 };
	const t0 = Date.now();
	await pointerDrag(
		page,
		{ x: first.x + 10, y: from.y },
		{ x: first.x + 10 + 270, y: from.y },
		{ steps: 30 },
	);
	console.info(`[perf-core] 30-step drag of ${picked.length} clips: ${Date.now() - t0} ms wall`);
	await expect.poll(async () => (await appliedLabels(page)).length).toBe(before.length + 1);
	const moved = (await clips(page)).filter((c) => picked.includes(c.id));
	const orig = new Map(v1.map((c) => [c.id, c.start]));
	expect(moved.length).toBe(picked.length);
	expect(moved.every((c) => c.start > orig.get(c.id)!)).toBe(true);
	await page.screenshot({ path: 'test-results/perf-core-drag.png' });

	const perf = await ui<{
		invariants: { mode: string; incremental: number; full: number; fallbacks: object };
	}>('perf', { sampleMs: 100 });
	console.info(`[perf-core] invariants ${JSON.stringify(perf.invariants)}`);
	expect(perf.invariants.mode).toBe('incremental');
	expect(perf.invariants.incremental).toBeGreaterThanOrEqual(11);
});
