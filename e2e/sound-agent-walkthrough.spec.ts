// Final verification walkthrough (wp-note "Final verification B"), as an agent: the built jasper-mcp against the built
// engine follows SOUND_GUIDE / PROPOSALS_GUIDE literally — create a project, import footage, music and dialogue, cut
// them with apply_commands → search_sounds (source + material + action + character, contact sheet) → view_sounds →
// find_sound_cues → set_sound_cues {add: the suggestions as returned} → plan_sound_design {check: true} → tell the user →
// wait_for_proposal while the user reviews in the editor (accept all, a note, Apply) → read the decisions and the note →
// sound_check → apply exactly the safe fixes in order → sound_check again → listen_to_sequence {images} →
// view_sound_timeline → describe_search_status (and search_sounds {describe} without the model: keywords) →
// acknowledge_sound_issue on a warning → export_sound_credits. Every claim of the guide that this run touches is
// asserted; every PNG an agent would look at is saved to test-results/e2e-sound-agent (looked at for the wp-note).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect, type Page, test } from '@playwright/test';
import { encodeWav } from '../packages/audio-dsp/src/index.ts';
import { dropMusic } from '../packages/audio-fx/test/music.ts';
import { appliedLabels, enableAgentBridge, FIXTURES, ROOT, serverInfo } from './support.ts';

test.describe.configure({ mode: 'serial' });

const outDir = join(ROOT, 'test-results', 'e2e-sound-agent');
const MCP_BUNDLE = join(ROOT, 'apps/mcp/dist/jasper-mcp.mjs');
const SR = 48_000;
const LONG = 1_500_000;
let page: Page;
let mcp: Client;
let dir = '';
const mcpLog: string[] = [];
const report: Record<string, unknown> = {};
let images = 0;

test.beforeAll(async ({ browser }) => {
	expect(existsSync(MCP_BUNDLE), `${MCP_BUNDLE} is missing: run \`pnpm mcp:build\``).toBe(true);
	mkdirSync(outDir, { recursive: true });
	dir = mkdtempSync(join(tmpdir(), 'jasper-e2e-sound-agent-'));
	writeFileSync(join(dir, 'music.wav'), encodeWav(dropMusic(SR, 120, 12, 5).audio, SR, 's16'));
	const d = new Float32Array(10 * SR);
	for (let i = 0; i < d.length; i++) {
		const t = i / SR;
		if ((t >= 0.5 && t < 3.5) || (t >= 5.5 && t < 8.5))
			d[i] = 0.15 * (0.5 - 0.5 * Math.cos(2 * Math.PI * 4 * t)) * Math.sin(2 * Math.PI * 1500 * t);
	}
	writeFileSync(join(dir, 'dialogue.wav'), encodeWav([d, d.slice()], SR, 's16'));
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
	transport.stderr?.on('data', (b: Buffer) => mcpLog.push(b.toString('utf8')));
	mcp = new Client({ name: 'e2e-sound-agent', version: '1.0.0' });
	await mcp.connect(transport);
});
test.afterAll(async () => {
	writeFileSync(join(outDir, 'agent-walkthrough.json'), JSON.stringify(report, null, 2));
	await mcp?.close().catch(() => {});
	await page?.close();
});

const textOf = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
/** Saves every image of a result as a PNG an agent would look at; returns how many. */
function savePngs(r: CallToolResult, name: string): number {
	let n = 0;
	for (const c of r.content)
		if (c.type === 'image') {
			const file = join(outDir, `${String(++images).padStart(2, '0')}-${name}${n ? `-${n}` : ''}.png`);
			writeFileSync(file, Buffer.from((c as { data: string }).data, 'base64'));
			n++;
		}
	return n;
}
async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
	return (await mcp.callTool({ name, arguments: args }, undefined, { timeout: LONG })) as CallToolResult;
}
async function tool<T>(
	name: string,
	args: Record<string, unknown>,
): Promise<{ body: T; raw: CallToolResult }> {
	const r = await call(name, args);
	expect(r.isError, `${name}: ${textOf(r)}\n${mcpLog.join('').slice(-2000)}`).toBeFalsy();
	// listen_to_sequence answers with the text first, then the JSON
	const json = r.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text);
	let body: T | undefined;
	for (const t of json)
		try {
			body = JSON.parse(t) as T;
			break;
		} catch {}
	return { body: body as T, raw: r };
}

test('agent walkthrough through jasper-mcp: the guide holds', async () => {
	test.setTimeout(7_200_000);
	// set up: a project, footage, music and dialogue, cut by the agent
	const { body: created } = await tool<{ projectId: string }>('create_project', {
		name: 'E2E Agent Sound Walkthrough',
	});
	const projectId = created.projectId;
	const { body: imp } = await tool<{ imported: { mediaId: string; name?: string }[] }>('import_media', {
		projectId,
		paths: [
			join(FIXTURES, 'clip-a.mp4'),
			join(FIXTURES, 'clip-b.mp4'),
			join(dir, 'music.wav'),
			join(dir, 'dialogue.wav'),
		],
	});
	const [a, b, music, dialogue] = imp.imported.map((m) => m.mediaId) as [string, string, string, string];
	const { body: cut } = await tool<{ ok?: boolean }>('apply_commands', {
		projectId,
		label: 'Cut the scene',
		commands: [
			{
				type: 'clip.place',
				source: { mediaId: a },
				sourceRange: { in: { seconds: 0 }, out: { seconds: 5 } },
				at: 0,
				tracks: { video: 'V1' },
				audio: false,
				matchSequence: 'keep',
			},
			{
				type: 'clip.place',
				source: { mediaId: b },
				sourceRange: { in: { seconds: 0 }, out: { seconds: 4 } },
				at: 150,
				tracks: { video: 'V1' },
				audio: false,
				matchSequence: 'keep',
				ref: '$b',
			},
			{
				type: 'clip.place',
				source: { mediaId: a },
				sourceRange: { in: { seconds: 2 }, out: { seconds: 9 } },
				at: 270,
				tracks: { video: 'V1' },
				audio: false,
				matchSequence: 'keep',
				ref: '$c',
			},
			{
				type: 'transition.add',
				clipId: '$c',
				edge: 'in',
				effectId: 'jasper.push',
				duration: 20,
				alignment: 'center',
				params: { direction: 'westToEast' },
			},
			{
				type: 'clip.addText',
				at: 20,
				duration: 100,
				track: 'V2',
				content: { text: 'AGENT CUT' },
				textAnimation: { in: { preset: 'typewriter', durationFrames: 40 } },
			},
			{ type: 'marker.add', frame: 420, name: 'sfx: boom' },
			{
				type: 'clip.place',
				source: { mediaId: music },
				sourceRange: { in: { seconds: 0 }, out: { seconds: 16 } },
				at: 0,
				tracks: { audio: 'A1' },
				ref: '$m',
			},
			{ type: 'essentialSound.setType', clipIds: ['$m'], audioType: 'music' },
			{
				type: 'clip.place',
				source: { mediaId: dialogue },
				sourceRange: { in: { seconds: 0.5 }, out: { seconds: 3.5 } },
				at: 180,
				tracks: { audio: 'A2' },
				ref: '$d',
			},
			{ type: 'essentialSound.setType', clipIds: ['$d'], audioType: 'dialogue' },
		],
	});
	report.cut = cut;
	// the user watches in the editor
	await page.goto(`/project/${encodeURIComponent(projectId)}`);
	await expect(page.getByTestId('editor-shell')).toBeVisible({ timeout: 120_000 });
	await expect.poll(() => page.evaluate(() => !!window.jasper)).toBe(true);
	await page.keyboard.press('Alt+Shift+Digit9');

	// the library is indexed (sound_library_status), then: search with a contact sheet
	await expect
		.poll(
			async () =>
				(await tool<{ sounds?: number; indexing?: unknown }>('sound_library_status', {})).body.sounds ?? 0,
			{
				timeout: 360_000,
				intervals: [2000],
			},
		)
		.toBeGreaterThan(20);
	const { body: found, raw: foundRaw } = await tool<{
		results: {
			soundId: string;
			title: string;
			peakSec: number;
			riseMs: number;
			decayMs: number | null;
			judge: { ok: boolean; score: number; reasons: string[] };
			license: string;
			credit?: string | null;
		}[];
		cells?: unknown[];
		total: number;
	}>('search_sounds', {
		q: 'heavy wooden impact, short and punchy',
		types: ['hit', 'thump'],
		contactSheet: true,
		limit: 6,
	});
	expect(found.results.length).toBeGreaterThan(0);
	for (const r of found.results) {
		expect(r.soundId).toMatch(/^snd_[0-9a-f]{16}/);
		expect(typeof r.peakSec).toBe('number');
		expect(r.judge).toBeTruthy();
		expect(r.license).toBeTruthy();
	}
	// "contactSheet: true also returns ONE PNG with a numbered cell per result … and its cells JSON"
	expect(savePngs(foundRaw, 'search-contact-sheet')).toBe(1);
	report.search = found.results.map((r) => ({
		title: r.title,
		peakSec: r.peakSec,
		riseMs: r.riseMs,
		decayMs: r.decayMs,
		judge: r.judge,
		license: r.license,
	}));
	const { body: viewed, raw: viewRaw } = await tool<{ cells: { soundId: string }[] }>('view_sounds', {
		soundIds: found.results.slice(0, 3).map((r) => r.soundId),
	});
	expect(savePngs(viewRaw, 'view-sounds')).toBe(1);
	expect(viewed.cells.map((c) => c.soundId)).toEqual(found.results.slice(0, 3).map((r) => r.soundId));

	// cues from the edit, stored as returned
	const { body: cues } = await tool<{
		count: number;
		cues: { frame: number; kind: string; weight: string; reason: string; types: string[] }[];
		dialogue: { start: number; end: number }[];
	}>('find_sound_cues', { projectId });
	expect(cues.count).toBeGreaterThan(0);
	for (const c of cues.cues) expect(c.reason, JSON.stringify(c)).toBeTruthy();
	report.cues = {
		count: cues.count,
		kinds: cues.cues.map((c) => `${c.kind}@${c.frame}:${c.weight}`),
		dialogue: cues.dialogue,
	};
	const setRes = await call('set_sound_cues', { projectId, add: cues.cues });
	report.setSoundCuesAsReturned = setRes.isError ? JSON.parse(textOf(setRes)) : 'ok';
	expect(
		setRes.isError,
		`"store the ones you keep with set_sound_cues {add: [the suggestions as returned]}": ${textOf(setRes)}`,
	).toBeFalsy();

	// the whole pass as ONE proposal, checked before it is handed over
	const { body: plan } = await tool<{
		proposalId: string;
		items: number;
		table: string;
		events: {
			itemId: string;
			timecode: string;
			title: string;
			role: string;
			why: string;
			limitedBy?: string[] | null;
			alternatives: unknown[];
		}[];
		soundCheck?: { summary: string; fixes: string[]; introduces: string[] } | null;
		next?: string;
	}>('plan_sound_design', { projectId, check: true, style: { seed: 3 } });
	expect(plan.proposalId).toMatch(/^prp_/);
	expect(plan.events.length).toBeGreaterThan(0);
	// "a per-event report with limitedBy" and "a why-line … ends with its level and what limited it"
	for (const e of plan.events) expect(e.why, JSON.stringify(e)).toMatch(/dB/);
	expect(plan.soundCheck, JSON.stringify(plan).slice(0, 2000)).toBeTruthy();
	report.plan = {
		items: plan.items,
		events: plan.events.map((e) => ({
			tc: e.timecode,
			title: e.title,
			role: e.role,
			why: e.why,
			limitedBy: e.limitedBy,
			alternatives: e.alternatives.length,
		})),
		soundCheck: plan.soundCheck,
		table: plan.table,
	};
	writeFileSync(join(outDir, 'plan-table.txt'), plan.table);

	// tell the user; wait while they review (accept all, a note on one, Apply)
	const waiting = tool<{ status: string; items: { itemId: string; state: string; note?: string }[] }>(
		'wait_for_proposal',
		{
			projectId,
			proposalId: plan.proposalId,
			until: 'decided',
			timeoutSeconds: 900,
		},
	);
	const card = page.locator(`[data-testid="proposal-card"][data-proposal-id="${plan.proposalId}"]`);
	await expect(card).toBeVisible({ timeout: 60_000 });
	await page.screenshot({ path: join(outDir, 'user-card.png') });
	await card.getByTestId('proposal-card-review').click();
	await expect(page.getByTestId('review-bar')).toBeVisible();
	const firstItem = plan.events[0]!.itemId;
	// the note first: wait_for_proposal {until: "decided"} returns once nothing is left to decide (Accept all)
	await page.locator(`[data-review-row="${firstItem}"]`).click();
	await page.getByTestId('review-details').locator('[data-review-detail="note"]').click();
	await page.getByLabel('Note for the agent').fill('Good, but try a softer one here next time');
	await page.getByTestId('review-details').locator('[data-review-detail="save-note"]').click();
	await expect(page.locator(`[data-review-row="${firstItem}"]`)).toHaveAttribute('aria-label', /note: Good, but/);
	await page.getByTestId('review-bar-accept-all').click();
	await page.screenshot({ path: join(outDir, 'user-review.png') });
	const before = await appliedLabels(page);
	await page.locator(`[data-review-row="${firstItem}"]`).click();
	await page.keyboard.press('Control+Enter');
	await expect
		.poll(async () => (await appliedLabels(page)).length, { timeout: 120_000 })
		.toBe(before.length + 1);
	await page.getByTestId('review-bar-exit').click();
	const { body: decided } = await waiting;
	report.waitForProposal = decided;
	expect(['applied', 'decided']).toContain(decided.status);
	expect(decided.items.find((i) => i.itemId === firstItem)?.note).toBe(
		'Good, but try a softer one here next time',
	);

	// Sound Check: apply exactly the safe fixes, in order, once each; check again
	type Check = {
		verdict: string;
		findings: string[];
		issues: {
			id: string;
			code: string;
			severity: string;
			timecode?: string;
			acknowledged?: { active: boolean };
		}[];
		safeFixes: { issueIds: string[]; tool: string; args: Record<string, unknown> }[];
		listen: { timecode: string; reason: string }[];
		next: string;
	};
	const { body: c1, raw: c1raw } = await tool<Check>('sound_check', { projectId });
	savePngs(c1raw, 'sound-check');
	report.check1 = {
		verdict: c1.verdict,
		findings: c1.findings,
		safeFixes: c1.safeFixes.map((f) => f.tool),
		listen: c1.listen,
		next: c1.next,
	};
	// "five listen-here timecodes"
	expect(c1.listen.length).toBeGreaterThan(0);
	expect(c1.listen.length).toBeLessThanOrEqual(5);
	for (const f of c1.safeFixes) {
		const r = await call(f.tool, f.args);
		expect(r.isError, `${f.tool}: ${textOf(r)}`).toBeFalsy();
	}
	const { body: c2 } = await tool<Check>('sound_check', { projectId });
	report.check2 = { verdict: c2.verdict, findings: c2.findings, safeFixes: c2.safeFixes.map((f) => f.tool) };
	// the safe fixes resolved what they were for
	const fixedIds = c1.safeFixes.flatMap((f) => f.issueIds);
	const open2 = c2.issues.filter((i) => !i.acknowledged?.active).map((i) => i.id);
	for (const id of fixedIds) expect(open2, `safe fix for ${id}`).not.toContain(id);

	// ears: the listening transcript (text first, then JSON, then the sheet)
	const listen = await call('listen_to_sequence', { projectId, images: true });
	expect(listen.isError, textOf(listen)).toBeFalsy();
	expect(listen.content[0]!.type).toBe('text');
	const transcript = (listen.content[0] as { text: string }).text;
	writeFileSync(join(outDir, 'listen-transcript.txt'), transcript);
	expect(transcript).toMatch(/\d\d[:;]\d\d[:;]\d\d[:;]\d\d/);
	expect(savePngs(listen, 'listen-sheet')).toBeGreaterThanOrEqual(1);
	report.listenFirstLines = transcript.split('\n').slice(0, 12);
	const { body: vt, raw: vtRaw } = await tool<{ cells: Record<string, unknown> }>('view_sound_timeline', {
		projectId,
		range: { start: 0, end: { seconds: 16 } },
	});
	expect(savePngs(vtRaw, 'sound-timeline')).toBe(1);
	expect(vt.cells).toBeTruthy();

	// Describe-it search: without the model, a description is searched by its words ("describe.mode keywords")
	const { body: ds } = await tool<{ status: string }>('describe_search_status', {});
	report.describeStatus = ds.status;
	const { body: dsearch } = await tool<{ describe?: { mode: string }; results: unknown[] }>('search_sounds', {
		describe: 'a single clean key press on a mechanical keyboard',
		limit: 5,
	});
	report.describeSearch = { mode: dsearch.describe?.mode, results: dsearch.results.length };
	if (ds.status !== 'ready') expect(dsearch.describe?.mode).toBe('keywords');

	// a deliberate exception: acknowledge a warning / info (never an error) with a reason
	const { body: kept } = await tool<Check & { state: string }>('get_sound_check', { projectId });
	const keptOpen = kept.issues.filter((i) => !i.acknowledged?.active);
	const ackable = keptOpen.find((f) => f.severity !== 'error');
	if (ackable) {
		const { body: ack } = await tool<Record<string, unknown>>('acknowledge_sound_issue', {
			projectId,
			key: ackable.id,
			reason: 'The user chose this on purpose in the walkthrough',
		});
		report.acknowledged = { key: ackable.id, result: ack };
		const { body: c3 } = await tool<Check & { acknowledged?: { count: number; findings: string[] } }>(
			'sound_check',
			{ projectId },
		);
		expect(c3.issues.filter((i) => !i.acknowledged?.active).map((i) => i.id)).not.toContain(ackable.id);
		expect(c3.acknowledged?.count ?? 0).toBeGreaterThanOrEqual(1);
	} else report.acknowledged = 'no warning or info left to acknowledge';
	const error = keptOpen.find((f) => f.severity === 'error');
	if (error) {
		const r = await call('acknowledge_sound_issue', { projectId, key: error.id, reason: 'agents may not' });
		expect(r.isError).toBe(true);
		expect(JSON.parse(textOf(r)).error.code).toBe('E_APPROVAL_REQUIRED');
	}

	// credits: listed and exported to a file
	const { body: credits } = await tool<{ count: number; text: string }>('list_sound_credits', { projectId });
	const { body: file } = await tool<{ path: string; count: number }>('export_sound_credits', {
		projectId,
		path: outDir,
	});
	expect(file.count).toBe(credits.count);
	expect(readFileSync(file.path, 'utf8')).toBe(credits.text);
	report.credits = { count: credits.count, path: file.path };
	await page.screenshot({ path: join(outDir, 'user-final.png') });
});
