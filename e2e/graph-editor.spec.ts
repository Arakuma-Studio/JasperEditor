// Effect Controls Value / Velocity graphs end to end (S03:KF-022, S05:ECP-006, wave1/graph-editor): twirl
// Opacity open, drag a key in the Value graph, then drag the key's out handle in the Velocity graph. Each
// drag is one History entry and the Linear key becomes Bezier with a faster leaving speed.
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clipBox,
	createProject,
	enableAgentBridge,
	expectTransaction,
	pointerDrag,
	query,
	timelineArea,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

type Key = {
	id: string;
	value: number;
	interpolation: string;
	easeOut: { influence: number; slope: number };
};

let page: Page;
let seqId = '';
let clipId = '';

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
	await createProject(page, 'E2E Graph editor');
	seqId = (await query<{ sequenceId: string }>(page, 'sequence.summary')).sequenceId;
});

test.afterAll(async () => {
	await page?.close();
});

const keys = async () =>
	(
		await query<{ opacity: { keyframes: Key[] } }>(page, 'doc.get', {
			path: ['sequences', seqId, 'clips', clipId],
			fields: ['opacity'],
		})
	).opacity.keyframes;

async function drag(selector: string, dx: number, dy: number): Promise<void> {
	const b = (await page.locator(selector).boundingBox())!;
	const x = b.x + b.width / 2;
	const y = b.y + b.height / 2;
	await pointerDrag(page, { x, y }, { x: x + dx, y: y + dy }, { steps: 8 });
}

test('Value and Velocity graph drags edit keys (one undo entry each)', async () => {
	const r = await transact(page, [
		{ type: 'clip.addSolid', at: 0, duration: 120, track: 'V1', color: [0.2, 0.4, 0.9, 1] },
	]);
	expectTransaction(r);
	clipId = r.created.find((id) => id.startsWith('clp_'))!;
	expect(
		(
			await transact(page, [
				{ type: 'keyframe.add', target: ['clip', clipId, 'opacity'], at: { frames: 10 }, value: 0 },
				{ type: 'keyframe.add', target: ['clip', clipId, 'opacity'], at: { frames: 60 }, value: 100 },
			])
		).ok,
	).toBe(true);

	const b = await clipBox(page, clipId);
	const area = (await timelineArea(page).boundingBox())!;
	await page.mouse.click(
		(Math.max(b.x, area.x + 4) + Math.min(b.x + b.width, area.x + area.width - 4)) / 2,
		b.y + b.height / 2,
	);
	await page.getByTestId('tab-effectControls').click();
	const ec = page.getByTestId('ec-content');
	await ec.getByTestId('twirl-opacity').click();
	await expect(ec.getByTestId('graphs-opacity')).toBeVisible();
	await ec.getByTestId('graphs-opacity').scrollIntoViewIfNeeded();

	const [first] = await keys();
	// Value graph: drag the first key up.
	await drag(`[data-testid="graph-value-key-${first!.id}"]`, 0, -20);
	await expect.poll(async () => (await keys())[0]!.value).toBeGreaterThan(5);
	expect((await appliedLabels(page)).at(-1)).toBe('Edit Keyframe: Opacity');

	// Velocity graph: the selected key shows its handles; dragging the out handle up speeds it up.
	const handle = `[data-testid="graph-velocity-handle-${first!.id}-out"]`;
	await expect(page.locator(handle)).toBeVisible();
	await drag(handle, 0, -15);
	await expect.poll(async () => (await keys())[0]!.interpolation).toBe('bezier');
	expect((await keys())[0]!.easeOut.slope).toBeGreaterThan(1);
	expect((await appliedLabels(page)).at(-1)).toBe('Keyframe Velocity: Opacity');

	// One undo restores the Linear key.
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await keys())[0]!.interpolation).toBe('linear');
});
