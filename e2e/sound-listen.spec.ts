// Spec 12 §4 P6-E6 / P6-E7 in the built app (wp-note "Phase 6 → WP-E3"): the Phase 4 fixture — the Phase 2 edit, pink
// music on A1, an interview on A2 with a knock inside it (production audio), an Auto Sound Pass accepted and applied —
// then Sequence ▸ Sound Design ▸ Listen to Sequence: the Sound Check panel's Log tab lists the transcript; a line moves
// the playhead and selects its clip; the spectrogram strip; jasper-mcp `listen_to_sequence` on the same project prints
// the same lines, and its sheet (images: true) is written to look at. Measured numbers go to listen-real-run.json.
// Screenshots and the sheet (looked at): test-results/e2e-sound-listen.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { FIXTURE_COMMANDS } from '../apps/mcp/test/sound-cues-fixture.ts';
import { appliedLabels, enableAgentBridge, playheadFrame, query, ROOT, serverInfo, transact } from './support.ts';

test.describe.configure({ mode: 'serial' });

const outDir = join(ROOT, 'test-results', 'e2e-sound-listen');
const FFMPEG = process.env.JASPER_FFMPEG ?? 'ffmpeg';
const MCP_BUNDLE = join(ROOT, 'apps/mcp/dist/jasper-mcp.mjs');
const LONG_MS = 1_500_000;
let page: Page;
let mcp: Client;
const mcpLog: string[] = [];

test.beforeAll(async ({ browser }) => {
	expect(existsSync(MCP_BUNDLE), `${MCP_BUNDLE} is missing: run \`pnpm mcp:build\``).toBe(true);
	mkdirSync(outDir, { recursive: true });
	page = await browser.newPage({ viewport: { width: 1800, height: 1050 } });
	await enableAgentBridge(page);
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('JASPER_')) env[k] = v;
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [MCP_BUNDLE, '--appdir', serverInfo().appdir],
		env,
		stderr: 'pipe',
	});
	transport.stderr?.on('data', (d: Buffer) => mcpLog.push(d.toString('utf8')));
	mcp = new Client({ name: 'e2e-sound-listen', version: '1.0.0' });
	await mcp.connect(transport);
});
test.afterAll(async () => {
	await mcp?.close().catch(() => {});
	await page?.close();
});

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
	const r = (await mcp.callTool({ name, arguments: args }, undefined, { timeout: LONG_MS })) as CallToolResult;
	const first = (r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
	expect(r.isError, `${name}: ${first}\n${mcpLog.join('').slice(-2000)}`).toBeFalsy();
	return r;
}

function wav(name: string, args: string[]): string {
	const file = join(outDir, name);
	const r = spawnSync(FFMPEG, ['-v', 'error', '-y', ...args, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', file]);
	expect(r.status, String(r.stderr)).toBe(0);
	return file;
}

async function createProject(p: Page, name: string): Promise<string> {
	await p.goto('/');
	await expect(p.getByTestId('home')).toBeVisible({ timeout: 120_000 });
	await p.getByTestId('home-new').click();
	await p.getByTestId('new-project-name').fill(name);
	await p.getByTestId('new-project-create').click();
	await expect(p.getByTestId('editor-shell')).toBeVisible({ timeout: 180_000 });
	await expect(p.getByTestId('timeline-track-area')).toBeVisible({ timeout: 120_000 });
	await expect.poll(() => p.evaluate(() => !!window.jasper), { timeout: 120_000 }).toBe(true);
	const m = /\/project\/([^/?#]+)/.exec(p.url());
	if (!m) throw new Error(`Unexpected editor URL ${p.url()}`);
	return decodeURIComponent(m[1]!);
}

async function libraryReady(request: APIRequestContext) {
	await expect
		.poll(
			async () => {
				const r = await request.get('/api/sounds/status');
				if (!r.ok()) return 0;
				const s = (await r.json()) as { sounds: number; indexing: unknown; needsIndex: boolean };
				return s.indexing || s.needsIndex ? 0 : s.sounds;
			},
			{ timeout: 360_000, intervals: [1000] },
		)
		.toBeGreaterThan(20);
}

async function menu(p: Page, item: string) {
	const menubar = p.getByTestId('title-bar').getByRole('menubar');
	await menubar.getByRole('menuitem', { name: 'Sequence', exact: true }).click();
	await p.getByRole('menuitem', { name: 'Sound Design' }).hover();
	await p.getByRole('menuitem', { name: item, exact: true }).click();
}

const panel = () => page.locator('[data-panel-kind="soundCheck"][data-instance-id]');

test('Log tab and listen_to_sequence on the Phase 4 fixture with a knock in the interview', async ({ request }) => {
	test.setTimeout(5_400_000);
	const projectId = await createProject(page, 'E2E Listen');
	const music = wav('music.wav', ['-f', 'lavfi', '-i', 'anoisesrc=d=14:c=pink:a=0.08:seed=7', '-t', '14']);
	// an interview: a 1.5 kHz "voice" from 4 to 8 s in 4 Hz syllables, with a knock (a decaying 90 Hz thump) at 6.5 s
	const interview = wav('interview.wav', [
		'-f',
		'lavfi',
		'-i',
		"aevalsrc='if(between(t\\,4\\,8)\\,0.2*sin(2*PI*1500*t)*(0.5-0.5*cos(2*PI*4*(t-4)))\\,0)+if(between(t\\,6.5\\,6.8)\\,0.8*exp(-(t-6.5)/0.04)*sin(2*PI*90*(t-6.5))\\,0)':s=48000:d=14",
		'-t',
		'14',
	]);
	await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Control+KeyI');
	await (await chooser).setFiles([music, interview]);
	for (const n of ['music.wav', 'interview.wav'])
		await expect(page.getByTestId('project-row').filter({ hasText: n })).toBeVisible({ timeout: 120_000 });
	const items = await query<Record<string, { id: string; name: string }>>(page, 'doc.get', { path: ['items'] });
	const item = (n: string) => Object.values(items).find((i) => i.name === n)!.id;
	const setup = await transact(page, [
		...((FIXTURE_COMMANDS as { type: string }[]).filter((c) => c.type !== 'clip.addMotionGraphic') as never[]),
		{ type: 'clip.place', source: { projectItemId: item('music.wav') }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
		{ type: 'clip.place', source: { projectItemId: item('interview.wav') }, at: 0, tracks: { audio: 'A2' }, ref: '$d' },
		{ type: 'essentialSound.setType', clipIds: ['$m'], audioType: 'music' },
		{ type: 'essentialSound.setType', clipIds: ['$d'], audioType: 'dialogue' },
	] as never);
	expect(setup.ok, JSON.stringify(setup)).toBe(true);
	const dialogueClip = (setup as unknown as { refs: Record<string, string> }).refs.$d!;
	await libraryReady(request);
	await page.keyboard.press('Alt+Shift+Digit9');
	await expect(page.getByRole('tab', { name: 'Sound Check' })).toBeVisible({ timeout: 60_000 });

	// the sound pass, accepted and applied
	await menu(page, 'Auto Sound Pass…');
	const dialog = page.getByTestId('auto-sound-pass-dialog');
	await expect(dialog).toBeVisible();
	await dialog.getByRole('button', { name: 'Propose' }).click();
	await expect(page.getByTestId('review-bar')).toBeVisible({ timeout: LONG_MS });
	if (await dialog.getByTestId('auto-pass-notes').isVisible()) await dialog.locator('[data-dialog-primary]').click();
	await expect(dialog).toBeHidden();
	const before = await appliedLabels(page);
	await page.getByTestId('review-bar-accept-all').click();
	await page.getByTestId('review-bar-apply').click();
	await expect.poll(async () => (await appliedLabels(page)).length, { timeout: 120_000 }).toBe(before.length + 1);
	await page.getByTestId('review-bar-exit').click();

	// Sequence ▸ Sound Design ▸ Listen to Sequence: the Log tab
	await menu(page, 'Listen to Sequence');
	await expect(panel()).toBeVisible({ timeout: 60_000 });
	await expect(panel().getByTestId('sound-check-tab-log')).toHaveAttribute('aria-selected', 'true');
	const lines = panel().getByTestId('sound-listen-line');
	await expect(lines.first()).toBeVisible({ timeout: LONG_MS });
	await expect(panel().getByTestId('sound-listen-progress')).toBeHidden({ timeout: LONG_MS });
	await page.screenshot({ path: join(outDir, '1-log-tab.png') });
	const panelLines = await lines.evaluateAll((els) =>
		els.map(
			(e) =>
				`${e.querySelector('[data-testid="sound-listen-timecode"]')?.textContent ?? ''}  ${e.querySelector('[data-testid="sound-listen-text"]')?.textContent ?? ''}`,
		),
	);
	expect(panelLines[0]).toMatch(/Listened 00[:;]00[:;]00[:;]00/);
	expect(panelLines.some((l) => / · SFX A\d+ "/.test(l))).toBe(true);
	// the knock in the interview is the dialogue clip's
	const knock = panelLines.find((l) => /^00[:;]00[:;]06[:;]1[3-6] {2}hit, .*dialogue, A2 "interview\.wav"/.test(l));
	expect(knock, panelLines.join('\n')).toBeDefined();

	// a line jumps the playhead and selects its clip; the spectrogram strip
	const knockRow = lines.filter({ hasText: knock!.slice(knock!.indexOf('  ') + 2) }).first();
	const knockFrame = Number(await knockRow.getAttribute('data-frame'));
	await knockRow.click();
	await expect.poll(() => playheadFrame(page)).toBe(knockFrame);
	const sel = await query<{ selection: { timeline?: { clips?: string[] } } }>(page, 'selection.get');
	expect(sel.selection.timeline?.clips).toEqual([dialogueClip]);
	const selection = JSON.stringify(sel.selection);
	await panel().getByTestId('sound-listen-spectrogram').click();
	await expect(panel().getByTestId('sound-listen-spectrogram')).toHaveAttribute('data-frames', /\d+/, {
		timeout: 120_000,
	});
	await page.screenshot({ path: join(outDir, '2-line-and-spectrogram.png') });
	const panelBox = await panel().boundingBox();
	if (panelBox) await page.screenshot({ path: join(outDir, '3-panel.png'), clip: panelBox });

	// MCP: the same lines; the sheet
	const r = await call('listen_to_sequence', { projectId, images: true });
	const transcript = (r.content[0] as { text: string }).text;
	const compact = JSON.parse((r.content[1] as { text: string }).text) as {
		placed: { clipId: string; title: string; heard: boolean; ownOffsetMs: number | null }[];
		counts: Record<string, number>;
		sync: Record<string, unknown>;
		unanswered: unknown[];
		timings: Record<string, number>;
	};
	expect(transcript.split('\n')).toEqual(panelLines);
	const png = r.content.find((c) => c.type === 'image') as { data: string } | undefined;
	expect(png).toBeDefined();
	writeFileSync(join(outDir, 'listen-sheet.png'), Buffer.from(png!.data, 'base64'));
	writeFileSync(join(outDir, 'transcript.txt'), transcript);
	const heard = compact.placed.filter((p) => p.heard).length;
	const offsets = compact.placed.map((p) => p.ownOffsetMs).filter((x): x is number => x !== null);
	writeFileSync(
		join(outDir, 'listen-real-run.json'),
		JSON.stringify(
			{
				placed: compact.placed.length,
				heard,
				ownOffsetMsMaxAbs: offsets.length ? Math.max(...offsets.map(Math.abs)) : null,
				counts: compact.counts,
				sync: compact.sync,
				unanswered: compact.unanswered,
				timings: compact.timings,
				selectionAfterKnockLine: selection,
				dialogueClip,
			},
			null,
			1,
		),
	);
	console.log(
		`listen real run: ${heard}/${compact.placed.length} placed sounds heard; own offsets |max| ${offsets.length ? Math.max(...offsets.map(Math.abs)) : '—'} ms; ${JSON.stringify(compact.counts)}; ${JSON.stringify(compact.timings)}`,
	);
	expect(compact.placed.length).toBeGreaterThan(5);
	for (const p of compact.placed) if (p.ownOffsetMs !== null) expect(Math.abs(p.ownOffsetMs), p.title).toBeLessThanOrEqual(1);
});
