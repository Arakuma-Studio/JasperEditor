// Shapes end to end (S11 §11 test 5, wp-m2-shapes): Graphics ▸ New Layer ▸ Rectangle / Ellipse are enabled and
// insert shapes (FIX-007); the Rectangle / Ellipse tools draw the dragged box in the Program monitor (Shift =
// square, Alt = from the centre, Escape cancels, one undo step each); Properties ▸ Shape edits fill, stroke and
// corner radius; Effect Controls keyframes the size; undo/redo; the export matches
// a `renderStill` frame of the same document.
//
// Export path: shapes are DOM layers. When the engine reports `features.layerBake.state === 'ready'`,
// Auto plans the native path with baked layers (`native`/`hybrid`). If layer bake is unavailable,
// the planner uses Remotion with a "requires graphics rendering" blocker. The spec checks either path.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clipElement,
	createProject,
	enableAgentBridge,
	exportViaUi,
	focusTimeline,
	pointerDrag,
	query,
	ROOT,
	sequenceSummary,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

type Anim<T> = { value: T; keyframes: { id: string; time: number; value: T }[] };
type ShapeClip = {
	id: string;
	kind: 'shape';
	name: string;
	trackId: string;
	start: number;
	shape: {
		type: 'rect' | 'ellipse';
		size: Anim<[number, number]>;
		fill: Anim<number[]> | null;
		stroke: { color: Anim<number[]>; width: Anim<number>; position: string } | null;
		cornerRadius: Anim<number>;
	};
	transform: { position: Anim<[number, number]> };
};

const EXPORT_DIR = join(ROOT, 'test-results', 'e2e-shapes');
const FFMPEG = process.env.JASPER_FFMPEG ?? 'ffmpeg';

let page: Page;
let seqId = '';
/** Shapes created by the steps, by role. */
const ids = { menuRect: '', menuEllipse: '', drawn: '', square: '', alt: '' };

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
	await createProject(page, 'E2E Shapes');
	seqId = (await sequenceSummary(page)).sequenceId;
});

test.afterAll(async () => {
	await page?.close();
});

async function shapes(): Promise<ShapeClip[]> {
	const seq = await query<{ clips: Record<string, { kind: string }> }>(page, 'doc.get', {
		path: ['sequences', seqId],
	});
	return Object.values(seq.clips).filter((c): c is ShapeClip => c.kind === 'shape');
}
const shapeById = async (id: string) => (await shapes()).find((c) => c.id === id)!;
const newShapeId = async (known: number) => {
	await expect.poll(async () => (await shapes()).length).toBe(known + 1);
	const sel = await query<{ selection: { timeline?: { clips?: string[] } } }>(page, 'selection.get');
	return sel.selection.timeline!.clips![0]!;
};

/** Screen point of a sequence-pixel point in the Program monitor (the Player wrapper is the scaled frame). */
async function toScreen(p: [number, number]): Promise<{ x: number; y: number }> {
	const b = (await page.getByTestId('program-player-wrapper').boundingBox())!;
	return { x: b.x + (p[0] * b.width) / 1920, y: b.y + (p[1] * b.height) / 1080 };
}

async function chooseShapeTool(tool: 'rectangle' | 'ellipse'): Promise<void> {
	const strip = page.getByTestId('tools-panel');
	await strip
		.locator('[data-tool="pen"], [data-tool="rectangle"], [data-tool="ellipse"]')
		.click({ button: 'right' });
	await strip.locator(`[data-tool-option="${tool}"]`).click();
	await expect(strip.locator(`[data-tool="${tool}"]`)).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByTestId('shape-tool-overlay')).toBeVisible();
}

async function menuNewShape(label: 'Rectangle' | 'Ellipse'): Promise<void> {
	await page.getByTestId('title-bar').getByRole('menuitem', { name: 'Graphics', exact: true }).click();
	await page.getByRole('menuitem', { name: /New Layer/ }).click();
	const item = page.getByRole('menuitem', { name: new RegExp(`^${label}`) });
	await expect(item).toBeEnabled();
	await item.click();
}

/** Opens the value editor of a scrubby number (click without drag) and types a value. */
async function typeNumber(
	scope: ReturnType<Page['getByTestId']>,
	testId: string,
	value: number,
): Promise<void> {
	await scope.getByTestId(testId).click();
	const input = scope.getByTestId(`${testId}-input`);
	await input.fill(String(value));
	await input.press('Enter');
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

test('Graphics ▸ New Layer ▸ Rectangle / Ellipse are enabled and insert shapes at the playhead (FIX-007)', async () => {
	const labels0 = (await appliedLabels(page)).length;
	await menuNewShape('Rectangle');
	ids.menuRect = await newShapeId(0);
	const rect = await shapeById(ids.menuRect);
	expect(rect).toMatchObject({ name: 'Rectangle', start: 0 });
	expect(rect.shape).toMatchObject({
		type: 'rect',
		size: { value: [400, 400] },
		fill: { value: [1, 1, 1, 1] },
		stroke: null,
	});
	expect(rect.transform.position.value).toEqual([960, 540]);
	await menuNewShape('Ellipse');
	ids.menuEllipse = await newShapeId(1);
	const ell = await shapeById(ids.menuEllipse);
	expect(ell.shape.type).toBe('ellipse');
	expect(ell.trackId).not.toBe(rect.trackId); // V1 is taken over the clip's span: the next free track
	expect((await appliedLabels(page)).slice(labels0)).toEqual(['New Rectangle', 'New Ellipse']);
	// Timeline: the clip carries its name and the Remotion badge; the Program draws the SVG.
	await expect(clipElement(page, ids.menuRect)).toContainText('Rectangle');
	await expect(clipElement(page, ids.menuRect).locator('[data-engine-badge="R"]')).toBeVisible();
	await expect(
		page.locator(
			`[data-testid="program-player-wrapper"] [data-clip-id="${ids.menuEllipse}"] svg[data-shape="ellipse"]`,
		),
	).toBeAttached();
	// Undo / redo.
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await shapes()).length).toBe(1);
	await page.keyboard.press('Control+Shift+KeyZ');
	await expect.poll(async () => (await shapes()).length).toBe(2);
});

test('Rectangle / Ellipse tools: drag box, Shift = square, Alt = from the centre, Escape cancels (XF-061)', async () => {
	const labels0 = (await appliedLabels(page)).length;
	await chooseShapeTool('rectangle');
	await pointerDrag(page, await toScreen([200, 200]), await toScreen([600, 400]), { steps: 10 });
	ids.drawn = await newShapeId(2);
	const drawn = await shapeById(ids.drawn);
	const [w, h] = drawn.shape.size.value;
	const [cx, cy] = drawn.transform.position.value;
	expect(drawn.shape.type).toBe('rect');
	expect(near(w, 400, 6) && near(h, 200, 6), `${w}×${h}`).toBe(true);
	expect(near(cx, 400, 4) && near(cy, 300, 4), `${cx},${cy}`).toBe(true);
	// The tool returns to Selection with the new shape selected.
	await expect(page.locator('[data-testid="tools-panel"] [data-tool="selection"]')).toHaveAttribute(
		'aria-pressed',
		'true',
	);

	await chooseShapeTool('rectangle');
	await pointerDrag(page, await toScreen([1200, 200]), await toScreen([1400, 260]), {
		modifiers: ['Shift'],
		steps: 10,
	});
	ids.square = await newShapeId(3);
	const sq = await shapeById(ids.square);
	expect(sq.shape.size.value[0]).toBe(sq.shape.size.value[1]);
	expect(near(sq.shape.size.value[0], 200, 6), String(sq.shape.size.value)).toBe(true);
	expect(near(sq.transform.position.value[0], 1300, 4) && near(sq.transform.position.value[1], 300, 4)).toBe(
		true,
	);

	await chooseShapeTool('ellipse');
	const centre = await toScreen([960, 900]);
	await pointerDrag(page, centre, await toScreen([1060, 950]), { modifiers: ['Alt'], steps: 10 });
	ids.alt = await newShapeId(4);
	const alt = await shapeById(ids.alt);
	expect(alt.shape.type).toBe('ellipse');
	expect(near(alt.transform.position.value[0], 960, 4) && near(alt.transform.position.value[1], 900, 4)).toBe(
		true,
	);
	expect(near(alt.shape.size.value[0], 200, 8) && near(alt.shape.size.value[1], 100, 8)).toBe(true);

	// Escape during a drag: nothing is added and the tool stays active.
	await chooseShapeTool('ellipse');
	const a = await toScreen([100, 900]);
	const b = await toScreen([300, 1000]);
	await page.mouse.move(a.x, a.y);
	await page.mouse.down();
	await page.mouse.move(b.x, b.y, { steps: 6 });
	await expect(page.getByTestId('shape-tool-preview')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('shape-tool-preview')).toHaveCount(0);
	await page.mouse.up();
	expect(await shapes()).toHaveLength(5);
	// Esc belonged to the drag: the keymap's Escape (deselect, TL-903) did not run as well (wp fixups).
	const kept = await query<{ selection: { timeline?: { clips?: string[] } } }>(page, 'selection.get');
	expect(kept.selection.timeline?.clips).toEqual([ids.alt]);
	await page.locator('[data-testid="tools-panel"] [data-tool="selection"]').click();
	expect((await appliedLabels(page)).slice(labels0)).toEqual([
		'New Rectangle',
		'New Rectangle',
		'New Ellipse',
	]);
});

test('Properties ▸ Shape edits fill, stroke and corner radius (one undo step each, SHP-005)', async () => {
	await clipElement(page, ids.drawn).click();
	await page.getByTestId('tab-properties').click();
	const section = page.getByTestId('shape-section');
	await expect(section).toBeVisible();
	await expect(section.getByTestId('shape-type')).toHaveText('Rectangle');
	const labels0 = (await appliedLabels(page)).length;

	await section.locator('input[type="color"][aria-label="Fill"]').fill('#ff0000');
	await expect.poll(async () => (await shapeById(ids.drawn)).shape.fill?.value).toEqual([1, 0, 0, 1]);
	await section.getByLabel('No stroke').click();
	await expect.poll(async () => (await shapeById(ids.drawn)).shape.stroke?.position).toBe('center');
	await typeNumber(section, 'prop-shape.stroke.width', 12);
	await expect.poll(async () => (await shapeById(ids.drawn)).shape.stroke?.width.value).toBe(12);
	await section.getByTestId('prop-shape.stroke.position').selectOption('inside');
	await expect.poll(async () => (await shapeById(ids.drawn)).shape.stroke?.position).toBe('inside');
	await section.locator('input[type="color"][aria-label="Stroke Color"]').fill('#0000ff');
	await expect.poll(async () => (await shapeById(ids.drawn)).shape.stroke?.color.value).toEqual([0, 0, 1, 1]);
	await typeNumber(section, 'prop-shape.cornerRadius', 24);
	await expect.poll(async () => (await shapeById(ids.drawn)).shape.cornerRadius.value).toBe(24);
	expect((await appliedLabels(page)).length).toBe(labels0 + 6);

	// The Program draws the inside stroke as a clipped double-width stroke.
	const stroke = page.locator(
		`[data-testid="program-player-wrapper"] [data-clip-id="${ids.drawn}"] [data-shape-part="stroke"]`,
	);
	await expect(stroke).toHaveAttribute('data-stroke-position', 'inside');
	await expect(stroke).toHaveAttribute('stroke-width', '24');
	await expect(stroke).toHaveAttribute('clip-path', /^url\(#shape-/);

	// Undo the radius, redo it.
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await shapeById(ids.drawn)).shape.cornerRadius.value).toBe(0);
	await page.keyboard.press('Control+Shift+KeyZ');
	await expect.poll(async () => (await shapeById(ids.drawn)).shape.cornerRadius.value).toBe(24);
});

test('Effect Controls ▸ Shape keyframes the size; undo/redo', async () => {
	await clipElement(page, ids.drawn).click();
	await query(page, 'playhead.set', { frame: 0 });
	await page.getByTestId('tab-effectControls').click();
	const ec = page.getByTestId('effect-controls-panel');
	const stopwatch = ec.getByTestId('stopwatch-shape.size');
	await expect(stopwatch).toBeVisible();
	const size0 = (await shapeById(ids.drawn)).shape.size.value;
	await stopwatch.click();
	await expect.poll(async () => (await shapeById(ids.drawn)).shape.size.keyframes.length).toBe(1);
	await query(page, 'playhead.set', { frame: 60 });
	await typeNumber(ec, 'prop-shape.size-0', 800);
	await expect.poll(async () => (await shapeById(ids.drawn)).shape.size.keyframes.length).toBe(2);
	const keys = (await shapeById(ids.drawn)).shape.size.keyframes;
	expect(keys[0]!.value).toEqual(size0);
	expect(keys[1]!.value).toEqual([800, size0[1]]);

	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await shapeById(ids.drawn)).shape.size.keyframes.length).toBe(1);
	await page.keyboard.press('Control+Shift+KeyZ');
	await expect.poll(async () => (await shapeById(ids.drawn)).shape.size.keyframes.length).toBe(2);
});

test('export: native with baked layers when the layer bake is ready, else Remotion; the frame matches renderStill', async ({
	request,
}) => {
	mkdirSync(EXPORT_DIR, { recursive: true });
	const caps = (await (await request.get('/api/capabilities')).json()) as {
		features?: { layerBake?: { state?: string } };
	};
	const baked = caps.features?.layerBake?.state === 'ready';
	test.info().annotations.push({
		type: 'export-path',
		description: baked
			? 'features.layerBake ready: shapes are baked and exported natively'
			: 'features.layerBake unavailable: shapes export on the Remotion path',
	});
	const out = await exportViaUi(page, request, {
		engine: 'auto',
		fileName: 'shapes.mp4',
		expectPath: baked ? /native|hybrid/i : /remotion/i,
		...(baked ? {} : { expectBlocker: /graphics rendering/i }),
		outDir: EXPORT_DIR,
	});
	const renderPath = String(out.job.result?.renderPath);
	if (baked) expect(['native', 'hybrid']).toContain(renderPath);
	else expect(renderPath).toBe('remotion');

	// Frame 30 (mid size animation) of the export vs a renderStill of the same document.
	const frame = 30;
	const still = await query<{ url: string }>(page, 'frame.capture', { frame });
	const png = await request.get(still.url);
	expect(png.ok()).toBe(true);
	const stillFile = join(EXPORT_DIR, 'still-30.png');
	writeFileSync(stillFile, await png.body());
	const W = 192;
	const H = 108;
	const decode = (file: string, vf: string) =>
		execFileSync(
			FFMPEG,
			[
				'-v',
				'error',
				'-i',
				file,
				'-frames:v',
				'1',
				'-vf',
				vf,
				'-f',
				'rawvideo',
				'-pix_fmt',
				'rgb24',
				'pipe:1',
			],
			{ maxBuffer: 1 << 22 },
		);
	// Frame by index (a timestamp seek lands one frame late on this H.264 output), BT.709 limited range.
	const video = decode(out.file, `select=eq(n\\,${frame}),scale=${W}:${H}:in_color_matrix=bt709:in_range=tv`);
	const image = decode(stillFile, `scale=${W}:${H}`);
	expect(video.length).toBe(W * H * 3);
	expect(image.length).toBe(W * H * 3);
	// Luma carries the geometry; H.264 4:2:0 smears the chroma of thin saturated strokes, so colour is checked
	// on average only (measured on the Remotion path: luma mean 0.33, 0 px > 16; colour mean 1.18).
	const luma = (b: Buffer, k: number) => 0.2126 * b[k]! + 0.7152 * b[k + 1]! + 0.0722 * b[k + 2]!;
	let lumaSum = 0;
	let colourSum = 0;
	let far = 0;
	for (let i = 0; i < video.length; i += 3) {
		const dy = Math.abs(luma(video, i) - luma(image, i));
		lumaSum += dy;
		if (dy > 16) far++;
		colourSum += Math.max(
			Math.abs(video[i]! - image[i]!),
			Math.abs(video[i + 1]! - image[i + 1]!),
			Math.abs(video[i + 2]! - image[i + 2]!),
		);
	}
	const n = W * H;
	test.info().annotations.push({
		type: 'export-vs-still',
		description: `${renderPath}: luma mean ${(lumaSum / n).toFixed(2)}/255, ${far} of ${n} px > 16; colour mean ${(colourSum / n).toFixed(2)}`,
	});
	expect(lumaSum / n).toBeLessThan(2);
	expect(far / n).toBeLessThan(0.005);
	expect(colourSum / n).toBeLessThan(6);
	// The red drawn rectangle is really there in the export (centre of its fill).
	const ref = await shapeById(ids.drawn);
	const [cx, cy] = ref.transform.position.value;
	const i = (Math.round((cy / 1080) * H) * W + Math.round((cx / 1920) * W)) * 3;
	expect(video[i]!).toBeGreaterThan(200);
	expect(video[i + 1]!).toBeLessThan(60);
});
