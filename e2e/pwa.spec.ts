// PWA checks on the production build served by the engine (ARCHITECTURE §12, §15 item 12, S05 §20):
// the manifest is linked, valid and installable-shaped; every icon exists with its declared size; the
// service worker registers, activates and controls the reloaded page.

import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

type ManifestIcon = { src: string; sizes: string; type: string; purpose?: string };

test('manifest.webmanifest is linked, valid and its icons exist with the declared sizes', async ({
	request,
	page,
}) => {
	await page.goto('/');
	await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
	const res = await request.get('/manifest.webmanifest');
	expect(res.status()).toBe(200);
	expect(res.headers()['content-type']).toMatch(/application\/manifest\+json|application\/json/);
	const m = (await res.json()) as {
		name: string;
		short_name: string;
		start_url: string;
		scope: string;
		display: string;
		display_override?: string[];
		background_color: string;
		theme_color: string;
		icons: ManifestIcon[];
		file_handlers?: { action: string; accept: Record<string, string[]> }[];
	};
	expect(m).toMatchObject({
		name: 'JasperEditor',
		start_url: '/',
		scope: '/',
		display: 'standalone',
	});
	expect(m.display_override).toContain('window-controls-overlay');
	expect(m.file_handlers?.[0]?.accept).toMatchObject({ 'application/x-jasper-project': ['.jasper'] });
	// Installability: 192 and 512 px "any" icons plus separate maskable ones.
	for (const [size, purpose] of [
		['192x192', 'any'],
		['512x512', 'any'],
		['192x192', 'maskable'],
		['512x512', 'maskable'],
	] as const) {
		expect(
			m.icons.some((i) => i.sizes === size && (i.purpose ?? 'any') === purpose),
			`${size} ${purpose}`,
		).toBe(true);
	}
	for (const icon of m.icons) {
		const r = await request.get(icon.src);
		expect(r.status(), icon.src).toBe(200);
		expect(r.headers()['content-type']).toBe('image/png');
		const png = await r.body();
		const [w, h] = icon.sizes.split('x').map(Number);
		expect([png.readUInt32BE(16), png.readUInt32BE(20)], icon.src).toEqual([w, h]);
	}
	writeFileSync('test-results/e2e-pwa-manifest.json', JSON.stringify(m, null, 2));
});

test('the production service worker registers, activates and controls the page', async ({
	page,
	request,
}) => {
	const sw = await request.get('/sw.js');
	expect(sw.status()).toBe(200);
	expect(sw.headers()['content-type']).toMatch(/javascript/);
	await page.goto('/');
	await expect(page.getByTestId('home')).toBeVisible();
	const scriptURL = await page.evaluate(async () => {
		const reg = await navigator.serviceWorker.ready;
		return reg.active?.scriptURL ?? null;
	});
	expect(scriptURL).toMatch(/\/sw\.js$/);
	// Reloading attaches the installed production worker to the page.
	await page.reload();
	await expect(page.getByTestId('home')).toBeVisible();
	await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
	const controller = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL);
	writeFileSync(
		'test-results/e2e-pwa-service-worker.json',
		JSON.stringify({ scriptURL, controller }, null, 2),
	);
});
