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
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

let page: Page;
let clipId = '';
let seqId = '';

type Fx = {
	id: string;
	effectId: string;
	params: Record<string, { value: unknown }>;
	puppet?: { meshes: { id: string }[]; pins: { id: string; position: { value: number[] } }[] };
};

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	if (page && !page.isClosed()) await page.screenshot({ path: 'test-results/e2e-sim-warp-final.png' });
	await page?.close();
});

const effects = async () =>
	(await query<{ effects?: Fx[] }>(page, 'doc.get', { path: ['sequences', seqId, 'clips', clipId] }))
		.effects ?? [];
const fxOf = async (effectId: string) => (await effects()).find((e) => e.effectId === effectId)!;

async function monitorPoint(seqX: number, seqY: number): Promise<{ x: number; y: number }> {
	const b = await page.getByTestId('program-player-wrapper').boundingBox();
	if (!b) throw new Error('Program monitor not visible');
	return { x: b.x + (seqX / 1920) * b.width, y: b.y + (seqY / 1080) * b.height };
}

/** Opens Effect Controls and focuses the effect whose header shows `title` (its monitor tools appear). */
async function focusEffect(title: string) {
	await clipElement(page, clipId).click();
	await page.keyboard.press('Shift+Digit5'); // Window ▸ Effect Controls
	const ec = page.getByTestId('effect-controls-panel');
	await expect(ec).toBeVisible();
	await ec.getByTestId('fx-header-select').filter({ hasText: title }).first().click();
	return ec;
}

test('Puppet: the Pin tool adds pins on the Program monitor and a drag moves one', async () => {
	await createProject(page, 'Sim Warp E2E');
	await importFiles(page, ['chart.png']);
	const media = await query<{ media: { mediaId: string; originalName: string }[] }>(page, 'media.list');
	const mediaId = media.media.find((m) => m.originalName === 'chart.png')!.mediaId;
	const r = await page.evaluate(
		(id) =>
			window.jasper!.transact({
				label: 'Place chart',
				commands: [
					{ type: 'clip.place', source: { mediaId: id }, at: 0, tracks: { video: 'V1' }, ref: '$c' },
					{ type: 'clip.fitToFrame', clipIds: ['$c'], mode: 'fit' },
					{ type: 'effect.add', target: { clipId: '$c' }, effectId: 'jasper.puppet' },
				],
			}),
		mediaId,
	);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	clipId = (await clips(page)).find((c) => c.track === 'V1')!.id;
	seqId = (await query<{ sequenceId: string }>(page, 'sequence.summary')).sequenceId;
	await query(page, 'playhead.set', { frame: 10 });
	const ec = await focusEffect('Puppet');
	await ec.getByLabel('Puppet Pin tool').check();
	await expect(page.getByTestId('puppet-tool-target')).toBeVisible();
	const labels0 = (await appliedLabels(page)).length;
	const p1 = await monitorPoint(400, 540);
	await page.mouse.click(p1.x, p1.y);
	await expect.poll(async () => (await fxOf('jasper.puppet')).puppet?.pins.length ?? 0).toBe(1);
	const p2 = await monitorPoint(1500, 540);
	await page.mouse.click(p2.x, p2.y);
	await expect.poll(async () => (await fxOf('jasper.puppet')).puppet?.pins.length ?? 0).toBe(2);
	expect((await appliedLabels(page)).slice(labels0)).toEqual(['Add Puppet Pin', 'Add Puppet Pin']);
	expect((await fxOf('jasper.puppet')).puppet!.meshes).toHaveLength(1);
	await expect(ec.locator('[data-testid^="puppet-pin-name-"]')).toHaveCount(2);
	await ec.getByLabel('Puppet Pin tool').uncheck();
	const pin = (await fxOf('jasper.puppet')).puppet!.pins[1]!;
	const handle = page.getByTestId(`puppet-pin-handle-${pin.id}`);
	const hx = Number(await handle.getAttribute('data-x'));
	const hy = Number(await handle.getAttribute('data-y'));
	const svg = await page.getByTestId('puppet-overlay').boundingBox();
	const from = { x: svg!.x + hx, y: svg!.y + hy };
	await pointerDrag(page, from, { x: from.x, y: from.y - 80 }, { steps: 10 });
	await expect.poll(async () => (await appliedLabels(page)).at(-1)).toBe('Move Puppet Pins');
	const moved = (await fxOf('jasper.puppet')).puppet!.pins[1]!.position.value;
	expect(moved[1]).toBeLessThan(0.45);
	expect(Math.abs(moved[0]! - pin.position.value[0]!)).toBeLessThan(0.02);
	await expect(page.getByTestId('puppet-mesh')).toBeVisible();
	await page.screenshot({ path: 'test-results/e2e-sim-warp-puppet.png' });
	await page.keyboard.press('Control+z');
	await expect
		.poll(async () => (await fxOf('jasper.puppet')).puppet!.pins[1]!.position.value)
		.toEqual(pin.position.value);
});

test('Liquify: the brush paints one undoable stroke', async () => {
	expect(
		(await transact(page, [{ type: 'effect.add', target: { clipId }, effectId: 'jasper.liquify' }])).ok,
	).toBe(true);
	const ec = await focusEffect('Liquify');
	await expect(ec.getByTestId('liquify-tools')).toBeVisible();
	await ec.getByLabel('Liquify brush').check();
	await expect(page.getByTestId('liquify-brush-target')).toBeVisible();
	const a = await monitorPoint(800, 500);
	const b = await monitorPoint(1100, 520);
	await pointerDrag(page, a, b, { steps: 14 });
	await expect.poll(async () => (await appliedLabels(page)).at(-1)).toBe('Liquify');
	const mesh = (await fxOf('jasper.liquify')).params.distortionMesh!.value as number[];
	expect(mesh.slice(3).some((v) => v !== 0)).toBe(true);
	await page.screenshot({ path: 'test-results/e2e-sim-warp-liquify.png' });
	await ec.getByLabel('Liquify brush').uncheck();
	await page.keyboard.press('Control+z');
	await expect
		.poll(async () => ((await fxOf('jasper.liquify')).params.distortionMesh!.value as number[]).length)
		.toBe(0);
});

test('Mesh Warp: dragging a vertex edits the Distortion Mesh', async () => {
	expect(
		(await transact(page, [{ type: 'effect.add', target: { clipId }, effectId: 'jasper.mesh-warp' }])).ok,
	).toBe(true);
	await focusEffect('Mesh Warp');
	const v = page.getByTestId('mesh-warp-vertex-3-3');
	await expect(v).toBeAttached();
	const svg = await page.getByTestId('mesh-warp-overlay').boundingBox();
	const from = {
		x: svg!.x + Number(await v.getAttribute('data-x')),
		y: svg!.y + Number(await v.getAttribute('data-y')),
	};
	await pointerDrag(page, from, { x: from.x + 60, y: from.y + 30 }, { steps: 10 });
	await expect.poll(async () => (await appliedLabels(page)).at(-1)).toBe('Edit Distortion Mesh');
	const mesh = (await fxOf('jasper.mesh-warp')).params.distortionMesh!.value as number[];
	expect(mesh.length).toBeGreaterThan(3);
	await expect(page.getByTestId('mesh-warp-tangent-right')).toBeAttached();
	await page.screenshot({ path: 'test-results/e2e-sim-warp-mesh-warp.png' });
});
