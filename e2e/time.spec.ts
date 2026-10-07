// Workstream `time` through the real UI of the built app (docs/wp-notes/time.md):
// - clip menu ▸ Show Clip Keyframes ▸ Time Remapping ▸ Speed shows the speed band; dragging it changes the speed
//   (one undo step) and the clip's duration follows;
// - clip menu ▸ Time Interpolation, the Effect Controls Time Remapping section;
// - the Program monitor draws the remapped frame (frame-code.mp4 carries its frame number as 6 white boxes);
// - a native export shows the same frames;
// - clip menu ▸ Scene Edit Detection… cuts scenes.mp4 at its four hard cuts in one undo step.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clipBox,
	clipElement,
	clips,
	createProject,
	enableAgentBridge,
	exportViaUi,
	focusTimeline,
	importFiles,
	pointerDrag,
	query,
	ROOT,
	sequenceSummary,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

let page: Page;
let coded = '';

test.beforeAll(async ({ browser }) => {
	// Tall enough for the whole clip context menu.
	page = await browser.newPage({ viewport: { width: 1600, height: 1400 } });
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	if (page && !page.isClosed()) await page.screenshot({ path: 'test-results/e2e-time-final.png' });
	await page?.close();
});

type RemapClip = {
	id: string;
	kind: string;
	start: number;
	duration: number;
	timeRemap?: { enabled: boolean; keyframes: unknown[]; speedBefore?: number };
	timeInterpolation?: string;
};
type Doc = {
	items: Record<string, { id: string; kind: string; name: string }>;
	sequences: Record<string, { clips: Record<string, RemapClip> }>;
};
const doc = () => query<Doc>(page, 'doc.get');
async function clipDoc(id: string): Promise<RemapClip> {
	const d = await doc();
	for (const s of Object.values(d.sequences)) if (s.clips[id]) return s.clips[id]!;
	throw new Error(`no clip ${id}`);
}

const SEQ_FPS = 30000 / 1001;
/** frame-code.mp4 frame shown at sequence frame `f` of a clip at 0 playing at `speed` from source 0. */
const expectedCode = (f: number, speed: number) => Math.floor((f / SEQ_FPS) * speed * 30 + 1e-3);
/** Frames whose source time is well inside a source frame (no rounding ambiguity at 29.97 → 30). */
const unambiguous = (f: number, speed: number) => {
	const x = (f / SEQ_FPS) * speed * 30;
	return x - Math.floor(x) > 0.1 && x - Math.floor(x) < 0.9;
};

/** The 6-bit frame code drawn by the Program monitor (boxes at x 40 + 70·b … +60, y 40…100 of 1920×1080). */
async function programCode(): Promise<number> {
	return page.getByTestId('program-player-wrapper').evaluate((root) => {
		const w = 384;
		const h = 216;
		const c = document.createElement('canvas');
		c.width = w;
		c.height = h;
		const g = c.getContext('2d', { willReadFrequently: true })!;
		g.fillStyle = '#000';
		g.fillRect(0, 0, w, h);
		for (const s of root.querySelectorAll('canvas, video, img')) {
			const el = s as HTMLCanvasElement;
			const r = el.getBoundingClientRect();
			if (r.width < 8 || r.height < 8) continue;
			try {
				g.drawImage(el, 0, 0, w, h);
			} catch {
				// not drawable yet
			}
		}
		let code = 0;
		for (let b = 0; b < 6; b++) {
			const d = g.getImageData(Math.round((70 + 70 * b) / 5), 14, 1, 1).data;
			if (d[0]! > 127 && d[1]! > 127) code |= 1 << b;
		}
		return code;
	});
}

function fileCode(file: string, frame: number, width: number): number {
	const W = width;
	const raw = execFileSync(
		process.env.JASPER_FFMPEG ?? 'ffmpeg',
		[
			...['-v', 'error', '-i', file],
			...['-vf', `select=eq(n\\,${frame}),format=rgb24`],
			...['-frames:v', '1', '-f', 'rawvideo', '-'],
		],
		{ maxBuffer: 64 << 20 },
	);
	const s = W / 1920;
	let code = 0;
	for (let b = 0; b < 6; b++) {
		const x = Math.round((70 + 70 * b) * s);
		const o = (Math.round(70 * s) * W + x) * 3;
		if (raw[o]! > 127) code |= 1 << b;
	}
	return code;
}

test('Show Clip Keyframes ▸ Time Remapping ▸ Speed; dragging the band slows the clip down', async () => {
	await createProject(page, 'E2E Time');
	await importFiles(page, ['frame-code.mp4', 'scenes.mp4']);
	const d = await doc();
	const item = Object.values(d.items).find((i) => i.name.startsWith('frame-code'))!;
	const r = await transact(page, [
		{
			type: 'clip.place',
			source: { projectItemId: item.id },
			at: 0,
			sourceRange: { in: { seconds: 0 }, out: { seconds: 2 } },
		},
	]);
	expect(r.ok, JSON.stringify(r.errors)).toBe(true);
	const [v] = await clips(page, ['V1']);
	coded = v!.id;
	const before = (await clipDoc(coded)).duration;
	// Like Premiere, the speed band needs a tall track: Expand All Tracks.
	await focusTimeline(page);
	await page.keyboard.press('Shift+Equal');
	const box = await clipBox(page, coded);
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
	await clipElement(page, coded).click({
		button: 'right',
		position: { x: box.width / 2, y: box.height / 2 },
	});
	await page.getByRole('menu').getByText('Show Clip Keyframes', { exact: true }).hover();
	await page.getByRole('menu').getByText('Time Remapping', { exact: true }).hover();
	await page.getByRole('menuitem', { name: /Speed$/ }).click();
	const line = page.locator(`[data-speed-band="${coded}"] [data-speed-band-line]`);
	await expect(line).toBeAttached();
	const lb = (await line.boundingBox())!;
	const x = lb.x + lb.width / 2;
	const y = lb.y + lb.height / 2;
	// Down = slower (Premiere): the clip gets longer.
	await pointerDrag(page, { x, y }, { x, y: y + 8 });
	await expect.poll(async () => (await clipDoc(coded)).timeRemap?.enabled).toBe(true);
	expect((await clipDoc(coded)).duration).toBeGreaterThan(before);
	expect((await appliedLabels(page)).at(-1)).toBe('Change Speed');
	// One undo step restores the clip.
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await clipDoc(coded)).duration).toBe(before);
});

test('Time Interpolation menu and the Effect Controls Time Remapping section', async () => {
	const r = await transact(page, [{ type: 'timeRemap.setSpeed', clipId: coded, at: 0, speedPercent: 50 }]);
	expect(r.ok, JSON.stringify(r.errors)).toBe(true);
	const c = await clipDoc(coded);
	expect(c.timeRemap?.enabled).toBe(true);
	expect(c.duration).toBeGreaterThan(110);
	const box = await clipBox(page, coded);
	for (const [label, mode] of [
		['Optical Flow', 'optical-flow'],
		['Frame Sampling', 'frame-sampling'],
	] as const) {
		await clipElement(page, coded).click({ button: 'right', position: { x: 40, y: box.height / 2 } });
		await page.getByRole('menu').getByText('Time Interpolation', { exact: true }).hover();
		await page.getByRole('menuitem', { name: new RegExp(`${label}$`) }).click();
		await expect.poll(async () => (await clipDoc(coded)).timeInterpolation ?? 'frame-sampling').toBe(mode);
	}
	await page.mouse.click(box.x + 40, box.y + box.height / 2);
	await page
		.locator('.dv-tab')
		.filter({ hasText: /^Effect Controls$/ })
		.first()
		.click();
	await expect(page.getByTestId('time-remap-section')).toBeVisible();
	await expect(page.getByTestId('time-remap-section')).toContainText('50');
});

test('the Program monitor draws the remapped source frame', async () => {
	for (const f of [10, 37, 70, 101].filter((n) => unambiguous(n, 0.5))) {
		await query(page, 'playhead.set', { frame: f });
		await expect.poll(programCode, { timeout: 20_000, message: `frame ${f}` }).toBe(expectedCode(f, 0.5));
	}
});

test('a native export shows the same frames', async ({ request }) => {
	const outDir = join(ROOT, 'test-results', 'e2e-time');
	mkdirSync(outDir, { recursive: true });
	const { file } = await exportViaUi(page, request, {
		engine: 'native',
		fileName: 'time-native.mp4',
		expectPath: /native/i,
		outDir,
	});
	const { settings } = await sequenceSummary(page);
	const c = await clipDoc(coded);
	const frames = [0, 7, 21, 50, 77, 99, c.duration - 2].filter((n) => unambiguous(n, 0.5));
	for (const f of frames) expect(fileCode(file, f, settings.width), `frame ${f}`).toBe(expectedCode(f, 0.5));
});

test('Scene Edit Detection… cuts at the four hard cuts in one undo step', async () => {
	const d = await doc();
	const item = Object.values(d.items).find((i) => i.name.startsWith('scenes'))!;
	const start = (await clipDoc(coded)).duration + 30;
	const r = await transact(page, [{ type: 'clip.place', source: { projectItemId: item.id }, at: start }]);
	expect(r.ok, JSON.stringify(r.errors)).toBe(true);
	const scenes = (await clips(page, ['V1'])).find((c) => c.start === start)!;
	await page.keyboard.press('Backslash');
	const box = await clipBox(page, scenes.id);
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
	await clipElement(page, scenes.id).click({
		button: 'right',
		position: { x: box.width / 2, y: box.height / 2 },
	});
	await page.getByRole('menuitem', { name: /^Scene Edit Detection/ }).click();
	const dialog = page.getByTestId('scene-detect-dialog');
	await expect(dialog).toBeVisible();
	const labels = (await appliedLabels(page)).length;
	await dialog.getByRole('button', { name: 'Analyze' }).click();
	await expect(dialog).toBeHidden({ timeout: 120_000 });
	const pieces = (await clips(page, ['V1'])).filter((c) => c.start >= start);
	expect(pieces.length).toBe(5);
	const cuts = pieces.slice(1).map((c) => c.start - start);
	// 30 fps source cuts 45, 75, 120, 198 in a 29.97 sequence.
	for (const [i, src] of [45, 75, 120, 198].entries())
		expect(Math.abs(cuts[i]! - src * (SEQ_FPS / 30)), `cut ${i}`).toBeLessThanOrEqual(1);
	const after = await appliedLabels(page);
	expect(after.length).toBe(labels + 1);
	expect(after.at(-1)).toBe('Scene Edit Detection');
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await clips(page, ['V1'])).filter((c) => c.start >= start).length).toBe(1);
});
