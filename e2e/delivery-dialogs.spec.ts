// Spec 19 §12 in the built app: the delivery dialogs of the Graphics menu. Send to Photoshop, Import Layer Styles, Export
// Title and Split Image each open from the menu, show their options and what blocks them, and Cancel leaves the project
// as it was. Writing a PSD, a PNG sequence or the split parts is covered by the engine's `delivery.e2e.test.ts`; this is
// the dialogs' side.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clipElement,
	createProject,
	enableAgentBridge,
	expectTransaction,
	focusTimeline,
	playheadFrame,
	query,
	ROOT,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const OUT = join(ROOT, 'test-results', 'e2e-delivery-dialogs');
mkdirSync(OUT, { recursive: true });

let page: Page;
let titleId = '';

/** An RGBA PNG (8 bits, no filter), enough for a picture with islands. */
function png(
	width: number,
	height: number,
	paint: (x: number, y: number) => [number, number, number, number],
) {
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) raw.set(paint(x, y), y * (width * 4 + 1) + 1 + x * 4);
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([len, body, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr.set([8, 6, 0, 0, 0], 8);
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

/** A 9 × 9 grid of dots: 81 islands, more than a split may make at the default merge distance. */
const DOTS = join(OUT, 'dots.png');
writeFileSync(
	DOTS,
	png(900, 900, (x, y) => (x % 100 < 30 && y % 100 < 30 ? [230, 120, 40, 255] : [0, 0, 0, 0])),
);

/** A PSD whose layer has a stroke, a drop shadow, a colour fill and a pattern overlay (not supported). */
const STYLES = join(OUT, 'styled.psd');
{
	const { writePsdUint8Array } = createRequire(join(ROOT, 'apps/engine/package.json'))('ag-psd') as {
		writePsdUint8Array(psd: unknown, opts?: unknown): Uint8Array;
	};
	const effects = {
		stroke: [
			{
				enabled: true,
				size: { units: 'Pixels', value: 6 },
				position: 'center',
				fillType: 'color',
				blendMode: 'normal',
				opacity: 1,
				color: { r: 20, g: 20, b: 80 },
			},
		],
		dropShadow: [
			{
				enabled: true,
				size: { units: 'Pixels', value: 12 },
				distance: { units: 'Pixels', value: 9 },
				choke: { units: 'Pixels', value: 0 },
				angle: 120,
				color: { r: 0, g: 0, b: 0 },
				opacity: 0.6,
				blendMode: 'multiply',
			},
		],
		solidFill: [{ enabled: true, blendMode: 'normal', opacity: 1, color: { r: 240, g: 200, b: 40 } }],
		patternOverlay: { enabled: true, blendMode: 'normal', opacity: 1, pattern: { name: 'Bricks', id: 'x' } },
	};
	writeFileSync(
		STYLES,
		writePsdUint8Array(
			{
				width: 64,
				height: 64,
				children: [{ name: 'Styled title', left: 0, top: 4, bottom: 44, right: 10, effects }],
			},
			{ noBackground: true },
		),
	);
}

async function graphics(item: string) {
	await page.getByTestId('menubar').getByRole('menuitem', { name: 'Graphics', exact: true }).click();
	return page.getByRole('menuitem', { name: item, exact: true }).first();
}

const dialogCancel = (testId: string) =>
	page.getByTestId(testId).getByRole('button', { name: 'Cancel', exact: true });

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
	await createProject(page, 'E2E Delivery Dialogs');
	const r = await transact(page, [
		{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [0.1, 0.25, 0.5, 1] },
		{ type: 'clip.addText', at: 0, duration: 60, track: 'V2', content: { text: 'Delivery' }, ref: '$t' },
	] as never);
	expectTransaction(r);
	titleId = r.refs.$t!;
	// A title with a look: Send to Photoshop can split it into its rims and face.
	expectTransaction(
		await transact(page, [
			{
				type: 'look.apply',
				clipIds: [titleId],
				look: {
					name: 'Edged',
					recipe: {
						palette: { face: [1, 1, 1, 1] },
						layers: [{ type: 'rim', params: { width: 4 } }, { type: 'face' }],
					},
				},
			},
		] as never),
	);
});

test.afterAll(async () => {
	await page?.close();
});

test('Send to Photoshop: an empty frame is blocked by name, a full one lists its layers; Cancel writes nothing', async () => {
	// On a transparent background, past the clips, nothing is visible: the dialog says so and will not write.
	expectTransaction(
		await transact(page, [
			{ type: 'sequence.updateSettings', settings: { backgroundColor: [0, 0, 0, 0] } },
		] as never),
	);
	await focusTimeline(page);
	await page.keyboard.press('End');
	expect(await playheadFrame(page)).toBe(60);
	await (await graphics('Send to Photoshop…')).click();
	const dialog = page.getByTestId('psd-dialog');
	await expect(dialog).toBeVisible();
	await expect(page.getByTestId('psd-blockers')).toContainText('Nothing is visible at this frame');
	await expect(dialog.getByRole('button', { name: 'Write PSD' })).toBeDisabled();
	await page.screenshot({ path: join(OUT, 'psd-blocked.png') });
	await dialogCancel('psd-dialog').click();
	await expect(dialog).toHaveCount(0);

	await focusTimeline(page);
	await page.keyboard.press('Home');
	expect(await playheadFrame(page)).toBe(0);
	await (await graphics('Send to Photoshop…')).click();
	await expect(page.getByTestId('psd-layers')).toContainText('Delivery');
	await expect(page.getByTestId('psd-blockers')).toHaveCount(0);
	await expect(page.getByTestId('psd-warnings')).toContainText('rasterised');
	await expect(dialog.getByRole('button', { name: 'Write PSD' })).toBeEnabled();
	// The option re-plans: a title split into its parts is a group.
	await dialog.getByText('Split titles into rims, face and fx').click();
	await expect(page.getByTestId('psd-layers')).toContainText('(group)');
	await page.screenshot({ path: join(OUT, 'psd-split.png') });
	const before = await appliedLabels(page);
	await dialogCancel('psd-dialog').click();
	await expect(dialog).toHaveCount(0);
	expect(await appliedLabels(page)).toEqual(before);
});

test('Export Title: unavailable without a title; its options; Cancel exports nothing', async () => {
	// Nothing selected: the entry is there, disabled.
	await focusTimeline(page);
	await page.keyboard.press('Control+Shift+KeyA');
	const entry = await graphics('Export Title…');
	await expect(entry).toHaveAttribute('aria-disabled', 'true');
	await page.keyboard.press('Escape');

	await clipElement(page, titleId).click({ position: { x: 20, y: 10 } });
	await (await graphics('Export Title…')).click();
	const dialog = page.getByTestId('alpha-dialog');
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText('Export Title');
	await expect(dialog).toContainText('60 transparent PNGs');
	// A title trims to its content by default, with a margin; without the trim there is no margin to set.
	await expect(page.getByTestId('alpha-margin')).toBeVisible();
	await expect(dialog).toContainText('glows do not clip');
	await dialog.getByText('Trim to content').click();
	await expect(page.getByTestId('alpha-margin')).toHaveCount(0);
	await expect(dialog).not.toContainText('glows do not clip');
	await dialog.getByText('Trim to content').click();
	await expect(page.getByTestId('alpha-margin')).toBeVisible();
	await dialog.getByRole('combobox', { name: 'Frames' }).click();
	await page.getByRole('option', { name: 'Frame at the playhead' }).click();
	await expect(dialog).toContainText('One transparent PNG.');
	await page.screenshot({ path: join(OUT, 'export-title.png') });
	await dialogCancel('alpha-dialog').click();
	await expect(dialog).toHaveCount(0);
	await expect(page.getByTestId('alpha-progress')).toHaveCount(0);
});

test('Import Layer Styles: the report names what maps and what is not supported; Cancel adds no look', async () => {
	const looks = async () =>
		Object.keys((await query<Record<string, unknown>>(page, 'doc.get', { path: ['titleLooks'] })) ?? {});
	const before = await looks();
	const chooser = page.waitForEvent('filechooser');
	await (await graphics('Import Layer Styles…')).click();
	await (await chooser).setFiles(STYLES);
	const dialog = page.getByTestId('layer-style-dialog');
	await expect(dialog).toBeVisible();
	await expect(page.getByTestId('layer-style-row')).toHaveCount(1);
	await expect(page.getByTestId('style-mapped')).toBeVisible();
	await expect(page.getByTestId('style-unsupported')).toContainText(/pattern/i);
	await expect(dialog.getByRole('button', { name: 'Import 1 style' })).toBeEnabled();
	// The reference size is an option per style; unticking the only style leaves nothing to import.
	await dialog.getByLabel('Reference size of Styled title').fill('48');
	await dialog.getByText('Styled title', { exact: true }).click();
	await expect(dialog.getByRole('button', { name: 'Import 0 styles' })).toBeDisabled();
	await page.screenshot({ path: join(OUT, 'layer-styles.png') });
	await dialogCancel('layer-style-dialog').click();
	await expect(dialog).toHaveCount(0);
	expect(await looks()).toEqual(before);
});

test('Split Image: too many parts is refused by name, the merge distance groups them; Cancel splits nothing', async () => {
	await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Control+KeyI');
	await (await chooser).setFiles(DOTS);
	await expect(page.getByTestId('project-row').filter({ hasText: 'dots.png' })).toBeVisible({
		timeout: 60_000,
	});
	const media = await query<Record<string, { id: string; originalName: string }>>(page, 'doc.get', {
		path: ['media'],
	});
	const mediaId = Object.values(media).find((m) => m.originalName === 'dots.png')!.id;
	const placed = await transact(page, [
		{ type: 'clip.place', source: { mediaId }, at: 120, tracks: { video: 'V1' }, ref: '$c' },
	] as never);
	expectTransaction(placed);
	const stillId = placed.refs.$c!;
	await expect(clipElement(page, stillId)).toBeVisible();
	await clipElement(page, stillId).click({ position: { x: 10, y: 10 } });
	const clipsBefore = (await query<{ clips: unknown[] }>(page, 'sequence.clipsInRange', { from: 0, to: 1e7 }))
		.clips.length;
	await (await graphics('Split Image…')).click();
	const dialog = page.getByTestId('split-dialog');
	await expect(page.getByTestId('split-stage')).toBeVisible({ timeout: 120_000 });
	await expect(page.getByTestId('split-count')).toHaveText('81 parts');
	await expect(page.getByTestId('split-too-many')).toContainText('At most 64 parts');
	await expect(dialog.getByRole('button', { name: /^Split/ })).toBeDisabled();
	await page.screenshot({ path: join(OUT, 'split-too-many.png') });
	// A merge distance past the gaps (70 px of 900 = 7.8 %) makes the grid one part: nothing to split.
	await page.getByTestId('split-merge').fill('8');
	await expect(page.getByTestId('split-count')).toHaveText('1 part');
	await expect(dialog.getByRole('button', { name: 'Split', exact: true })).toBeDisabled();
	await expect(page.getByTestId('split-too-many')).toHaveCount(0);
	await dialogCancel('split-dialog').click();
	await expect(dialog).toHaveCount(0);
	const clipsAfter = (await query<{ clips: unknown[] }>(page, 'sequence.clipsInRange', { from: 0, to: 1e7 }))
		.clips.length;
	expect(clipsAfter).toBe(clipsBefore);
});
