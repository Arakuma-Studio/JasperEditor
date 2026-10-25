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
	await page.addInitScript(() => localStorage.setItem('jasper:agent-bridge', '1'));
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
	// The worker warms on-demand runtimes after load, preserving first use offline without evaluating them during
	// startup. This generated list includes their static dependencies as well as the format runtimes themselves.
	const optional = await page.evaluate(async () => {
		const source = await (await fetch('/editor-assets.js')).text();
		return JSON.parse(
			source
				.slice(source.indexOf('=') + 1)
				.trim()
				.replace(/;$/, ''),
		) as string[];
	});
	expect(optional.length).toBeGreaterThan(0);
	await expect
		.poll(() =>
			page.evaluate(
				async (urls) => (await Promise.all(urls.map((url) => caches.match(url)))).every(Boolean),
				optional,
			),
		)
		.toBe(true);
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
	await page.evaluate(async (urls) => {
		for (const url of urls) await import(url);
	}, optional);
	await page.waitForFunction(() => !!window.jasper);
	const clipId = await page.evaluate(async () => {
		const result = await window.jasper!.transact({
			protocol: 'jasper.tx/1',
			label: 'Offline expression',
			commands: [
				{ type: 'clip.addSolid', at: 0, duration: 150, track: 'V1', color: [0.9, 0.3, 0.1, 1], ref: '$c' },
				{ type: 'expression.set', target: ['clip', '$c', 'transform', 'rotation'], text: 'time * 90' },
			],
		});
		if (!result.ok) throw new Error(JSON.stringify(result.errors));
		return result.refs.$c!;
	});
	await expect
		.poll(() =>
			page.evaluate(async (id) => {
				const scene = (await window.jasper!.query('sequence.at', { frame: 30 })) as {
					video: { clipId: string; transform: { rotation: number } }[];
				};
				return scene.video.find((clip) => clip.clipId === id)?.transform.rotation;
			}, clipId),
		)
		.toBe(90.09);
	const screenshot = optional.find((url) => /\/vendor-screenshot-/.test(url));
	expect(screenshot).toBeTruthy();
	expect(
		await page.evaluate(async (url) => {
			const module = (await import(url)) as {
				domToPng(node: HTMLElement, options: { scale: number }): Promise<string>;
			};
			return (await module.domToPng(document.body, { scale: 0.25 })).startsWith('data:image/png;base64,');
		}, screenshot!),
	).toBe(true);
	expect(errors).toEqual([]);
});

test.afterEach(async ({ page }, testInfo) => {
	await testInfo.attach('editor', { body: await page.screenshot(), contentType: 'image/png' });
});
