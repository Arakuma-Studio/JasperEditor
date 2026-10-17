// Spec 12 §4 P6-E1 / P6-E13 in the built app (wp-note "Phase 6 → WP-E1"): generated music faded out, a CC BY-SA sound
// that starts on a full-level sample at an edit (CLICK), a held chord whose head starts mid-sound (EDGE) → Sequence ▸
// Sound Design ▸ Run Sound Check → the panel groups them under Edges (and the ShareAlike LICENSE warning under
// Licence) with the same codes at the same frames as jasper-mcp `sound_check` → Fix on the click = one History entry →
// Re-run: the click is gone. The timeline shows the "SA" clip badge; the Sound Library has "Include ShareAlike".
// Screenshots (looked at): test-results/e2e-sound-check-edges.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect, type Page, test } from '@playwright/test';
import { appliedLabels, enableAgentBridge, query, ROOT, serverInfo, transact } from './support.ts';

test.describe.configure({ mode: 'serial' });

const outDir = join(ROOT, 'test-results', 'e2e-sound-check-edges');
const FFMPEG = process.env.JASPER_FFMPEG ?? 'ffmpeg';
const MCP_BUNDLE = join(ROOT, 'apps/mcp/dist/jasper-mcp.mjs');
const CHECK_MS = 900_000;
let page: Page;
let mcp: Client;
const mcpLog: string[] = [];

test.beforeAll(async ({ browser }) => {
	expect(existsSync(MCP_BUNDLE), `${MCP_BUNDLE} is missing: run \`pnpm mcp:build\``).toBe(true);
	mkdirSync(outDir, { recursive: true });
	page = await browser.newPage({ viewport: { width: 1800, height: 1050 } });
	await enableAgentBridge(page);
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env))
		if (v !== undefined && !k.startsWith('JASPER_')) env[k] = v;
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [MCP_BUNDLE, '--appdir', serverInfo().appdir],
		env,
		stderr: 'pipe',
	});
	transport.stderr?.on('data', (d: Buffer) => mcpLog.push(d.toString('utf8')));
	mcp = new Client({ name: 'e2e-sound-check-edges', version: '1.0.0' });
	await mcp.connect(transport);
});
test.afterAll(async () => {
	await mcp?.close().catch(() => {});
	await page?.close();
});

const text = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
async function tool<T>(name: string, args: Record<string, unknown>): Promise<T> {
	const r = (await mcp.callTool({ name, arguments: args }, undefined, { timeout: CHECK_MS })) as CallToolResult;
	expect(r.isError, `${name}: ${text(r)}\n${mcpLog.join('').slice(-2000)}`).toBeFalsy();
	return JSON.parse(text(r)) as T;
}

function wav(name: string, source: string, seconds: number): string {
	const file = join(outDir, name);
	const r = spawnSync(FFMPEG, [
		'-v',
		'error',
		'-y',
		'-f',
		'lavfi',
		'-i',
		source,
		'-t',
		String(seconds),
		'-ar',
		'48000',
		'-ac',
		'2',
		'-c:a',
		'pcm_s16le',
		file,
	]);
	expect(r.status, String(r.stderr)).toBe(0);
	return file;
}

async function menu(p: Page, item: string) {
	const menubar = p.getByTestId('title-bar').getByRole('menubar');
	await menubar.getByRole('menuitem', { name: 'Sequence', exact: true }).click();
	await p.getByRole('menuitem', { name: 'Sound Design' }).hover();
	await p.getByRole('menuitem', { name: item, exact: true }).click();
}

const panel = () => page.locator('[data-panel-kind="soundCheck"][data-instance-id]');
const rows = () => panel().locator('[data-issue-id]');
async function panelFindings(): Promise<string[]> {
	const list = await rows().evaluateAll((els) =>
		els.map((e) => `${e.getAttribute('data-code')}@${e.getAttribute('data-frame') ?? ''}`),
	);
	return list.sort();
}
async function waitVerdict(previous?: string) {
	await expect(panel().getByTestId('sound-check-verdict')).toBeVisible({ timeout: CHECK_MS });
	await expect(panel().getByTestId('sound-check-progress')).toBeHidden({ timeout: CHECK_MS });
	if (previous)
		await expect
			.poll(async () => (await panel().getByTestId('sound-check-live').textContent()) ?? '', {
				timeout: CHECK_MS,
			})
			.not.toBe(previous);
}

type Clip = { id: string; kind: string; start: number; mediaId?: string };

test('Sound Check edges: CLICK and EDGE under Edges, ShareAlike under Licence, the same as MCP; Fix clears the click', async () => {
	test.setTimeout(3_600_000);
	await page.goto('/');
	await expect(page.getByTestId('home')).toBeVisible({ timeout: 120_000 });
	await page.getByTestId('home-new').click();
	await page.getByTestId('new-project-name').fill('E2E Sound Check Edges');
	await page.getByTestId('new-project-create').click();
	await expect(page.getByTestId('editor-shell')).toBeVisible({ timeout: 180_000 });
	await expect.poll(() => page.evaluate(() => !!window.jasper), { timeout: 120_000 }).toBe(true);
	const projectId = decodeURIComponent(/\/project\/([^/?#]+)/.exec(page.url())![1]!);

	const music = wav('music.wav', 'anoisesrc=d=10:c=pink:a=0.06:seed=7', 10);
	// a 1 kHz tone starting on a full-level sample (cos): a step from silence
	const step = wav('step.wav', 'aevalsrc=0.1*cos(2*PI*1000*t)*exp(-t/0.4):d=1', 1);
	// a held chord
	const chord = wav(
		'chord.wav',
		'aevalsrc=0.1*(sin(2*PI*220*t)+sin(2*PI*277.18*t)+sin(2*PI*329.63*t)):d=6',
		6,
	);
	await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Control+KeyI');
	await (await chooser).setFiles([music, step, chord]);
	for (const n of ['music.wav', 'step.wav', 'chord.wav'])
		await expect(page.getByTestId('project-row').filter({ hasText: n })).toBeVisible({ timeout: 120_000 });
	const items = await query<Record<string, { id: string; name: string; mediaId?: string }>>(page, 'doc.get', {
		path: ['items'],
	});
	const item = (n: string) => Object.values(items).find((i) => i.name === n)!;
	const setup = await transact(page, [
		{ type: 'track.add', kind: 'audio', count: 2 },
		{ type: 'clip.place', source: { projectItemId: item('music.wav').id }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
		{ type: 'essentialSound.setType', clipIds: ['$m'], audioType: 'music' },
		{ type: 'transition.add', clipId: '$m', edge: 'out', effectId: 'jasper.exponential-fade', duration: 60 },
		{ type: 'mixer.setLoudness', enabled: true, targetLufs: -14, truePeakDb: -1 },
		{ type: 'clip.place', source: { projectItemId: item('step.wav').id }, at: 120, tracks: { audio: 'A2' }, ref: '$s' },
		{ type: 'essentialSound.setType', clipIds: ['$s'], audioType: 'sfx' },
		{
			type: 'clip.place',
			source: { projectItemId: item('chord.wav').id },
			sourceRange: { in: { seconds: 1 }, out: { seconds: 6 } },
			at: 150,
			tracks: { audio: 'A3' },
			ref: '$c',
		},
	] as never);
	expect(setup.ok, JSON.stringify(setup)).toBe(true);
	const seq0 = Object.values(
		await query<Record<string, { id: string; clips: Record<string, Clip> }>>(page, 'doc.get', { path: ['sequences'] }),
	)[0]!;
	const stepClip = Object.values(seq0.clips).find((c) => c.start === 120)!;
	const chordClip = Object.values(seq0.clips).find((c) => c.start === 150)!;
	// the step sound is a CC BY-SA library sound (ShareAlike)
	const lib = await transact(page, [
		{
			type: 'media.setLibraryInfo',
			mediaId: stepClip.mediaId!,
			library: {
				soundId: 'snd_00000000000e2e01',
				title: 'Step tone',
				types: ['click'],
				source: { type: 'folder', rootId: 'root_000000000e2e', relPath: 'step.wav' },
				license: 'CC-BY-SA-4.0',
				author: 'E2E',
				attribution: '"Step tone" by E2E, CC BY-SA 4.0',
			},
		},
	] as never);
	expect(lib.ok, JSON.stringify(lib)).toBe(true);

	// the timeline: the "SA" badge on the clip
	await page.keyboard.press('Alt+Shift+Digit9');
	await expect(page.getByRole('tab', { name: 'Sound Check' })).toBeVisible({ timeout: 60_000 });
	const badge = page.locator(`[data-sound-badges="${stepClip.id}"] [data-sound-badge="share-alike"]`);
	await expect(badge).toBeVisible({ timeout: 60_000 });
	await page.getByTestId('timeline-track-area').screenshot({ path: join(outDir, 'timeline-sa-badge.png') });
	// the Sound Library: Commercial-safe leaves BY-SA out; Include ShareAlike is next to it
	const library = page.locator('[data-panel-kind="soundLibrary"][data-instance-id]');
	if (await library.isVisible()) {
		await expect(library.getByTestId('sound-include-share-alike')).toBeVisible();
		await expect(library.getByTestId('sound-include-share-alike')).toHaveAttribute('aria-pressed', 'false');
		await library.screenshot({ path: join(outDir, 'library-include-share-alike.png') });
	}

	// Run Sound Check
	await menu(page, 'Run Sound Check');
	await expect(panel()).toBeVisible({ timeout: 60_000 });
	await waitVerdict();
	const click = panel().locator(`[data-issue-id="CLICK:${stepClip.id}:start"]`);
	await expect(click).toBeVisible();
	await expect(click).toHaveAttribute('data-frame', '120');
	await expect(click.getByTestId('sound-check-message')).toContainText(/Click at an edit: the start of/);
	const edges = panel().locator('[data-category="edges"]');
	await expect(edges).toContainText('Edges');
	const entry = panel().locator(`[data-issue-id="EDGE:${chordClip.id}:start"]`);
	await expect(entry).toBeVisible();
	await expect(entry).toHaveAttribute('data-frame', '150');
	await expect(entry.getByTestId('sound-check-message')).toContainText(/starts mid-sound/);
	const sa = panel().locator(`[data-issue-id="LICENSE:${stepClip.id}"]`);
	await expect(sa).toBeVisible();
	await expect(sa.getByTestId('sound-check-message')).toContainText(/ShareAlike/);
	await panel().screenshot({ path: join(outDir, 'panel.png') });

	// the agent's view: the same codes at the same frames
	const agent = await tool<{ verdict: string; issues: { code: string; frame?: number; range?: { start: number } }[] }>(
		'sound_check',
		{ projectId, images: false },
	);
	const agentFindings = agent.issues.map((i) => `${i.code}@${i.frame ?? i.range?.start ?? ''}`).sort();
	expect(agentFindings).toEqual(await panelFindings());
	expect(agentFindings).toContain('CLICK@120');
	expect(agentFindings).toContain('EDGE@150');

	// Fix on the click: one History entry; Re-run: the click is gone
	const before = await appliedLabels(page);
	await click.getByTestId('sound-check-fix').click();
	await expect.poll(async () => (await appliedLabels(page)).length, { timeout: 60_000 }).toBe(before.length + 1);
	expect((await appliedLabels(page)).at(-1)).toMatch(/^Sound Check Fix: Fade it in/);
	const live = (await panel().getByTestId('sound-check-live').textContent()) ?? '';
	await panel().getByTestId('sound-check-run').click();
	await waitVerdict(live);
	await expect(panel().locator(`[data-issue-id="CLICK:${stepClip.id}:start"]`)).toHaveCount(0);
	await panel().screenshot({ path: join(outDir, 'panel-after-fix.png') });
	await page.evaluate(() => document.documentElement.setAttribute('data-pr-contrast', 'high'));
	await panel().screenshot({ path: join(outDir, 'panel-high-contrast.png') });
	await page.evaluate(() => document.documentElement.removeAttribute('data-pr-contrast'));
});
