import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { bundleForBrowser } from '../packages/testkit/src/browser.ts';
import { createProject, enableAgentBridge, query, ROOT } from './support.ts';

const FIXTURE_PROJECT = join(ROOT, 'fixtures', 'mg-project');

test.describe.configure({ mode: 'serial' });

let page: Page;
let protocolScript = '';

test.beforeAll(async ({ browser }) => {
	protocolScript = await bundleForBrowser(join(ROOT, 'packages/compositions/src/mg-host/remote.ts'), {
		globalName: 'MgHost',
	});
	page = await browser.newPage();
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	await page?.close();
});

test('renderer-page protocol contract (Remotion 4.0.499) drives the fixture bundle frame by frame', async ({
	browser,
	request,
}) => {
	test.setTimeout(600_000);
	const imported = await request.post('/api/mg-bundles/import', { data: { path: FIXTURE_PROJECT } });
	expect(imported.status(), await imported.text()).toBe(200);
	const reg = (await imported.json()) as { mediaKey: string; mgBundle: { compositions: { id: string }[] } };

	const probe = await browser.newPage(); // own context: the shared page's context refuses newPage()
	await probe.goto('/health');
	// The opaque-origin iframe is controlled through a MessagePort, as in the Composition layer.
	await probe.setContent(
		'<html><body style="margin:0;background:rgb(255,0,0)"><iframe id="h" sandbox="allow-scripts" style="border:0;width:1920px;height:1080px;color-scheme:light"></iframe></body></html>',
	);
	await probe.addScriptTag({ content: protocolScript });
	const r = await probe.evaluate(async (key) => {
		type Remote = {
			check(): Promise<{ ok: boolean; missing: string[]; remotionVersion: string; siteVersion: string }>;
			configure(
				c: unknown,
			): Promise<{ width: number; height: number; fps: number; durationInFrames: number }>;
			seek(id: string, f: number): Promise<void>;
		};
		const M = (window as unknown as { MgHost: { connectMgHost(f: HTMLIFrameElement): Promise<Remote> } })
			.MgHost;
		const f = document.getElementById('h') as HTMLIFrameElement;
		await new Promise((res) => {
			f.onload = res;
			f.src = `/mg/bundles/${encodeURIComponent(key)}/index.html?jasper-host=1`;
		});
		const d = await M.connectMgHost(f);
		const meta = await d.configure({
			compositionId: 'Title',
			props: { title: 'Contract', accent: '#00ff00', delay: 0 },
			override: { fps: 30, width: 1280, height: 720 },
		});
		await d.seek('Title', 45);
		(window as unknown as { __host: Remote }).__host = d;
		let reachable = true;
		try {
			reachable = !!f.contentDocument || 'remotion_setFrame' in (f.contentWindow as object);
		} catch {
			reachable = false;
		}
		return { check: await d.check(), meta, reachable };
	}, reg.mediaKey);
	const host = probe.frames().find((x) => x.url().includes('/mg/sandbox/'))!;
	expect(host, 'the host page lives under its capability path').toBeTruthy();
	const drawn = () =>
		host.evaluate(() => {
			const panel = document.querySelector('[data-testid="title-panel"]') as HTMLElement | null;
			const w = window as unknown as { remotion_renderReady?: boolean; parent: Window };
			let parentReachable = true;
			try {
				parentReachable = !!w.parent.document;
			} catch {
				parentReachable = false;
			}
			// What the page finds where storage and cookies would be: stand-ins of its own document (the bootstrap
			// installs them because the real ones throw in an opaque origin, and Remotion reads them at start-up).
			// biome-ignore lint/suspicious/noDocumentCookie: the point is what a plain cookie write does in the sandbox
			document.cookie = 'stolen=1';
			const cookies = document.cookie;
			window.localStorage.setItem('jasper-mg-probe', 'from-the-bundle');
			const storage = window.localStorage.getItem('jasper-mg-probe');
			return {
				ready: w.remotion_renderReady,
				text: document.querySelector('[data-testid="title-text"]')?.textContent,
				opacity: panel ? Number(getComputedStyle(panel).opacity) : -1,
				bodyBg: getComputedStyle(document.body).backgroundColor,
				origin: window.origin,
				parentReachable,
				cookies,
				storage,
			};
		});
	const at45 = await drawn();
	await probe.evaluate(() =>
		(window as unknown as { __host: { seek(id: string, f: number): Promise<void> } }).__host.seek('Title', 0),
	);
	const at0 = await drawn();
	// Frame positioning depends on Remotion's renderer-page protocol; the host agent must match it.
	expect(r.check).toEqual({ ok: true, missing: [], remotionVersion: '4.0.499', siteVersion: '11' });
	expect(r.meta).toMatchObject({ width: 1280, height: 720, fps: 30, durationInFrames: 90 });
	expect(at45.ready).toBe(true);
	expect(at45.text).toBe('Contract');
	expect(at45.opacity).toBeCloseTo(1, 5);
	expect(at0.opacity).toBe(0);
	expect(at45.bodyBg).toBe('rgba(0, 0, 0, 0)');
	expect(r.reachable).toBe(false);
	expect(at45.origin).toBe('null');
	expect(at45.parentReachable).toBe(false);
	expect(at45.cookies).toBe('');
	expect(at45.storage).toBe('from-the-bundle');
	expect(await probe.evaluate(() => window.localStorage.getItem('jasper-mg-probe'))).toBeNull();
	expect((await probe.context().cookies()).some((c) => c.name === 'stolen')).toBe(false);
	// The bundle's own code cannot use the engine's API: no session from an opaque origin, and the origin is refused.
	const api = await host.evaluate(async (origin) => {
		const out: Record<string, number | string> = {};
		for (const path of ['/api/projects', '/api/agent/schema', '/health'])
			try {
				out[path] = (await fetch(`${origin}${path}`, { credentials: 'include' })).status;
			} catch (e) {
				out[path] = `blocked: ${(e as Error).name}`;
			}
		return out;
	}, new URL(probe.url()).origin);
	for (const [path, status] of Object.entries(api))
		expect([path, String(status)]).toEqual([path, 'blocked: TypeError']);
	writeFileSync('test-results/e2e-mg-host-protocol.json', JSON.stringify({ ...r, at45, at0, api }, null, 2));
	await probe.close();
});

/** Text the live host page of the Program monitor shows (read inside the sandboxed frame). */
async function hostText(p: Page): Promise<string | null> {
	return p
		.frameLocator('[data-testid="program-monitor"] iframe[data-mg-host]')
		.locator('[data-testid="title-text"]')
		.first()
		.textContent({ timeout: 2000 })
		.catch(() => null);
}

test('import a Remotion project, insert a composition, live preview, props edit, preview WebM', async () => {
	test.setTimeout(900_000);
	await createProject(page, 'E2E Composition Clips');
	await page.getByRole('menuitem', { name: 'File' }).click();
	await page.getByRole('menuitem', { name: /Import Remotion Project/ }).click();
	const dialog = page.getByTestId('mg-import-dialog');
	await expect(dialog).toBeVisible();
	await page.getByTestId('mg-import-path').fill(FIXTURE_PROJECT);
	await page.getByTestId('mg-import-watch').uncheck();
	await dialog.getByRole('button', { name: 'Import Folder' }).click();
	await expect(dialog).toBeHidden({ timeout: 600_000 });
	await expect(page.getByTestId('project-row').filter({ hasText: 'fixture-mg-project' })).toBeVisible();

	await page.getByText('Motion Templates', { exact: true }).first().click();
	await page.getByRole('tab', { name: 'Remotion' }).click();
	const card = page.locator('[data-testid="remotion-tab"] [data-composition="Title"]');
	await expect(card).toBeVisible();
	await card.dblclick();
	await expect
		.poll(async () => {
			const s = await query<{ clips: { id: string; kind: string; start: number; end: number }[] }>(
				page,
				'sequence.clipsInRange',
				{ from: 0, to: 100000 },
			);
			return s.clips.find((c) => c.kind === 'composition') ?? null;
		})
		.not.toBeNull();
	const clip = (
		await query<{ clips: { id: string; kind: string; start: number; end: number }[] }>(
			page,
			'sequence.clipsInRange',
			{ from: 0, to: 100000 },
		)
	).clips.find((c) => c.kind === 'composition')!;
	expect(clip.end - clip.start).toBe(90);
	await query(page, 'playhead.set', { frame: clip.start + 45 });

	await expect.poll(() => hostText(page), { timeout: 60_000 }).toBe('Hello Jasper');
	await expect(page.getByTestId('composition-section')).toBeVisible();

	const field = page.getByTestId('text-title');
	await field.fill('Edited in Properties');
	// The moment the new title is on screen is observed inside the host page (the editor cannot see into the
	// sandboxed frame); both sides stamp wall-clock times (performance.timeOrigin + now).
	const hostFrame = page.frames().find((x) => x.url().includes('/mg/sandbox/'))!;
	expect(hostFrame, 'the live host is a sandboxed frame under its capability path').toBeTruthy();
	await hostFrame.evaluate(() => {
		const w = window as unknown as { __seenAt?: number };
		w.__seenAt = undefined;
		const check = () => {
			if (document.querySelector('[data-testid="title-text"]')?.textContent === 'Edited in Properties')
				w.__seenAt = performance.timeOrigin + performance.now();
			else requestAnimationFrame(check);
		};
		requestAnimationFrame(check);
	});
	await field.evaluate((input) => {
		input.addEventListener(
			'keydown',
			(event) => {
				if (event instanceof KeyboardEvent && event.key === 'Enter')
					(window as unknown as { __enterAt?: number }).__enterAt =
						performance.timeOrigin + performance.now();
			},
			{ capture: true, once: true },
		);
	});
	await field.press('Enter');
	await expect
		.poll(() => hostFrame.evaluate(() => (window as unknown as { __seenAt?: number }).__seenAt ?? null), {
			timeout: 5_000,
			intervals: [20],
		})
		.not.toBeNull();
	const elapsed =
		(await hostFrame.evaluate(() => (window as unknown as { __seenAt: number }).__seenAt)) -
		(await page.evaluate(() => (window as unknown as { __enterAt: number }).__enterAt));
	test.info().annotations.push({ type: 'live-title-latency', description: `${elapsed.toFixed(1)} ms` });
	expect(elapsed).toBeLessThan(500);
	await expect.poll(() => hostText(page), { timeout: 5_000, intervals: [20] }).toBe('Edited in Properties');

	await expect(page.getByTestId('composition-status')).toHaveText(/Preview ready/, { timeout: 300_000 });

	await page.screenshot({ path: 'test-results/e2e-composition-preview.png' });
});
