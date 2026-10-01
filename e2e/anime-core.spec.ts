// wp-m2-anime-core (S11 acceptance 8, FIX-010): Help ▸ About lists anime.js (MIT, with its text) from the
// engine's /api/licenses and shows the JavaScript third-party notices that the built web app ships as
// /THIRD_PARTY_NOTICES.md.
import { expect, type Page, test } from '@playwright/test';
import { createProject, enableAgentBridge, watchPage } from './support.ts';

test.describe.configure({ mode: 'serial' });

let page: Page;
let watcher: { errors: string[] };

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	watcher = watchPage(page);
	await enableAgentBridge(page);
	await createProject(page, 'E2E Anime Core');
});

test.afterAll(async () => {
	await page.close();
});

test('the built web app serves THIRD_PARTY_NOTICES.md', async () => {
	const r = await page.request.get('/THIRD_PARTY_NOTICES.md');
	expect(r.status()).toBe(200);
	const text = await r.text();
	expect(text).toMatch(/^# Third-party notices/);
	expect(text).toContain('| animejs | 4.5.0 | MIT |');
	expect(text).toContain('| react | ');
});

test('Help ▸ About lists anime.js (MIT, licence text) and opens the third-party notices', async () => {
	await page.getByTestId('title-bar').getByRole('menuitem', { name: 'Help', exact: true }).click();
	await page.getByRole('menuitem', { name: /About JasperEditor/ }).click();
	const anime = page.getByTestId('license-animejs');
	await expect(anime).toBeVisible();
	await expect(page.getByTestId('license-animejs-name')).toHaveText('MIT');
	await anime.getByText('MIT License', { exact: true }).click();
	await expect(page.getByTestId('license-animejs-text')).toContainText('Julian Garnier');
	const notices = page.getByTestId('third-party-notices');
	await notices.getByText(/third-party notices/).click();
	await expect(page.getByTestId('third-party-notices-text')).toContainText('| animejs | 4.5.0 | MIT |');
	await expect(notices.getByRole('link', { name: 'THIRD_PARTY_NOTICES.md' })).toHaveAttribute(
		'href',
		'/THIRD_PARTY_NOTICES.md',
	);
	expect(watcher.errors).toEqual([]);
});
