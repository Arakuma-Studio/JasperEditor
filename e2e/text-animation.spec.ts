import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { clips, createProject, enableAgentBridge, exportViaUi, query, ROOT, transact } from './support.ts';

const OUT_DIR = join(ROOT, 'test-results', 'e2e-text-animation');

let page: Page;
let textId = '';

test.beforeEach(async ({ page: current }) => {
	page = current;
	await enableAgentBridge(page);
	await createProject(page, 'E2E Text Rendering Regression');
	const result = await transact(page, [
		{
			type: 'clip.addText',
			at: 0,
			// The longest tested animation is 45 frames; keep one rest frame and no extra export tail.
			duration: 46,
			track: 'V1',
			content: { text: 'Hello brave world', style: { sizePx: 160, weight: 700 } },
			textAnimation: { in: { preset: 'slide-up', durationFrames: 20, params: { unit: 'word' } } },
		},
	]);
	expect(result.ok, JSON.stringify(result)).toBe(true);
	textId = (await clips(page)).find((clip) => clip.kind === 'text')!.id;
});

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

test('TXA-013: character glyphs stay within 1 px of plain text at the animation boundary', async () => {
	const testInfo = test.info();
	const changed = await transact(page, [
		{
			type: 'clip.update',
			clipId: textId,
			patch: { textAnimation: { in: { preset: 'fade', durationFrames: 10, params: { unit: 'char' } } } },
		},
	]);
	expect(changed.ok, JSON.stringify(changed)).toBe(true);
	const glyphs = () =>
		page
			.getByTestId('program-player-wrapper')
			.locator('[data-text-block]')
			.evaluate((root) => {
				const base = root.getBoundingClientRect();
				const scale = base.width / (root as HTMLElement).offsetWidth;
				const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
				const result: { text: string; x: number; y: number }[] = [];
				let node = walker.nextNode();
				while (node) {
					const parent = node.parentElement;
					if (parent && getComputedStyle(parent).visibility !== 'hidden') {
						for (let i = 0; i < (node.textContent?.length ?? 0); i++) {
							const text = node.textContent![i]!;
							if (/\s/.test(text)) continue;
							const range = document.createRange();
							range.setStart(node, i);
							range.setEnd(node, i + 1);
							const box = range.getBoundingClientRect();
							if (box.width && box.height)
								result.push({ text, x: (box.left - base.left) / scale, y: (box.top - base.top) / scale });
						}
					}
					node = walker.nextNode();
				}
				return result;
			});
	await seek(9);
	await programLuma();
	const animated = await glyphs();
	await testInfo.attach('animated-glyphs', {
		body: await page.getByTestId('program-player-wrapper').screenshot(),
		contentType: 'image/png',
	});
	await seek(10);
	await programLuma();
	const plain = await glyphs();
	expect(animated.map((g) => g.text).join('')).toBe('Hellobraveworld');
	expect(plain.map((g) => g.text)).toEqual(animated.map((g) => g.text));
	const shift = Math.max(
		...animated.map((g, i) => Math.max(Math.abs(g.x - plain[i]!.x), Math.abs(g.y - plain[i]!.y))),
	);
	await testInfo.attach('glyph-positions', {
		body: JSON.stringify({ animated, plain, shift }, null, 2),
		contentType: 'application/json',
	});
	await testInfo.attach('plain-glyphs', {
		body: await page.getByTestId('program-player-wrapper').screenshot(),
		contentType: 'image/png',
	});
	expect(shift).toBeLessThanOrEqual(1);
});

test('returning from Export preserves the paused animated title without another seek', async ({
	request,
}, testInfo) => {
	test.setTimeout(600_000);
	await seek(8);
	const before = await programLuma();
	expect(mean(before)).toBeGreaterThan(0.5);
	await testInfo.attach('before-export', {
		body: await page.getByTestId('program-player-wrapper').screenshot(),
		contentType: 'image/png',
	});
	const out = await exportViaUi(page, request, {
		engine: 'auto',
		fileName: 'text-animation.mp4',
		expectPath: /native|hybrid|remotion/i,
		outDir: OUT_DIR,
	});
	const after = await programLuma();
	await testInfo.attach('after-export', {
		body: await page.getByTestId('program-player-wrapper').screenshot(),
		contentType: 'image/png',
	});
	await testInfo.attach('exported-title', { path: out.file, contentType: 'video/mp4' });
	expect(after).toEqual(before);
});

test('RTL typewriter keeps the caret and neutral punctuation on the visual left', async () => {
	const testInfo = test.info();
	const left = (await clips(page)).filter((c) => c.kind === 'text').sort((a, b) => a.start - b.start)[0]!;
	const changed = await transact(page, [
		{
			type: 'clip.update',
			clipId: left.id,
			patch: {
				content: { text: 'שלום! עולם', style: { sizePx: 160, weight: 700, direction: 'auto' } },
				textAnimation: {
					in: {
						preset: 'typewriter',
						version: 2,
						durationFrames: 45,
						params: { unit: 'word', caretBlink: false },
					},
				},
			},
		},
	]);
	expect(changed.ok, JSON.stringify(changed)).toBe(true);
	await seek(left.start + 10);
	const block = page.getByTestId('program-player-wrapper').locator('[data-text-block]');
	const sample = () =>
		block.evaluate((root) => {
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			let node = walker.nextNode();
			while (
				node &&
				(node.textContent !== 'שלום!' ||
					!node.parentElement ||
					getComputedStyle(node.parentElement).visibility === 'hidden')
			)
				node = walker.nextNode();
			const caret = root.querySelector<HTMLElement>('[data-text-caret]');
			if (!caret || !node) return null;
			const textNode = node;
			const word = document.createRange();
			word.selectNodeContents(textNode);
			const glyph = (at: number) => {
				const range = document.createRange();
				range.setStart(textNode, at);
				range.setEnd(textNode, at + 1);
				return range.getBoundingClientRect();
			};
			const first = glyph(0);
			const punctuation = glyph(4);
			return {
				text: node.textContent,
				wordLeft: word.getBoundingClientRect().left,
				caretRight: caret.getBoundingClientRect().right,
				firstCenter: first.left + first.width / 2,
				punctuationCenter: punctuation.left + punctuation.width / 2,
			};
		});
	await expect.poll(sample).not.toBeNull();
	const geometry = (await sample())!;
	await testInfo.attach('rtl-caret-geometry', {
		body: JSON.stringify(geometry, null, 2),
		contentType: 'application/json',
	});
	await testInfo.attach('rtl-caret', {
		body: await page.getByTestId('program-player-wrapper').screenshot(),
		contentType: 'image/png',
	});
	expect(geometry.caretRight).toBeLessThanOrEqual(geometry.wordLeft + 1);
	expect(geometry.punctuationCenter).toBeLessThan(geometry.firstCenter);
});
