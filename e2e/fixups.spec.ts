import { expect, type Locator, type Page, test } from '@playwright/test';
import { createProject, enableAgentBridge, importFiles, query, transact } from './support.ts';

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
	await enableAgentBridge(page);
	await createProject(page, 'E2E Fixups Menus');
	await importFiles(page, ['clip-a.mp4']);
	const media = (await query<{ media: { mediaId: string }[] }>(page, 'media.list')).media;
	const r = await transact(page, [
		{
			type: 'clip.place',
			source: { mediaId: media[0]!.mediaId },
			at: 0,
			tracks: { video: 'V1', audio: 'A1' },
		},
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
});

test.afterAll(async () => {
	await page?.close();
});

async function expectInside(menu: Locator, what: string): Promise<void> {
	const b = (await menu.boundingBox())!;
	const vp = page.viewportSize()!;
	expect(b, what).toBeTruthy();
	expect(b.y, `${what} top`).toBeGreaterThanOrEqual(0);
	expect(b.x, `${what} left`).toBeGreaterThanOrEqual(0);
	expect(b.y + b.height, `${what} bottom (${JSON.stringify(b)})`).toBeLessThanOrEqual(vp.height);
	expect(b.x + b.width, `${what} right`).toBeLessThanOrEqual(vp.width);
}

test('Project panel context menu stays inside the window, also with the Label list open', async () => {
	const row = page.getByTestId('project-row').filter({ hasText: 'clip-a.mp4' });
	const box = (await row.boundingBox())!;
	await row.click({ button: 'right', position: { x: Math.min(40, box.width / 2), y: box.height - 2 } });
	const menu = page.locator('[role="menu"]').filter({ has: page.getByTestId('project-menu-cut') });
	await expect(menu).toBeVisible();
	await expectInside(menu, 'project menu');
	await menu.getByRole('menuitem', { name: 'Label ▸' }).click();
	await expect(menu.getByRole('menuitem', { name: 'Indigo' })).toBeVisible();
	await expectInside(menu, 'project menu with labels');
	const last = menu.getByRole('menuitem').last();
	await last.scrollIntoViewIfNeeded();
	await expectInside(last, 'last project menu entry');
	await page.keyboard.press('Escape');
	await expect(menu).toHaveCount(0);
});

test('timeline clip context menu and its submenus stay inside the window', async () => {
	const seq = await query<{ clips: Record<string, { trackId: string; kind: string }> }>(page, 'doc.get', {
		path: ['sequences', (await query<{ sequenceId: string }>(page, 'sequence.summary')).sequenceId],
	});
	const clipId = Object.keys(seq.clips)[0]!;
	const clip = page.locator(`[data-testid="timeline-track-area"] [data-clip-id="${clipId}"]`).first();
	const cb = (await clip.boundingBox())!;
	await clip.click({ button: 'right', position: { x: Math.min(30, cb.width / 2), y: cb.height / 2 } });
	const menu = page.getByTestId('timeline-context-menu');
	await expect(menu).toBeVisible();
	await expectInside(menu, 'clip menu');
	const subs = menu.locator(':scope > div.relative');
	const n = await subs.count();
	expect(n).toBeGreaterThan(0);
	for (let i = 0; i < n; i++) {
		const sub = subs.nth(i);
		await sub.scrollIntoViewIfNeeded();
		await sub.hover();
		const panel = sub.locator(':scope > [role="menu"]');
		await expect(panel).toBeVisible();
		await expectInside(panel, `submenu ${await sub.innerText()}`);
	}
	await page.keyboard.press('Escape');
	await expect(menu).toHaveCount(0);
});

async function checkMenubar(): Promise<void> {
	const triggers = page.getByTestId('menubar').locator('[data-menu-id]');
	const n = await triggers.count();
	expect(n).toBeGreaterThan(5);
	for (let i = 0; i < n; i++) {
		const t = triggers.nth(i);
		if (await t.isDisabled()) continue;
		const id = await t.getAttribute('data-menu-id');
		await t.click();
		const content = page.locator('[data-radix-menu-content][role="menu"]').first();
		await expect(content).toBeVisible();
		await expectInside(content, `menu ${id}`);
		const subs = content.locator('[role="menuitem"][aria-haspopup="menu"]:not([data-disabled])');
		const k = await subs.count();
		for (let j = 0; j < k; j++) {
			const s = subs.nth(j);
			const label = await s.innerText();
			await s.scrollIntoViewIfNeeded();
			await s.hover();
			const sub = page.locator('[data-radix-menu-content][role="menu"]').nth(1);
			await expect(sub).toBeVisible();
			await expectInside(sub, `submenu ${id} ▸ ${label}`);
		}
		await page.keyboard.press('Escape');
		await expect(page.locator('[data-radix-menu-content]')).toHaveCount(0);
	}
}

test('every menubar menu and submenu fits a 1000 px window', async () => {
	await checkMenubar();
});

test('…and a 560 px one (long menus scroll)', async () => {
	await page.setViewportSize({ width: 1600, height: 560 });
	try {
		await checkMenubar();
	} finally {
		await page.setViewportSize({ width: 1600, height: 1000 });
	}
});
