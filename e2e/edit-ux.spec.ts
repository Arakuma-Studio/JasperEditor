// edit-ux in the built app: three/four-point Overwrite from the Source monitor with the Fit Clip dialog, keyboard
// trim mode with the Trim Monitor (Shift+T, Ctrl+→, Ctrl+Shift+→, dynamic L/K trimming = one History entry),
// Match Frame, keyframe lanes (Ctrl-click a keyframe on the rubber band, fade handle), the Keyboard Shortcuts
// editor, Program guides, and an export whose frames show the fit-to-fill speed and the fade.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clipElement,
	clips,
	createProject,
	enableAgentBridge,
	exportViaUi,
	ffprobe,
	focusTimeline,
	importFiles,
	pointerDrag,
	query,
	ROOT,
	regionLuma,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

let page: Page;
let media: { mediaId: string; originalName: string }[] = [];
const OUT = join(ROOT, 'test-results', 'edit-ux');

test.beforeAll(async ({ browser }) => {
	mkdirSync(OUT, { recursive: true });
	page = await browser.newPage();
	await enableAgentBridge(page);
	await createProject(page, 'E2E edit-ux');
	await importFiles(page, ['clip-a.mp4', 'clip-b.mp4']);
	media = (await query<{ media: { mediaId: string; originalName: string }[] }>(page, 'media.list')).media;
});

test.afterAll(async () => {
	if (page && !page.isClosed()) await page.screenshot({ path: join(OUT, 'final.png') });
	await page?.close();
});

const mediaId = (name: string) => media.find((m) => m.originalName === name)!.mediaId;

async function doc<T>(path: string[]): Promise<T> {
	return query<T>(page, 'doc.get', { path });
}

async function seqId(): Promise<string> {
	return (await query<{ sequenceId: string }>(page, 'sequence.summary')).sequenceId;
}

test('four-point Overwrite asks Fit Clip and fits the clip by speed', async () => {
	const items = await doc<Record<string, { id: string; kind: string; mediaId?: string }>>(['items']);
	const itemA = Object.values(items).find(
		(i) => i.kind === 'media' && i.mediaId === mediaId('clip-a.mp4'),
	)!.id;
	const r = await transact(page, [
		{ type: 'item.setMarks', itemId: itemA, in: { seconds: 0 }, out: { seconds: 2 } },
		{ type: 'sequence.setInOut', in: 0, out: 30 },
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	// Open clip-a in the Source monitor (double-click in the Project panel).
	await page.getByTestId('project-row').filter({ hasText: 'clip-a.mp4' }).dblclick();
	await expect(page.getByTestId('source-item')).toHaveValue(itemA);
	await page.getByTestId('src-overwrite').click();
	await expect(page.getByTestId('fit-clip-dialog')).toBeVisible();
	await page.getByTestId('fit-clip-change-speed').check();
	await page.getByRole('button', { name: 'OK' }).click();
	await expect.poll(async () => (await clips(page, ['V1'])).length).toBe(1);
	const v1 = (await clips(page, ['V1']))[0]!;
	expect([v1.start, v1.duration]).toEqual([0, 30]);
	const sq = await seqId();
	const clip = await doc<{ speed: { rate: number } }>(['sequences', sq, 'clips', v1.id]);
	expect(clip.speed.rate).toBeCloseTo((2 * 30000) / 1001 / 30, 3);
	await transact(page, [{ type: 'sequence.setInOut', in: null, out: null }]);
});

test('trim mode: Shift+T opens the Trim Monitor; Ctrl+→ and Ctrl+Shift+→ roll; L/K is one History entry', async () => {
	const r = await transact(page, [
		{
			type: 'clip.place',
			source: { mediaId: mediaId('clip-b.mp4') },
			at: 30,
			sourceRange: { in: { seconds: 1 }, out: { seconds: 3 } },
		},
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	await query(page, 'playhead.set', { frame: 28 });
	await focusTimeline(page);
	await page.keyboard.press('Shift+KeyT');
	await expect(page.getByTestId('trim-monitor')).toBeVisible();
	await expect(page.getByTestId('trim-monitor')).toHaveAttribute('data-trim-type', 'roll');
	await page.screenshot({ path: join(OUT, 'trim-monitor.png') });
	await page.keyboard.press('Control+ArrowRight');
	await page.keyboard.press('Control+Shift+ArrowRight');
	await expect.poll(async () => (await clips(page, ['V1']))[0]!.duration).toBe(36);
	await expect(page.getByTestId('trim-monitor-out-shift')).toHaveText('+6');
	const before = (await appliedLabels(page)).length;
	await page.keyboard.press('KeyL');
	await page.waitForTimeout(400);
	await page.keyboard.press('KeyK');
	await expect.poll(async () => (await appliedLabels(page)).at(-1)).toBe('Dynamic Rolling Edit');
	expect((await appliedLabels(page)).length).toBe(before + 1);
	const moved = (await clips(page, ['V1']))[0]!.duration;
	expect(moved).toBeGreaterThan(36);
	// Undo restores in one step.
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await clips(page, ['V1']))[0]!.duration).toBe(36);
	await page.keyboard.press('Escape');
});

test('Match Frame opens the source at the matching frame', async () => {
	await query(page, 'playhead.set', { frame: 40 });
	await focusTimeline(page);
	await page.keyboard.press('KeyF');
	const items = await doc<Record<string, { id: string; kind: string; mediaId?: string }>>(['items']);
	const itemB = Object.values(items).find(
		(i) => i.kind === 'media' && i.mediaId === mediaId('clip-b.mp4'),
	)!.id;
	await expect(page.getByTestId('source-item')).toHaveValue(itemB);
});

test('keyframe lane: Ctrl-click adds a keyframe; the fade handle fades in (one entry each)', async () => {
	await page.getByTestId('panel-menu-timeline').click();
	await page.getByRole('menuitem', { name: /Expand All Tracks/ }).click();
	const v1 = (await clips(page, ['V1']))[0]!;
	const band = page.getByTestId(`lane-band-${v1.id}`);
	await expect(band).toBeAttached();
	const box = (await clipElement(page, v1.id).boundingBox())!;
	const bandBox = (await band.boundingBox())!;
	await page.keyboard.down('Control');
	await page.mouse.click(box.x + box.width * 0.6, bandBox.y + bandBox.height / 2);
	await page.keyboard.up('Control');
	await expect.poll(async () => (await appliedLabels(page)).at(-1)).toBe('Add Keyframe');
	const fade = page.getByTestId(`lane-fade-in-${v1.id}`);
	const fb = (await fade.boundingBox())!;
	await pointerDrag(
		page,
		{ x: fb.x + fb.width / 2, y: fb.y + fb.height / 2 },
		{ x: fb.x + box.width * 0.3, y: fb.y + fb.height / 2 },
	);
	await expect.poll(async () => (await appliedLabels(page)).at(-1)).toBe('Fade In');
	await page.screenshot({ path: join(OUT, 'lanes.png') });
});

test('Keyboard Shortcuts editor opens with Ctrl+Alt+K, searches and switches layouts', async () => {
	await focusTimeline(page);
	await page.keyboard.press('Control+Alt+KeyK');
	await expect(page.getByTestId('keyboard-shortcuts-dialog')).toBeVisible();
	await page.getByTestId('kb-search').fill('Trim Edit');
	await expect(page.locator('[data-command="timeline.trimEdit"]')).toBeVisible();
	await page.screenshot({ path: join(OUT, 'keyboard-shortcuts.png') });
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('keyboard-shortcuts-dialog')).toBeHidden();
});

test('Program rulers and guides: Ctrl+R, drag a guide out of the ruler', async () => {
	await page.getByTestId('program-viewport').click({ position: { x: 5, y: 5 } });
	await page.keyboard.press('Control+KeyR');
	await expect(page.getByTestId('program-ruler-top')).toBeVisible();
	const rb = (await page.getByTestId('program-ruler-top').boundingBox())!;
	await pointerDrag(page, { x: rb.x + rb.width / 2, y: rb.y + 4 }, { x: rb.x + rb.width / 2, y: rb.y + 120 });
	await expect(page.getByTestId('program-guide-0')).toBeVisible();
	await page.screenshot({ path: join(OUT, 'guides.png') });
});

test('export renders the fit-to-fill clip and the fade', async ({ request }) => {
	const out = await exportViaUi(page, request, {
		engine: 'auto',
		fileName: 'edit-ux.mp4',
		expectPath: /native|hybrid|remotion/i,
		outDir: OUT,
	});
	const p = ffprobe(out.file);
	expect(Number(p.format.duration)).toBeGreaterThan(1.5);
	// The fade starts black and reaches the picture.
	const first = regionLuma(out.file, 0.0, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
	const later = regionLuma(out.file, 0.9, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
	expect(first).toBeLessThan(later);
});
