// Motion-graphics composition clips (M2, S08 §8 test 4): the renderer-page protocol contract of the live frame
// host (fails loudly when a Remotion upgrade changes the page protocol, ARCHITECTURE D-19), then the UI flow:
// File ▸ Import Remotion Project… (fixtures/mg-project), Motion Templates ▸ Remotion, insert, live host frame in
// the Program monitor, a props edit in Properties visible within 500 ms, and the switch to the cached VP9-alpha
// preview after the props stay unchanged for 2 s.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { createProject, enableAgentBridge, query, ROOT } from './support.ts';

const FIXTURE_PROJECT = join(ROOT, 'fixtures', 'mg-project');

test.describe.configure({ mode: 'serial' });

let page: Page;
let protocolScript = '';

test.beforeAll(async ({ browser }) => {
	// The adapter under test, bundled for the browser (the same module the Composition layer uses).
	const esbuild = createRequire(join(ROOT, 'apps/engine/package.json'))('esbuild') as {
		build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
	};
	const out = await esbuild.build({
		entryPoints: [join(ROOT, 'packages/compositions/src/mg-host/remote.ts')],
		bundle: true,
		format: 'iife',
		globalName: 'MgHost',
		write: false,
		logLevel: 'silent',
	});
	protocolScript = out.outputFiles[0]!.text;
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
	expect(reg.mgBundle.compositions.map((c) => c.id).sort()).toEqual(['Badge', 'LowerThird', 'Title']);

	const probe = await browser.newPage(); // own context: the shared page's context refuses newPage()
	await probe.goto('/health');
	// Security review MG-1: the host page is a sandboxed iframe (opaque origin). The editor drives it through the
	// page's host agent over a MessagePort (`connectMgHost`), exactly as the Composition layer does.
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
		// The page is out of the editor's reach: neither its document nor its globals are readable from here.
		let reachable = true;
		try {
			reachable = !!f.contentDocument || 'remotion_setFrame' in (f.contentWindow as object);
		} catch {
			reachable = false;
		}
		return { check: await d.check(), meta, reachable };
	}, reg.mediaKey);
	// What the page drew, read inside the frame (Playwright attaches to it; the editor cannot).
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
			let cookies: string | null = null;
			let storage = true;
			try {
				cookies = document.cookie;
			} catch {
				cookies = null;
			}
			try {
				void window.localStorage;
			} catch {
				storage = false;
			}
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
	// If any of these fail after a Remotion upgrade, packages/compositions/src/mg-host/agent.ts must follow.
	expect(r.check).toEqual({ ok: true, missing: [], remotionVersion: '4.0.499', siteVersion: '11' });
	expect(r.meta).toMatchObject({ width: 1280, height: 720, fps: 30, durationInFrames: 90 });
	expect(at45.ready).toBe(true);
	expect(at45.text).toBe('Contract');
	expect(at45.opacity).toBeCloseTo(1, 5); // frame 45: the panel has entered
	expect(at0.opacity).toBe(0); // frame 0: not yet
	expect(at45.bodyBg).toBe('rgba(0, 0, 0, 0)'); // transparent page
	// MG-1: an opaque origin on both sides of the frame boundary — no editor DOM, no cookies, no storage.
	expect(r.reachable).toBe(false);
	expect(at45.origin).toBe('null');
	expect(at45.parentReachable).toBe(false);
	expect(at45.cookies ?? '').toBe('');
	expect(at45.storage).toBe(false);
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
	// File ▸ Import Remotion Project…
	await page.getByRole('menuitem', { name: 'File' }).click();
	await page.getByRole('menuitem', { name: /Import Remotion Project/ }).click();
	const dialog = page.getByTestId('mg-import-dialog');
	await expect(dialog).toBeVisible();
	await page.getByTestId('mg-import-path').fill(FIXTURE_PROJECT);
	await page.getByTestId('mg-import-watch').uncheck();
	await dialog.getByRole('button', { name: 'Import Folder' }).click();
	await expect(dialog).toBeHidden({ timeout: 600_000 });
	await expect(page.getByTestId('project-row').filter({ hasText: 'fixture-mg-project' })).toBeVisible();

	// Motion Templates ▸ Remotion lists the compositions; double-click inserts at the playhead.
	await page.getByText('Motion Templates', { exact: true }).first().click();
	await page.getByRole('tab', { name: 'Remotion' }).click();
	const card = page.locator('[data-testid="remotion-tab"] [data-composition="Title"]');
	await expect(card).toBeVisible();
	await expect(page.locator('[data-testid="remotion-tab"] [data-composition="Badge"]')).toBeVisible();
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

	// The Program monitor shows the live host frame of the playhead.
	await expect.poll(() => hostText(page), { timeout: 60_000 }).toBe('Hello Jasper');
	await expect(page.getByTestId('composition-section')).toBeVisible();

	// Editing the title in Properties updates the Program monitor within 500 ms (S08 §8 test 4).
	// wp-m3-mgtext: `title` is a text layer (ui control "text"): its editor is in Properties ▸ Composition ▸ Text.
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

	// After 2 s without changes the layer switches to the pre-rendered preview WebM.
	await expect(page.getByTestId('composition-status')).toHaveText(/Preview ready/, { timeout: 300_000 });
	await expect(page.locator('[data-testid="program-monitor"] iframe[data-mg-host]')).toHaveAttribute(
		'data-mg-host-state',
		'idle',
	);

	// The history includes the import, insert and title edit.
	const hist = await query<{ entries: { label: string; applied: boolean }[] }>(page, 'history.list');
	expect(hist.entries.filter((e) => e.applied).map((e) => e.label)).toEqual(
		expect.arrayContaining(['Import Remotion Project', 'Add Title', 'Edit Text «Title»']),
	);
	await page.screenshot({ path: 'test-results/e2e-composition-preview.png' });
});
