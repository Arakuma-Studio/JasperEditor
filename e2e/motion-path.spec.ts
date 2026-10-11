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

type Key = { id: string; value: [number, number]; spatial?: { mode: string; outTangent: [number, number] } };

let page: Page;
let seqId = '';
let clipId = '';

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
	await createProject(page, 'E2E Motion Path');
	seqId = (await query<{ sequenceId: string }>(page, 'sequence.summary')).sequenceId;
});

test.afterAll(async () => {
	await page?.close();
});

async function positionKeys(): Promise<Key[]> {
	const seq = await query<{ clips: Record<string, { transform: { position: { keyframes: Key[] } } }> }>(
		page,
		'doc.get',
		{ path: ['sequences', seqId] },
	);
	return seq.clips[clipId]!.transform.position.keyframes;
}

test('the Program monitor draws the motion path of the selected clip', async () => {
	const r = await transact(page, [
		{ type: 'clip.addSolid', at: 0, duration: 90, track: 'V1', color: [0.1, 0.3, 0.8, 1], ref: '$s' },
	]);
	expect(r.ok).toBe(true);
	clipId = (await query<{ clips: { id: string }[] }>(page, 'sequence.clipsInRange', { from: 0, to: 100 }))
		.clips[0]!.id;
	const pos = ['clip', clipId, 'transform', 'position'];
	expect(
		(
			await transact(page, [
				{ type: 'param.setAnimated', target: pos, animated: true, at: { sequenceFrame: 0 } },
				{ type: 'param.set', target: pos, value: [400, 300], at: { sequenceFrame: 0 } },
				{ type: 'param.set', target: pos, value: [960, 800], at: { sequenceFrame: 30 } },
				{ type: 'param.set', target: pos, value: [1500, 300], at: { sequenceFrame: 60 } },
			])
		).ok,
	).toBe(true);
	expect((await positionKeys()).map((k) => k.spatial?.mode)).toEqual([
		'auto-bezier',
		'auto-bezier',
		'auto-bezier',
	]);
	await clipElement(page, clipId).click();
	const path = page.getByTestId('overlay-motion-path');
	await expect(path).toBeVisible();
	await expect(path.getByTestId('motion-path-dots')).toHaveAttribute('data-count', '90');
	await expect(path.locator('[data-path-key]')).toHaveCount(3);
	await expect(path.locator('[data-tangent]')).toHaveCount(4);
});

test('dragging a key square and a tangent handle are one undo step each', async () => {
	const keys = await positionKeys();
	const square = page.locator(`[data-path-key="${keys[1]!.id}"]`);
	const b = (await square.boundingBox())!;
	const from = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
	const before = (await appliedLabels(page)).length;
	await pointerDrag(page, from, { x: from.x + 30, y: from.y });
	await expect.poll(async () => (await positionKeys())[1]!.value[0]).toBeGreaterThan(960);
	expect((await positionKeys())[1]!.value[1]).toBeCloseTo(800, 0);
	expect((await appliedLabels(page)).slice(before)).toEqual(['Move Keyframe']);
	await expect(square).toHaveAttribute('data-selected', 'true');

	const handle = page.locator(`[data-tangent="${keys[1]!.id}:out"] circle`);
	const h = (await handle.boundingBox())!;
	const hc = { x: h.x + h.width / 2, y: h.y + h.height / 2 };
	await pointerDrag(page, hc, { x: hc.x, y: hc.y + 40 });
	await expect.poll(async () => (await positionKeys())[1]!.spatial?.mode).toBe('continuous-bezier');
	expect((await positionKeys())[1]!.spatial!.outTangent[1]).toBeGreaterThan(0);
	expect((await appliedLabels(page)).slice(before)).toEqual(['Move Keyframe', 'Edit Motion Path']);
});

test('Effect Controls ▸ Spatial Interpolation ▸ Linear straightens the path', async () => {
	const keys = await positionKeys();
	await page.getByTestId('tab-effectControls').click();
	const ec = page.getByTestId('effect-controls-panel');
	await ec.locator(`[data-kf-id="${keys[1]!.id}"]`).first().click({ button: 'right' });
	await page.getByTestId('ec-kf-spatial').click();
	await page.getByTestId('ec-kf-spatial-menu').locator('[data-spatial="linear"]').click();
	await expect.poll(async () => (await positionKeys())[1]!.spatial?.mode).toBe('linear');
	await expect(page.locator(`[data-tangent^="${keys[1]!.id}:"]`)).toHaveCount(0);
	expect((await appliedLabels(page)).at(-1)).toBe('Spatial Interpolation: Linear');
});
