// Program-monitor text editing of anime templates (WP7b canvas-edit, docs/wp-notes/social-comments.md "Program monitor
// editing") in the real editor: double-click a template text in the Program, the editor opens over it (same box at any
// zoom, rotation and aspect), Enter applies one History step, Esc cancels, locked tracks refuse with feedback and the
// topmost of two overlapping templates is edited.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clips,
	createProject,
	enableAgentBridge,
	expectTransaction,
	query,
	ROOT,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const OUT = join(ROOT, 'test-results', 'e2e-template-canvas-edit');
mkdirSync(OUT, { recursive: true });

let page: Page;

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	await page?.close();
});

const program = () => page.getByTestId('program-player-wrapper');
const input = () => page.getByTestId('template-text-input');

/** The rendered element of a template param of a clip in the Program. */
function paramEl(clipId: string, param: string): Locator {
	return program().locator(`[data-clip-id="${clipId}"] [data-template-param="${param}"]`).first();
}

async function clipParams(clipId: string): Promise<Record<string, unknown>> {
	const { sequenceId } = await query<{ sequenceId: string }>(page, 'sequence.summary');
	const c = await query<{ params?: Record<string, unknown> } | null>(page, 'doc.get', {
		path: ['sequences', sequenceId, 'clips', clipId],
	});
	return c?.params ?? {};
}

async function centre(
	l: Locator,
): Promise<{ x: number; y: number; box: { x: number; y: number; width: number; height: number } }> {
	const box = await l.boundingBox();
	if (!box) throw new Error('not laid out');
	return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

/** The screen centre of the first word's glyphs of an element (where a user double-clicks a word). */
async function wordPoint(l: Locator): Promise<{ x: number; y: number }> {
	return l.evaluate((el) => {
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		const t = walker.nextNode() as Text | null;
		if (!t) throw new Error('no text');
		const r = document.createRange();
		const end = t.data.search(/\s/);
		r.setStart(t, 0);
		r.setEnd(t, end > 0 ? end : t.data.length);
		const b = r.getBoundingClientRect();
		return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
	});
}

async function addLowerThird(track: string, name: string, extra: unknown[] = []): Promise<string> {
	const tx = await transact(page, [
		{
			type: 'clip.addMotionGraphic',
			at: 0,
			duration: 150,
			track,
			template: { id: 'lower-third-anim', version: 1 },
			params: { name },
			ref: '$lt',
		} as never,
		...(extra as never[]),
	]);
	expectTransaction(tx);
	return tx.refs.$lt!;
}

async function seek(frame: number): Promise<void> {
	await query(page, 'playhead.set', { frame });
	await expect.poll(async () => (await query<{ frame: number }>(page, 'playhead.get')).frame).toBe(frame);
}

test('double-click edits a template text in place; Enter applies one step, Esc cancels', async () => {
	await createProject(page, 'E2E Template Canvas Edit');
	const id = await addLowerThird('V1', 'Jordan Avery');
	// Mid-intro: the editor still opens on the settled (rest) layout.
	await seek(8);
	const name = paramEl(id, 'name');
	await expect(name).toBeAttached();
	const before = await centre(name);
	await page.mouse.dblclick(before.x, before.y);
	await expect(input()).toBeVisible();
	await expect(input()).toHaveAttribute('data-value', 'Jordan Avery');
	// The held layer shows its rest frame and the original text is hidden under the editor.
	await expect(program().locator(`[data-clip-id="${id}"] [data-template-hold="true"]`)).toBeAttached();
	const rest = (await name.boundingBox())!;
	const ed = (await input().boundingBox())!;
	expect(Math.abs(ed.x - rest.x)).toBeLessThan(3);
	expect(Math.abs(ed.y - rest.y)).toBeLessThan(3);
	expect(Math.abs(ed.height - rest.height)).toBeLessThan(4);
	writeFileSync(
		join(OUT, 'lower-third-editing.png'),
		await page.getByTestId('program-viewport').screenshot(),
	);
	// The double-clicked word is selected: typing replaces it.
	await page.keyboard.type('Casey');
	await expect(input()).toHaveAttribute('data-value', /Casey/);
	await page.keyboard.press('Enter');
	await expect(input()).toHaveCount(0);
	const after = String((await clipParams(id)).name);
	expect(after).toMatch(/Casey/);
	expect((await appliedLabels(page)).at(-1)).toBe('Edit Text');
	await expect(program().locator(`[data-clip-id="${id}"] [data-template-hold="true"]`)).toHaveCount(0);

	// Esc cancels.
	const c2 = await centre(name);
	await page.mouse.dblclick(c2.x, c2.y);
	await expect(input()).toBeVisible();
	await page.keyboard.type('zzz');
	await page.keyboard.press('Escape');
	await expect(input()).toHaveCount(0);
	expect((await clipParams(id)).name).toBe(after);

	// Undo restores the old text (one step).
	await page.getByTestId('timeline-track-area').click({ position: { x: 5, y: 5 } });
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await clipParams(id)).name).toBe('Jordan Avery');
});

test('rotated, scaled layer at 200 % zoom: the editor follows the layer', async () => {
	await createProject(page, 'E2E Template Canvas Edit Rotated');
	const id = await addLowerThird('V1', 'Rotated Name', [
		{ type: 'param.set', target: ['clip', '$lt', 'transform', 'rotation'], value: 12 },
		{ type: 'param.set', target: ['clip', '$lt', 'transform', 'scale'], value: 140 },
		// The name (≈ layer px 230, 900) lands near the frame centre, inside the 200 % view.
		{ type: 'param.set', target: ['clip', '$lt', 'transform', 'position'], value: [2064, 260] },
	]);
	await seek(60);
	await page.getByTestId('program-zoom').selectOption('200');
	const name = paramEl(id, 'name');
	await expect(name).toBeAttached();
	const c = await wordPoint(name);
	await page.mouse.dblclick(c.x, c.y);
	await expect(input()).toBeVisible();
	await expect(input()).toHaveAttribute('data-value', 'Rotated Name');
	expect(await page.evaluate(() => document.getSelection()?.toString())).toBe('Rotated');
	const rest = (await name.boundingBox())!;
	const ed = (await input().boundingBox())!;
	// Both are rotated by the layer: their bounding boxes coincide.
	expect(Math.abs(ed.x + ed.width / 2 - (rest.x + rest.width / 2))).toBeLessThan(6);
	expect(Math.abs(ed.y + ed.height / 2 - (rest.y + rest.height / 2))).toBeLessThan(6);
	writeFileSync(join(OUT, 'rotated-200.png'), await page.getByTestId('program-viewport').screenshot());
	await page.keyboard.press('End');
	await page.keyboard.type(' II');
	await page.keyboard.press('Enter');
	await expect.poll(async () => (await clipParams(id)).name).toBe('Rotated Name II');
	await page.getByTestId('program-zoom').selectOption('fit');
});

test('locked track refuses with feedback; the topmost of overlapping templates is edited', async () => {
	await createProject(page, 'E2E Template Canvas Edit Stack');
	const low = await addLowerThird('V1', 'Lower Card');
	const top = await addLowerThird('V2', 'Upper Card');
	await seek(60);
	const c = await wordPoint(paramEl(top, 'name'));
	await page.mouse.dblclick(c.x, c.y);
	await expect(input()).toBeVisible();
	await expect(input()).toHaveAttribute('data-value', 'Upper Card');
	await page.keyboard.press('Escape');
	await expect(input()).toHaveCount(0);

	expectTransaction(
		await transact(page, [{ type: 'track.update', trackId: 'V2', patch: { locked: true } } as never]),
	);
	await page.mouse.dblclick(c.x, c.y);
	await expect(page.getByTestId('template-text-message')).toHaveText('The clip’s track is locked');
	await expect(input()).toHaveCount(0);
	expect((await clipParams(low)).name).toBe('Lower Card');
	expect((await clipParams(top)).name).toBe('Upper Card');
});

test('vertical 9:16 sequence', async () => {
	await page.goto('/');
	await expect(page.getByTestId('home')).toBeVisible();
	await page.getByTestId('home-new').click();
	await page.getByTestId('new-project-name').fill('E2E Template Canvas Edit Vertical');
	await page.getByTestId('new-project-preset').selectOption('vertical-1080x1920-30');
	await page.getByTestId('new-project-create').click();
	await expect(page.getByTestId('editor-shell')).toBeVisible();
	await expect.poll(() => page.evaluate(() => !!window.jasper)).toBe(true);
	const id = await addLowerThird('V1', 'Vertical Name');
	await seek(60);
	const name = paramEl(id, 'name');
	await expect(name).toBeAttached();
	const c = await centre(name);
	await page.mouse.dblclick(c.x, c.y);
	await expect(input()).toBeVisible();
	const rest = (await name.boundingBox())!;
	const ed = (await input().boundingBox())!;
	expect(Math.abs(ed.x - rest.x)).toBeLessThan(3);
	expect(Math.abs(ed.y - rest.y)).toBeLessThan(3);
	writeFileSync(join(OUT, 'vertical.png'), await page.getByTestId('program-viewport').screenshot());
	await page.keyboard.press('End');
	await page.keyboard.type('!');
	await page.keyboard.press('Enter');
	await expect.poll(async () => (await clipParams(id)).name).toBe('Vertical Name!');
});

/** The screen centre of `word` inside an element's text. */
async function pointOf(l: Locator, word: string): Promise<{ x: number; y: number }> {
	return l.evaluate((el, w) => {
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		let t: Text | null;
		while ((t = walker.nextNode() as Text | null)) {
			const i = t.data.indexOf(w);
			if (i < 0) continue;
			const r = document.createRange();
			r.setStart(t, i);
			r.setEnd(t, i + w.length);
			const b = r.getBoundingClientRect();
			return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
		}
		throw new Error(`"${w}" is not drawn`);
	}, word);
}

/** A 9:16 project with one social-comment clip inserted from its gallery preset card. */
async function socialPreset(name: string, preset: string): Promise<string> {
	await page.goto('/');
	await expect(page.getByTestId('home')).toBeVisible();
	await page.getByTestId('home-new').click();
	await page.getByTestId('new-project-name').fill(name);
	await page.getByTestId('new-project-preset').selectOption('vertical-1080x1920-30');
	await page.getByTestId('new-project-create').click();
	await expect(page.getByTestId('editor-shell')).toBeVisible();
	await expect.poll(() => page.evaluate(() => !!window.jasper)).toBe(true);
	await page.getByText('Motion Templates', { exact: true }).first().click();
	const card = page.locator(`[data-preset="${preset}"]`).first();
	await expect(card).toBeVisible();
	await card.dblclick();
	await expect.poll(async () => (await clips(page)).length).toBe(1);
	const [clip] = await clips(page);
	// Text without emoji (no remote emoji needed), with word marks.
	expectTransaction(
		await transact(page, [
			{
				type: 'clip.update',
				clipId: clip!.id,
				patch: { params: { displayName: 'Luna Park', text: 'Hello ==big== world and more' } },
			} as never,
		]),
	);
	await page.getByTestId('program-zoom').selectOption('100');
	// Mid-entrance: the editor opens on the settled card.
	await seek(5);
	return clip!.id;
}

test('social comment (TikTok comment preset): marks survive typing, the toolbar, multi-line text, the name', async () => {
	const id = await socialPreset('E2E Canvas Edit TikTok comment', 'tiktok-comment');
	const text = paramEl(id, 'text');
	await expect(text).toBeAttached();
	const p = await pointOf(text, 'world');
	await page.mouse.dblclick(p.x, p.y);
	await expect(input()).toBeVisible();
	await expect(input()).toHaveAttribute('data-value', 'Hello ==big== world and more');
	await expect(program().locator(`[data-clip-id="${id}"] [data-template-hold="true"]`)).toBeAttached();
	const rest = (await text.boundingBox())!;
	const ed = (await input().boundingBox())!;
	expect(Math.abs(ed.x - rest.x)).toBeLessThan(2);
	expect(Math.abs(ed.y - rest.y)).toBeLessThan(2);
	expect(Math.abs(ed.width - rest.width)).toBeLessThan(2);
	expect(await page.evaluate(() => document.getSelection()?.toString())).toBe('world');
	const toolbar = page.getByTestId('template-marks-toolbar');
	await expect(toolbar).toBeVisible();
	writeFileSync(
		join(OUT, 'tiktok-comment-editing.png'),
		await page.getByTestId('program-viewport').screenshot(),
	);
	await toolbar.locator('[data-mark-action="blur"]').click();
	await expect.poll(async () => (await clipParams(id)).text).toBe('Hello ==big== ||world|| and more');
	expect((await appliedLabels(page)).at(-1)).toBe('Blur Words');
	// Typing keeps the marks; Shift+Enter is a new line (multi-line param); Enter applies one step.
	await expect(input()).toBeVisible();
	await page.keyboard.press('End');
	await page.keyboard.type(' yes');
	await page.keyboard.press('Shift+Enter');
	await page.keyboard.type('two');
	writeFileSync(
		join(OUT, 'tiktok-comment-typing.png'),
		await page.getByTestId('program-viewport').screenshot(),
	);
	await page.keyboard.press('Enter');
	await expect
		.poll(async () => (await clipParams(id)).text)
		.toBe('Hello ==big== ||world|| and more yes\ntwo');
	expect((await appliedLabels(page)).at(-1)).toBe('Edit Text');
	// The name (a flex item in the header row).
	const name = paramEl(id, 'displayName');
	const np = await pointOf(name, 'Park');
	await page.mouse.dblclick(np.x, np.y);
	await expect(input()).toHaveAttribute('data-value', 'Luna Park');
	const nRest = (await name.boundingBox())!;
	const nEd = (await input().boundingBox())!;
	expect(Math.abs(nEd.x - nRest.x)).toBeLessThan(2);
	expect(Math.abs(nEd.y - nRest.y)).toBeLessThan(2);
	await page.keyboard.type('Lake');
	await page.keyboard.press('Enter');
	await expect.poll(async () => (await clipParams(id)).displayName).toBe('Luna Lake');
	await page.waitForTimeout(300);
	writeFileSync(
		join(OUT, 'tiktok-comment-after.png'),
		await page.getByTestId('program-viewport').screenshot(),
	);
	// Undo from the Timeline: the name, then the text step.
	await page.getByTestId('timeline-track-area').click({ position: { x: 5, y: 5 } });
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await clipParams(id)).displayName).toBe('Luna Park');
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await clipParams(id)).text).toBe('Hello ==big== ||world|| and more');
});

test('social comment (TikTok reply preset): the name inside "Reply to …", Highlight from the toolbar, Esc', async () => {
	const id = await socialPreset('E2E Canvas Edit TikTok reply', 'tiktok-reply');
	const name = paramEl(id, 'displayName');
	await expect(name).toBeAttached();
	const np = await pointOf(name, 'Luna');
	await page.mouse.dblclick(np.x, np.y);
	await expect(input()).toHaveAttribute('data-value', 'Luna Park');
	expect(await page.evaluate(() => document.getSelection()?.toString())).toBe('Luna');
	const nRest = (await name.boundingBox())!;
	const nEd = (await input().boundingBox())!;
	expect(Math.abs(nEd.x - nRest.x)).toBeLessThan(2);
	expect(Math.abs(nEd.y - nRest.y)).toBeLessThan(3);
	writeFileSync(join(OUT, 'tiktok-reply-name.png'), await page.getByTestId('program-viewport').screenshot());
	await page.keyboard.type('Nova');
	await page.keyboard.press('Enter');
	await expect.poll(async () => (await clipParams(id)).displayName).toBe('Nova Park');

	const text = paramEl(id, 'text');
	const p = await pointOf(text, 'more');
	await page.mouse.dblclick(p.x, p.y);
	await expect(input()).toHaveAttribute('data-value', 'Hello ==big== world and more');
	await page.getByTestId('template-marks-toolbar').locator('[data-mark-action="highlight"]').click();
	await expect.poll(async () => (await clipParams(id)).text).toBe('Hello ==big== world and ==more==');
	writeFileSync(
		join(OUT, 'tiktok-reply-highlight.png'),
		await page.getByTestId('program-viewport').screenshot(),
	);
	await page.keyboard.type('X');
	await page.keyboard.press('Escape');
	await expect(input()).toHaveCount(0);
	expect((await clipParams(id)).text).toBe('Hello ==big== world and ==more==');
});

test('social comment (Instagram presets): the post and Reel cards draw; their handle and text edit in place', async () => {
	for (const preset of ['instagram-post', 'instagram-reel-reply']) {
		const id = await socialPreset(`E2E Canvas Edit ${preset}`, preset);
		expectTransaction(
			await transact(page, [
				{ type: 'clip.update', clipId: id, patch: { params: { handle: 'luna.park' } } } as never,
			]),
		);
		const card = program().locator(`[data-clip-id="${id}"] [data-social-variant="${preset}"]`);
		await expect(card).toBeAttached();
		await expect(program().locator('[data-social-unavailable]')).toHaveCount(0);
		// The handle ("username" on the post, "Replying to …" on the Reel card).
		const handle = paramEl(id, 'handle');
		await expect(handle).toHaveText('luna.park');
		const hp = await pointOf(handle, 'park');
		await page.mouse.dblclick(hp.x, hp.y);
		await expect(input()).toHaveAttribute('data-value', 'luna.park');
		const hRest = (await handle.boundingBox())!;
		const hEd = (await input().boundingBox())!;
		expect(Math.abs(hEd.x - hRest.x)).toBeLessThan(2);
		expect(Math.abs(hEd.y - hRest.y)).toBeLessThan(3);
		writeFileSync(join(OUT, `${preset}-handle.png`), await page.getByTestId('program-viewport').screenshot());
		await page.keyboard.press('End');
		await page.keyboard.type('_2');
		await page.keyboard.press('Enter');
		await expect.poll(async () => (await clipParams(id)).handle).toBe('luna.park_2');
		// The comment with its marks.
		const text = paramEl(id, 'text');
		const p = await pointOf(text, 'world');
		await page.mouse.dblclick(p.x, p.y);
		await expect(input()).toHaveAttribute('data-value', 'Hello ==big== world and more');
		await page.getByTestId('template-marks-toolbar').locator('[data-mark-action="highlight"]').click();
		await expect.poll(async () => (await clipParams(id)).text).toBe('Hello ==big world== and more');
		await page.keyboard.press('Escape');
		await expect(input()).toHaveCount(0);
		await page.waitForTimeout(300);
		writeFileSync(join(OUT, `${preset}-after.png`), await page.getByTestId('program-viewport').screenshot());
	}
});
