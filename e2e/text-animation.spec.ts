// S11 §11 test 2 (wp-m2-text-anim): text animators through the real UI of the built app — Graphics ▸ New Layer ▸
// Text, "Slide Up" (by word) as In and "Fade" as Out from Motion Templates ▸ Text Animations, the Program
// animates, scrubbing back and forth gives identical pixels on revisits, the razor keeps In on the left part and
// Out on the right one, undo/redo, the export (native/hybrid with baked layers once wp-m2-layer-bake is merged,
// the Remotion path before — annotated, never skipped) whose mid-In frame matches `renderStill`, and the MCP
// tools (list_text_animations, set_text_animation, render_frames) on the open editor.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clipBox,
	clips,
	createProject,
	enableAgentBridge,
	exportViaUi,
	focusTimeline,
	query,
	ROOT,
	serverInfo,
	waitForJob,
	watchPage,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

type Animator = { preset: string; version: number; durationFrames: number; params: Record<string, unknown> };
type TextAnimation = { in?: Animator | null; out?: Animator | null };

const MCP_BUNDLE = join(ROOT, 'apps/mcp/dist/jasper-mcp.mjs');
const OUT_DIR = join(ROOT, 'test-results', 'e2e-text-animation');

let page: Page;
let watcher: { errors: string[] };
let projectId = '';
let seqId = '';
let textId = '';

test.beforeAll(async ({ browser }) => {
	mkdirSync(OUT_DIR, { recursive: true });
	page = await browser.newPage();
	watcher = watchPage(page);
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	await page?.close();
});

async function transact(commands: unknown[]): Promise<{ ok: boolean; errors?: unknown[] }> {
	return page.evaluate(
		(cmds) =>
			(
				window as unknown as {
					jasper: { transact(tx: unknown): Promise<{ ok: boolean; errors?: unknown[] }> };
				}
			).jasper.transact({ protocol: 'jasper.tx/1', label: 'E2E setup', commands: cmds }),
		commands,
	);
}

async function animationOf(clipId: string): Promise<TextAnimation | undefined> {
	return query<TextAnimation | undefined>(page, 'doc.get', {
		path: ['sequences', seqId, 'clips', clipId, 'textAnimation'],
	}).catch(() => undefined);
}

async function seek(frame: number): Promise<void> {
	await query(page, 'playhead.set', { frame });
}

/** The Program monitor as composited on screen, decoded in the page: luma per pixel of a centre band. */
async function programLuma(): Promise<number[]> {
	const shot = await page.getByTestId('program-player-wrapper').screenshot();
	return page.evaluate(async (b64) => {
		const img = new Image();
		img.src = `data:image/png;base64,${b64}`;
		await img.decode();
		const c = document.createElement('canvas');
		c.width = img.width;
		c.height = img.height;
		const g = c.getContext('2d', { willReadFrequently: true })!;
		g.drawImage(img, 0, 0);
		const y0 = Math.floor(img.height * 0.3);
		const d = g.getImageData(0, y0, img.width, Math.floor(img.height * 0.4)).data;
		const out: number[] = [];
		for (let i = 0; i < d.length; i += 4)
			out.push(Math.round(0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!));
		return out;
	}, shot.toString('base64'));
}
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);

/** Waits until two consecutive Program captures agree (the Player finished drawing the seeked frame). */
async function settledLuma(): Promise<number[]> {
	let prev = await programLuma();
	for (let i = 0; i < 20; i++) {
		await page.waitForTimeout(150);
		const next = await programLuma();
		if (next.length === prev.length && next.every((v, k) => v === prev[k])) return next;
		prev = next;
	}
	return prev;
}

/** RGB24 pixels of one frame of a video (exact frame index) or an image, decoded by ffmpeg. */
function rgbFrame(file: string, frame: number | null, w: number, h: number): Buffer {
	return execFileSync(
		process.env.JASPER_FFMPEG ?? 'ffmpeg',
		[
			'-v',
			'error',
			'-i',
			file,
			...(frame === null ? [] : ['-vf', `select=eq(n\\,${frame})`, '-vsync', '0']),
			'-frames:v',
			'1',
			'-s',
			`${w}x${h}`,
			'-pix_fmt',
			'rgb24',
			'-f',
			'rawvideo',
			'pipe:1',
		],
		{ maxBuffer: w * h * 3 + 1024 },
	);
}

test('setup: Graphics ▸ New Layer ▸ Text adds a selected text clip', async () => {
	projectId = await createProject(page, 'E2E Text Animation');
	seqId = (await query<{ sequenceId: string }>(page, 'sequence.summary')).sequenceId;
	await page.getByTestId('title-bar').getByRole('menuitem', { name: 'Graphics', exact: true }).click();
	await page.getByRole('menuitem', { name: /New Layer/ }).click();
	await page.getByRole('menuitem', { name: /^Text(?! Animation)/ }).click();
	await expect.poll(async () => (await clips(page)).filter((c) => c.kind === 'text').length).toBe(1);
	textId = (await clips(page)).find((c) => c.kind === 'text')!.id;
	// Setup only: a three-word title, large enough to measure (the edits under test go through the UI).
	const r = await transact([
		{
			type: 'clip.update',
			clipId: textId,
			patch: { content: { text: 'Hello brave world', style: { sizePx: 160, weight: 700 } } },
		},
	]);
	expect(r.ok, JSON.stringify(r.errors)).toBe(true);
	await focusTimeline(page);
	await page.locator(`[data-testid="timeline-track-area"] [data-clip-id="${textId}"]`).first().click();
});

test('Motion Templates ▸ Text Animations: Slide Up (word) as In and Fade as Out', async () => {
	await page.getByTestId('tab-motionTemplates').click();
	await page.getByRole('tab', { name: 'Text Animations' }).click();
	const tab = page.getByTestId('text-animations-tab');
	await expect(tab).toBeVisible();
	await expect(tab.locator('[data-text-animation]')).toHaveCount(12);
	await expect(tab.locator('[data-preview-thumb]').first()).toBeVisible();
	const before = (await appliedLabels(page)).length;
	await tab.locator('[data-text-animation="slide-up@1"]').dblclick();
	await expect.poll(async () => (await animationOf(textId))?.in?.preset).toBe('slide-up');
	await tab.locator('[data-side-chip="out"]').click();
	await tab.locator('[data-text-animation="fade@1"]').dblclick();
	await expect.poll(async () => (await animationOf(textId))?.out?.preset).toBe('fade');
	const a = (await animationOf(textId))!;
	expect(a.in).toMatchObject({
		preset: 'slide-up',
		version: 1,
		durationFrames: 20,
		params: { unit: 'word' },
	});
	expect(a.out).toMatchObject({ preset: 'fade', version: 1, durationFrames: 15 });
	expect((await appliedLabels(page)).slice(before)).toEqual(['Apply Slide Up In', 'Apply Fade Out']);
	// The timeline shows the head/tail wedges.
	await expect(
		page.locator(
			`[data-testid="timeline-track-area"] [data-clip-id="${textId}"] [data-text-anim-wedges="20/15"]`,
		),
	).toBeVisible();
	await page.screenshot({ path: join(OUT_DIR, 'tab.png') });
});

test('the Program animates the title; revisiting a frame gives identical pixels', async () => {
	const clip = (await clips(page)).find((c) => c.id === textId)!;
	await seek(clip.start + 40);
	const rest = mean(await settledLuma());
	await seek(clip.start);
	const first = mean(await settledLuma());
	// Frame 0 of slide-up: every word is transparent.
	expect(rest - first).toBeGreaterThan(2);
	const mid = clip.start + 8;
	await seek(mid);
	const a = await settledLuma();
	expect(mean(a)).toBeGreaterThan(first);
	expect(mean(a)).toBeLessThan(rest + 0.5);
	await page.getByTestId('program-player-wrapper').screenshot({ path: join(OUT_DIR, 'program-mid-in.png') });
	// Scrub forward and back (In, rest, Out, before the clip) and return.
	for (const f of [clip.start + 19, clip.start + 3, clip.start + 70, clip.end - 2, clip.start + 12, mid + 1])
		await seek(f);
	await seek(mid);
	const b = await settledLuma();
	expect(b.length).toBe(a.length);
	expect(b.filter((v, i) => v !== a[i]!).length).toBe(0);
	// Out: the last frame is faded to (almost) nothing.
	await seek(clip.end - 1);
	expect(mean(await settledLuma())).toBeLessThan(first + 1);
});

test('razor: the left part keeps In only, the right part Out only; undo/redo', async () => {
	const clip = (await clips(page)).find((c) => c.id === textId)!;
	const before = (await appliedLabels(page)).length;
	await focusTimeline(page);
	await page.keyboard.press('KeyC');
	const b = await clipBox(page, textId);
	await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
	await page.keyboard.press('KeyV');
	await expect.poll(async () => (await clips(page)).filter((c) => c.kind === 'text').length).toBe(2);
	const [left, right] = (await clips(page))
		.filter((c) => c.kind === 'text')
		.sort((x, y) => x.start - y.start);
	expect(left!.id).toBe(textId);
	expect(left!.start).toBe(clip.start);
	expect(right!.end).toBe(clip.end);
	expect(await animationOf(left!.id)).toEqual({ in: expect.objectContaining({ preset: 'slide-up' }) });
	expect(await animationOf(right!.id)).toEqual({ out: expect.objectContaining({ preset: 'fade' }) });
	expect((await appliedLabels(page)).length).toBe(before + 1);
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await clips(page)).filter((c) => c.kind === 'text').length).toBe(1);
	const restored = (await animationOf(textId))!;
	expect(restored.in?.preset).toBe('slide-up');
	expect(restored.out?.preset).toBe('fade');
	await page.keyboard.press('Control+Shift+KeyZ');
	await expect.poll(async () => (await clips(page)).filter((c) => c.kind === 'text').length).toBe(2);
	expect(await animationOf(textId)).toEqual({ in: expect.objectContaining({ preset: 'slide-up' }) });
});

test('TXA-013: char units at the window boundary sit on the glyphs of the plain text (≤ 1 px)', async () => {
	const left = (await clips(page)).filter((c) => c.kind === 'text').sort((x, y) => x.start - y.start)[0]!;
	// Setup only: a char-unit fade (positions are exactly at rest, only opacity animates).
	const r = await transact([
		{
			type: 'clip.update',
			clipId: left.id,
			patch: { textAnimation: { in: { preset: 'fade', durationFrames: 10, params: { unit: 'char' } } } },
		},
	]);
	expect(r.ok, JSON.stringify(r.errors)).toBe(true);
	const block = page.getByTestId('program-player-wrapper').locator('[data-text-block]');
	// Last In frame: the overlay draws every character box (layout px = screen px / Player scale).
	await seek(left.start + 9);
	await expect(block).toHaveAttribute('data-text-animating', 'in');
	const split = await block.evaluate((p: HTMLElement) => {
		const scale = p.getBoundingClientRect().width / p.offsetWidth;
		const base = p.getBoundingClientRect();
		return [...p.querySelectorAll('[data-text-overlay] [data-text-unit-index] span')].map((s) => {
			const b = s.getBoundingClientRect();
			return { text: s.textContent ?? '', x: (b.left - base.left) / scale, y: (b.top - base.top) / scale };
		});
	});
	// First rest frame: the plain text node; glyph boxes from a Range per character (test-only measurement).
	await seek(left.start + 10);
	await expect(block).not.toHaveAttribute('data-text-animating', /.+/);
	const plain = await block.evaluate((p: HTMLElement) => {
		const scale = p.getBoundingClientRect().width / p.offsetWidth;
		const base = p.getBoundingClientRect();
		const node = p.firstChild as Text;
		const out: { text: string; x: number; y: number }[] = [];
		const range = document.createRange();
		for (let i = 0; i < node.length; i++) {
			const ch = node.data[i]!;
			if (/\s/.test(ch)) continue;
			range.setStart(node, i);
			range.setEnd(node, i + 1);
			const b = range.getBoundingClientRect();
			out.push({ text: ch, x: (b.left - base.left) / scale, y: (b.top - base.top) / scale });
		}
		return out;
	});
	expect(split.map((s) => s.text)).toEqual(plain.map((s) => s.text));
	const shift = Math.max(
		...split.map((s, i) => Math.max(Math.abs(s.x - plain[i]!.x), Math.abs(s.y - plain[i]!.y))),
	);
	test.info().annotations.push({ type: 'glyph-shift-px', description: shift.toFixed(3) });
	expect(shift).toBeLessThanOrEqual(1);
	// Back to the tab's preset for the export.
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await animationOf(left.id))?.in?.preset).toBe('slide-up');
});

test('export: the mid-In frame matches renderStill (≤ 3/255 on 99 % of the pixels)', async ({ request }) => {
	test.setTimeout(600_000);
	const caps = await (await request.get('/api/capabilities')).json();
	const bake = caps?.features?.layerBake?.state;
	const baked = bake === 'ready';
	if (!baked)
		test.info().annotations.push({
			type: 'layer-bake',
			description: `features.layerBake is ${bake ?? 'absent'}: text exports through the Remotion path until wp-m2-layer-bake is merged`,
		});
	const out = await exportViaUi(page, request, {
		engine: 'auto',
		fileName: 'text-animation.mp4',
		expectPath: baked ? /native|hybrid/i : /remotion/i,
		outDir: OUT_DIR,
	});
	// Baked layers: the native builder overlays them (plan path native or hybrid, S11:LBK-002).
	expect(baked ? ['native', 'hybrid'] : ['remotion']).toContain(out.job.result?.renderPath);
	const left = (await clips(page)).filter((c) => c.kind === 'text').sort((x, y) => x.start - y.start)[0]!;
	const frame = left.start + 8;
	// renderStill of the same frame through the engine (the project as the editor holds it).
	const doc = await query<Record<string, unknown>>(page, 'doc.get');
	const job = await (
		await request.post('/api/stills', {
			data: {
				envelope: {
					format: 'jasper-project',
					schemaVersion: doc.schemaVersion,
					savedAt: new Date().toISOString(),
					savedBy: { app: 'JasperEditor', version: '0.1.0', platform: 'e2e' },
					revision: 1,
					document: doc,
				},
				sequenceId: seqId,
				frame,
			},
		})
	).json();
	const done = await waitForJob(request, job.id);
	expect(done.state, JSON.stringify(done.error ?? null)).toBe('succeeded');
	const url = (done.result as { url: string }).url;
	const png = join(OUT_DIR, `still-${frame}.png`);
	writeFileSync(png, Buffer.from(await (await request.get(url)).body()));
	const [w, h] = [1920, 1080];
	const a = rgbFrame(out.file, frame, w, h);
	const b = rgbFrame(png, null, w, h);
	expect(a.length).toBe(w * h * 3);
	expect(b.length).toBe(w * h * 3);
	let close = 0;
	let textPixels = 0;
	for (let i = 0; i < a.length; i += 3) {
		const d = Math.max(
			Math.abs(a[i]! - b[i]!),
			Math.abs(a[i + 1]! - b[i + 1]!),
			Math.abs(a[i + 2]! - b[i + 2]!),
		);
		if (d <= 3) close++;
		if (b[i]! > 128) textPixels++;
	}
	// The frame shows (part of) the title, and the export agrees with the still.
	expect(textPixels).toBeGreaterThan(1000);
	expect(close / (w * h)).toBeGreaterThanOrEqual(0.99);
});

test('MCP: list_text_animations, set_text_animation and render_frames on the open editor', async () => {
	test.setTimeout(300_000);
	expect(existsSync(MCP_BUNDLE), `${MCP_BUNDLE} is missing: run \`pnpm mcp:build\``).toBe(true);
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env))
		if (v !== undefined && !k.startsWith('JASPER_')) env[k] = v;
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [MCP_BUNDLE, '--appdir', serverInfo().appdir],
		env,
		stderr: 'pipe',
	});
	const log: string[] = [];
	transport.stderr?.on('data', (d: Buffer) => log.push(d.toString('utf8')));
	const mcp = new Client({ name: 'e2e-text-anim', version: '1.0.0' });
	await mcp.connect(transport);
	try {
		const call = async (name: string, args: Record<string, unknown>) => {
			const r = (await mcp.callTool({ name, arguments: args }, undefined, {
				timeout: 180_000,
			})) as CallToolResult;
			const text = (r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
			expect(r.isError, `${name}: ${text}\n${log.join('')}`).toBeFalsy();
			return { r, text };
		};
		const list = await call('list_text_animations', {});
		expect(list.text).toContain('slide-up');
		expect(list.text).toContain('typewriter');
		const right = (await clips(page)).filter((c) => c.kind === 'text').sort((x, y) => x.start - y.start)[1]!;
		const before = (await appliedLabels(page)).length;
		await call('set_text_animation', {
			projectId,
			clipId: right.id,
			in: { preset: 'typewriter', durationSeconds: 0.5 },
			out: null,
		});
		await expect.poll(async () => (await animationOf(right.id))?.in?.preset).toBe('typewriter');
		const a = (await animationOf(right.id))!;
		expect(a.in?.durationFrames).toBe(15);
		expect(a.out ?? null).toBeNull();
		// Applied live in the open editor as one History entry.
		expect((await appliedLabels(page)).length).toBe(before + 1);
		const sheet = await call('render_frames', {
			projectId,
			count: 4,
			from: right.start,
			to: right.start + 15,
		});
		const image = sheet.r.content.find((c) => c.type === 'image') as
			| { data: string; mimeType: string }
			| undefined;
		expect(image?.mimeType).toBe('image/png');
		writeFileSync(join(OUT_DIR, 'contact-sheet.png'), Buffer.from(image!.data, 'base64'));
	} finally {
		await mcp.close().catch(() => {});
	}
});

test('no uncaught page errors', async () => {
	expect(watcher.errors.filter((e) => !/favicon|ResizeObserver/.test(e))).toEqual([]);
});
