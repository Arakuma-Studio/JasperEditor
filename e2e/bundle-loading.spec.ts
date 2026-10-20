import { expect, test } from '@playwright/test';

test.describe('editor download recovery', () => {
	// Request interception must bypass service workers to exercise an actual failed chunk download.
	test.use({ serviceWorkers: 'block' });
	test('a failed editor download offers a reload', async ({ page }) => {
		await page.goto('/');
		await page.route('**/assets/*.js', (route) => route.abort());
		await page.getByRole('button', { name: 'Open demo project' }).click();
		await expect(page.getByTestId('editor-load-error')).toBeVisible();
		await page.unroute('**/assets/*.js');
		await page.getByRole('button', { name: 'Reload editor' }).click();
		await expect(page.getByTestId('editor-shell')).toBeVisible();
	});
});

test('visited editor reloads online and offline', async ({ page, context }) => {
	const scripts = new Set<string>();
	const errors: string[] = [];
	page.on('request', (request) => {
		if (request.resourceType() === 'script') scripts.add(request.url());
	});
	page.on('pageerror', (error) => errors.push(error.message));
	await page.goto('/');
	await expect(page.getByTestId('home')).toBeVisible();
	// Wait for the worker to control this page before fetching the editor so its chunks are cached.
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller) {
			await new Promise<void>((resolve) =>
				navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }),
			);
		}
	});
	await page.getByRole('button', { name: 'Open demo project' }).click();
	await expect(page.getByTestId('editor-shell')).toBeVisible();
	await page.reload();
	await expect(page.getByTestId('editor-shell')).toBeVisible();
	await expect(page.getByTestId('timeline-panel')).toBeVisible();
	// Runtime caching is asynchronous. Wait until every requested script is available offline.
	await expect
		.poll(() =>
			page.evaluate(
				async (urls) => (await Promise.all(urls.map((url) => caches.match(url)))).every(Boolean),
				[...scripts],
			),
		)
		.toBe(true);
	await context.setOffline(true);
	await page.reload();
	await expect(page.getByTestId('engine-unreachable')).toBeVisible();
	await page.getByRole('button', { name: 'Continue without engine' }).click();
	await expect(page.getByTestId('editor-shell')).toBeVisible();
	await expect(page.getByTestId('timeline-panel')).toBeVisible();
	expect(errors).toEqual([]);
});

test.afterEach(async ({ page }, testInfo) => {
	await testInfo.attach('editor', { body: await page.screenshot(), contentType: 'image/png' });
});
