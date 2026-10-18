// Spec 12 §4 P6-E8 in the built app (wp-note "Phase 6 → WP-E4"): three generated reference soundtracks imported into a
// project → Edit ▸ Preferences ▸ Sound Library ▸ Reference profiles ▸ New Reference Profile… (the three picked from the
// project, Build Profile, its progress, what was measured) → the Sound Check panel's Reference select (one History
// entry) → Run: the Reference group (an AIR info for the dull soundtrack) and the rows table → jasper-mcp `sound_check`
// gives the same rows with the same statuses → Export… downloads the file, Import… reads it back, Delete… asks first.
// Screenshots (looked at): test-results/e2e-sound-reference-profile.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect, type Page, test } from '@playwright/test';
import { appliedLabels, enableAgentBridge, query, ROOT, serverInfo, transact } from './support.ts';

test.describe.configure({ mode: 'serial' });

const outDir = join(ROOT, 'test-results', 'e2e-sound-reference-profile');
const MCP_BUNDLE = join(ROOT, 'apps/mcp/dist/jasper-mcp.mjs');
const LONG = 900_000;
const SR = 48_000;
let page: Page;
let mcp: Client;
const mcpLog: string[] = [];

function rng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s = (Math.imul(s, 1103515245) + 12345) >>> 0;
		return (s / 2 ** 32) * 2 - 1;
	};
}
/** 12 s of quiet stereo noise with a 3 kHz click every second (`dull`: low-passed noise, no air). */
function soundtrack(seed: number, dull = false): Buffer {
	const n = 12 * SR;
	const r = rng(seed);
	const ch = [new Float32Array(n), new Float32Array(n)];
	let y0 = 0;
	let y1 = 0;
	for (let i = 0; i < n; i++) {
		const a = r() * 0.02;
		const b = r() * 0.02;
		y0 = dull ? y0 + 0.05 * (a - y0) : a;
		y1 = dull ? y1 + 0.05 * (b - y1) : b;
		ch[0]![i] = y0 * (dull ? 4 : 1);
		ch[1]![i] = y1 * (dull ? 4 : 1);
	}
	for (let t = 0.5; t < 12; t += 1)
		for (const c of ch) {
			const at = Math.round(t * SR);
			for (let i = 0; i < 0.02 * SR; i++)
				c[at + i]! += 0.5 * Math.exp(-i / (SR * 0.003)) * Math.sin((2 * Math.PI * 3000 * i) / SR);
		}
	const b = Buffer.alloc(44 + n * 4);
	b.write('RIFF', 0);
	b.writeUInt32LE(36 + n * 4, 4);
	b.write('WAVEfmt ', 8);
	b.writeUInt32LE(16, 16);
	b.writeUInt16LE(1, 20);
	b.writeUInt16LE(2, 22);
	b.writeUInt32LE(SR, 24);
	b.writeUInt32LE(SR * 4, 28);
	b.writeUInt16LE(4, 32);
	b.writeUInt16LE(16, 34);
	b.write('data', 36);
	b.writeUInt32LE(n * 4, 40);
	for (let i = 0; i < n; i++)
		for (let k = 0; k < 2; k++)
			b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(ch[k]![i]! * 32767))), 44 + (i * 2 + k) * 2);
	return b;
}

test.beforeAll(async ({ browser }) => {
	expect(existsSync(MCP_BUNDLE), `${MCP_BUNDLE} is missing: run \`pnpm mcp:build\``).toBe(true);
	mkdirSync(join(outDir, 'media'), { recursive: true });
	page = await browser.newPage({ viewport: { width: 1800, height: 1050 }, acceptDownloads: true });
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
	mcp = new Client({ name: 'e2e-sound-profile', version: '1.0.0' });
	await mcp.connect(transport);
});
test.afterAll(async () => {
	await mcp?.close().catch(() => {});
	await page?.close();
});

const text = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
async function tool<T>(name: string, args: Record<string, unknown>): Promise<T> {
	const r = (await mcp.callTool({ name, arguments: args }, undefined, { timeout: LONG })) as CallToolResult;
	expect(r.isError, `${name}: ${text(r)}\n${mcpLog.join('').slice(-2000)}`).toBeFalsy();
	return JSON.parse(text(r)) as T;
}
async function menu(p: Page, item: string) {
	const menubar = p.getByTestId('title-bar').getByRole('menubar');
	await menubar.getByRole('menuitem', { name: 'Sequence', exact: true }).click();
	await p.getByRole('menuitem', { name: 'Sound Design' }).hover();
	await p.getByRole('menuitem', { name: item, exact: true }).click();
}
async function openSoundPrefs(p: Page) {
	await p.getByTestId('title-bar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
	await p.getByRole('menuitem', { name: /^Preferences$/ }).hover();
	await p.getByRole('menuitem', { name: /^Preferences…/ }).click();
	const prefs = p.getByTestId('preferences-dialog');
	await expect(prefs).toBeVisible();
	await prefs.getByTestId('prefs-page-sound-library').click();
	return prefs;
}
const panel = () => page.locator('[data-panel-kind="soundCheck"][data-instance-id]');

test('build a reference profile from project media, compare the sequence in Sound Check, the same in MCP; export, import, delete', async () => {
	test.setTimeout(3_600_000);
	await page.goto('/');
	await expect(page.getByTestId('home')).toBeVisible({ timeout: 120_000 });
	await page.getByTestId('home-new').click();
	await page.getByTestId('new-project-name').fill('E2E Reference Profile');
	await page.getByTestId('new-project-create').click();
	await expect(page.getByTestId('editor-shell')).toBeVisible({ timeout: 180_000 });
	await expect.poll(() => page.evaluate(() => !!window.jasper), { timeout: 120_000 }).toBe(true);
	const projectId = decodeURIComponent(/\/project\/([^/?#]+)/.exec(page.url())![1]!);

	// three reference soundtracks and the sequence's own (dull: no air)
	const names = ['Episode 1.wav', 'Episode 2.wav', 'Episode 3.wav', 'Draft mix.wav'];
	const files = names.map((n, i) => {
		const p = join(outDir, 'media', n);
		writeFileSync(p, soundtrack(i + 1, i === 3));
		return p;
	});
	await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Control+KeyI');
	await (await chooser).setFiles(files);
	for (const n of names)
		await expect(page.getByTestId('project-row').filter({ hasText: n })).toBeVisible({ timeout: 120_000 });
	const items = await query<Record<string, { id: string; name: string; mediaId?: string }>>(page, 'doc.get', {
		path: ['items'],
	});
	const item = (n: string) => Object.values(items).find((i) => i.name === n)!;
	const setup = await transact(page, [
		{
			type: 'clip.place',
			source: { projectItemId: item('Draft mix.wav').id },
			at: 0,
			tracks: { audio: 'A1' },
		},
	] as never);
	expect(setup.ok, JSON.stringify(setup)).toBe(true);

	// 1. Preferences ▸ Sound Library ▸ Reference profiles ▸ New Reference Profile…
	let prefs = await openSoundPrefs(page);
	const section = prefs.getByTestId('prefs-sound-profiles');
	await section.scrollIntoViewIfNeeded();
	// Profiles are the engine's, not the project's: a repeat in the same server (--repeat-each) meets what an earlier
	// run left if it failed before deleting its own, so this run counts from what is there and names its profile apart.
	const profiles = section.locator('[data-sound-profile]');
	await expect(section.getByTestId('sound-profiles-empty').or(profiles.first())).toBeVisible({
		timeout: 60_000,
	});
	const earlier = await profiles.count();
	if (earlier === 0) await expect(section.getByTestId('sound-profiles-empty')).toBeVisible();
	const repeat = test.info().repeatEachIndex;
	const name = repeat ? `My channel ${repeat + 1}` : 'My channel';
	const named = (n: string) =>
		profiles.filter({ has: page.getByRole('button', { name: `Rename ${n}`, exact: true }) });
	await section.getByTestId('sound-profiles-new').click();
	const dialog = section.getByTestId('new-reference-profile-form');
	await expect(dialog).toBeVisible();
	await dialog.getByTestId('new-reference-profile-name').fill(name);
	for (const n of names.slice(0, 3)) await dialog.getByRole('checkbox', { name: n }).click();
	await page.screenshot({ path: join(outDir, '1-new-profile-dialog.png') });
	await dialog.getByRole('button', { name: 'Build Profile' }).click();
	await expect(dialog.getByTestId('new-reference-profile-result')).toBeVisible({ timeout: LONG });
	await expect(dialog.getByTestId('new-reference-profile-result')).toContainText(
		`“${name}”: 3 references measured.`,
	);
	await page.screenshot({ path: join(outDir, '2-new-profile-result.png') });
	await dialog.getByRole('button', { name: 'Done' }).click();
	await expect(dialog).toBeHidden();
	await expect(profiles).toHaveCount(earlier + 1, { timeout: 60_000 });
	const row = named(name);
	await expect(row).toHaveCount(1);
	await expect(row).toContainText('3 references: Episode 1.wav, Episode 2.wav, Episode 3.wav');
	const profileId = (await row.getAttribute('data-sound-profile'))!;
	await section.screenshot({ path: join(outDir, '3-prefs-profiles.png') });
	await page.keyboard.press('Escape');
	await expect(prefs).toBeHidden();

	// 2. Sound Check: select the profile (one History entry), Run
	await page.keyboard.press('Alt+Shift+Digit9');
	await menu(page, 'Run Sound Check');
	await expect(panel()).toBeVisible({ timeout: 60_000 });
	await expect(panel().getByTestId('sound-check-verdict')).toBeVisible({ timeout: LONG });
	const before = await appliedLabels(page);
	await panel().getByTestId('sound-check-reference').getByRole('combobox').click();
	await page.getByRole('option', { name: `${name} (3 references)`, exact: true }).click();
	await expect
		.poll(async () => (await appliedLabels(page)).at(-1), { timeout: 60_000 })
		.toBe('Compare with Reference Profile');
	expect((await appliedLabels(page)).length).toBe(before.length + 1);
	await panel().getByTestId('sound-check-run').click();
	const rows = panel().getByTestId('sound-check-reference-rows');
	await expect(rows).toBeVisible({ timeout: LONG });
	await expect(panel().getByTestId('sound-check-progress')).toBeHidden({ timeout: LONG });
	await expect(rows.locator('[data-reference-metric="band_air"]')).toHaveAttribute(
		'data-reference-status',
		'low',
	);
	const air = panel().getByTestId('sound-check-findings').locator('[data-issue-id="REFERENCE:band_air"]');
	await expect(air).toBeVisible();
	await air.scrollIntoViewIfNeeded();
	await panel().screenshot({ path: join(outDir, '4-sound-check-reference.png') });
	await rows.scrollIntoViewIfNeeded();
	await panel().screenshot({ path: join(outDir, '4b-reference-differences.png') });
	await rows.getByTestId('sound-check-reference-all').click();
	await rows.scrollIntoViewIfNeeded();
	const statuses = Object.fromEntries(
		await rows
			.locator('[data-reference-metric]')
			.evaluateAll((els) =>
				els.map((e) => [e.getAttribute('data-reference-metric'), e.getAttribute('data-reference-status')]),
			),
	);
	await panel().screenshot({ path: join(outDir, '5-reference-all-rows.png') });

	// 3. MCP: the same rows with the same statuses
	const agent = await tool<{ jobId: string; reference: { rows: string[] } }>('sound_check', {
		projectId,
		images: false,
	});
	const job = await tool<{
		result: { report: { reference: { rows: { metric: string; status: string }[] } } };
	}>('get_job', { jobId: agent.jobId });
	const mcpStatuses = Object.fromEntries(job.result.report.reference.rows.map((r) => [r.metric, r.status]));
	expect(mcpStatuses).toEqual(statuses);
	expect(agent.reference.rows).toHaveLength(Object.keys(statuses).length);
	expect(agent.reference.rows.find((l) => l.includes('(band_air, minor)'))).toMatch(
		/^LOW Air 8–16 kHz share/,
	);

	// 4. export, import, delete (asks first)
	prefs = await openSoundPrefs(page);
	const sec = prefs.getByTestId('prefs-sound-profiles');
	await sec.scrollIntoViewIfNeeded();
	const download = page.waitForEvent('download');
	await sec.getByTestId(`sound-profile-export-${profileId}`).click();
	const saved = join(outDir, 'exported.sound-profile.json');
	await (await download).saveAs(saved);
	const file = JSON.parse(readFileSync(saved, 'utf8')) as {
		format: string;
		id: string;
		references: unknown[];
	};
	expect(file).toMatchObject({ format: 'jasper-sound-profile', id: profileId });
	expect(file.references).toHaveLength(3);
	expect(readFileSync(saved, 'utf8')).not.toContain(join(outDir, 'media'));
	await sec.getByTestId('sound-profiles-import-file').setInputFiles(saved);
	await expect(profiles).toHaveCount(earlier + 2, { timeout: 60_000 });
	// the copy gets a distinct name
	const copy = named(`${name} (2)`);
	await expect(copy).toHaveCount(1);
	const copyId = (await copy.getAttribute('data-sound-profile'))!;
	await sec.getByTestId(`sound-profile-delete-${profileId}`).click();
	const confirm = page.getByTestId('confirm-dialog');
	await expect(confirm).toContainText('building it again needs its 3 references');
	await page.screenshot({ path: join(outDir, '6-delete-confirm.png') });
	await confirm.getByRole('button', { name: 'Delete Profile' }).click();
	await expect(profiles).toHaveCount(earlier + 1, { timeout: 60_000 });
	await expect(sec.locator(`[data-sound-profile="${profileId}"]`)).toHaveCount(0);
	await sec.screenshot({ path: join(outDir, '7-after-import-delete.png') });
	// the imported copy goes too: the engine keeps no profile of this test
	await sec.getByTestId(`sound-profile-delete-${copyId}`).click();
	await confirm.getByRole('button', { name: 'Delete Profile' }).click();
	await expect(profiles).toHaveCount(earlier, { timeout: 60_000 });
	await page.keyboard.press('Escape');
	await expect(prefs).toBeHidden();
});
