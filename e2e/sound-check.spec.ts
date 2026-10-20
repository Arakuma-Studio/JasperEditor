// Spec 12 Phase 5 in the built app (WP5.2, P5-R3 and the Phase 5 "Done when": the panel and the MCP tool show the same
// report): the Phase 2 fixture with generated music on A1 → Auto Sound Pass… ("Music carries the cuts" off) → Accept
// all → Apply → seeded defects: a hit on a cut nudged 2 frames late, 0.8 s of the music cut out (digital silence) →
// Sequence ▸ Sound Design ▸ Run Sound Check → the panel shows OUT_OF_SYNC (the nudged hit, at its cue's timecode) and
// SILENCE (at the hole) → the sync strip (5 stills + waveform) → listen here: Sounds right on one moment, Flag + note
// on another (user comment markers) → jasper-mcp `sound_check` on the same project returns the same codes at the same
// frames as the panel, and the two verdicts as humanVerdicts → Export with "Run Sound Check before export": the fail
// prompt → Review issues → Fix (align) = one History entry → Fix all safe (one entry, the check again) → Fix… on the
// silence (intended) → Re-run: both findings gone. Screenshots (looked at): test-results/e2e-sound-check.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { FIXTURE_COMMANDS } from '../apps/mcp/test/sound-cues-fixture.ts';
import {
	appliedLabels,
	browserLaunch,
	enableAgentBridge,
	focusTimeline,
	query,
	ROOT,
	serverInfo,
	transact,
} from './support.ts';

test.use({ launchOptions: browserLaunch(['--autoplay-policy=no-user-gesture-required']) });
test.describe.configure({ mode: 'serial' });

const outDir = join(ROOT, 'test-results', 'e2e-sound-check');
const FFMPEG = process.env.JASPER_FFMPEG ?? 'ffmpeg';
const MCP_BUNDLE = join(ROOT, 'apps/mcp/dist/jasper-mcp.mjs');
const CHECK_MS = 1_200_000;
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
	mcp = new Client({ name: 'e2e-sound-check', version: '1.0.0' });
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

type Clip = {
	id: string;
	kind: string;
	start: number;
	duration: number;
	trackId: string;
	essential?: { type?: string };
	sfx?: { cueId: string | null; placement?: { align: string } };
};
type Seq = {
	id: string;
	clips: Record<string, Clip>;
	markers: { id: string; frame: number; name: string; comment: string; type: string; author: unknown }[];
	soundDesign?: { cues?: Record<string, { id: string; frame: number; kind: string }> };
};
async function sequence(p: Page): Promise<Seq> {
	const seqs = await query<Record<string, Seq>>(p, 'doc.get', { path: ['sequences'] });
	return Object.values(seqs)[0]!;
}

async function menu(p: Page, item: string) {
	const menubar = p.getByTestId('title-bar').getByRole('menubar');
	await menubar.getByRole('menuitem', { name: 'Sequence', exact: true }).click();
	await p.getByRole('menuitem', { name: 'Sound Design' }).hover();
	await p.getByRole('menuitem', { name: item, exact: true }).click();
}

const panel = () => page.locator('[data-panel-kind="soundCheck"][data-instance-id]');
const rows = () => panel().locator('[data-issue-id]');
/** The panel's findings as "CODE@frame" (sorted), as the MCP tool gives them. */
async function panelFindings(): Promise<string[]> {
	const list = await rows().evaluateAll((els) =>
		els.map((e) => `${e.getAttribute('data-code')}@${e.getAttribute('data-frame') ?? ''}`),
	);
	return list.sort();
}
async function waitVerdict(previousRun?: string) {
	await expect(panel().getByTestId('sound-check-verdict')).toBeVisible({ timeout: CHECK_MS });
	await expect(panel().getByTestId('sound-check-progress')).toBeHidden({ timeout: CHECK_MS });
	if (previousRun)
		await expect
			.poll(async () => (await panel().getByTestId('sound-check-live').textContent()) ?? '', {
				timeout: CHECK_MS,
			})
			.not.toBe(previousRun);
}

test('Sound Check panel: seeded defects found with timecodes, the same as MCP; verdicts; export prompt; fixes', async ({
	request,
}) => {
	test.setTimeout(5_400_000);
	const projectId = await createProject(page, 'E2E Sound Check');
	const music = wav('music.wav', 'anoisesrc=d=14:c=pink:a=0.08:seed=7', 14);
	await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Control+KeyI');
	await (await chooser).setFiles([music]);
	await expect(page.getByTestId('project-row').filter({ hasText: 'music.wav' })).toBeVisible({
		timeout: 120_000,
	});
	const items = await query<Record<string, { id: string; name: string }>>(page, 'doc.get', {
		path: ['items'],
	});
	const musicItem = Object.values(items).find((i) => i.name === 'music.wav')!.id;
	const setup = await transact(page, [
		...((FIXTURE_COMMANDS as { type: string }[]).filter(
			(c) => c.type !== 'clip.addMotionGraphic',
		) as never[]),
		{ type: 'clip.place', source: { projectItemId: musicItem }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
		{ type: 'essentialSound.setType', clipIds: ['$m'], audioType: 'music' },
	] as never);
	expect(setup.ok, JSON.stringify(setup)).toBe(true);
	await libraryReady(request);
	await page.keyboard.press('Alt+Shift+Digit9');
	// the Sound Design workspace has the panel next to Review (a background tab)
	await expect(page.getByRole('tab', { name: 'Sound Check' })).toBeVisible({ timeout: 60_000 });

	// 1. a sound pass, accepted and applied
	await menu(page, 'Auto Sound Pass…');
	const dialog = page.getByTestId('auto-sound-pass-dialog');
	await expect(dialog).toBeVisible();
	// The seeded sync defect is a hit on the cut at 90, under the music. "Music carries the cuts" (P6-E10, default on)
	// halves a cut's confidence under music and the density budget then leaves it without a sound; this scenario wants
	// the cut's hit, so the user turns the option off (spec 12 §4 "Music carries the cuts").
	const carries = dialog
		.getByTestId('auto-pass-style')
		.getByRole('checkbox', { name: 'Music carries the cuts (fewer cut sounds under music)' });
	await expect(carries).toBeChecked();
	await carries.click();
	await expect(carries).not.toBeChecked();
	await dialog.getByRole('button', { name: 'Propose' }).click();
	// review opens; a plan with notes keeps the dialog open listing them until Close (Phase 4 verification)
	await expect(page.getByTestId('review-bar')).toBeVisible({ timeout: 1_500_000 });
	if (await dialog.getByTestId('auto-pass-notes').isVisible())
		await dialog.locator('[data-dialog-primary]').click();
	await expect(dialog).toBeHidden();
	const before = await appliedLabels(page);
	await page.getByTestId('review-bar-accept-all').click();
	await page.getByTestId('review-bar-apply').click();
	await expect
		.poll(async () => (await appliedLabels(page)).length, { timeout: 120_000 })
		.toBe(before.length + 1);
	await page.getByTestId('review-bar-exit').click();

	// 2. seeded defects: the hit on the cut at 90 two frames late; 0.8 s (frames 360–384) of the music cut out
	let seq = await sequence(page);
	const cues = seq.soundDesign?.cues ?? {};
	const sfx = Object.values(seq.clips).filter((c) => c.sfx?.cueId && cues[c.sfx.cueId]);
	const onCut = sfx
		.filter((c) => cues[c.sfx!.cueId!]!.kind === 'cut' && c.sfx?.placement?.align !== 'end')
		.sort((a, b) => cues[a.sfx!.cueId!]!.frame - cues[b.sfx!.cueId!]!.frame);
	let nudged: Clip | undefined;
	for (const c of onCut) {
		const r = await transact(page, [{ type: 'clip.move', clipIds: [c.id], deltaFrames: 2 }] as never);
		if (r.ok) {
			nudged = c;
			break;
		}
	}
	expect(
		nudged,
		JSON.stringify({
			onCut: onCut.map((c) => c.id),
			cues: Object.values(cues).map((c) => [c.frame, c.kind]),
			sfx: Object.values(seq.clips)
				.filter((c) => c.sfx)
				.map((c) => [c.start, c.sfx!.cueId && cues[c.sfx!.cueId]?.frame, c.sfx!.placement?.align]),
		}),
	).toBeTruthy();
	const cueFrame = cues[nudged!.sfx!.cueId!]!.frame;
	const musicClip = Object.values(seq.clips).find((c) => c.essential?.type === 'music')!;
	expect((await transact(page, [{ type: 'clip.split', at: 360, clipIds: [musicClip.id] }] as never)).ok).toBe(
		true,
	);
	seq = await sequence(page);
	const tail = Object.values(seq.clips).find((c) => c.essential?.type === 'music' && c.start === 360)!;
	expect((await transact(page, [{ type: 'clip.split', at: 384, clipIds: [tail.id] }] as never)).ok).toBe(
		true,
	);
	seq = await sequence(page);
	const hole = Object.values(seq.clips).find((c) => c.essential?.type === 'music' && c.start === 360)!;
	expect((await transact(page, [{ type: 'clip.lift', clipIds: [hole.id] }] as never)).ok).toBe(true);
	seq = await sequence(page);
	// nothing else sounds in the hole
	const inHole = Object.values(seq.clips).filter(
		(c) => c.kind === 'audio' && c.start < 384 && c.start + c.duration > 360,
	);
	expect(inHole.map((c) => c.id)).toEqual([]);

	// 3. Sequence ▸ Sound Design ▸ Run Sound Check
	await menu(page, 'Run Sound Check');
	await expect(panel()).toBeVisible({ timeout: 60_000 });
	await waitVerdict();
	await expect(panel().getByTestId('sound-check-verdict')).toHaveAttribute('data-verdict', 'fail');
	const sync = panel().locator(`[data-issue-id="OUT_OF_SYNC:${nudged!.id}"]`);
	await expect(sync).toBeVisible();
	await expect(sync).toHaveAttribute('data-frame', String(cueFrame));
	await expect(sync.getByTestId('sound-check-message')).toContainText(/ms late/);
	const silence = panel().locator('[data-code="SILENCE"]').first();
	await expect(silence).toBeVisible();
	const silenceFrame = Number(await silence.getAttribute('data-frame'));
	expect(Math.abs(silenceFrame - 360)).toBeLessThanOrEqual(3);
	const tcOf = async (row: typeof sync) =>
		(await row.getByTestId('sound-check-timecode').textContent()) ?? '';
	expect(await tcOf(sync)).toMatch(/^00[:;]00[:;]0\d[:;]\d\d$/);
	expect(await tcOf(silence)).toMatch(/^00[:;]00[:;]12[:;]0\d$/);
	await panel().screenshot({ path: join(outDir, 'panel.png') });
	await page.evaluate(() => document.documentElement.setAttribute('data-pr-contrast', 'high'));
	await panel().screenshot({ path: join(outDir, 'panel-high-contrast.png') });
	await page.evaluate(() => document.documentElement.removeAttribute('data-pr-contrast'));
	// the timecode jumps the playhead and selects the clip
	await sync.getByTestId('sound-check-timecode').click();
	await expect.poll(async () => (await query<{ frame: number }>(page, 'playhead.get')).frame).toBe(cueFrame);
	await expect
		.poll(
			async () =>
				(await query<{ selection: { timeline: { clips: string[] } } }>(page, 'selection.get')).selection
					.timeline.clips,
		)
		.toContain(nudged!.id);
	// the sync strip: 5 frames above the waveform, the picture and the measured line
	await sync.getByTestId('sound-check-strip-toggle').click();
	const strip = sync.getByTestId('sound-check-sync-strip');
	await expect(strip.getByTestId('sound-check-thumb')).toHaveCount(5, { timeout: 300_000 });
	// the sound-effects stem drawn over the bed (Phase 5 verification), with its legend
	await expect(strip.getByTestId('sound-check-wave-sfx')).toBeAttached({ timeout: 60_000 });
	await expect(strip.getByTestId('sound-check-wave-bed')).toBeAttached();
	await expect(strip.getByTestId('sound-check-wave-legend')).toContainText('Sound effects');
	// (a vertical SVG line has no width: Playwright calls it hidden, so check that it is drawn)
	await expect(strip.getByTestId('sound-check-peak-line')).toBeAttached();
	await expect(strip.getByTestId('sound-check-event-line')).toBeAttached();
	await expect(strip.getByTestId('sound-check-wave')).toHaveAttribute('aria-label', /late \(2\.\d frames\)/);
	await strip.screenshot({ path: join(outDir, 'sync-strip.png') });

	// 4. listen here: Sounds right on the first moment after the worst, Flag + note on the worst
	const listen = panel().getByTestId('sound-check-listen-row');
	await expect(listen.first()).toBeVisible();
	const worst = listen.first();
	const other = listen.nth(1);
	const worstFrame = Number(await worst.getAttribute('data-frame'));
	const otherFrame = Number(await other.getAttribute('data-frame'));
	await other.getByTestId('sound-check-sounds-right').click();
	await worst.getByTestId('sound-check-flag').click();
	await panel().getByTestId('sound-check-note-input').fill('The hit lands after the cut');
	await panel().getByTestId('sound-check-note-save').click();
	await expect(worst).toHaveAttribute('data-verdict', 'flag');
	await expect(other).toHaveAttribute('data-verdict', 'ok');
	seq = await sequence(page);
	const verdictMarkers = seq.markers
		.filter((m) => m.name.startsWith('Sound Check: '))
		.map((m) => ({ frame: m.frame, name: m.name, comment: m.comment, type: m.type, author: m.author }))
		.sort((a, b) => a.frame - b.frame);
	expect(verdictMarkers).toEqual(
		[
			{
				frame: worstFrame,
				name: 'Sound Check: flagged',
				comment: 'The hit lands after the cut',
				type: 'comment',
				author: 'user',
			},
			{ frame: otherFrame, name: 'Sound Check: sounds right', comment: '', type: 'comment', author: 'user' },
		].sort((a, b) => a.frame - b.frame),
	);
	await panel()
		.getByTestId('sound-check-listen')
		.screenshot({ path: join(outDir, 'listen-here.png') });
	// Play all keeps playing while a verdict is given (Phase 5 verification): the verdict is recorded, the chain goes on
	const playAll = panel().getByTestId('sound-check-play-all');
	await playAll.click();
	await expect(playAll).toHaveText(/Stop/);
	const labelsBefore = await appliedLabels(page);
	await other.getByTestId('sound-check-sounds-right').click();
	await expect.poll(async () => (await appliedLabels(page)).length).toBe(labelsBefore.length + 1);
	await expect(playAll).toHaveText(/Stop/);
	await playAll.click();
	await expect(playAll).toHaveText(/Play all/);

	// 5. the agent's view of the same project: the same findings at the same frames, and the user's verdicts
	const shown = await panelFindings();
	type McpCheck = {
		verdict: string;
		issues: { code: string; frame?: number; range?: { start: number } }[];
		listen: string[];
		humanVerdicts: {
			frame: number;
			verdict: string;
			note: string | null;
			slot?: string;
			clipId?: string;
			stale: boolean | null;
		}[];
	};
	const agent = await tool<McpCheck>('sound_check', { projectId, images: false, timeoutSeconds: 1200 });
	const agentFindings = agent.issues.map((i) => `${i.code}@${i.frame ?? i.range?.start ?? ''}`).sort();
	expect(agentFindings).toEqual(shown);
	expect(agent.verdict).toBe('fail');
	expect(agent.humanVerdicts.map(({ frame, verdict, note }) => ({ frame, verdict, note }))).toEqual(
		[
			{ frame: worstFrame, verdict: 'flagged', note: 'The hit lands after the cut' },
			{ frame: otherFrame, verdict: 'sounds right', note: null },
		].sort((a, b) => a.frame - b.frame),
	);
	expect(agent.humanVerdicts.find((v) => v.frame === worstFrame)?.slot).toBe('worst');
	// bound to the moment they judged, and current (nothing changed since the user listened)
	expect(agent.humanVerdicts.every((v) => v.stale === false)).toBe(true);
	expect(agent.humanVerdicts.find((v) => v.frame === worstFrame)?.clipId).toBe(nudged!.id);
	// the last report as the engine keeps it: current
	const kept = await tool<{ state: string; verdict: string }>('get_sound_check', { projectId });
	expect(kept).toMatchObject({ state: 'current', verdict: 'fail' });

	// 6. Export with "Run Sound Check before export": it fails → the prompt → Review issues opens the panel
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyM');
	await expect(page.getByTestId('export-mode')).toBeVisible();
	const toggle = page.getByTestId('export-sound-check-toggle');
	await expect(toggle).toBeVisible();
	if (!(await toggle.isChecked())) await toggle.check();
	await expect(page.getByTestId('plan-path')).toBeVisible({ timeout: 60_000 });
	await expect(page.getByTestId('export-start')).toBeEnabled({ timeout: 60_000 });
	await page.getByTestId('export-start').click();
	const prompt = page.getByTestId('export-sound-check-prompt');
	await expect(prompt).toBeVisible({ timeout: CHECK_MS });
	await expect(prompt).toContainText(/Fail.*Sound Check: \d+ errors?/);
	await page.screenshot({ path: join(outDir, 'export-prompt.png') });
	await prompt.getByTestId('export-sound-check-review').click();
	await expect(page.getByTestId('export-mode')).toBeHidden();
	await expect(panel()).toBeVisible();

	// 7. Fix (align) = one History entry; Fix all safe = one entry + the check again; Fix… the silence; Re-run
	let labels = await appliedLabels(page);
	await panel().locator(`[data-issue-id="OUT_OF_SYNC:${nudged!.id}"]`).getByTestId('sound-check-fix').click();
	await expect
		.poll(async () => (await appliedLabels(page)).slice(labels.length), { timeout: 120_000 })
		.toEqual(['Sound Check Fix: Align its peak to the cue']);
	seq = await sequence(page);
	expect(seq.clips[nudged!.id]!.start).toBe(nudged!.start);
	await expect(panel().getByTestId('sound-check-stale')).toBeVisible();
	labels = await appliedLabels(page);
	const live = (await panel().getByTestId('sound-check-live').textContent()) ?? '';
	const fixAll = panel().getByTestId('sound-check-fix-all');
	if (await fixAll.isEnabled()) {
		await fixAll.click();
		await waitVerdict(live);
		const after = (await appliedLabels(page)).slice(labels.length);
		expect(after.at(-1)).toBe('Sound Check Result');
		// the document fixes are ONE entry (engine jobs, when there are any, are their own)
		expect(after.filter((l) => /Sound Check Finding/.test(l)).length).toBe(1);
	} else {
		await panel().getByTestId('sound-check-rerun').click();
		await waitVerdict(live);
	}
	await expect(panel().locator(`[data-issue-id="OUT_OF_SYNC:${nudged!.id}"]`)).toHaveCount(0);
	await panel().screenshot({ path: join(outDir, 'after-fix-all.png') });
	const silence2 = panel().locator('[data-code="SILENCE"]').first();
	await expect(silence2).toBeVisible();
	labels = await appliedLabels(page);
	// a fix that needs judgement asks first, naming what it changes (Phase 5 verification)
	await silence2.getByTestId('sound-check-fix').click();
	const confirm = page.getByTestId('confirm-dialog');
	await expect(confirm).toBeVisible();
	await expect(confirm).toContainText('This will change: Adds a silence cue');
	await expect(confirm).toContainText('Only if the silence is intended');
	await page.screenshot({ path: join(outDir, 'fix-confirm.png') });
	await confirm.getByRole('button', { name: 'Apply Fix' }).click();
	await expect
		.poll(async () => (await appliedLabels(page)).slice(labels.length), { timeout: 60_000 })
		.toEqual(['Sound Check Fix: Mark it as intended silence (a silence cue)']);

	const live2 = (await panel().getByTestId('sound-check-live').textContent()) ?? '';
	await panel().getByTestId('sound-check-rerun').click();
	await waitVerdict(live2);
	await expect(panel().locator(`[data-issue-id="OUT_OF_SYNC:${nudged!.id}"]`)).toHaveCount(0);
	expect((await panelFindings()).filter((f) => f.startsWith('SILENCE@'))).toEqual([]);
	await panel().screenshot({ path: join(outDir, 'final.png') });
	// and the agent sees the same again
	const final = await tool<McpCheck>('sound_check', { projectId, images: false, timeoutSeconds: 1200 });
	expect(final.issues.map((i) => `${i.code}@${i.frame ?? i.range?.start ?? ''}`).sort()).toEqual(
		await panelFindings(),
	);
	// the flag on the late hit no longer covers it: the hit moved back on its cue since the user listened
	const flagged = final.humanVerdicts.find((v) => v.frame === worstFrame);
	expect(flagged).toMatchObject({ verdict: 'flagged', clipId: nudged!.id, stale: true });
	expect((flagged as { staleReasons?: string[] }).staleReasons).toEqual(expect.arrayContaining(['moved']));
});
