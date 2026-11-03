// Spec 19 §10 in the built app: click a look, swap its colourway, preview without editing, edit a layer on the canvas,
// keyframe a param, undo, save and reload. Looks come from the project so the spec does not depend on the library's data.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	browserLaunch,
	clips,
	createProject,
	enableAgentBridge,
	focusTimeline,
	playheadFrame,
	programPixels,
	query,
	ROOT,
	transact,
} from './support.ts';

test.use({ launchOptions: browserLaunch(['--enable-features=CanvasDrawElement']) });
test.describe.configure({ mode: 'serial' });

const OUT = join(ROOT, 'test-results', 'e2e-title-looks');
mkdirSync(OUT, { recursive: true });

const colorways = [
	{ id: 'cw.ember', name: 'Ember', palette: { face: [1, 0.3, 0.1, 1], accent1: [1, 0.8, 0.2, 1] } },
	{ id: 'cw.ice', name: 'Ice', palette: { face: [0.6, 0.9, 1, 1], accent1: [1, 1, 1, 1] } },
];
const gold = {
	name: 'Gold',
	colorways,
	recipe: {
		palette: { face: [1, 0.8, 0.2, 1], keyline: [0.2, 0.08, 0, 1] },
		layers: [
			{ type: 'shadow', params: { distance: 10, blur: 8 } },
			{ type: 'rim', name: 'Outer', params: { width: 8 } },
			{ type: 'face' },
		],
	},
};
const neon = {
	name: 'Neon',
	recipe: {
		palette: { face: [1, 1, 1, 1], glow: [0.1, 0.9, 1, 1], keyline: [0.1, 0.9, 1, 1] },
		layers: [
			{ type: 'glow', params: { radius: 30 } },
			{ type: 'rim', params: { width: 3 } },
			{ type: 'face' },
		],
	},
};

let page: Page;
let projectId = '';

type Stored = {
	appearance: {
		lookId?: string;
		colorwayId?: string;
		palette: Record<string, { value: number[] }>;
		layers: { id: string; type: string; params: Record<string, { value: unknown; keyframes: unknown[] }> }[];
	};
};

async function look(id: string): Promise<Stored['appearance'] | null> {
	const seq = await query<{ sequenceId: string }>(page, 'sequence.summary');
	const clip = await query<{ effects: ({ effectId: string } & Stored)[] }>(page, 'doc.get', {
		path: ['sequences', seq.sequenceId, 'clips', id],
	});
	return clip.effects.find((e) => e.effectId === 'jasper.title-look')?.appearance ?? null;
}

const card = (name: string) => page.getByRole('listitem', { name: new RegExp(`^${name} \\(`) });
/** The shipped library comes first and the grid is virtualised: show the project's own looks. */
const projectLooks = (scope: Page | Locator = page) =>
	scope.getByRole('button', { name: 'This Project', exact: true }).click();

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
	projectId = await createProject(page, 'E2E Title Looks');
	// `look.apply` copies a look into the project; removing it leaves the project's two looks and an empty timeline.
	const r = await transact(page, [
		{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'seed' }, ref: '$t' },
		{ type: 'look.apply', clipIds: ['$t'], look: gold },
		{ type: 'look.apply', clipIds: ['$t'], look: neon },
		{ type: 'clip.lift', clipIds: ['$t'] },
	] as never);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	await expect.poll(async () => (await clips(page)).length).toBe(0);
	await page.getByText('Motion Templates', { exact: true }).first().click();
	await page.getByRole('tab', { name: 'Looks' }).click();
	await projectLooks();
	await expect(card('Gold')).toBeVisible();
});

test.afterAll(async () => {
	await page?.close();
});

test('the grid mounts cards with their colourways; a poster comes from the engine', async () => {
	await expect(page.getByTestId('looks-status')).toContainText('add a title at the playhead');
	// Its own colourways come first; the library's factory colourways follow (TL-086).
	await expect(card('Gold').locator('[data-colorway]').nth(0)).toHaveAttribute('data-colorway', 'cw.ember');
	await expect(card('Gold').locator('[data-colorway]').nth(1)).toHaveAttribute('data-colorway', 'cw.ice');
	await expect(card('Gold').locator('[data-poster]')).toHaveAttribute('data-poster', 'ready', {
		timeout: 180_000,
	});
	await page.getByTestId('looks-browser').screenshot({ path: join(OUT, 'grid.png') });
});

test('clicking a look with nothing selected adds a title at the playhead, in one undo step', async () => {
	const before = (await appliedLabels(page)).length;
	await card('Gold').click();
	await expect.poll(async () => (await clips(page)).length).toBe(1);
	expect((await appliedLabels(page)).length).toBe(before + 1);
	const [title] = await clips(page);
	expect(title!.kind).toBe('text');
	await expect(page.getByTestId('look-name')).toHaveText('Gold');
	await expect(page.getByTestId('look-status')).toHaveText('Matches the look');
	await expect.poll(async () => (await programPixels(page)).std).toBeGreaterThan(1);
});

test('hovering shows a look in Program without an edit, and leaving ends it', async () => {
	const [title] = await clips(page);
	const labels = await appliedLabels(page);
	await card('Neon').hover();
	await expect(page.getByTestId('look-preview-chip')).toContainText('Neon');
	await page.getByTestId('look-name').hover();
	await expect(page.getByTestId('look-preview-chip')).toHaveCount(0);
	expect(await appliedLabels(page)).toEqual(labels);
	expect((await look(title!.id))?.layers.map((l) => l.type)).toEqual(['shadow', 'rim', 'face']);
});

test('swapping colourways keeps the structure, and clicks in a row are one History entry', async () => {
	const [title] = await clips(page);
	const n = (await appliedLabels(page)).length;
	const strip = page.getByTestId('look-colorways-strip');
	await strip.locator('[data-colorway="cw.ember"]').click();
	await strip.locator('[data-colorway="cw.ice"]').click();
	await expect.poll(async () => (await look(title!.id))?.colorwayId).toBe('cw.ice');
	expect((await appliedLabels(page)).length).toBe(n + 1);
	expect((await look(title!.id))?.palette.face?.value).toEqual([0.6, 0.9, 1, 1]);
	expect((await look(title!.id))?.layers).toHaveLength(3);
});

test('selecting a layer outlines it in Program, and its handle edits it in one undo step', async () => {
	const [title] = await clips(page);
	await page.getByTestId('look-layer-open-1').click();
	await expect(page.getByTestId('look-layer-name')).toHaveText('Outer');
	await expect(page.getByTestId('tool-target')).toContainText('› Outer');
	const width = async () =>
		(await look(title!.id))!.layers.find((l) => l.type === 'rim')!.params.width!.value as number;
	expect(await width()).toBe(8);
	const n = (await appliedLabels(page)).length;
	const h = page.getByTestId('look-handle-width').locator('circle').last();
	const box = (await h.boundingBox())!;
	const x = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + 20, y, { steps: 4 });
	await page.mouse.up();
	await expect.poll(width).toBeGreaterThan(8);
	expect((await appliedLabels(page)).length).toBe(n + 1);
	await expect(page.getByTestId('look-status')).toContainText('change');
	await page.screenshot({ path: join(OUT, 'layer.png') });
	// The clip stayed selected, whatever was clicked.
	await expect(page.getByTestId('look-name')).toHaveText('Gold');
});

/** Drags a Program handle by (dx, dy) screen px from where it is drawn. */
async function dragHandle(testId: string, dx: number, dy: number) {
	const h = page.getByTestId(testId).locator('circle').last();
	const box = (await h.boundingBox())!;
	const x = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + dx, y + dy, { steps: 5 });
	await page.mouse.up();
}

test('a shadow’s offset handle sets angle and distance in one step, and keys them at the playhead when animated', async () => {
	const [title] = await clips(page);
	const shadow = () => look(title!.id).then((l) => l!.layers.find((x) => x.type === 'shadow')!);
	await page.getByTestId('look-layer-open-2').click();
	await expect(page.getByTestId('look-layer-name')).toHaveText('Shadow');
	const before = await shadow();
	const n = (await appliedLabels(page)).length;
	await dragHandle('look-handle-distance', 0, 60);
	await expect
		.poll(async () => (await shadow()).params.distance!.value)
		.not.toBe(before.params.distance!.value);
	expect((await shadow()).params.angle!.value).not.toBe(before.params.angle!.value);
	expect((await appliedLabels(page)).length).toBe(n + 1);
	await page.screenshot({ path: join(OUT, 'shadow-offset.png') });

	// Animated: the drag adds a key at the playhead instead of moving the whole animation.
	const seq = await query<{ sequenceId: string }>(page, 'sequence.summary');
	const clip = await query<{ effects: { id: string; effectId: string }[] }>(page, 'doc.get', {
		path: ['sequences', seq.sequenceId, 'clips', title!.id],
	});
	const fxId = clip.effects.find((e) => e.effectId === 'jasper.title-look')!.id;
	const id = (await shadow()).id;
	const r = await transact(page, [
		{
			type: 'param.setAnimated',
			target: ['appearance', fxId, id, 'distance'],
			animated: true,
			at: { sequenceFrame: 0 },
		},
	] as never);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	const start = await playheadFrame(page);
	for (let i = 0; i < 12; i++) await page.getByTestId('btn-step-forward').click();
	await expect.poll(() => playheadFrame(page)).toBe(start + 12);
	await dragHandle('look-handle-distance', 40, 0);
	await expect.poll(async () => (await shadow()).params.distance!.keyframes.length).toBe(2);
});

test('a shadow following the light turns the look’s light from its handle', async () => {
	const [title] = await clips(page);
	const appearance = async () =>
		(await look(title!.id))! as Stored['appearance'] & { light: { angle: { value: number } } };
	const seq = await query<{ sequenceId: string }>(page, 'sequence.summary');
	const clip = await query<{ effects: { id: string; effectId: string }[] }>(page, 'doc.get', {
		path: ['sequences', seq.sequenceId, 'clips', title!.id],
	});
	const fxId = clip.effects.find((e) => e.effectId === 'jasper.title-look')!.id;
	const id = (await appearance()).layers.find((x) => x.type === 'shadow')!.id;
	expect(
		(
			await transact(page, [
				{ type: 'param.set', target: ['appearance', fxId, id, 'useLight'], value: true },
			] as never)
		).ok,
	).toBe(true);
	await expect(page.getByTestId('look-handle-light-angle')).toBeVisible();
	await expect(page.getByTestId('look-handle-angle')).toHaveCount(0);
	const before = (await appearance()).light.angle.value;
	const n = (await appliedLabels(page)).length;
	// Across the ring, not along its radius: the light is up and to the left (225°), so up and to the right turns it.
	await dragHandle('look-handle-light-angle', 60, -40);
	await expect.poll(async () => (await appearance()).light.angle.value).not.toBe(before);
	expect((await appliedLabels(page)).length).toBe(n + 1);
	await page.screenshot({ path: join(OUT, 'light-angle.png') });
});

test('Effect Controls keyframes a layer param', async () => {
	const [title] = await clips(page);
	const rim = (await look(title!.id))!.layers.find((l) => l.type === 'rim')!;
	await page.getByText('Effect Controls', { exact: true }).first().click();
	await page.getByTestId(`ec-look-toggle-${rim.id}`).click();
	await page.getByTestId(`stopwatch-appearance.${rim.id}.width`).click();
	await expect
		.poll(
			async () =>
				(await look(title!.id))!.layers.find((l) => l.id === rim.id)!.params.width!.keyframes.length,
		)
		.toBe(1);
	await page.screenshot({ path: join(OUT, 'effect-controls.png') });
});

test('undo walks back through it, and save and reload keep the look', async () => {
	const [title] = await clips(page);
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect
		.poll(
			async () =>
				(await look(title!.id))!.layers.find((l) => l.type === 'rim')!.params.width!.keyframes.length,
		)
		.toBe(0);
	await page.keyboard.press('Control+KeyS');
	await expect(page.getByText('Saved', { exact: true }).first()).toBeVisible();
	await page.goto(`/project/${projectId}`);
	await expect(page.getByTestId('timeline-track-area')).toBeVisible();
	await expect.poll(() => page.evaluate(() => !!window.jasper)).toBe(true);
	const stored = await look(title!.id);
	expect(stored?.colorwayId).toBe('cw.ice');
	expect(stored?.layers.map((l) => l.type)).toEqual(['shadow', 'rim', 'face']);
});

test('Graphics ▸ Apply Look… opens the same grid, and Remove Look leaves the clip plain', async () => {
	const [title] = await clips(page);
	await page
		.locator(`[data-testid="timeline-track-area"] [data-clip-id="${title!.id}"]`)
		.first()
		.click({ position: { x: 12, y: 10 } });
	await page.getByRole('menuitem', { name: 'Graphics' }).click();
	await page.getByRole('menuitem', { name: 'Apply Look…' }).click();
	const dialog = page.getByTestId('apply-look-dialog');
	await expect(dialog).toBeVisible();
	await projectLooks(dialog);
	await dialog.getByRole('listitem', { name: /^Neon \(/ }).click();
	await expect(dialog).toHaveCount(0);
	await expect.poll(async () => (await look(title!.id))?.layers[0]?.type).toBe('glow');
	await page.getByRole('menuitem', { name: 'Graphics' }).click();
	await page.getByRole('menuitem', { name: 'Look', exact: true }).hover();
	await page.getByRole('menuitem', { name: 'Remove Look' }).click();
	await expect.poll(() => look(title!.id)).toBeNull();
	await expect(page.getByTestId('look-none')).toBeVisible();
});

test('a card dragged onto a clip in the Timeline applies there; on an empty place it adds a title', async () => {
	const [title] = await clips(page);
	await page.getByText('Motion Templates', { exact: true }).first().click();
	await page.getByRole('tab', { name: 'Looks' }).click();
	await projectLooks();
	const area = page.getByTestId('timeline-track-area');
	await card('Gold').dragTo(area.locator(`[data-clip-id="${title!.id}"]`).first());
	await expect.poll(async () => (await look(title!.id))?.layers[0]?.type).toBe('shadow');
	const box = (await area.boundingBox())!;
	await card('Neon').dragTo(area, { targetPosition: { x: box.width - 60, y: 30 } });
	await expect.poll(async () => (await clips(page)).length).toBe(2);
	const added = (await clips(page)).find((c) => c.id !== title!.id)!;
	expect(added.kind).toBe('text');
	expect((await look(added.id))?.layers[0]?.type).toBe('glow');
	expect((await look(title!.id))?.layers[0]?.type).toBe('shadow');
});

test('Graphics ▸ New Layer ▸ Generator adds a fire below the title; a preset chip sets it in one step; the palette finds presets', async () => {
	const [title] = await clips(page);
	await page
		.locator(`[data-testid="timeline-track-area"] [data-clip-id="${title!.id}"]`)
		.first()
		.click({ position: { x: 12, y: 10 } });
	const before = (await clips(page)).length;
	await page.getByTestId('menubar').getByRole('menuitem', { name: 'Graphics', exact: true }).click();
	await page.getByRole('menuitem', { name: 'New Layer', exact: true }).hover();
	await page.getByRole('menuitem', { name: 'Generator', exact: true }).hover();
	await page.getByRole('menuitem', { name: 'Fire', exact: true }).click();
	await expect.poll(async () => (await clips(page)).length).toBe(before + 1);
	const all = await clips(page);
	const fire = all.find((c) => !c.kind.startsWith('text'))!;
	const t = all.find((c) => c.id === title!.id)!;
	expect([fire.start, fire.duration]).toEqual([t.start, t.duration]);
	const seq = await query<{ sequenceId: string; tracks?: { id: string; label: string }[] }>(
		page,
		'sequence.summary',
	);
	const fx = async () =>
		(
			await query<{
				effects: { id: string; effectId: string; params: Record<string, { value: unknown }> }[];
			}>(page, 'doc.get', { path: ['sequences', seq.sequenceId, 'clips', fire.id] })
		).effects[0]!;
	expect((await fx()).effectId).toBe('jasper.generator.fire');
	// It is selected: Effect Controls shows its chips above its params.
	await page.getByText('Effect Controls', { exact: true }).first().click();
	const chips = page.getByTestId(`generator-presets-${(await fx()).id}`);
	await expect(chips).toBeVisible();
	await expect(chips.locator('[data-preset="behind"]')).toHaveAttribute('aria-pressed', 'true');
	const n = (await appliedLabels(page)).length;
	await chips.locator('[data-preset="blaze"]').click();
	await expect.poll(async () => (await fx()).params.height?.value).toBe(130);
	expect((await appliedLabels(page)).length).toBe(n + 1);
	await expect(chips.locator('[data-preset="blaze"]')).toHaveAttribute('aria-pressed', 'true');
	await page.screenshot({ path: join(OUT, 'generator-chips.png') });

	await focusTimeline(page);
	await page.keyboard.press('Control+Shift+KeyP');
	await page.getByTestId('palette-input').fill('spirit fire');
	const row = page.getByTestId('palette-row').filter({ hasText: 'New Generator Layer: Fire › Spirit Fire' });
	await expect(row).toBeVisible();
	await page.screenshot({ path: join(OUT, 'generator-palette.png') });
	await row.click();
	await expect.poll(async () => (await clips(page)).length).toBe(before + 2);
});
