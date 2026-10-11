import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clipBox,
	clipElement,
	clips,
	createProject,
	enableAgentBridge,
	focusTimeline,
	importFiles,
	playheadFrame,
	pointerDrag,
	query,
	sequenceSummary,
	timelineArea,
	trackRow,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	if (page && !page.isClosed()) await page.screenshot({ path: 'test-results/e2e-editing-final.png' });
	await page?.close();
});

async function selection(): Promise<string[]> {
	const s = await query<{ selection: { timeline?: { clips?: string[] } } }>(page, 'selection.get');
	return s.selection.timeline?.clips ?? [];
}

/** Canvas pixels drawn inside a timeline clip (filmstrip tiles / waveform). */
async function drawnPixels(clipId: string): Promise<number> {
	return clipElement(page, clipId).evaluate((el) => {
		let n = 0;
		for (const c of el.querySelectorAll('canvas')) {
			const g = (c as HTMLCanvasElement).getContext('2d');
			if (!g || !c.width || !c.height) continue;
			const d = g.getImageData(0, 0, c.width, c.height).data;
			for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) n++;
		}
		return n;
	});
}

test('Backquote maximizes and restores the timeline', async () => {
	await createProject(page, 'E2E Editing');
	const tl = (await page.getByTestId('timeline-panel').boundingBox())!;
	await page.mouse.move(tl.x + tl.width / 2, tl.y + tl.height / 2);
	await page.keyboard.press('Backquote');
	await expect(page.getByTestId('restore-maximized')).toBeVisible();
	await page.keyboard.press('Backquote');
	await expect(page.getByTestId('restore-maximized')).toBeHidden();
});

test('drop clip-a on V1: filmstrip and waveform are drawn', async () => {
	await importFiles(page, ['clip-a.mp4', 'clip-b.mp4']);
	const row = page.getByTestId('project-row').filter({ hasText: 'clip-a.mp4' });
	await row.click(); // the import selected both items; drag only clip-a
	const box = (await timelineArea(page).boundingBox())!;
	await row.dragTo(timelineArea(page), { targetPosition: { x: 0, y: box.height - 150 } });
	await expect.poll(async () => (await clips(page)).length).toBe(2);
	// Taller tracks show filmstrips (S02: thumbnails need ≥ 40 px); waveforms show at the default height.
	await page.getByTestId('panel-menu-timeline').click();
	await page.getByRole('menuitem', { name: /Expand All Tracks/ }).click();
	const a1 = (await clips(page, ['A1']))[0]!;
	const v1 = (await clips(page, ['V1']))[0]!;
	await expect.poll(() => drawnPixels(a1.id), { timeout: 30_000 }).toBeGreaterThan(500);
	await expect.poll(() => drawnPixels(v1.id), { timeout: 30_000 }).toBeGreaterThan(500);
});

test('Ctrl-drop inserts clip-b at 5 s and ripples the sync-locked tracks (one History entry)', async () => {
	const before = (await appliedLabels(page)).length;
	const a = (await clips(page, ['V1']))[0]!;
	const b = await clipBox(page, a.id);
	const area = (await timelineArea(page).boundingBox())!;
	const v1Track = (await sequenceSummary(page)).tracks!.find((t) => t.label === 'V1')!;
	const v1Row = (await trackRow(page, v1Track.id).boundingBox()) ?? b;
	const x = b.x + b.width / 2 - area.x;
	const y = v1Row.y + v1Row.height / 2 - area.y;
	const rowB = page.getByTestId('project-row').filter({ hasText: 'clip-b.mp4' });
	await rowB.click();
	await page.keyboard.down('Control');
	await rowB.dragTo(timelineArea(page), { targetPosition: { x, y } });
	await page.keyboard.up('Control');
	await expect.poll(async () => (await clips(page, ['V1'])).length).toBe(3);
	const v = await clips(page, ['V1']);
	const au = await clips(page, ['A1']);
	expect(v.map((c) => c.name)).toEqual(['clip-a.mp4', 'clip-b.mp4', 'clip-a.mp4']);
	expect(au.at(-1)!.start).toBe(v.at(-1)!.start);
	expect(v[1]!.end).toBe(v[2]!.start);
	expect((await appliedLabels(page)).length).toBe(before + 1);
	await page.getByTestId('timeline-panel').click({ position: { x: 5, y: 5 } });
	await page.keyboard.press('Backslash'); // zoom to sequence
});

test('transport: timecode entry, ←/→ steps, L/K/J shuttle', async () => {
	await page.getByTestId('timeline-timecode').click();
	const input = page.getByTestId('timeline-timecode-input');
	await expect(input).toBeVisible();
	await input.fill('00;00;02;00');
	await input.press('Enter');
	await expect.poll(() => playheadFrame(page)).toBe(60);
	await focusTimeline(page);
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowLeft');
	expect(await playheadFrame(page)).toBe(61);
	await page.keyboard.press('KeyL');
	await expect
		.poll(async () => (await query<{ playing: boolean; frame: number }>(page, 'playhead.get')).frame)
		.toBeGreaterThan(70);
	await page.keyboard.press('KeyK');
	await expect
		.poll(async () => (await query<{ playing: boolean }>(page, 'playhead.get')).playing)
		.toBe(false);
	const stopped = await playheadFrame(page);
	await page.keyboard.press('KeyJ');
	await expect.poll(async () => playheadFrame(page)).toBeLessThan(stopped - 5);
	await page.keyboard.press('KeyK');
	await expect
		.poll(async () => (await query<{ playing: boolean }>(page, 'playhead.get')).playing)
		.toBe(false);
});

test('Ctrl+K adds an edit at the playhead on targeted tracks (one History entry)', async () => {
	await page.getByTestId('timeline-timecode').click();
	await page.getByTestId('timeline-timecode-input').fill('00;00;01;00');
	await page.getByTestId('timeline-timecode-input').press('Enter');
	await focusTimeline(page);
	const before = (await appliedLabels(page)).length;
	const n = (await clips(page, ['V1'])).length;
	await page.keyboard.press('Control+KeyK');
	await expect.poll(async () => (await clips(page, ['V1'])).length).toBe(n + 1);
	expect((await clips(page, ['V1']))[1]!.start).toBe(30);
	expect((await appliedLabels(page)).length).toBe(before + 1);
});

test('Delete lifts, Shift+Delete ripple-deletes; Ctrl+Z restores the clip and its selection', async () => {
	const v = await clips(page, ['V1']);
	const target = v[1]!; // 1 s … 5 s piece of clip-a
	const b = await clipBox(page, target.id);
	await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
	await expect.poll(selection).toContain(target.id);
	const before = (await appliedLabels(page)).length;
	await page.keyboard.press('Delete');
	await expect.poll(async () => (await clips(page, ['V1'])).length).toBe(v.length - 1);
	expect((await clips(page, ['V1']))[1]!.start).toBe(v[2]!.start);
	expect((await appliedLabels(page)).length).toBe(before + 1);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await clips(page, ['V1'])).length).toBe(v.length);
	await expect.poll(selection).toContain(target.id);

	await page.keyboard.press('Shift+Delete');
	await expect.poll(async () => (await clips(page, ['V1'])).length).toBe(v.length - 1);
	const after = await clips(page, ['V1']);
	expect(after[1]!.start).toBe(target.start);
	expect((await clips(page, ['A1'])).find((c) => c.start === target.start)).toBeTruthy();
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await clips(page, ['V1'])).length).toBe(v.length);
});

test('B (ripple edit tool) trims the tail and ripples later clips; Ctrl-move inserts; S toggles snapping', async () => {
	await focusTimeline(page);
	const v = await clips(page, ['V1']);
	const first = v[0]!; // 0 … 1 s
	const next = v[1]!;
	const b = await clipBox(page, first.id);
	const pxPerFrame = b.width / first.duration;
	await page.keyboard.press('KeyB');
	const before = (await appliedLabels(page)).length;
	await pointerDrag(
		page,
		{ x: b.x + b.width - 2, y: b.y + b.height / 2 },
		{ x: b.x + b.width - 2 - 10 * pxPerFrame, y: b.y + b.height / 2 },
	);
	await expect.poll(async () => (await clips(page, ['V1']))[0]!.duration).toBeLessThan(first.duration);
	const trimmed = await clips(page, ['V1']);
	expect(trimmed[1]!.start).toBe(trimmed[0]!.end);
	expect(trimmed[1]!.start).toBeLessThan(next.start);
	expect((await appliedLabels(page)).length).toBe(before + 1);
	await page.keyboard.press('KeyV');
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await clips(page, ['V1']))[0]!.duration).toBe(first.duration);

	const cur = await clips(page, ['V1']);
	const last = cur.at(-1)!;
	const lb = await clipBox(page, last.id);
	const fb = await clipBox(page, cur[0]!.id);
	const n0 = (await appliedLabels(page)).length;
	await pointerDrag(
		page,
		{ x: lb.x + 10, y: lb.y + lb.height / 2 },
		{ x: fb.x + 1, y: fb.y + fb.height / 2 },
		{ modifiers: ['Control'] },
	);
	await expect.poll(async () => (await appliedLabels(page)).length).toBe(n0 + 1);
	expect((await appliedLabels(page)).at(-1)).toMatch(/Insert|Move/);
	const moved = await clips(page, ['V1']);
	expect(moved[0]!.id).toBe(last.id);
	await page.keyboard.press('Control+KeyZ');

	const snap = page.locator('[data-testid="timeline-toolbar"] [data-control="snap"]');
	const state0 = await snap.getAttribute('aria-pressed');
	await focusTimeline(page);
	await page.keyboard.press('KeyS');
	await expect(snap).not.toHaveAttribute('aria-pressed', state0 ?? '');
	await page.keyboard.press('KeyS');
	await expect(snap).toHaveAttribute('aria-pressed', state0 ?? '');
});
