// Tracking UI acceptance (S09 §8 item 6, TRU-001…004): a plate on V1 and a still on V2; add a planar tracker in
// Properties ▸ Tracking → drag a corner on the Program monitor (one History entry) → Track Forward (engine job,
// live overlay) → Apply to… Corner Pin (one entry) → drag a corner-pin handle at a frame (keyframe updated, one
// entry) → the undo chain restores each step.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clipElement,
	clips,
	createProject,
	enableAgentBridge,
	FIXTURES,
	importFiles,
	query,
	watchPage,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const PLATE = existsSync(join(FIXTURES, 'plate-planar.mp4')) ? 'plate-planar.mp4' : 'clip-a.mp4';

let page: Page;
let watcher: { errors: string[] };
let plateId = '';
let stillId = '';
let seqId = '';

type Tracker = {
	id: string;
	name: string;
	reference: { time: number; corners?: [number, number][] };
	samples: { start: number; data: number[] } | null;
};
type Key = { time: number; value: [number, number] };
type Fx = { id: string; effectId: string; params: Record<string, { value: unknown; keyframes: Key[] }> };

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	watcher = watchPage(page);
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	await page?.close();
});

async function clipDoc<T>(id: string): Promise<T> {
	return query<T>(page, 'doc.get', { path: ['sequences', seqId, 'clips', id] });
}
const trackers = async () => (await clipDoc<{ trackers?: Tracker[] }>(plateId)).trackers ?? [];
const pinOf = async () =>
	((await clipDoc<{ effects?: Fx[] }>(stillId)).effects ?? []).find(
		(e) => e.effectId === 'jasper.corner-pin',
	);

/** Centre of an SVG element in page coordinates. */
async function centreOf(selector: string): Promise<{ x: number; y: number }> {
	const box = await page.locator(selector).first().boundingBox();
	if (!box) throw new Error(`${selector} is not visible`);
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	for (let i = 1; i <= 10; i++) {
		await page.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10);
		await page.waitForTimeout(16);
	}
	await page.mouse.up();
}

test('set up: plate on V1, still on V2', async () => {
	await createProject(page, 'Tracking E2E');
	await importFiles(page, [PLATE, 'still.png']);
	const media = await query<{ media: { mediaId: string; originalName: string }[] }>(page, 'media.list');
	const idOf = (n: string) => media.media.find((m) => m.originalName === n)!.mediaId;
	const r = await page.evaluate(
		([plate, still]) =>
			(
				window as unknown as { jasper: { transact(tx: unknown): Promise<{ ok: boolean; errors?: unknown }> } }
			).jasper.transact({
				label: 'Place plate and still',
				commands: [
					{
						type: 'clip.place',
						source: { mediaId: plate },
						at: 0,
						tracks: { video: 'V1' },
						matchSequence: 'keep',
						audio: false,
					},
					{
						type: 'clip.place',
						source: { mediaId: still },
						at: 0,
						tracks: { video: 'V2' },
						sourceRange: { in: { seconds: 0 }, out: { seconds: 4 } },
						matchSequence: 'keep',
					},
				],
			}),
		[idOf(PLATE), idOf('still.png')] as const,
	);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	const rows = await clips(page);
	plateId = rows.find((c) => c.track === 'V1')!.id;
	stillId = rows.find((c) => c.track === 'V2')!.id;
	seqId = (await query<{ sequenceId: string }>(page, 'sequence.summary')).sequenceId;
	// The still covers the frame: shrink it into a corner so the plate stays visible while placing the tracker.
	const s = await page.evaluate(
		(id) =>
			(window as unknown as { jasper: { transact(tx: unknown): Promise<{ ok: boolean }> } }).jasper.transact({
				label: 'Shrink still',
				commands: [
					{ type: 'param.set', target: ['clip', id, 'transform', 'scale'], value: 25 },
					{ type: 'param.set', target: ['clip', id, 'transform', 'position'], value: [1650, 150] },
				],
			}),
		stillId,
	);
	expect(s.ok).toBe(true);
});

test('add a planar tracker and drag a corner on the Program monitor (one History entry)', async () => {
	await clipElement(page, plateId).click();
	const section = page.getByTestId('tracking-section');
	await expect(section).toBeVisible();
	await section.scrollIntoViewIfNeeded();
	await page.getByTestId('tracking-add-planar').click();
	await expect.poll(async () => (await appliedLabels(page)).at(-1)).toBe('Add Planar Tracker');
	await expect(page.getByTestId('tracker-overlay')).toBeVisible();
	const before = (await trackers())[0]!;
	const labels0 = (await appliedLabels(page)).length;
	const c0 = await centreOf('[data-testid="tracker-corner-0"] rect:last-child');
	await drag(c0, { x: c0.x - 12, y: c0.y - 8 });
	await expect.poll(async () => (await appliedLabels(page)).length).toBe(labels0 + 1);
	expect((await appliedLabels(page)).at(-1)).toBe('Adjust Tracker');
	const after = (await trackers())[0]!;
	expect(after.reference.corners![0]![0]).toBeLessThan(before.reference.corners![0]![0] - 20);
	expect(after.reference.corners![1]).toEqual(before.reference.corners![1]);
});

test('Track Forward runs an engine job with a live overlay and commits one "Track" entry', async () => {
	const labels0 = (await appliedLabels(page)).length;
	await page.getByTestId('track-forward').click();
	const error = page.getByTestId('tracking-error');
	// While the job runs the section shows its progress and the Program overlay stays on the tracker.
	await expect(page.getByTestId('tracking-progress').or(error)).toBeVisible({ timeout: 30_000 });
	if (await error.isVisible()) throw new Error(`tracking failed: ${await error.textContent()}`);
	await expect(page.getByTestId('tracker-overlay')).toBeVisible();
	await expect(page.getByTestId('tracking-progress')).toBeHidden({ timeout: 120_000 });
	await expect.poll(async () => (await appliedLabels(page)).slice(labels0)).toEqual(['Track']);
	const t = (await trackers())[0]!;
	expect(t.samples?.data.length).toBeGreaterThan(8 * 10);
	await expect(page.getByTestId(`tracker-span-${t.id}`)).not.toHaveText('Not tracked');
	await expect(page.getByTestId(`tracker-confidence-${t.id}`)).toBeVisible();
	await expect(page.getByTestId('tracker-overlay')).toHaveAttribute('data-tracked', '1');
});

test('Apply to… Corner Pin bakes keyframes onto the still (one "Apply Tracking" entry)', async () => {
	const labels0 = (await appliedLabels(page)).length;
	await page.getByTestId('tracking-apply').click();
	const dialog = page.getByTestId('tracking-apply-dialog');
	await expect(dialog).toBeVisible();
	await expect(page.getByTestId(`tracking-target-${stillId}`)).toBeVisible();
	await expect(page.getByTestId('tracking-mode-corner-pin').locator('input')).toBeChecked();
	await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect.poll(async () => (await appliedLabels(page)).slice(labels0)).toEqual(['Apply Tracking']);
	const pin = await pinOf();
	expect(pin).toBeTruthy();
	expect(pin!.params.topLeft!.keyframes.length).toBeGreaterThan(10);
	const still = await clipDoc<{ trackedBy?: { trackerId: string; mode: string } }>(stillId);
	expect(still.trackedBy?.mode).toBe('corner-pin');
});

test('drag a corner-pin handle at a frame: the keyframe there changes (one entry)', async () => {
	await query(page, 'playhead.set', { frame: 30 });
	await clipElement(page, stillId).click();
	await page.getByRole('tab', { name: 'Effect Controls' }).click();
	const editor = page.getByTestId('corner-pin-editor');
	await expect(editor).toBeVisible();
	await expect(page.getByTestId('corner-pin-driven')).toContainText('Planar Tracker 1');
	await page.getByTestId('corner-pin-handles-toggle').click();
	await expect(page.getByTestId('corner-pin-overlay')).toBeVisible();
	const pin0 = (await pinOf())!;
	const keysBefore = pin0.params.bottomRight!.keyframes;
	const labels0 = (await appliedLabels(page)).length;
	const h = await centreOf('[data-testid="corner-pin-handle-2"] circle:last-child');
	await drag(h, { x: h.x + 15, y: h.y + 10 });
	await expect.poll(async () => (await appliedLabels(page)).length).toBe(labels0 + 1);
	expect((await appliedLabels(page)).at(-1)).toBe('Corner Pin');
	const keysAfter = (await pinOf())!.params.bottomRight!.keyframes;
	expect(keysAfter.length).toBe(keysBefore.length);
	const changed = keysAfter.filter((k, i) => k.value[0] !== keysBefore[i]!.value[0]);
	expect(changed).toHaveLength(1);
	expect(changed[0]!.value[0]).toBeGreaterThan(keysBefore.find((k) => k.time === changed[0]!.time)!.value[0]);
});

test('the undo chain restores each step', async () => {
	const expectTop = async (label: string) =>
		expect.poll(async () => (await appliedLabels(page)).at(-1)).toBe(label);
	await expectTop('Corner Pin');
	await page.getByTestId('program-monitor').click({ position: { x: 5, y: 5 } });
	const undo = async () => {
		await page.keyboard.press('Control+KeyZ');
	};
	await undo();
	await expectTop('Apply Tracking');
	await undo();
	await expectTop('Track');
	expect(await pinOf()).toBeUndefined();
	await undo();
	await expectTop('Adjust Tracker');
	expect((await trackers())[0]!.samples).toBeNull();
	await undo();
	await expectTop('Add Planar Tracker');
	await undo();
	expect(await trackers()).toEqual([]);
	expect(watcher.errors.filter((e) => !/favicon|ResizeObserver/.test(e))).toEqual([]);
});
