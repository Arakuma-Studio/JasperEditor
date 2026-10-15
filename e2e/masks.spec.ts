import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clipElement,
	createProject,
	enableAgentBridge,
	pointerDrag,
	query,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

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

test('dragging a vertex on the monitor is one undo step', async () => {
	const [m0] = await masks();
	const before = (await appliedLabels(page)).length;
	const v = await centre('mask-vertex-0');
	await pointerDrag(page, v, { x: v.x + 30, y: v.y - 20 }, { steps: 8 });
	await expect.poll(async () => (await appliedLabels(page)).length).toBe(before + 1);
	const [m1] = await masks();
	expect(m1!.path.value.vertices[0]!.p[0]).toBeGreaterThan(m0!.path.value.vertices[0]!.p[0]);
	expect(m1!.path.value.vertices[1]!.p).toEqual(m0!.path.value.vertices[1]!.p);
});

test('the feather handle sets Mask Feather (one undo step)', async () => {
	const before = (await appliedLabels(page)).length;
	const h = await centre('mask-feather-handle');
	await pointerDrag(page, h, { x: h.x, y: h.y - 25 }, { steps: 8 });
	await expect.poll(async () => (await appliedLabels(page)).length).toBe(before + 1);
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

test.afterEach(async () => {
	await test
		.info()
		.attach('mask-document', { body: JSON.stringify(await masks()), contentType: 'application/json' });
});
