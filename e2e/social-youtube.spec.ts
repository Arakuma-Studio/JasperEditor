// The YouTube cards of social-comment@1 (WP6c, docs/wp-notes/social-comments.md "YouTube cards") in the built editor:
// the gallery shows both presets, a double-click inserts one, the Program draws the card (Roboto, the comment, the
// counts), and the handle and the comment are edited in place on the Program (contract C5).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clips,
	enableAgentBridge,
	expectTransaction,
	query,
	ROOT,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const OUT = join(ROOT, 'test-results', 'e2e-social-youtube');
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

function cardEl(clipId: string, selector: string): Locator {
	return program().locator(`[data-clip-id="${clipId}"] ${selector}`).first();
}

async function clipParams(clipId: string): Promise<Record<string, unknown>> {
	const { sequenceId } = await query<{ sequenceId: string }>(page, 'sequence.summary');
	const c = await query<{ params?: Record<string, unknown> } | null>(page, 'doc.get', {
		path: ['sequences', sequenceId, 'clips', clipId],
	});
	return c?.params ?? {};
}

async function seek(frame: number): Promise<void> {
	await query(page, 'playhead.set', { frame });
	await expect.poll(async () => (await query<{ frame: number }>(page, 'playhead.get')).frame).toBe(frame);
}

/** Screen centre of `word` inside an element. */
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

/** A 9:16 project with the gallery's YouTube preset card inserted (double-click); returns the clip id. */
async function youtubePreset(name: string, preset: string): Promise<string> {
	await page.goto('/');
	await expect(page.getByTestId('home')).toBeVisible();
	await page.getByTestId('home-new').click();
	await page.getByTestId('new-project-name').fill(name);
	await page.getByTestId('new-project-preset').selectOption('vertical-1080x1920-30');
	await page.getByTestId('new-project-create').click();
	await expect(page.getByTestId('editor-shell')).toBeVisible();
	await expect.poll(() => page.evaluate(() => !!window.jasper)).toBe(true);
	await page.getByText('Motion Templates', { exact: true }).first().click();
	for (const p of ['youtube-comment', 'youtube-shorts-reply'])
		await expect(page.locator(`[data-preset="${p}"]`).first()).toBeVisible();
	await page.locator(`[data-preset="${preset}"]`).first().dblclick();
	await expect.poll(async () => (await clips(page)).length).toBe(1);
	const [clip] = await clips(page);
	await page.getByTestId('program-zoom').selectOption('100');
	await seek(60);
	return clip!.id;
}

test('YouTube comment preset: inserted from the gallery, drawn in Roboto, the handle and the text edited in place', async () => {
	const id = await youtubePreset('E2E YouTube comment', 'youtube-comment');
	const card = cardEl(id, '[data-social-variant="youtube-comment"]');
	await expect(card).toBeVisible();
	await expect(cardEl(id, '[data-part="name"]')).toHaveText('@Username');
	await expect(cardEl(id, '[data-part="time"]')).toHaveText('10 months ago');
	await expect(cardEl(id, '[data-part="likes"]')).toHaveText('72');
	await expect(cardEl(id, '[data-part="replies"]')).toHaveText('2 replies');
	expect(await card.evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Roboto');
	expect(await page.evaluate(() => document.fonts.check('500 13px Roboto'))).toBe(true);
	writeFileSync(join(OUT, 'youtube-comment.png'), await page.getByTestId('program-viewport').screenshot());

	// the handle: the "@" stays outside the editable element
	const handle = cardEl(id, '[data-template-param="handle"]');
	const hp = await pointOf(handle, 'Username');
	await page.mouse.dblclick(hp.x, hp.y);
	await expect(input()).toHaveAttribute('data-value', 'Username');
	await page.keyboard.press('ControlOrMeta+KeyA');
	await page.keyboard.type('luna.makes');
	await page.keyboard.press('Enter');
	await expect.poll(async () => (await clipParams(id)).handle).toBe('luna.makes');
	await expect(cardEl(id, '[data-part="name"]')).toHaveText('@luna.makes');

	// the comment, with a highlight from the marks toolbar
	const text = cardEl(id, '[data-template-param="text"][data-template-marks="true"]');
	const tp = await pointOf(text, 'comment');
	await page.mouse.dblclick(tp.x, tp.y);
	await expect(input()).toBeVisible();
	await page.getByTestId('template-marks-toolbar').locator('[data-mark-action="highlight"]').click();
	await expect
		.poll(async () => (await clipParams(id)).text)
		.toBe('Write any ==comment== and see what happens 😊');
	await page.keyboard.press('Escape');
	await expect(input()).toHaveCount(0);
	await seek(61);
	await seek(60);
	await expect(cardEl(id, '[data-mark="highlight"]')).toBeVisible();
	writeFileSync(
		join(OUT, 'youtube-comment-edited.png'),
		await page.getByTestId('program-viewport').screenshot(),
	);
	expect((await appliedLabels(page)).length).toBeGreaterThanOrEqual(3);
});

test('YouTube Shorts preset: "Comment from @handle", no stats; switching the variant keeps the content', async () => {
	const id = await youtubePreset('E2E YouTube Shorts', 'youtube-shorts-reply');
	await expect(cardEl(id, '[data-social-variant="youtube-shorts-reply"]')).toBeVisible();
	await expect(cardEl(id, '[data-part="header"]')).toHaveText('Comment from @Username');
	await expect(cardEl(id, '[data-part="likes"]')).toHaveCount(0);
	writeFileSync(join(OUT, 'youtube-shorts.png'), await page.getByTestId('program-viewport').screenshot());
	expectTransaction(
		await transact(page, [
			{
				type: 'clip.update',
				clipId: id,
				patch: {
					params: { variant: 'youtube-comment', theme: 'dark', text: 'Part two please @luna #shorts' },
				},
			} as never,
		]),
	);
	await seek(61);
	await seek(60);
	await expect(cardEl(id, '[data-social-variant="youtube-comment"]')).toBeVisible();
	await expect(cardEl(id, '[data-part="name"]')).toHaveText('@Username');
	await expect(cardEl(id, '[data-template-param="text"]')).toHaveText('Part two please @luna #shorts');
	writeFileSync(
		join(OUT, 'youtube-comment-dark.png'),
		await page.getByTestId('program-viewport').screenshot(),
	);
});
