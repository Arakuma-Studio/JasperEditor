import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clipElement,
	clips,
	createProject,
	enableAgentBridge,
	importFiles,
	pointerDrag,
	query,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const PLATE = 'roto-object.mp4';
const FIXTURES = join(process.cwd(), 'fixtures', 'media');

let page: Page;
let clipId = '';
let seqId = '';

type Roto = {
	id: string;
	base: number | null;
	span: number[];
	strokes: unknown[];
	result: { start: number; end: number } | null;
};

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	if (page && !page.isClosed()) await page.screenshot({ path: 'test-results/e2e-roto-final.png' });
	await page?.close();
});

const clipDoc = async <T>() => query<T>(page, 'doc.get', { path: ['sequences', seqId, 'clips', clipId] });
const rotos = async () => (await clipDoc<{ rotos?: Roto[] }>()).rotos ?? [];

/** Screen point of a sequence pixel on the Program monitor (the frame is fit to the monitor). */
async function monitorPoint(seqX: number, seqY: number): Promise<{ x: number; y: number }> {
	const b = await page.getByTestId('program-player-wrapper').boundingBox();
	if (!b) throw new Error('Program monitor not visible');
	return { x: b.x + (seqX / 1920) * b.width, y: b.y + (seqY / 1080) * b.height };
}

test('paint over the object with the Roto Brush: a roto, an Object Matte and the segmented frame', async () => {
	await createProject(page, 'Roto E2E');
	await importFiles(page, [PLATE]);
	const media = await query<{ media: { mediaId: string; originalName: string }[] }>(page, 'media.list');
	const mediaId = media.media.find((m) => m.originalName === PLATE)!.mediaId;
	const r = await page.evaluate(
		(id) =>
			window.jasper!.transact({
				label: 'Place plate',
				commands: [
					{
						type: 'clip.place',
						source: { mediaId: id },
						at: 0,
						tracks: { video: 'V1' },
						matchSequence: 'keep',
						audio: false,
						ref: '$c',
					},
					{ type: 'clip.fitToFrame', clipIds: ['$c'], mode: 'fit' },
				],
			}),
		mediaId,
	);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	clipId = (await clips(page)).find((c) => c.track === 'V1')!.id;
	seqId = (await query<{ sequenceId: string }>(page, 'sequence.summary')).sequenceId;
	await query(page, 'playhead.set', { frame: 10 });
	await clipElement(page, clipId).click();
	const toggle = page.getByTestId('section-toggle-properties.ext.roto');
	await toggle.scrollIntoViewIfNeeded();
	if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
	await expect(page.getByTestId('roto-section')).toBeVisible();
	await page.getByTestId('roto-tool').click();
	await expect(page.getByTestId('roto-brush-surface')).toBeVisible();
	const labels0 = (await appliedLabels(page)).length;
	// The ellipse at frame 10: centre (230, 185) in 640×360 media px = (690, 555) sequence px.
	const a = await monitorPoint(640, 545);
	const b = await monitorPoint(740, 565);
	await pointerDrag(page, a, b, { steps: 12 });
	await expect
		.poll(async () => (await appliedLabels(page)).slice(labels0, labels0 + 1))
		.toEqual(['Roto Brush']);
	const roto = (await rotos())[0]!;
	expect(roto.base).toBe(10);
	expect(roto.strokes).toHaveLength(1);
	const fx = (
		await clipDoc<{ effects: { effectId: string; params: Record<string, { value: unknown }> }[] }>()
	).effects;
	expect(fx.find((e) => e.effectId === 'jasper.object-matte')?.params.object?.value).toBe(roto.id);
	await expect
		.poll(async () => (await appliedLabels(page)).slice(labels0), { timeout: 120_000 })
		.toEqual(['Roto Brush', 'Propagate Roto']);
	expect((await rotos())[0]!.result).toMatchObject({ start: 10, end: 10 });
	await expect(page.getByTestId('roto-matte')).toBeVisible();
	await page.screenshot({ path: 'test-results/e2e-roto-stroke.png' });
});

test('Propagate both directions runs one engine job and commits one entry; the output is cut out', async () => {
	await page.getByTestId('roto-tool').click(); // tool off: the monitor shows the matte only
	const labels0 = (await appliedLabels(page)).length;
	await page.getByTestId('roto-propagate').click();
	await expect
		.poll(async () => (await appliedLabels(page)).slice(labels0), { timeout: 300_000 })
		.toEqual(['Propagate Roto']);
	const roto = (await rotos())[0]!;
	expect(roto.result).toMatchObject({ start: 0, end: 44 });
	await expect(page.getByTestId('roto-status-text')).toContainText('Computed 0–44');
	await query(page, 'playhead.set', { frame: 30 });
	await expect(page.getByTestId('roto-overlay')).toHaveAttribute('data-media-frame', '30');
	await expect(page.getByTestId('roto-matte')).toHaveAttribute('data-url', /n=30/);
	await page.screenshot({ path: 'test-results/e2e-roto-propagated.png' });
	await page.getByTestId('roto-view').selectOption('boundary');
	await expect(page.getByTestId('roto-matte')).toBeVisible();
	await page.screenshot({ path: 'test-results/e2e-roto-boundary.png' });
	await page.getByTestId('roto-view').selectOption('off');
	await expect(page.getByTestId('roto-matte')).toBeHidden();
	await page.getByTestId('roto-view').selectOption('overlay');
});

test('Convert to Masks adds an Opacity mask around the object (one entry); undo removes it', async () => {
	const labels0 = (await appliedLabels(page)).length;
	await page.getByTestId('roto-to-masks').click();
	await expect.poll(async () => (await appliedLabels(page)).slice(labels0)).toEqual(['Convert to Masks']);
	const masks = (await clipDoc<{ masks?: unknown[] }>()).masks ?? [];
	expect(masks).toHaveLength(1);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => ((await clipDoc<{ masks?: unknown[] }>()).masks ?? []).length).toBe(0);
});

test('Effect Controls: the Object Matte lists the roto object; Freeze locks it', async () => {
	await clipElement(page, clipId).click();
	await page.getByRole('tab', { name: 'Effect Controls' }).click();
	const roto = (await rotos())[0]!;
	await expect(page.locator(`select[aria-label="Object"]`).first()).toHaveValue(roto.id);
	await page.getByRole('tab', { name: 'Properties' }).click();
	await page.getByTestId('roto-freeze').click();
	await expect.poll(async () => (await appliedLabels(page)).at(-1)).toBe('Freeze Roto');
	expect(readFileSync(join(FIXTURES, 'roto-object.json'), 'utf8')).toContain('roto-fixtures');
});
