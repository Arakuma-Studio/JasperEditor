import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { BOOT_RETRIES } from '../apps/web/editor-boot.ts';
import { budgetMs, budgetReport } from '../scripts/perf/budget.ts';
import { measureOpen } from '../scripts/perf/open-phases.ts';
import { cachedFixture } from '../scripts/perf/ui-run.ts';
import { uploadProject } from '../scripts/perf/ui-scenarios.ts';
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

const openMenu = (id: string) => page.locator(`[data-menu-id="${id}"]`).click();

test.beforeAll(async ({ browser }) => {
	const context = await browser.newContext();
	page = await context.newPage();
	await enableAgentBridge(page);
	projectId = await createProject(page, 'E2E polish');
	await importFiles(page, ['clip-a.mp4']);
});

test.afterAll(async () => {
	await page?.close();
});

test('the menu entries that used to be disabled are wired', async () => {
	await openMenu('file');
	const fromBrowser = page.getByRole('menuitem', { name: /^Import from Media Browser/ });
	await expect(fromBrowser).toBeVisible();
	await expect(fromBrowser).not.toHaveAttribute('aria-disabled', 'true');
	await page.getByRole('menuitem', { name: 'Engine' }).hover();
	const status = page.getByRole('menuitem', { name: /^Engine Status/ });
	await expect(status).not.toHaveAttribute('aria-disabled', 'true');
	await status.click();

	const dialog = page.getByTestId('engine-status-dialog');
	await expect(dialog).toBeVisible();
	await expect(page.getByTestId('engine-status-state')).toHaveText('Connected');
	await expect(page.getByTestId('engine-status-media')).toContainText('FFmpeg');
	await expect(page.getByTestId('engine-status-render')).toContainText('Native export');
	await shot(page, 'engine-status');
	await dialog.getByRole('button', { name: 'Close' }).first().click();
	await expect(dialog).toBeHidden();

	await runCommand('engine.connect');
	const connect = page.getByTestId('engine-connect-dialog');
	await expect(connect).toBeVisible();
	const { port } = serverInfo();
	await expect(page.getByTestId('engine-connect-address')).toHaveValue(`http://127.0.0.1:${port}`);
	await connect.getByRole('button', { name: 'Reconnect' }).click();
	await expect(page.getByTestId('engine-connect-result')).toContainText('Connected to engine');
	await shot(page, 'engine-connect');
	await connect.getByRole('button', { name: 'Close' }).first().click();

	await page.getByTestId('project-row').filter({ hasText: 'clip-a.mp4' }).click();
	await openMenu('file');
	await page.getByRole('menuitem', { name: /^Get Properties for Selection/ }).click();
	const properties = page.getByTestId('media-properties-dialog');
	await expect(properties).toBeVisible();
	await expect(properties.getByTestId('media-properties')).toContainText('1920 × 1080');
	await expect(properties.getByTestId('media-properties')).toContainText('File Path');
	await expect(properties.getByTestId('media-properties')).toContainText('Total Duration');
	await shot(page, 'media-properties');
	await properties.getByRole('button', { name: 'Close' }).first().click();
	await expect(properties).toBeHidden();

	await openMenu('help');
	await page.getByRole('menuitem', { name: 'Third-Party Notices' }).click();
	const notices = page.getByTestId('notices-dialog');
	await expect(notices).toBeVisible();
	await expect(notices.getByTestId('licenses')).toBeVisible();
	await expect(notices.getByTestId('third-party-notices-text')).toContainText('MIT', { timeout: 20_000 });
	await shot(page, 'notices');
	await notices.getByRole('button', { name: 'Close' }).first().click();
});

test('Media Browser: browse the fixtures folder, preview a clip, import it in place', async () => {
	await page.keyboard.press('Escape');
	await runCommand('panel.focus.mediaBrowser');
	const panel = page.getByTestId('media-browser');
	await expect(panel).toBeVisible();
	await expect(panel.getByRole('combobox', { name: 'Places' })).toBeVisible();
	const path = page.getByTestId('media-browser-path');
	await path.fill(FIXTURES);
	await path.press('Enter');
	const entry = (name: string) => page.getByTestId('media-browser-entry').filter({ hasText: name });
	await expect(entry('clip-b.mp4')).toBeVisible();
	await expect(entry('tone.wav')).toBeVisible();
	await expect(entry('plate-planar.json')).toHaveCount(0);

	await entry('clip-b.mp4').click();
	const facts = page.getByTestId('media-browser-facts');
	await expect(facts).toContainText('1280 × 720');
	await expect(facts).toContainText('h264');
	const video = page.getByTestId('media-browser-video');
	await expect(video).toBeVisible();
	await expect
		.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 1 && v.videoWidth), {
			timeout: 20_000,
		})
		.toBe(1280);
	await shot(page, 'media-browser-list');

	await panel.getByRole('button', { name: 'Thumbnail View' }).click();
	const thumb = entry('clip-b.mp4').locator('img');
	await expect
		.poll(() => thumb.evaluate((i: HTMLImageElement) => i.naturalWidth), { timeout: 30_000 })
		.toBeGreaterThan(0);
	await shot(page, 'media-browser-thumbnails');
	await panel.getByRole('button', { name: 'List View' }).click();

	await entry('clip-b.mp4').click();
	await runCommand('project.importFromMediaBrowser');
	await runCommand('panel.focus.project');
	await expect(page.getByTestId('project-row').filter({ hasText: 'clip-b.mp4' })).toBeVisible({
		timeout: 60_000,
	});
	const media = (await query<{ media: { originalName: string }[] }>(page, 'media.list')).media;
	expect(media.map((m) => m.originalName).sort()).toEqual(['clip-a.mp4', 'clip-b.mp4']);
	expect(await appliedLabels(page)).toContain('Import 1 file');
});

test('Clip ▸ Motion Graphic ▸ Edit Parameters shows the template parameters of the selected clip', async () => {
	const r = await transact(page, [
		{
			type: 'clip.addMotionGraphic',
			template: { id: 'lower-third', version: 1 },
			at: 0,
			duration: 90,
			track: 'V2',
			ref: '$mg',
		},
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	const mg = (
		await query<{ clips: { id: string; kind: string }[] }>(page, 'sequence.clipsInRange', { from: 0, to: 10 })
	).clips.find((c) => c.kind === 'motion-graphic')!;
	await runCommand('panel.focus.timeline');
	await ui('click', { timeline: { clipId: mg.id } });
	await openMenu('clip');
	await page.getByRole('menuitem', { name: 'Motion Graphic' }).hover();
	const edit = page.getByRole('menuitem', { name: /^Edit Parameters/ });
	await expect(edit).not.toHaveAttribute('aria-disabled', 'true');
	await edit.click();
	const section = page.locator('[data-section="properties.template"]');
	await expect(section).toBeVisible();
	await expect(section).toContainText('Parameters');
	await shot(page, 'edit-parameters');
});

const es = JSON.parse(readFileSync(join(ROOT, 'apps/web/src/i18n/es.json'), 'utf8')) as Record<
	string,
	string
>;
/** English strings that have another Spanish text: seen in the DOM while the UI is Spanish, they were left behind. */
const ENGLISH = Object.keys(es).filter((k) => es[k] !== k && !k.includes('{0}'));
/** Spanish texts that are not also an English string: seen while the UI is English, they were left behind. */
const SPANISH = [...new Set(Object.values(es))].filter((v) => !Object.hasOwn(es, v) && !v.includes('{0}'));

/**
 * The strings of `dict` shown anywhere in the document (text nodes and tooltips / labels), user names excluded, each
 * with where it was seen (for the failure message).
 */
async function shown(dict: string[]): Promise<[string, string][]> {
	return page.evaluate((list) => {
		const set = new Set(list);
		const out = new Map<string, string>();
		const skip = (el: Element | null) =>
			!!el?.closest(
				'[data-no-i18n],[contenteditable=""],[contenteditable="true"],textarea,code,pre,script,style',
			);
		const where = (el: Element | null, how: string) => {
			const host = el?.closest('[data-testid]');
			const html = (el?.cloneNode(false) as Element | undefined)?.outerHTML.slice(0, 160) ?? '?';
			return `${how} in ${html} under ${host?.getAttribute('data-testid') ?? 'body'}`;
		};
		const check = (s: string | null, el: Element | null, how: string) => {
			const k = (s ?? '').trim();
			if (k && set.has(k) && !out.has(k)) out.set(k, where(el, how));
		};
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			if (n.nodeType === Node.TEXT_NODE) {
				if (!skip(n.parentElement)) check((n as Text).data, n.parentElement, 'text');
			} else if (!skip(n as Element))
				for (const a of ['title', 'aria-label', 'placeholder'])
					check((n as Element).getAttribute(a), n as Element, a);
		}
		return [...out];
	}, dict);
}

/** Walks the workspaces, the menus, the palette and Preferences, collecting the strings of `dict` on screen. */
async function tour(dict: string[]): Promise<Map<string, string>> {
	const found = new Map<string, string>();
	const collect = async (state: string) => {
		for (const [s, where] of await shown(dict)) if (!found.has(s)) found.set(s, `${where} (${state})`);
	};
	for (const ws of ['editing', 'color', 'audio', 'effects', 'motion', 'captions']) {
		await page.keyboard.press('Escape');
		await runCommand('workspace.switch', { id: ws });
		await page.waitForTimeout(700);
		await collect(`workspace ${ws}`);
	}
	await runCommand('workspace.switch', { id: 'editing' });
	for (const kind of [
		'effectControls',
		'properties',
		'history',
		'mediaBrowser',
		'essentialGraphics',
		'effects',
	]) {
		await runCommand(`panel.focus.${kind}`);
		await page.waitForTimeout(300);
		await collect(`panel ${kind}`);
	}
	for (const menu of ['file', 'edit', 'clip', 'sequence', 'markers', 'graphics', 'view', 'window', 'help']) {
		const trigger = page.locator(`[data-menu-id="${menu}"]`);
		if (!(await trigger.count())) continue;
		await trigger.click();
		await page.waitForTimeout(150);
		await collect(`menu ${menu}`);
		await page.keyboard.press('Escape');
	}
	await runCommand('palette.open');
	await page.waitForTimeout(300);
	await collect('palette');
	await page.keyboard.press('Escape');
	await runCommand('app.preferences', { page: 'appearance' });
	await expect(page.getByTestId('preferences-dialog')).toBeVisible();
	await collect('preferences');
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('preferences-dialog')).toBeHidden();
	return found;
}

/** What `live` shows that `reference` (the same tour after a reload) does not. */
const leftBehind = (live: Map<string, string>, reference: Map<string, string>) =>
	[...live].filter(([s]) => !reference.has(s)).map(([s, where]) => `“${s}” — ${where}`);

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

test('the language switches live in both directions: nothing is reloaded, undo survives, no string is left behind', async () => {
	test.setTimeout(600_000);
	// A clip with an effect, selected: Effect Controls shows names from the model (and labels built from them).
	const media = (await query<{ media: { mediaId: string; originalName: string }[] }>(page, 'media.list'))
		.media;
	const a = media.find((m) => m.originalName === 'clip-a.mp4')!.mediaId;
	const placed = await transact(page, [
		{ type: 'clip.place', source: { mediaId: a }, at: 120, tracks: { video: 'V1', audio: 'A1' }, ref: '$c' },
		{ type: 'marker.add', frame: 30, name: 'Language marker' },
	]);
	expect(placed.ok, JSON.stringify(placed)).toBe(true);
	const clip = (
		await query<{ clips: { id: string; kind: string }[] }>(page, 'sequence.clipsInRange', {
			from: 120,
			to: 121,
		})
	).clips.find((c) => c.kind === 'video')!;
	expect(
		(
			await transact(page, [
				{ type: 'effect.add', target: { clipId: clip.id }, effectId: 'jasper.gaussian-blur' },
			])
		).ok,
	).toBe(true);
	await runCommand('panel.focus.timeline');
	await ui('click', { timeline: { clipId: clip.id } });
	// Media analysis done: its transient status lines would differ between the tours.
	await expect
		.poll(async () => (await (await page.request.get('/api/jobs?active=1')).json()).jobs.length, {
			timeout: 120_000,
		})
		.toBe(0);
	const historyBefore = await appliedLabels(page);
	expect(historyBefore.length).toBeGreaterThan(2);
	await page.evaluate(() => {
		(window as unknown as { __polishNoReload?: boolean }).__polishNoReload = true;
	});

	await switchLanguageLive('Español');
	expect(
		await page.evaluate(() => (window as unknown as { __polishNoReload?: boolean }).__polishNoReload),
	).toBe(true);
	await expect(page.locator('[data-menu-id="file"]')).toHaveText('Archivo');
	expect(await appliedLabels(page)).toEqual(historyBefore);
	const liveEs = await tour(ENGLISH);
	await runCommand('panel.focus.effectControls');
	await expect(page.getByTestId('editor-shell')).toContainText('Desenfoque gaussiano');
	await shot(page, 'spanish-live');
	await runCommand('history.undo');
	expect((await appliedLabels(page)).length).toBe(historyBefore.length - 1);
	await runCommand('history.redo');
	expect(await appliedLabels(page)).toEqual(historyBefore);

	// What a reload in Spanish shows is the reference: live must not leave more English behind.
	await page.reload();
	await expect(page.getByTestId('editor-shell')).toBeVisible();
	await expect(page.getByTestId('banner-read-only')).toHaveCount(0);
	await expect(page.locator('html')).toHaveAttribute('lang', 'es');
	const reloadEs = await tour(ENGLISH);
	expect(leftBehind(liveEs, reloadEs), 'left in English after the live switch').toEqual([]);

	await switchLanguageLive('English');
	await expect(page.locator('[data-menu-id="file"]')).toHaveText('File');
	const liveEn = await tour(SPANISH);
	await shot(page, 'english-live');
	await page.reload();
	await expect(page.getByTestId('editor-shell')).toBeVisible();
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
	const reloadEn = await tour(SPANISH);
	expect(leftBehind(liveEn, reloadEn), 'left in Spanish after the live switch').toEqual([]);
	// (one- to three-letter texts are key names and units: "O" is both a shortcut and the Spanish "or")
	expect(
		leftBehind(reloadEn, new Map()).filter((line) => !/^“.{1,3}”/.test(line)),
		'Spanish shown by an English page',
	).toEqual([]);
});

test('a 2 000-item project opens with two media status requests, a windowed bin and within the budget', async ({
	browser,
}) => {
	test.setTimeout(300_000);
	const base = `http://127.0.0.1:${serverInfo().port}`;
	const id = await uploadProject(base, await cachedFixture('items:2000'));
	// Three cold opens; the median is compared with the documented budget (2 s), scaled by the host load like every
	// timing budget (the browser is another process: `parallel`). PERF=1 enforces it exactly.
	const runs = [];
	for (let i = 0; i < 3; i++)
		runs.push(await measureOpen(browser, base, id, 'items:2000', { trace: i === 0 }));
	const first = runs[0]!;
	// Media resolution batches contain at most 1 000 items.
	expect(first.requests['media status'] ?? 0).toBe(0);
	expect(first.requests['media status (batch)']).toBe(2);
	const median = [...runs].sort((a, b) => a.media - b.media)[1]!;
	console.info(
		budgetReport('open 2 000 items (interactive, every medium resolved)', median.media, 2000, {
			parallel: true,
		}),
		`· runs ${runs.map((r) => r.media).join(' / ')} ms · main thread ${JSON.stringify(first.work)}`,
	);
	expect(median.media).toBeLessThanOrEqual(budgetMs(2000, { parallel: true }));

	const p = await browser.newPage({ viewport: { width: 1600, height: 960 } });
	let most = 0;
	await p.addInitScript(() => {
		const w = window as unknown as { __rows: number };
		w.__rows = 0;
		new MutationObserver(() => {
			w.__rows = Math.max(w.__rows, document.querySelectorAll('[data-testid="project-row"]').length);
		}).observe(document, { subtree: true, childList: true });
	});
	await p.goto(`${base}/project/${id}`);
	await expect(p.getByTestId('project-count')).toHaveText(/2[\s,.]?0\d\d items/);
	most = await p.evaluate(() => (window as unknown as { __rows: number }).__rows);
	expect(most).toBeGreaterThan(5);
	expect(most).toBeLessThan(200);
	await p.close();
});

test('a bundle that cannot be downloaded says so and reloads, instead of a blank page', async ({
	browser,
}) => {
	// Request interception must bypass the service worker to exercise a failed download of a static import.
	const context = await browser.newContext({ serviceWorkers: 'block' });
	const p = await context.newPage();
	try {
		await p.route('**/assets/vendor-react-*.js', (route) => route.abort('internetdisconnected'));
		let loads = 0;
		p.on('load', () => loads++);
		await p.goto(`http://127.0.0.1:${serverInfo().port}/`);
		const failed = p.getByTestId('app-load-error');
		// The page first reloads itself (a transient abort is the common cause; apps/web/editor-boot.ts): at least
		// BOOT_RETRIES (3) times, more when the machine is slow enough for the failures to count as cut-off loads.
		await expect(failed).toBeVisible({ timeout: 60_000 });
		expect(loads).toBeGreaterThanOrEqual(1 + BOOT_RETRIES);
		await expect(failed).toContainText('JasperEditor could not load');
		await shot(p, 'app-load-error');
		await p.unroute('**/assets/vendor-react-*.js');
		await failed.getByRole('button', { name: 'Reload' }).click();
		await expect(p.getByTestId('home')).toBeVisible();
		await expect(failed).toHaveCount(0);
	} finally {
		await context.close();
	}
});
