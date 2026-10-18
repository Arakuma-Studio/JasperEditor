// Spec 12 §4 P6-E4 / P6-E5 in the built app (wp-note "Phase 6 → WP-E2"): generated music cut at a loud frame (ENDING), a
// hit on a cut cue and a tick → Sequence ▸ Sound Design ▸ Run Sound Check → Acknowledge… on ENDING with a reason (one
// History entry; the finding moves to "Acknowledged (1)" and leaves the verdict) → jasper-mcp `sound_check` lists it
// under acknowledged and the same open findings as the panel → the agent proposes the same hit again on the next cut
// (`place_sound`, a REPEAT) and checks the proposal (`sound_check {proposalId}`) → the user opens it from its card: the
// Review panel shows the same "fixes · introduces" with the REPEAT linked to its item, the row badge, the ghost card's
// line; "Check again" in the panel gives the same delta. Screenshots (looked at): test-results/e2e-sound-check-ack.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect, type Page, test } from '@playwright/test';
import { appliedLabels, enableAgentBridge, query, ROOT, serverInfo, transact } from './support.ts';

test.describe.configure({ mode: 'serial' });

const outDir = join(ROOT, 'test-results', 'e2e-sound-check-ack');
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
	mcp = new Client({ name: 'e2e-sound-ack', version: '1.0.0' });
	await mcp.connect(transport);
});
test.afterAll(async () => {
	await mcp?.close().catch(() => {});
	await page?.close();
});

const text = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
async function tool<T>(name: string, args: Record<string, unknown>): Promise<T> {
	const r = (await mcp.callTool({ name, arguments: args }, undefined, {
		timeout: CHECK_MS,
	})) as CallToolResult;
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
const reviewPanel = () => page.locator('[data-panel-kind="review"][data-instance-id]');
/** The findings that count, as "CODE@frame" (the list; the acknowledged group is apart). */
async function panelOpen(): Promise<string[]> {
	return (
		await panel()
			.getByTestId('sound-check-findings')
			.locator('[data-issue-id]')
			.evaluateAll((els) =>
				els.map((e) => `${e.getAttribute('data-code')}@${e.getAttribute('data-frame') ?? ''}`),
			)
	).sort();
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

type Issue = {
	id: string;
	code: string;
	severity: string;
	frame?: number;
	range?: { start: number };
	acknowledged?: { active: boolean; reason: string; by: string };
};
type Check = {
	verdict: string;
	counts: Record<string, number>;
	findings: string[];
	issues: Issue[];
	acknowledged?: { count: number; findings: string[] };
	proposal?: { summary: string; introduces: string[]; fixes: string[]; perItem: { itemId: string }[] };
};

test('acknowledge a finding in the panel, the same in MCP; a proposal checked by the agent shows in the Review panel', async () => {
	test.setTimeout(3_600_000);
	await page.goto('/');
	await expect(page.getByTestId('home')).toBeVisible({ timeout: 120_000 });
	await page.getByTestId('home-new').click();
	await page.getByTestId('new-project-name').fill('E2E Sound Check Acknowledge');
	await page.getByTestId('new-project-create').click();
	await expect(page.getByTestId('editor-shell')).toBeVisible({ timeout: 180_000 });
	await expect.poll(() => page.evaluate(() => !!window.jasper), { timeout: 120_000 }).toBe(true);
	const projectId = decodeURIComponent(/\/project\/([^/?#]+)/.exec(page.url())![1]!);

	// pink music cut at a loud frame (no fade: ENDING), a decaying 180 Hz thump, a short 1 kHz tick
	const music = wav('music.wav', 'anoisesrc=d=10:c=pink:a=0.06:seed=11', 10);
	const hit = wav('hit.wav', 'aevalsrc=0.5*sin(2*PI*180*t)*exp(-t/0.06):d=0.5', 0.5);
	const tick = wav('tick.wav', 'aevalsrc=0.25*sin(2*PI*1000*t)*exp(-t/0.012):d=0.15', 0.15);
	await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Control+KeyI');
	await (await chooser).setFiles([music, hit, tick]);
	for (const n of ['music.wav', 'hit.wav', 'tick.wav'])
		await expect(page.getByTestId('project-row').filter({ hasText: n })).toBeVisible({ timeout: 120_000 });
	const items = await query<Record<string, { id: string; name: string; mediaId?: string }>>(page, 'doc.get', {
		path: ['items'],
	});
	const item = (n: string) => Object.values(items).find((i) => i.name === n)!;
	const library = (soundId: string, title: string, types: string[]) => ({
		soundId,
		title,
		types,
		source: { type: 'folder', rootId: 'root_000000000e2e', relPath: `${title}.wav` },
		license: 'CC0-1.0',
		author: 'E2E',
		attribution: null,
	});
	const setup = await transact(page, [
		{ type: 'track.add', kind: 'audio', count: 2 },
		{
			type: 'clip.place',
			source: { projectItemId: item('music.wav').id },
			at: 0,
			tracks: { audio: 'A1' },
			ref: '$m',
		},
		{ type: 'essentialSound.setType', clipIds: ['$m'], audioType: 'music' },
		{ type: 'mixer.setLoudness', enabled: true, targetLufs: -14, truePeakDb: -1 },
		{
			type: 'media.setLibraryInfo',
			mediaId: item('hit.wav').mediaId,
			library: library('snd_0000000000e2e0a1', 'Thump', ['hit']),
		},
		{
			type: 'media.setLibraryInfo',
			mediaId: item('tick.wav').mediaId,
			library: library('snd_0000000000e2e0a2', 'Tick', ['tick']),
		},
		{ type: 'soundCue.add', cues: [{ frame: 30, kind: 'cut', weight: 'hero', source: 'user', ref: '$a' }] },
		{
			type: 'soundDesign.place',
			cueId: '$a',
			layers: [{ mediaId: item('hit.wav').mediaId, role: 'hero', align: 'peak' }],
		},
		{
			type: 'soundCue.add',
			cues: [{ frame: 90, kind: 'cut', weight: 'support', source: 'user', ref: '$b' }],
		},
		{
			type: 'soundDesign.place',
			cueId: '$b',
			layers: [{ mediaId: item('tick.wav').mediaId, role: 'support', align: 'peak' }],
		},
	] as never);
	expect(setup.ok, JSON.stringify(setup)).toBe(true);

	// 1. Run Sound Check; acknowledge ENDING with a reason
	await page.keyboard.press('Alt+Shift+Digit9');
	await menu(page, 'Run Sound Check');
	await expect(panel()).toBeVisible({ timeout: 60_000 });
	await waitVerdict();
	const ending = panel().getByTestId('sound-check-findings').locator('[data-code="ENDING"]');
	await expect(ending).toBeVisible();
	const endingId = (await ending.getAttribute('data-issue-id'))!;
	const verdictBefore = await panel().getByTestId('sound-check-verdict').getAttribute('data-verdict');
	await panel().screenshot({ path: join(outDir, '1-findings.png') });
	const before = await appliedLabels(page);
	await ending.getByTestId('sound-check-acknowledge').click();
	const reason = panel().getByTestId('sound-check-ack-reason');
	await expect(reason).toBeFocused();
	await reason.fill('The cut to black on the hit is the punchline');
	await page.screenshot({ path: join(outDir, '2-ack-editor.png') });
	await reason.press('Enter');
	await expect
		.poll(async () => (await appliedLabels(page)).length, { timeout: 60_000 })
		.toBe(before.length + 1);
	expect((await appliedLabels(page)).at(-1)).toBe('Acknowledge Sound Check Finding');
	await expect(panel().getByTestId('sound-check-findings').locator('[data-code="ENDING"]')).toHaveCount(0);
	const toggle = panel().getByTestId('sound-check-acknowledged-toggle');
	await expect(toggle).toContainText('Acknowledged (1)');
	await toggle.click();
	const ackRow = panel().getByTestId('sound-check-acknowledged-row');
	await expect(ackRow).toHaveAttribute('data-issue-id', endingId);
	await expect(ackRow).toContainText('Reason: The cut to black on the hit is the punchline');
	await expect(ackRow).toContainText('by you');
	await panel().screenshot({ path: join(outDir, '3-acknowledged.png') });

	// 2. the agent's view: the same open findings, ENDING acknowledged; then the panel's re-run agrees
	const agent = await tool<Check>('sound_check', { projectId, images: false });
	const open = agent.issues
		.filter((i) => !i.acknowledged?.active)
		.map((i) => `${i.code}@${i.frame ?? i.range?.start ?? ''}`)
		.sort();
	expect(open).toEqual(await panelOpen());
	expect(agent.acknowledged?.count).toBe(1);
	expect(agent.counts.acknowledged).toBe(1);
	expect(agent.issues.find((i) => i.id === endingId)?.acknowledged).toMatchObject({
		active: true,
		by: 'user',
		reason: 'The cut to black on the hit is the punchline',
	});
	const live = (await panel().getByTestId('sound-check-live').textContent()) ?? '';
	await panel().getByTestId('sound-check-run').click();
	await waitVerdict(live);
	await expect(panel().getByTestId('sound-check-verdict')).toHaveAttribute('data-verdict', agent.verdict);
	expect(await panelOpen()).toEqual(open);
	// ENDING was a warning: with it left out the verdict is no worse than before
	const rank = { pass: 0, warn: 1, fail: 2 } as const;
	expect(rank[agent.verdict as keyof typeof rank]).toBeLessThanOrEqual(
		rank[verdictBefore as keyof typeof rank],
	);

	// 3. the agent proposes the same thump on the next cut (a REPEAT) and checks the proposal first
	const placed = await tool<{ proposalId: string }>('place_sound', {
		projectId,
		at: 60,
		kind: 'cut',
		layers: [{ mediaId: item('hit.wav').mediaId, role: 'support', align: 'peak' }],
	});
	const pc = await tool<Check>('sound_check', { projectId, proposalId: placed.proposalId });
	const repeat = pc.proposal!.introduces.find((l) => l.startsWith('WARNING REPEAT'));
	expect(repeat, JSON.stringify(pc.proposal, null, 1)).toMatch(/— item place$/);
	const summary = pc.proposal!.summary;
	expect(summary).toMatch(/^Sound Check of this proposal: fixes \d+ · introduces \d+/);

	// 4. the user opens it from its card: the Review panel shows the agent's check
	const card = page.locator(`[data-testid="proposal-card"][data-proposal-id="${placed.proposalId}"]`);
	await expect(card).toBeVisible({ timeout: 60_000 });
	await card.getByTestId('proposal-card-review').click();
	await expect(page.getByTestId('review-bar')).toBeVisible();
	const bar = reviewPanel().getByTestId('review-check');
	const engineText = summary.replace(/ \(\d+ errors?\)$/, '');
	await expect(bar.getByTestId('review-check-summary')).toContainText(engineText, { timeout: 60_000 });
	await expect(bar).toHaveAttribute('data-check-state', 'current');
	const link = bar.getByTestId('review-check-introduced').locator('[data-check-item="place"]').first();
	await expect(link).toBeVisible();
	await expect(reviewPanel().locator('[data-review-row="place"] [data-review-check]')).toContainText(
		'introduces',
	);
	await reviewPanel().screenshot({ path: join(outDir, '4-review-check.png') });
	await link.click();
	await expect(reviewPanel().getByTestId('review-item-check')).toContainText('Introduces REPEAT');
	// the ghost card says it too
	await page.locator('[data-ghost-clip][data-ghost-item="place"]').first().click();
	const ghostCard = page.getByTestId('proposal-ghost-card');
	await expect(ghostCard.locator('[data-ghost-check]')).toContainText('Sound Check: introduces');
	await page.screenshot({ path: join(outDir, '5-ghost-card.png') });
	await page.keyboard.press('Escape');

	// 5. Check again in the panel: the same delta (deterministic), nothing applied
	const labelsBefore = await appliedLabels(page);
	await bar.getByTestId('review-check-run').click();
	await expect(bar.getByTestId('review-check-cancel')).toBeHidden({ timeout: CHECK_MS });
	await expect(bar.getByTestId('review-check-summary')).toContainText(engineText);
	expect(await appliedLabels(page)).toEqual(labelsBefore);
	await page.evaluate(() => document.documentElement.setAttribute('data-pr-contrast', 'high'));
	await reviewPanel().screenshot({ path: join(outDir, '6-review-high-contrast.png') });
	await page.evaluate(() => document.documentElement.removeAttribute('data-pr-contrast'));
});
