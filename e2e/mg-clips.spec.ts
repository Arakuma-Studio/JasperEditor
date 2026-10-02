// Motion-graphics composition clips (M2, S08 §8 test 4): the renderer-page protocol contract of the live frame
// host (fails loudly when a Remotion upgrade changes the page protocol, ARCHITECTURE D-19), then the UI flow:
// File ▸ Import Remotion Project… (fixtures/mg-project), Motion Templates ▸ Remotion, insert, live host frame in
// the Program monitor, a props edit in Properties visible within 500 ms, and the switch to the cached VP9-alpha
// preview after the props stay unchanged for 2 s.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect, type Page, test } from '@playwright/test';
import { appliedLabels, createProject, enableAgentBridge, query, ROOT, serverInfo } from './support.ts';

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
		entryPoints: [join(ROOT, 'packages/compositions/src/mg-host/protocol.ts')],
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
	await probe.setContent(
		'<html><body style="margin:0;background:rgb(255,0,0)"><iframe id="h" style="border:0;width:1920px;height:1080px;color-scheme:light"></iframe></body></html>',
	);
	await probe.addScriptTag({ content: protocolScript });
	const r = await probe.evaluate(async (key) => {
		type Host = {
			MgFrameHostDriver: new (
				w: unknown,
			) => {
				configure(
					c: unknown,
				): Promise<{ width: number; height: number; fps: number; durationInFrames: number }>;
				seek(id: string, f: number): Promise<void>;
			};
			checkHostProtocol(w: unknown): {
				ok: boolean;
				missing: string[];
				remotionVersion: string;
				siteVersion: string;
			};
			hostPageUrl(base: string): string;
			bundleServeUrl(key: string): string;
		};
		const M = (window as unknown as { MgHost: Host }).MgHost;
		const f = document.getElementById('h') as HTMLIFrameElement;
		await new Promise((res) => {
			f.onload = res;
			f.src = M.hostPageUrl(M.bundleServeUrl(key));
		});
		const w = f.contentWindow as unknown as Record<string, unknown>;
		const globals = Object.fromEntries(
			[
				'remotion_setBundleMode',
				'remotion_calculateComposition',
				'remotion_getCompositionNames',
				'getStaticCompositions',
			].map((k) => [k, typeof w[k]]),
		);
		const d = new M.MgFrameHostDriver(w);
		const meta = await d.configure({
			compositionId: 'Title',
			props: { title: 'Contract', accent: '#00ff00', delay: 0 },
			override: { fps: 30, width: 1280, height: 720 },
		});
		const setFrame = typeof w.remotion_setFrame;
		await d.seek('Title', 45);
		const doc = f.contentDocument!;
		const text = doc.querySelector('[data-testid="title-text"]')?.textContent;
		const panel = doc.querySelector('[data-testid="title-panel"]') as HTMLElement | null;
		const opacity = panel ? Number(getComputedStyle(panel).opacity) : -1;
		await d.seek('Title', 0);
		const opacityAt0 = panel ? Number(getComputedStyle(panel).opacity) : -1;
		return {
			check: M.checkHostProtocol(w),
			globals,
			setFrame,
			meta,
			ready: w.remotion_renderReady,
			text,
			opacity,
			opacityAt0,
			bodyBg: getComputedStyle(doc.body).backgroundColor,
		};
	}, reg.mediaKey);
	// If any of these fail after a Remotion upgrade, packages/compositions/src/mg-host/protocol.ts must follow.
	expect(r.check).toEqual({ ok: true, missing: [], remotionVersion: '4.0.499', siteVersion: '11' });
	expect(r.globals).toEqual({
		remotion_setBundleMode: 'function',
		remotion_calculateComposition: 'function',
		remotion_getCompositionNames: 'function',
		getStaticCompositions: 'function',
	});
	expect(r.setFrame).toBe('function');
	expect(r.meta).toMatchObject({ width: 1280, height: 720, fps: 30, durationInFrames: 90 });
	expect(r.ready).toBe(true);
	expect(r.text).toBe('Contract');
	expect(r.opacity).toBeCloseTo(1, 5); // frame 45: the panel has entered
	expect(r.opacityAt0).toBe(0); // frame 0: not yet
	expect(r.bodyBg).toBe('rgba(0, 0, 0, 0)'); // transparent page
	await probe.close();
});

async function hostText(p: Page): Promise<string | null> {
	return p
		.locator('[data-testid="program-monitor"] iframe[data-mg-host]')
		.evaluate(
			(f) =>
				(f as HTMLIFrameElement).contentDocument?.querySelector('[data-testid="title-text"]')?.textContent ??
				null,
		)
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
	const latencyMark = 'e2e:mg-title-enter';
	const latencyMeasure = 'e2e:mg-title-visible';
	await field.evaluate(
		(input, { mark, measure }) => {
			performance.clearMarks(mark);
			performance.clearMeasures(measure);
			input.addEventListener(
				'keydown',
				(event) => {
					if (!(event instanceof KeyboardEvent) || event.key !== 'Enter') return;
					performance.mark(mark);
					const check = () => {
						const iframe = document.querySelector<HTMLIFrameElement>(
							'[data-testid="program-monitor"] iframe[data-mg-host]',
						);
						const title = iframe?.contentDocument?.querySelector('[data-testid="title-text"]')?.textContent;
						if (title === 'Edited in Properties') performance.measure(measure, mark);
						else if (performance.now() - performance.getEntriesByName(mark, 'mark')[0]!.startTime < 5_000)
							requestAnimationFrame(check);
					};
					requestAnimationFrame(check);
				},
				{ capture: true, once: true },
			);
		},
		{ mark: latencyMark, measure: latencyMeasure },
	);
	await field.press('Enter');
	await expect
		.poll(
			() =>
				page.evaluate(
					(name) => performance.getEntriesByName(name, 'measure')[0]?.duration ?? null,
					latencyMeasure,
				),
			{ timeout: 5_000, intervals: [20] },
		)
		.not.toBeNull();
	const elapsed = await page.evaluate(
		(name) => performance.getEntriesByName(name, 'measure')[0]!.duration,
		latencyMeasure,
	);
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

test('MCP: import_mg_bundle → add_composition → set_composition_props → render_frame, as Agent History entries', async () => {
	test.setTimeout(900_000);
	const bundle = join(ROOT, 'apps/mcp/dist/jasper-mcp.mjs');
	expect(existsSync(bundle), `${bundle} is missing: run \`pnpm mcp:build\``).toBe(true);
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env))
		if (v !== undefined && !k.startsWith('JASPER_')) env[k] = v;
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [bundle, '--appdir', serverInfo().appdir],
		env,
		stderr: 'pipe',
	});
	const log: string[] = [];
	transport.stderr?.on('data', (d: Buffer) => log.push(d.toString('utf8')));
	const mcp = new Client({ name: 'e2e-mg', version: '1.0.0' });
	await mcp.connect(transport);
	const text = (r: CallToolResult) =>
		(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
	const tool = async <T>(
		name: string,
		args: Record<string, unknown>,
	): Promise<{ body: T; r: CallToolResult }> => {
		const r = (await mcp.callTool({ name, arguments: args }, undefined, {
			timeout: 600_000,
		})) as CallToolResult;
		expect(r.isError, `${name}: ${text(r)}\n${log.join('')}`).toBeFalsy();
		return { body: JSON.parse(text(r)) as T, r };
	};
	try {
		const projectId = /\/project\/([^/?#]+)/.exec(page.url())![1]!;
		const imp = await tool<{
			mediaId: string;
			compositions: { id: string; props: Record<string, unknown> }[];
		}>('import_mg_bundle', { projectId, path: FIXTURE_PROJECT });
		expect(imp.body.compositions.map((c) => c.id).sort()).toEqual(['Badge', 'LowerThird', 'Title']);
		expect(imp.body.compositions.find((c) => c.id === 'Title')!.props.title).toMatchObject({
			type: 'string',
		});
		const listed = await tool<{ bundles: { mediaId: string }[] }>('list_compositions', { projectId });
		expect(listed.body.bundles.map((b) => b.mediaId)).toContain(imp.body.mediaId);
		const added = await tool<{ appliedBy: string; created: string[] }>('add_composition', {
			projectId,
			mediaId: imp.body.mediaId,
			compositionId: 'Title',
			at: 200,
			track: 'V3',
			props: { delay: 0 },
		});
		expect(added.body.appliedBy).toBe('session');
		const clipId = added.body.created.find((id) => id.startsWith('clp_'))!;
		const bad = (await mcp.callTool({
			name: 'set_composition_props',
			arguments: { projectId, clipId, props: { title: 42 } },
		})) as CallToolResult;
		expect(bad.isError).toBe(true);
		expect(text(bad)).toContain('E_INVALID_PARAM');
		const set = await tool<{ effectiveProps: Record<string, unknown> }>('set_composition_props', {
			projectId,
			clipId,
			props: { title: 'Agent title', accent: '#3366ff' },
		});
		expect(set.body.effectiveProps).toMatchObject({ title: 'Agent title', accent: '#3366ff', delay: 0 });
		const frame = await tool<{ frame: number; renderedBy?: string }>('render_frame', {
			projectId,
			at: 245,
			width: 960,
		});
		const img = frame.r.content.find((c) => c.type === 'image') as { data: string } | undefined;
		expect(img).toBeDefined();
		expect(Buffer.from(img!.data, 'base64').readUInt32BE(16)).toBe(960);
		// The agent's edits are History entries of the open editor.
		const labels = await appliedLabels(page);
		expect(labels).toEqual(expect.arrayContaining(['Agent: Add Title', 'Agent: Edit Props']));
	} finally {
		await mcp.close().catch(() => {});
	}
});
