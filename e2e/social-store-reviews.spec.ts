// The store review cards of social-comment@1 (design §11, docs/wp-notes/social-comments.md "Store reviews") in the
// built editor: the gallery shows the three presets, a double-click inserts one, the Program draws the card in its
// font, Properties' star and date controls edit it (one undo step each), the App Store title is edited in place on the
// Program (contract C5), the stars fill during the like tick, and a long review is clamped with "more".
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

const OUT = join(ROOT, 'test-results', 'e2e-social-store-reviews');
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
const cardEl = (clipId: string, selector: string): Locator =>
	program().locator(`[data-clip-id="${clipId}"] ${selector}`).first();

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

/** A 9:16 project with a store preset inserted from the gallery (double-click); returns the clip id. */
async function storePreset(name: string, preset: string): Promise<string> {
	await page.goto('/');
	await expect(page.getByTestId('home')).toBeVisible();
	await page.getByTestId('home-new').click();
	await page.getByTestId('new-project-name').fill(name);
	await page.getByTestId('new-project-preset').selectOption('vertical-1080x1920-30');
	await page.getByTestId('new-project-create').click();
	await expect(page.getByTestId('editor-shell')).toBeVisible();
	await expect.poll(() => page.evaluate(() => !!window.jasper)).toBe(true);
	await page.getByText('Motion Templates', { exact: true }).first().click();
	for (const p of ['play-store-review', 'app-store-review', 'app-store-review-ios'])
		await expect(page.locator(`[data-preset="${p}"]`).first()).toBeVisible();
	await page.locator(`[data-preset="${preset}"]`).first().dblclick();
	await expect.poll(async () => (await clips(page)).length).toBe(1);
	const [clip] = await clips(page);
	await page.getByTestId('program-zoom').selectOption('100');
	await seek(60);
	return clip!.id;
}

const filledStars = (id: string) =>
	program().locator(`[data-clip-id="${id}"] [data-part="stars"] [data-star="filled"]`);

test('Play Store preset: Roboto card with green stars and M/D/YY date; stars and date edited in Properties', async () => {
	const id = await storePreset('E2E Play review', 'play-store-review');
	const card = cardEl(id, '[data-social-variant="play-store-review"]');
	await expect(card).toBeVisible();
	await expect(cardEl(id, '[data-part="name"]')).toHaveText('Display Name');
	await expect(cardEl(id, '[data-part="date"]')).toHaveText('9/24/25');
	await expect(filledStars(id)).toHaveCount(4);
	expect(await card.evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Roboto');
	expect(await page.evaluate(() => document.fonts.check('500 14px Roboto'))).toBe(true);
	writeFileSync(join(OUT, 'play-store-review.png'), await page.getByTestId('program-viewport').screenshot());

	await page.getByRole('tab', { name: 'Properties' }).click();
	const before = (await appliedLabels(page)).length;
	await page.getByTestId('social-rating-2').click({ force: true });
	await expect.poll(async () => (await clipParams(id)).rating).toBe(2);
	await expect(filledStars(id)).toHaveCount(2);
	await page.getByTestId('social-date-input').fill('2018-11-06');
	await expect.poll(async () => (await clipParams(id)).date).toBe('2018-11-06');
	await expect(page.getByTestId('social-date-preview')).toHaveText('11/6/18');
	await expect(cardEl(id, '[data-part="date"]')).toHaveText('11/6/18');
	expect((await appliedLabels(page)).length).toBe(before + 2);
	await page.getByTestId('properties-panel').screenshot({ path: join(OUT, 'play-properties.png') });
	// undo restores the date, then the stars
	await page.keyboard.press('ControlOrMeta+KeyZ');
	await expect.poll(async () => (await clipParams(id)).date).toBe('2025-09-24');
	await page.keyboard.press('ControlOrMeta+KeyZ');
	await expect.poll(async () => (await clipParams(id)).rating).toBe(4);
});

test('App Store preset: SF Pro card; the title edited on the Program; a long review clamped with "more"', async () => {
	const id = await storePreset('E2E App Store review', 'app-store-review');
	const card = cardEl(id, '[data-social-variant="app-store-review"]');
	await expect(card).toBeVisible();
	await expect(cardEl(id, '[data-part="byline"]')).toHaveText('Display Name, 09/24/2025');
	await expect.poll(() => page.evaluate(() => document.fonts.check('600 13px "SF Pro Text"'))).toBe(true);
	writeFileSync(join(OUT, 'app-store-review.png'), await page.getByTestId('program-viewport').screenshot());

	const title = cardEl(id, '[data-template-param="title"]');
	const box = (await title.boundingBox())!;
	await page.mouse.dblclick(box.x + 10, box.y + box.height / 2);
	const input = page.getByTestId('template-text-input');
	await expect(input).toHaveAttribute('data-value', 'Review title');
	await page.keyboard.press('ControlOrMeta+KeyA');
	await page.keyboard.type('Great so far');
	await page.keyboard.press('Enter');
	await expect.poll(async () => (await clipParams(id)).title).toBe('Great so far');
	await expect(cardEl(id, '[data-part="title"]')).toHaveText('Great so far');

	expectTransaction(
		await transact(page, [
			{
				type: 'clip.update',
				clipId: id,
				patch: {
					params: {
						text: 'I have used this app every day for two years and it keeps getting better. The new update made syncing between my phone and laptop instant, the widgets are lovely and support answered within an hour when I had a billing question.',
					},
				},
			} as never,
		]),
	);
	await seek(61);
	await seek(60);
	await expect(cardEl(id, '[data-part="more"]')).toHaveText('more');
	await expect(cardEl(id, '[data-part="clamp"]')).toHaveAttribute('data-clamped', 'true');
	writeFileSync(
		join(OUT, 'app-store-review-long.png'),
		await page.getByTestId('program-viewport').screenshot(),
	);
});

test('iPhone preset: title, "1y ago" / "edited 1y ago", outline stars; the stars fill during the like tick', async () => {
	const id = await storePreset('E2E iPhone review', 'app-store-review-ios');
	await expect(cardEl(id, '[data-social-variant="app-store-review-ios"]')).toBeVisible();
	await expect(cardEl(id, '[data-part="date"]')).toHaveText('1y ago');
	expectTransaction(
		await transact(page, [
			{
				type: 'clip.update',
				clipId: id,
				patch: { params: { edited: true, likeTick: true, theme: 'dark' } },
			} as never,
		]),
	);
	await seek(61);
	await seek(60);
	await expect(cardEl(id, '[data-part="date"]')).toHaveText('edited 1y ago');
	await expect(filledStars(id)).toHaveCount(4);
	writeFileSync(
		join(OUT, 'app-store-review-ios-dark.png'),
		await page.getByTestId('program-viewport').screenshot(),
	);
	// mid-tick: fewer filled stars, one partly filled
	await seek(20);
	await expect
		.poll(async () =>
			program()
				.locator(
					`[data-clip-id="${id}"] [data-part="stars"] [data-star="partial"], [data-clip-id="${id}"] [data-part="stars"] [data-star="empty"]`,
				)
				.count(),
		)
		.toBeGreaterThan(1);
	writeFileSync(
		join(OUT, 'app-store-review-ios-filling.png'),
		await page.getByTestId('program-viewport').screenshot(),
	);
});
