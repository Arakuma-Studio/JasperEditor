// Edit ▸ Preferences ▸ Media Cache (M3, S04:CA-013/CA-014, wp-m3-cachegc): with a project open and media imported,
// the page lists the cache per kind; Clean Unused and Clean All (not in use)… (after its confirmation) never remove
// what the open project uses; the automatic-cleaning settings save through the engine (the size-limit dropdown
// opens above the dialog).

import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { createProject, enableAgentBridge, importFiles, ROOT, serverInfo } from './support.ts';

test.describe.configure({ mode: 'serial' });

let page: Page;

type Usage = { kinds: { kind: string; entries: number; bytes: number; inUseBytes: number }[] };

async function usage(): Promise<Usage> {
	return (await page.request.get('/api/cache')).json();
}

const kind = (u: Usage, k: string) => u.kinds.find((x) => x.kind === k)!;

/** Relative paths and sizes of every file under `dir` (sorted). */
function listTree(dir: string, prefix = ''): string[] {
	const out: string[] = [];
	for (const n of readdirSync(dir).sort()) {
		const p = join(dir, n);
		if (statSync(p).isDirectory()) out.push(...listTree(p, `${prefix}${n}/`));
		else out.push(`${prefix}${n} ${statSync(p).size}`);
	}
	return out;
}

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
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
	// The open project's media cache files (waveform peaks, poster, filmstrip, keyframe index) live under
	// `cache/<fingerprint>/`. The engine is shared by every spec: other (closed) projects' files are in the usage too,
	// and Clean All may legitimately remove them — so this spec measures its own project's files.
	const fp = await page.evaluate(() => {
		const doc = (window as unknown as { jasper: { query(n: string): Promise<unknown> } }).jasper;
		return doc.query('doc.get').then((d) => {
			const m = Object.values(
				(d as { media: Record<string, { originalName: string; fingerprint: string }> }).media,
			);
			return m.find((x) => x.originalName === 'clip-a.mp4')!.fingerprint;
		});
	});
	const own = join(serverInfo().appdir, 'cache', fp.replace(/^q1:/, ''));
	const ownFiles = () => (existsSync(own) ? listTree(own) : []);
	await expect
		.poll(() => ownFiles().filter((f) => /^(poster|keyframes|peaks|sprite)-/.test(f)).length, {
			timeout: 120_000,
		})
		.toBeGreaterThanOrEqual(4);

	await page.getByTestId('title-bar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
	await page.getByRole('menuitem', { name: /^Preferences$/ }).hover();
	await page.getByRole('menuitem', { name: /^Media Cache…/ }).click();
	const prefs = page.getByTestId('preferences-dialog');
	await expect(prefs.getByTestId('prefs-cache')).toBeVisible();
	await expect(prefs.getByTestId('prefs-page-media-cache')).toHaveAttribute('aria-current', 'page');
	await expect
		.poll(async () => Number(await prefs.getByTestId('cache-kind-media-cache-entries').textContent()))
		.toBeGreaterThanOrEqual(3);
	await page.screenshot({ path: join(ROOT, 'test-results', 'media-cache-page.png') });

	// Clean Unused: the open project's files stay.
	const before = ownFiles();
	await prefs.getByTestId('cache-clean-unused').click();
	await expect(prefs.getByTestId('cache-status')).toContainText('Clean Unused: removed');
	expect(ownFiles()).toEqual(before);

	// Clean All asks first; confirmed, it still keeps what the open project uses.
	await prefs.getByTestId('cache-clean-all').click();
	const confirm = page.getByTestId('confirm-dialog');
	await expect(confirm).toBeVisible();
	await confirm.getByRole('button', { name: 'Cancel' }).click();
	await expect(confirm).toBeHidden();
	await prefs.getByTestId('cache-clean-all').click();
	await page.getByTestId('confirm-dialog').getByRole('button', { name: 'Clean All' }).click();
	await expect(prefs.getByTestId('cache-status')).toContainText('Clean All: removed');
	expect(ownFiles()).toEqual(before);
	// Whatever is left of the media cache is in use (open project, recent files of other specs).
	const after = kind(await usage(), 'media-cache');
	expect(after.inUseBytes).toBe(after.bytes);
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
	expect(saved).toMatchObject({
		autoClean: true,
		maxTotalBytes: 50 * 1024 ** 3,
		maxAgeDays: 21,
		kinds: { proxies: { maxBytes: 12 * 1024 ** 3 } },
	});
	await prefs.getByTestId('cache-save').scrollIntoViewIfNeeded();
	await page.screenshot({ path: join(ROOT, 'test-results', 'media-cache-settings.png') });
	// Exports never expire; logs keep 14 days.
	await prefs.getByTestId('cache-kind-exports-days').fill('never');
	await prefs.getByTestId('cache-logs-days').fill('14');
	await prefs.getByTestId('cache-save').click();
	await expect(prefs.getByTestId('cache-status')).toHaveText('Settings saved');
	const s2 = await (await page.request.get('/api/cache/settings')).json();
	expect(s2.kinds.exports).toEqual({ maxAgeDays: null });
	expect(s2.logs.maxAgeDays).toBe(14);
});

test('Change… moves the cache to another folder and back (CA-021)', async () => {
	const prefs = page.getByTestId('preferences-dialog');
	const dest = mkdtempSync(join(tmpdir(), 'jasper-e2e-cache-'));
	const before = (await (await page.request.get('/api/cache')).json()) as { location: string };
	await prefs.getByTestId('cache-location-change').scrollIntoViewIfNeeded();
	await prefs.getByTestId('cache-location-change').click();
	await prefs.getByTestId('cache-location-path').fill(dest);
	await prefs.getByTestId('cache-location-check').click();
	await expect(prefs.getByTestId('cache-location-result')).toContainText('free');
	await page.screenshot({ path: join(ROOT, 'test-results', 'media-cache-location.png') });
	await prefs.getByTestId('cache-location-move').click();
	await expect(prefs.getByTestId('cache-status')).toHaveText('The media cache location changed', {
		timeout: 120_000,
	});
	const target = join(dest, 'JasperEditor Media Cache');
	await expect(prefs.getByTestId('cache-location')).toHaveText(target);
	expect(readdirSync(join(target, 'cache')).length).toBeGreaterThan(0); // the imported media's cache moved along
	// The editor keeps working: the media's poster is served through the new location.
	await expect.poll(async () => kind(await usage(), 'media-cache').entries).toBeGreaterThanOrEqual(3);
	// Back to the default location.
	await prefs.getByTestId('cache-location-change').click();
	await prefs.getByTestId('cache-location-default').click();
	await expect(prefs.getByTestId('cache-location')).toHaveText(before.location, { timeout: 120_000 });
	expect(existsSync(join(target, 'cache'))).toBe(false);
});
