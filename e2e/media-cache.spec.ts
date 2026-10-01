// Edit ▸ Preferences ▸ Media Cache (M3, S04:CA-013/CA-014, wp-m3-cachegc): with a project open and media imported,
// the page lists the cache per kind; Clean Unused and Clean All (not in use)… (after its confirmation) never remove
// what the open project uses; the automatic-cleaning settings save through the engine (the size-limit dropdown
// opens above the dialog).

import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { createProject, enableAgentBridge, importFiles, ROOT, watchPage } from './support.ts';

test.describe.configure({ mode: 'serial' });

let page: Page;
let errors: string[];

type Usage = { kinds: { kind: string; entries: number; bytes: number; inUseBytes: number }[] };

async function usage(): Promise<Usage> {
	return (await page.request.get('/api/cache')).json();
}

const kind = (u: Usage, k: string) => u.kinds.find((x) => x.kind === k)!;

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
	errors = watchPage(page).errors;
});

test.afterAll(async () => {
	await page.request.put('/api/cache/settings', {
		data: { autoClean: true, maxTotalBytes: null, maxAgeDays: 30, kinds: {} },
	});
	await page?.close();
});

test('the Media Cache page shows the cache of the open project and cleaning keeps what it uses', async () => {
	await createProject(page, 'E2E Media Cache');
	await importFiles(page, ['clip-a.mp4']);
	// Waveform peaks, poster, filmstrip and keyframe index of the import are cache entries.
	await expect
		.poll(async () => kind(await usage(), 'media-cache').entries, { timeout: 120_000 })
		.toBeGreaterThanOrEqual(3);

	await page.getByTestId('title-bar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
	await page.getByRole('menuitem', { name: /^Preferences$/ }).hover();
	await page.getByRole('menuitem', { name: /^Media Cache…/ }).click();
	const prefs = page.getByTestId('preferences-dialog');
	await expect(prefs.getByTestId('prefs-cache')).toBeVisible();
	await expect(prefs.getByTestId('prefs-page-media-cache')).toHaveAttribute('aria-current', 'page');
	await expect(prefs.getByTestId('cache-table').getByRole('row')).toHaveCount(11);
	await expect
		.poll(async () => Number(await prefs.getByTestId('cache-kind-media-cache-entries').textContent()))
		.toBeGreaterThanOrEqual(3);
	await expect(prefs.getByTestId('cache-total')).toContainText('(automatic limit)');
	await page.screenshot({ path: join(ROOT, 'test-results', 'media-cache-page.png') });

	// Clean Unused: the open project's files stay.
	const before = kind(await usage(), 'media-cache').bytes;
	await prefs.getByTestId('cache-clean-unused').click();
	await expect(prefs.getByTestId('cache-status')).toContainText('Clean Unused: removed');
	expect(kind(await usage(), 'media-cache').bytes).toBeGreaterThanOrEqual(before);

	// Clean All asks first; confirmed, it still keeps what the open project uses.
	await prefs.getByTestId('cache-clean-all').click();
	const confirm = page.getByTestId('confirm-dialog');
	await expect(confirm).toBeVisible();
	await confirm.getByRole('button', { name: 'Cancel' }).click();
	await expect(confirm).toBeHidden();
	await prefs.getByTestId('cache-clean-all').click();
	await page.getByTestId('confirm-dialog').getByRole('button', { name: 'Clean All' }).click();
	await expect(prefs.getByTestId('cache-status')).toContainText('Clean All: removed');
	const after = kind(await usage(), 'media-cache');
	expect(after.bytes).toBeGreaterThanOrEqual(before);
	expect(after.inUseBytes).toBe(after.bytes);
	await expect(prefs.getByTestId('cache-last-gc')).toContainText('Clean All');
});

test('automatic cleaning settings: custom size limit and a per-kind limit are saved by the engine', async () => {
	const prefs = page.getByTestId('preferences-dialog');
	await prefs.getByRole('combobox', { name: 'Cache size limit' }).click();
	// The dropdown opens above the dialog (not behind its scrim).
	await page.getByRole('option', { name: 'Custom' }).click();
	await prefs.getByTestId('cache-budget-gb').fill('50');
	await prefs.getByTestId('cache-max-age').fill('21');
	await prefs.getByTestId('cache-kind-proxies-max').fill('12');
	await prefs.getByTestId('cache-save').click();
	await expect(prefs.getByTestId('cache-status')).toHaveText('Settings saved');
	const saved = await (await page.request.get('/api/cache/settings')).json();
	expect(saved).toEqual({
		autoClean: true,
		maxTotalBytes: 50 * 1024 ** 3,
		maxAgeDays: 21,
		kinds: { proxies: { maxBytes: 12 * 1024 ** 3 } },
	});
	await expect(prefs.getByTestId('cache-total')).toContainText('of 50.0 GB');
	await prefs.getByTestId('cache-save').scrollIntoViewIfNeeded();
	await page.screenshot({ path: join(ROOT, 'test-results', 'media-cache-settings.png') });
	expect(errors).toEqual([]);
});
