// Masks end to end (wp masks): Effect Controls ▸ Opacity ▸ ellipse tool creates a centred mask; the Program monitor
// shows its vertices; dragging a vertex is one History entry; the pen draws a closed free-form mask; the preview is
// masked; the export (native kernel) cuts the solid to the mask.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clipElement,
	createProject,
	enableAgentBridge,
	exportViaUi,
	pointerDrag,
	programPixels,
	query,
	ROOT,
	regionLuma,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const EXPORT_DIR = join(ROOT, 'test-results', 'e2e-masks');
type Mask = {
	id: string;
	name: string;
	path: { value: { closed: boolean; vertices: { p: [number, number] }[] } };
};

let page: Page;
let seqId = '';
let clipId = '';

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
	await createProject(page, 'E2E Masks');
	seqId = (await query<{ sequenceId: string }>(page, 'sequence.summary')).sequenceId;
});

test.afterAll(async () => {
	await page?.close();
});

async function masks(): Promise<Mask[]> {
	const seq = await query<{ clips: Record<string, { masks?: Mask[] }> }>(page, 'doc.get', {
		path: ['sequences', seqId],
	});
	return seq.clips[clipId]!.masks ?? [];
}

const centre = async (testId: string) => {
	const b = (await page.getByTestId(testId).boundingBox())!;
	return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

test('Effect Controls ▸ Opacity ▸ ellipse creates a centred mask drawn on the monitor', async () => {
	expect(
		(await transact(page, [{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [1, 1, 1, 1] }]))
			.ok,
	).toBe(true);
	clipId = (await query<{ clips: { id: string }[] }>(page, 'sequence.clipsInRange', { from: 0, to: 60 }))
		.clips[0]!.id;
	await query(page, 'playhead.set', { frame: 10 });
	await clipElement(page, clipId).click();
	await page.getByRole('tab', { name: 'Effect Controls' }).click();
	await page.getByTestId(`mask-ellipse-${clipId}:opacity`).click();
	await expect.poll(async () => (await masks()).length).toBe(1);
	const [m] = await masks();
	expect(m!.name).toBe('Mask (1)');
	await expect(page.getByTestId(`mask-selected-${m!.id}`)).toBeVisible();
	await expect(page.locator('[data-testid^="mask-vertex-"]')).toHaveCount(4);
	// The preview is masked: darker than the full white solid, not black.
	await expect.poll(async () => (await programPixels(page)).mean, { timeout: 30_000 }).toBeLessThan(200);
	expect((await programPixels(page)).mean).toBeGreaterThan(5);
});

test('dragging a vertex on the monitor is one undo step', async () => {
	const [m0] = await masks();
	const before = (await appliedLabels(page)).length;
	const v = await centre('mask-vertex-0');
	await pointerDrag(page, v, { x: v.x + 30, y: v.y - 20 }, { steps: 8 });
	await expect.poll(async () => (await appliedLabels(page)).length).toBe(before + 1);
	expect((await appliedLabels(page)).at(-1)).toBe('Move Mask Vertex');
	const [m1] = await masks();
	expect(m1!.path.value.vertices[0]!.p[0]).toBeGreaterThan(m0!.path.value.vertices[0]!.p[0]);
	expect(m1!.path.value.vertices[1]!.p).toEqual(m0!.path.value.vertices[1]!.p);
});

test('the feather handle sets Mask Feather (one undo step)', async () => {
	const before = (await appliedLabels(page)).length;
	const h = await centre('mask-feather-handle');
	await pointerDrag(page, h, { x: h.x, y: h.y - 25 }, { steps: 8 });
	await expect.poll(async () => (await appliedLabels(page)).length).toBe(before + 1);
	expect((await appliedLabels(page)).at(-1)).toBe('Mask Feather');
	const seq = await query<{ clips: Record<string, { masks: { feather: { value: number } }[] }> }>(
		page,
		'doc.get',
		{
			path: ['sequences', seqId],
		},
	);
	expect(seq.clips[clipId]!.masks[0]!.feather.value).toBeGreaterThan(20);
});

test('the pen draws a closed free-form mask (click, click, click, click the first vertex)', async () => {
	await page.getByTestId(`mask-pen-${clipId}:opacity`).click();
	const surface = page.getByTestId('mask-pen-surface');
	await expect(surface).toBeVisible();
	const b = (await page.getByTestId('program-player-wrapper').boundingBox())!;
	const pts = [
		{ x: b.x + b.width * 0.15, y: b.y + b.height * 0.15 },
		{ x: b.x + b.width * 0.35, y: b.y + b.height * 0.15 },
		{ x: b.x + b.width * 0.25, y: b.y + b.height * 0.35 },
	];
	for (const p of pts) await page.mouse.click(p.x, p.y);
	await page.mouse.click(pts[0]!.x, pts[0]!.y);
	await expect.poll(async () => (await masks()).length).toBe(2);
	const pen = (await masks())[1]!;
	expect(pen.path.value.closed).toBe(true);
	expect(pen.path.value.vertices).toHaveLength(3);
	await expect(surface).toBeHidden();
});

test('native export cuts the solid to the mask', async ({ request }) => {
	mkdirSync(EXPORT_DIR, { recursive: true });
	// Drop the pen mask; keep the ellipse.
	const ms = await masks();
	expect((await transact(page, [{ type: 'mask.remove', maskIds: [ms[1]!.id] }])).ok).toBe(true);
	const out = await exportViaUi(page, request, {
		engine: 'auto',
		fileName: 'masks.mp4',
		expectPath: /native/i,
		outDir: EXPORT_DIR,
	});
	expect(String(out.job.result?.renderPath)).toBe('native');
	// Corners are outside the centred ellipse (black background); the centre is the white solid.
	expect(regionLuma(out.file, 0.5, { x: 0.02, y: 0.02, w: 0.08, h: 0.08 })).toBeLessThan(25);
	expect(regionLuma(out.file, 0.5, { x: 0.45, y: 0.45, w: 0.1, h: 0.1 })).toBeGreaterThan(220);
});
