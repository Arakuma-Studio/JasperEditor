import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
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

type Item = {
	id: string;
	type: string;
	name: string;
	enabled?: boolean;
	contents?: Item[];
	[k: string]: unknown;
};
type VClip = {
	id: string;
	kind: 'shape';
	shape: { type: string; contents: Item[] };
	transform: { position: { value: [number, number] } };
};

const OUT = join(ROOT, 'test-results', 'e2e-vector-shapes');
const FFMPEG = process.env.JASPER_FFMPEG ?? 'ffmpeg';
let page: Page;
let seqId = '';
let clipId = '';

test.beforeAll(async ({ browser }) => {
	mkdirSync(OUT, { recursive: true });
	page = await browser.newPage();
	await enableAgentBridge(page);
	await createProject(page, 'E2E Vector Shapes');
	seqId = (await sequenceSummary(page)).sequenceId;
});
test.afterAll(async () => {
	await page?.close();
});

async function vclips(): Promise<VClip[]> {
	const seq = await query<{ clips: Record<string, VClip> }>(page, 'doc.get', { path: ['sequences', seqId] });
	return Object.values(seq.clips).filter((c) => c.kind === 'shape' && c.shape.type === 'vector');
}
const flat = (items: Item[]): Item[] => items.flatMap((i) => [i, ...flat(i.contents ?? [])]);
const items = async () => flat((await vclips()).find((c) => c.id === clipId)!.shape.contents);

async function toScreen(p: [number, number]): Promise<{ x: number; y: number }> {
	const b = (await page.getByTestId('program-player-wrapper').boundingBox())!;
	return { x: b.x + (p[0] * b.width) / 1920, y: b.y + (p[1] * b.height) / 1080 };
}

async function chooseTool(tool: 'star' | 'pen' | 'polygon'): Promise<void> {
	const strip = page.getByTestId('tools-panel');
	await strip
		.locator(
			'[data-tool="pen"], [data-tool="rectangle"], [data-tool="ellipse"], [data-tool="polygon"], [data-tool="star"]',
		)
		.click({ button: 'right' });
	await strip.locator(`[data-tool-option="${tool}"]`).click();
	await expect(strip.locator(`[data-tool="${tool}"]`)).toHaveAttribute('aria-pressed', 'true');
}

test('Star tool draws a vector shape in the Program monitor (one undo step)', async () => {
	const labels0 = (await appliedLabels(page)).length;
	await chooseTool('star');
	await pointerDrag(page, await toScreen([960, 540]), await toScreen([960, 290]), { steps: 10 });
	await expect.poll(async () => (await vclips()).length).toBe(1);
	const c = (await vclips())[0]!;
	clipId = c.id;
	expect(c.transform.position.value).toEqual([960, 540]);
	const star = c.shape.contents[0]!;
	expect(star.type).toBe('polystar');
	expect(Math.abs((star.outerRadius as { value: number }).value - 250)).toBeLessThan(6);
	expect((await appliedLabels(page)).slice(labels0)).toEqual(['New Star']);
	await expect(
		page.locator(
			`[data-testid="program-player-wrapper"] [data-clip-id="${clipId}"] svg[data-shape="vector"]`,
		),
	).toBeAttached();
});

test('Shape Contents: add a gradient fill, a stroke and a Trim Paths; edit End; toggle and undo', async () => {
	const tree = page.getByTestId('vector-tree');
	await expect(tree).toBeVisible();
	const star = (await items())[0]!;
	await page.getByTestId(`vector-item-${star.id}`).click();
	const add = page.getByTestId('vector-add');
	await add.selectOption('gradientFill');
	await add.selectOption('stroke');
	await add.selectOption('trim');
	await expect
		.poll(async () => (await items()).map((i) => i.type))
		.toEqual(['polystar', 'gradientFill', 'stroke', 'trim', 'fill']);
	const trim = (await items()).find((i) => i.type === 'trim')!;
	const end = page.getByTestId(`prop-shape.items.${trim.id}.end`);
	await end.click();
	const input = page.getByTestId(`prop-shape.items.${trim.id}.end-input`);
	await input.fill('60');
	await input.press('Enter');
	await expect
		.poll(async () => ((await items()).find((i) => i.id === trim.id)!.end as { value: number }).value)
		.toBe(60);
	const fill = (await items()).find((i) => i.type === 'fill')!;
	await page.getByTestId(`vector-eye-${fill.id}`).click();
	await expect.poll(async () => (await items()).find((i) => i.id === fill.id)!.enabled).toBe(false);
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await items()).find((i) => i.id === fill.id)!.enabled).toBeUndefined();
	await page.keyboard.press('Control+Shift+KeyZ');
	await expect.poll(async () => (await items()).find((i) => i.id === fill.id)!.enabled).toBe(false);
});

test('Pen tool draws and closes a path in the selected shape; a vertex drags on the monitor', async () => {
	await chooseTool('pen');
	const pts: [number, number][] = [
		[300, 300],
		[600, 300],
		[450, 550],
	];
	for (const p of pts) {
		const s = await toScreen(p);
		await page.mouse.click(s.x, s.y);
	}
	const first = await toScreen(pts[0]!);
	await page.mouse.click(first.x, first.y);
	await expect
		.poll(async () => {
			const p = (await items()).find((i) => i.type === 'path');
			return p ? (p.path as { value: { closed: boolean; vertices: unknown[] } }).value : null;
		})
		.toMatchObject({ closed: true, vertices: [{}, {}, {}] });
	await page.getByTestId('tools-panel').locator('[data-tool="selection"]').click();
	const v = page.getByTestId('vector-vertex-2');
	await expect(v).toBeVisible();
	const vb = (await v.boundingBox())!;
	const to = await toScreen([450, 650]);
	await pointerDrag(page, { x: vb.x + vb.width / 2, y: vb.y + vb.height / 2 }, to, { steps: 8 });
	await expect
		.poll(async () => {
			const p = (await items()).find((i) => i.type === 'path')!;
			const vs = (p.path as { value: { vertices: { p: [number, number] }[] } }).value.vertices;
			return Math.round(vs[2]!.p[1] + 540);
		})
		.toBeGreaterThan(630);
	await page.getByTestId('program-player-wrapper').screenshot({ path: join(OUT, 'program.png') });
	test.info().attachments.push({ name: 'program', path: join(OUT, 'program.png'), contentType: 'image/png' });
});

test('export matches a still of the same document', async ({ request }) => {
	const out = await exportViaUi(page, request, {
		engine: 'auto',
		fileName: 'vector-shapes.mp4',
		expectPath: /native|hybrid|remotion/i,
		outDir: OUT,
		jobTimeoutMs: 600_000,
	});
	const frame = 10;
	const still = await query<{ url: string }>(page, 'frame.capture', { frame });
	const png = await (await request.get(still.url)).body();
	const stillFile = join(OUT, 'still.png');
	writeFileSync(stillFile, png);
	const W = 480;
	const H = 270;
	const decode = (file: string, select: string | null) =>
		execFileSync(
			FFMPEG,
			[
				...['-v', 'error', '-i', file],
				...['-vf', `${select ? `${select},` : ''}scale=${W}:${H}`, '-frames:v', '1', '-vsync', '0'],
				...['-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
			],
			{ maxBuffer: 1 << 26 },
		);
	const video = decode(out.file, `select=eq(n\\,${frame})`);
	const image = decode(stillFile, null);
	let sum = 0;
	for (let i = 0; i < image.length; i++) sum += Math.abs(video[i]! - image[i]!);
	const mean = sum / image.length;
	test.info().annotations.push({ type: 'export-vs-still', description: `mean |Δ| ${mean.toFixed(2)}/255` });
	expect(mean).toBeLessThan(3);
	const c = ((H / 2) * W + W / 2) * 3;
	expect(video[c]!).toBeGreaterThan(150);
});
