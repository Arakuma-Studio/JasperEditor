import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

import {
	appliedLabels,
	createProject,
	enableAgentBridge,
	FIXTURES,
	importFiles,
	query,
	ROOT,
	serverInfo,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const SHOTS = join(ROOT, 'test-results', 'polish');
mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) });

let page: Page;
let projectId = '';

/** Live-UI automation of this window through the engine (the path agents use, POST /api/agent/ui). */
async function ui<T = unknown>(action: string, args: Record<string, unknown> = {}): Promise<T> {
	const { port } = serverInfo();
	const r = await page.request.post(`http://127.0.0.1:${port}/api/agent/ui`, {
		data: { projectId, action, args },
	});
	const body = await r.json();
	expect(r.ok(), `${action} ${JSON.stringify(args)}: ${JSON.stringify(body)}`).toBe(true);
	return body.result as T;
}
const runCommand = (id: string, args?: unknown) => ui('command', { id, ...(args ? { args } : {}) });

test.beforeAll(async ({ browser }) => {
	const context = await browser.newContext();
	page = await context.newPage();
	await enableAgentBridge(page);
	projectId = await createProject(page, 'E2E polish');
	await importFiles(page, ['clip-a.mp4']);
});

test.afterAll(async () => {
	await page?.context().close();
});

test('Media Browser: browse the fixtures folder, preview a clip, import it in place', async () => {
	await page.keyboard.press('Escape');
	await runCommand('panel.focus.mediaBrowser');
	const panel = page.getByTestId('media-browser');
	await expect(panel).toBeVisible();
	const path = page.getByTestId('media-browser-path');
	await path.fill(FIXTURES);
	await path.press('Enter');
	const entry = (name: string) => page.getByTestId('media-browser-entry').filter({ hasText: name });
	await expect(entry('clip-b.mp4')).toBeVisible();

	await entry('clip-b.mp4').click();
	const video = page.getByTestId('media-browser-video');
	await expect(video).toBeVisible();
	await expect
		.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 1 && v.videoWidth), {
			timeout: 20_000,
		})
		.toBe(1280);
	await shot(page, 'media-browser-list');

	await entry('clip-b.mp4').click();
	await runCommand('project.importFromMediaBrowser');
	await runCommand('panel.focus.project');
	await expect(page.getByTestId('project-row').filter({ hasText: 'clip-b.mp4' })).toBeVisible({
		timeout: 60_000,
	});
	const media = (await query<{ media: { originalName: string }[] }>(page, 'media.list')).media;
	expect(media.map((m) => m.originalName).sort()).toEqual(['clip-a.mp4', 'clip-b.mp4']);
});

async function switchLanguageLive(label: 'English' | 'Español') {
	await runCommand('app.preferences', { page: 'appearance' });
	const dialog = page.getByTestId('preferences-dialog');
	await expect(dialog).toBeVisible();
	await dialog.getByRole('combobox', { name: /^(Language|Idioma)$/ }).click();
	await page.getByRole('option', { name: label }).click();
	await expect(page.locator('html')).toHaveAttribute('lang', label === 'Español' ? 'es' : 'en');
	await expect(dialog).toBeVisible();
	await expect(dialog.getByTestId('prefs-page-appearance')).toHaveAttribute('aria-current', 'page');
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(page.getByTestId('editor-shell')).toBeVisible();
	await expect(page.getByTestId('timeline-track-area')).toBeVisible();
}

test('live language switches preserve the page, document and undo history', async () => {
	const placed = await transact(page, [{ type: 'marker.add', frame: 30, name: 'Language marker' }]);
	expect(placed.ok, JSON.stringify(placed)).toBe(true);
	const historyBefore = await appliedLabels(page);
	const markers = async () => {
		const doc = await query<{ sequences: Record<string, { markers: { name: string }[] }> }>(page, 'doc.get');
		return Object.values(doc.sequences).flatMap((seq) => seq.markers.map((marker) => marker.name));
	};
	expect(await markers()).toContain('Language marker');
	const loadedAt = await page.evaluate(() => performance.timeOrigin);

	for (const language of ['Español', 'English'] as const) {
		await switchLanguageLive(language);
		expect(await page.evaluate(() => performance.timeOrigin)).toBe(loadedAt);
		expect(await appliedLabels(page)).toEqual(historyBefore);
		await runCommand('history.undo');
		expect(await markers()).not.toContain('Language marker');
		await runCommand('history.redo');
		expect(await markers()).toContain('Language marker');
		await shot(page, language === 'Español' ? 'spanish-live' : 'english-live');
	}
});

test('a bundle that cannot be downloaded says so and reloads, instead of a blank page', async ({
	browser,
}) => {
	// Request interception must bypass the service worker to exercise a failed download of a static import.
	const context = await browser.newContext({ serviceWorkers: 'block' });
	const p = await context.newPage();
	try {
		await p.route('**/assets/*.js', (route) => route.abort('internetdisconnected'));
		await p.goto(`http://127.0.0.1:${serverInfo().port}/`);
		const failed = p.getByTestId('app-load-error');
		await expect(failed).toBeVisible({ timeout: 60_000 });
		await shot(p, 'app-load-error');
		await p.unroute('**/assets/*.js');
		await failed.getByRole('button', { name: 'Reload' }).click();
		await expect(p.getByTestId('home')).toBeVisible();
		await expect(failed).toHaveCount(0);
	} finally {
		await context.close();
	}
});
