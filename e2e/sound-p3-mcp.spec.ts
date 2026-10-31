// Spec 12 Phase 3 end to end, driven by an MCP agent (Phase 3 verification): jasper-mcp over stdio (the built bundle,
// the token, no editor key) plans a sound pass with `plan_sound_design` (style.cueSources) → the card says it waits
// while `wait_for_proposal` polls → the user reviews in the editor (reject one, accept two, an alternate, a note) and
// applies them with Ctrl+Enter (one History entry) → `wait_for_proposal` returns the decisions and the note → the
// agent's `accept_proposal` is refused (E_APPROVAL_REQUIRED) → the user turns on "Allow agents to apply sound
// proposals" in Preferences (a real click) → the agent's `accept_proposal "all"` applies the rest (one "Agent:" History
// entry) → the agent exports with `start_export` → every placed sound peaks where the document puts it (ffmpeg +
// cross-correlation). Screenshots: test-results/e2e-sound-p3-mcp.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { FIXTURE_COMMANDS } from '../apps/mcp/test/sound-cues-fixture.ts';
import {
	appliedLabels,
	browserLaunch,
	createProject,
	enableAgentBridge,
	query,
	ROOT,
	serverInfo,
	transact,
} from './support.ts';

test.use({ launchOptions: browserLaunch(['--autoplay-policy=no-user-gesture-required']) });
test.describe.configure({ mode: 'serial' });

const outDir = join(ROOT, 'test-results', 'e2e-sound-p3-mcp');
const MCP_BUNDLE = join(ROOT, 'apps/mcp/dist/jasper-mcp.mjs');
const FLICKS = 705_600_000;
let page: Page;
let mcp: Client;
const mcpLog: string[] = [];

const text = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
	return (await mcp.callTool({ name, arguments: args }, undefined, { timeout: 900_000 })) as CallToolResult;
}
async function tool<T>(name: string, args: Record<string, unknown>): Promise<T> {
	const r = await call(name, args);
	expect(r.isError, `${name}: ${text(r)}\n${mcpLog.join('').slice(-2000)}`).toBeFalsy();
	return JSON.parse(text(r)) as T;
}
async function toolError(name: string, args: Record<string, unknown>) {
	const r = await call(name, args);
	expect(r.isError, `${name} should fail: ${text(r)}`).toBe(true);
	return (JSON.parse(text(r)) as { error: { code: string; message: string; hint?: string } }).error;
}

test.beforeAll(async ({ browser }) => {
	expect(existsSync(MCP_BUNDLE), `${MCP_BUNDLE} is missing: run \`pnpm mcp:build\``).toBe(true);
	mkdirSync(outDir, { recursive: true });
	page = await browser.newPage({ viewport: { width: 1800, height: 1050 } });
	await enableAgentBridge(page);
	// jasper-mcp finds the E2E engine the way it finds a user's: <appdir>/engine/runtime.json (token, no editor key)
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env))
		if (v !== undefined && !k.startsWith('JASPER_')) env[k] = v;
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [MCP_BUNDLE, '--appdir', serverInfo().appdir, '--toolsets', 'all'],
		env,
		stderr: 'pipe',
	});
	transport.stderr?.on('data', (d: Buffer) => mcpLog.push(d.toString('utf8')));
	mcp = new Client({ name: 'e2e-p3-agent', version: '1.0.0' });
	await mcp.connect(transport);
});
test.afterAll(async () => {
	await mcp?.close().catch(() => {});
	await page?.close();
});

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
	start: number;
	sourceIn: number;
	mediaId: string;
	speed: { rate: number };
	sfx?: { cueId: string | null; placement: { align: string; peakFlicks: number } };
};
type Seq = {
	clips: Record<string, Clip>;
	settings: { frameRate: { num: number; den: number } };
	soundDesign?: { cues?: Record<string, { id: string; frame: number; placedClipIds?: string[] }> };
};
async function sequence(): Promise<Seq> {
	const seqs = await query<Record<string, Seq>>(page, 'doc.get', { path: ['sequences'] });
	return Object.values(seqs)[0]!;
}

function decodeMono(file: string, rate = 1): Float32Array {
	const af = rate === 1 ? 'pan=mono|c0=c0' : `pan=mono|c0=c0,asetrate=48000*${rate},aresample=48000`;
	const raw = execFileSync(
		process.env.JASPER_FFMPEG ?? 'ffmpeg',
		['-v', 'error', '-i', file, '-map', '0:a:0', '-af', af, '-ar', '48000', '-f', 'f32le', '-'],
		{ maxBuffer: 256 * 1024 * 1024 },
	);
	return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
}
function locate(mix: Float32Array, ref: Float32Array, w0: number, w1: number, guess: number, span: number) {
	let best = { lag: Number.NaN, r: -2 };
	let rr = 0;
	for (let i = w0; i < w1; i++) rr += ref[i]! * ref[i]!;
	for (let lag = guess - span; lag <= guess + span; lag++) {
		let xy = 0;
		let xx = 0;
		for (let i = w0; i < w1; i++) {
			const x = mix[lag + i] ?? 0;
			xy += x * ref[i]!;
			xx += x * x;
		}
		const r = xx > 0 && rr > 0 ? xy / Math.sqrt(xx * rr) : -1;
		if (r > best.r) best = { lag, r };
	}
	return best;
}

/**
 * The normalised correlation of `mix[lag + i]` with `ref[i]` over [w0, w1) at the best fractional delay of `ref`
 * (−0.5 … +0.5 sample in tenths, windowed sinc, 33 taps). A varispeed clip's samples fall between the reference's:
 * measured on a bright whoosh at rate 0.987 (sound-p3-mcp, Final verification A), r 0.938 at the integer lag and
 * 0.9995 at a 0.3-sample delay (a 33-tap filter took the reference to the mix within −92 dB).
 */
function subSampleCorrelation(mix: Float32Array, ref: Float32Array, w0: number, w1: number, lag: number) {
	const K = 16;
	let best = { r: -2, delay: 0 };
	for (let tenth = -5; tenth <= 5; tenth++) {
		const d = tenth / 10;
		const h: number[] = [];
		for (let k = -K; k <= K; k++) {
			const x = k - d;
			const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
			h.push(sinc * (0.5 + 0.5 * Math.cos((Math.PI * x) / (K + 1))));
		}
		let xy = 0;
		let xx = 0;
		let yy = 0;
		for (let i = w0; i < w1; i++) {
			let y = 0;
			for (let k = -K; k <= K; k++) y += h[k + K]! * (ref[i - k] ?? 0);
			const x = mix[lag + i] ?? 0;
			xy += x * y;
			xx += x * x;
			yy += y * y;
		}
		const r = xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : -1;
		if (r > best.r) best = { r, delay: d };
	}
	return best;
}

const reviewPanel = () => page.locator('[data-panel-kind="review"][data-instance-id]');
const row = (id: string) => page.locator(`[data-review-row="${id}"]`);

type Planned = { proposalId: string };
type WaitItem = { itemId: string; state: string; note?: string; swapped?: { alternative: number } };
type Waited = {
	status: string;
	updatedAt: string;
	items: WaitItem[];
	notes?: { itemId: string; note: string }[];
};

test('an MCP agent proposes, the user reviews and applies, the agent reads the review, is refused, then allowed; export peaks', async ({
	request,
}) => {
	test.setTimeout(1_800_000);
	const projectId = await createProject(page, 'E2E Sound MCP');
	const r = await transact(page, FIXTURE_COMMANDS as never);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	const cues = await transact(page, [
		{
			type: 'soundCue.add',
			cues: [
				{ frame: 90, kind: 'cut', weight: 'support', types: ['hit'], source: 'user' },
				{ frame: 180, kind: 'transition', weight: 'support', types: ['whoosh'], source: 'user' },
				{ frame: 300, kind: 'cut', weight: 'support', types: ['hit'], source: 'user' },
			],
		},
	] as never);
	expect(cues.ok, JSON.stringify(cues)).toBe(true);
	await libraryReady(request);
	await page.keyboard.press('Alt+Shift+Digit9');
	await expect(reviewPanel()).toBeVisible({ timeout: 60_000 });
	const before = await appliedLabels(page);

	// 1. the agent plans: the three stored cues plus the cues derived from the markers only (style.cueSources). On a
	// loaded host the job can outlast one call: the tool then names the job, and the agent waits for it (wait_for_job).
	const planned = await call('plan_sound_design', {
		projectId,
		style: { seed: 7, cueSources: ['markers'] },
		timeoutSeconds: 900,
	});
	expect(planned.isError, `plan_sound_design: ${text(planned)}\n${mcpLog.join('').slice(-2000)}`).toBeFalsy();
	let planBody = JSON.parse(text(planned)) as Partial<Planned> & { jobId?: string };
	for (let i = 0; !planBody.proposalId && planBody.jobId && i < 6; i++) {
		const j = await tool<{ timedOut?: boolean; result?: { proposalId?: string | null } }>('wait_for_job', {
			jobId: planBody.jobId,
			timeoutSeconds: 900,
		});
		if (!j.timedOut) planBody = { ...planBody, proposalId: j.result?.proposalId ?? undefined };
	}
	const proposalId = planBody.proposalId!;
	expect(proposalId, JSON.stringify(planBody).slice(0, 2000)).toMatch(/^prp_/);
	type StoredItem = { id: string; meta?: { setup?: boolean; frame?: number } };
	const storedItems = async () =>
		(
			(await (await request.get(`/api/projects/${projectId}/proposals/${proposalId}`)).json()) as {
				proposal: { items: StoredItem[] };
			}
		).proposal.items;
	const placeItems = (await storedItems()).filter((it) => !it.meta?.setup);
	const plan = {
		proposalId,
		events: placeItems.map((it) => ({ itemId: it.id, frame: it.meta?.frame ?? -1 })),
	};
	const frames = plan.events.map((e) => e.frame).sort((a, b) => a - b);
	expect(frames).toEqual([90, 180, 250, 300]); // 250: the "sfx: boom+swoosh" marker; no other derived source
	expect(await appliedLabels(page)).toEqual(before); // nothing applied

	// 2. the agent waits for the review: the card says so
	const firstWait = tool<Waited>('wait_for_proposal', {
		projectId,
		proposalId: plan.proposalId,
		timeoutSeconds: 600,
	});
	const card = page.locator(`[data-testid="proposal-card"][data-proposal-id="${plan.proposalId}"]`);
	await expect(card).toBeVisible({ timeout: 60_000 });
	await expect(card.getByTestId('proposal-card-waiting')).toHaveText(
		'e2e-p3-agent is waiting for your review',
		{
			timeout: 30_000,
		},
	);
	await page.screenshot({ path: join(outDir, '1-card-waiting.png') });
	await card.getByTestId('proposal-card-review').click();
	await expect(page.getByTestId('review-bar')).toBeVisible();
	const byFrame = new Map(plan.events.map((e) => [e.frame, e.itemId]));
	const [i90, i180, i250, i300] = [90, 180, 250, 300].map((f) => byFrame.get(f)!) as [
		string,
		string,
		string,
		string,
	];
	await expect(reviewPanel().locator('[data-review-row]')).toHaveCount(4);
	await page.screenshot({ path: join(outDir, '2-review.png') });

	// 3. the user rejects the marker's item: the agent's wait returns with it
	await row(i250).click();
	await page.keyboard.press('Backspace');
	await expect(row(i250)).toHaveAttribute('data-review-state', 'rejected');
	const w1 = await firstWait;
	expect(w1.status).toBe('changed');
	expect(w1.items.find((i) => i.itemId === i250)?.state).toBe('rejected');

	// 4. accept two, an alternate on one, a note on the other; Ctrl+Enter = ONE History entry
	await row(i90).click();
	await page.keyboard.press('Enter');
	await page.getByTestId('review-details').getByRole('button', { name: 'Next alternate' }).click();
	await expect(page.getByTestId('review-details').locator('[data-review-alt-label]')).toContainText(
		'Alternate 2/',
	);
	await row(i180).click();
	await page.keyboard.press('Enter');
	await page.getByTestId('review-details').locator('[data-review-detail="note"]').click();
	await page.getByLabel('Note for the agent').fill('Softer whoosh, please');
	await page.getByTestId('review-details').locator('[data-review-detail="save-note"]').click();
	await expect(page.getByTestId('review-apply')).toHaveText('Apply 2 of 4');
	await page.screenshot({ path: join(outDir, '3-decided.png') });
	await row(i90).click();
	await page.keyboard.press('Control+Enter');
	await expect
		.poll(async () => (await appliedLabels(page)).length, { timeout: 120_000 })
		.toBe(before.length + 1);
	expect((await appliedLabels(page)).at(-1)).toMatch(/^Accept Sound design: /);
	await expect(
		page.getByTestId('toast').filter({ hasText: 'Applied 2 of 4 sounds from e2e-p3-agent' }),
	).toBeVisible();
	await page.screenshot({ path: join(outDir, '4-applied.png') });

	// 5. the agent reads the review: decisions, the alternate, the note
	const w2 = await tool<Waited>('wait_for_proposal', {
		projectId,
		proposalId: plan.proposalId,
		since: w1.updatedAt,
		timeoutSeconds: 120,
	});
	const st = (id: string) => w2.items.find((i) => i.itemId === id);
	expect([st(i90)?.state, st(i180)?.state, st(i250)?.state, st(i300)?.state]).toEqual([
		'accepted',
		'accepted',
		'rejected',
		'pending',
	]);
	expect(st(i90)?.swapped?.alternative).toBe(1);
	expect(w2.notes?.map((x) => [x.itemId, x.note])).toEqual([[i180, 'Softer whoosh, please']]);

	// 6. the agent may not apply the rest itself
	const refused = await toolError('accept_proposal', {
		projectId,
		proposalId: plan.proposalId,
		itemIds: 'all',
	});
	expect(refused.code).toBe('E_APPROVAL_REQUIRED');
	expect(refused.hint ?? refused.message).toMatch(/Review panel|Allow agents/);
	expect((await appliedLabels(page)).length).toBe(before.length + 1);

	// 7. the user allows agents to apply sound proposals (Preferences ▸ Sound Library ▸ Proposals, a real click)
	await page.getByTestId('review-bar-exit').click();
	await page.getByTestId('title-bar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
	await page.getByRole('menuitem', { name: /^Preferences$/ }).hover();
	await page.getByRole('menuitem', { name: /^Preferences…/ }).click();
	const prefs = page.getByTestId('preferences-dialog');
	await expect(prefs).toBeVisible();
	await prefs.getByTestId('prefs-page-sound-library').click();
	const allow = prefs.getByTestId('prefs-sound-proposals').getByRole('checkbox');
	await expect(allow).toHaveAttribute('aria-checked', 'false');
	await allow.click();
	await expect(allow).toHaveAttribute('aria-checked', 'true');
	await prefs.screenshot({ path: join(outDir, '5-preference.png') });
	await page.keyboard.press('Escape');
	await expect(prefs).toBeHidden();
	expect((await appliedLabels(page)).at(-1)).toBe('Allow Agents to Apply Sound Proposals');

	// 8. now the agent applies the rest: one more History entry, the agent's
	const n = (await appliedLabels(page)).length;
	const ok = await tool<{ applied: string[]; revision: number }>('accept_proposal', {
		projectId,
		proposalId: plan.proposalId,
		itemIds: 'all',
	});
	expect(ok.applied).toContain(i300);
	expect(ok.applied).not.toContain(i250); // the user's rejection stands
	await expect.poll(async () => (await appliedLabels(page)).length, { timeout: 60_000 }).toBe(n + 1);
	expect((await appliedLabels(page)).at(-1)).toMatch(/^Agent: Accept Sound design: /);
	const w3 = await tool<Waited>('wait_for_proposal', {
		projectId,
		proposalId: plan.proposalId,
		until: 'decided',
		timeoutSeconds: 60,
	});
	expect(['applied', 'decided']).toContain(w3.status);
	await page.screenshot({ path: join(outDir, '6-agent-applied.png') });

	// 9. the agent exports; every placed, peak-aligned sound is where the document puts it
	const seq = await sequence();
	const placed = Object.values(seq.soundDesign?.cues ?? {})
		.filter((c) => (c.placedClipIds ?? []).some((id) => seq.clips[id]))
		.sort((a, b) => a.frame - b.frame);
	expect(placed.map((c) => c.frame)).toEqual([90, 180, 300]);
	// PCM audio (ProRes master): the default preset's AAC drops and smears the top octaves, so a bright sound's
	// correlation with its source fell to 0.86–0.92 whenever the plan picked one (Phase 4 verification: residual within
	// 1 dB of the signal over 16 kHz, 7 dB under it at 8–12 kHz) — the peak positions were exact (lag 0). A varispeed
	// clip still lands between the reference's samples: the correlation is taken at its sub-sample delay.
	const exported = await tool<{ path?: string; result?: { path?: string }; state?: string }>('start_export', {
		projectId,
		preset: 'master-prores-422hq',
		wait: true,
		timeoutSeconds: 1500,
		outputPath: join(outDir, 'p3-mcp.mov'),
	});
	const file = exported.result?.path ?? exported.path ?? join(outDir, 'p3-mcp.mov');
	expect(existsSync(file), JSON.stringify(exported)).toBe(true);
	const mix = decodeMono(file);
	const SR = 48_000;
	const F = (FLICKS * seq.settings.frameRate.den) / seq.settings.frameRate.num;
	type MediaRow = { locators: { type: string; key?: string }[] };
	const mediaDoc = await query<Record<string, MediaRow>>(page, 'doc.get', { path: ['media'] });
	const report: Record<string, unknown>[] = [];
	for (const cue of placed) {
		for (const id of (cue.placedClipIds ?? []).filter((x) => seq.clips[x])) {
			const c = seq.clips[id]!;
			if (c.sfx?.placement.align !== 'peak') continue;
			const key = mediaDoc[c.mediaId]!.locators.find((l) => l.type === 'engine-store')?.key;
			const res = await request.get(`/media/${encodeURIComponent(key!)}`);
			expect(res.ok()).toBe(true);
			const local = join(outDir, `${c.id}.media`);
			writeFileSync(local, await res.body());
			const ref = decodeMono(local, c.speed.rate);
			const refPoint = Math.round(((c.sfx.placement.peakFlicks / FLICKS) * SR) / c.speed.rate);
			const w0 = Math.max(0, refPoint - 4800);
			const w1 = Math.min(ref.length, refPoint + 4800);
			const clipStart = Math.round(((c.start * F - c.sourceIn / c.speed.rate) / FLICKS) * SR);
			const found = locate(mix, ref, w0, w1, clipStart, 960);
			const docPoint = Math.round(
				((c.start * F + (c.sfx.placement.peakFlicks - c.sourceIn) / c.speed.rate) / FLICKS) * SR,
			);
			const cueSample = Math.round(((cue.frame * F) / FLICKS) * SR);
			const fine = subSampleCorrelation(mix, ref, w0, w1, found.lag);
			report.push({
				cue: cue.frame,
				rate: c.speed.rate,
				r: Number(found.r.toFixed(3)),
				rFine: Number(fine.r.toFixed(4)),
				delaySamples: fine.delay,
				vsDocument: found.lag + refPoint - docPoint,
				fromCueFrame: found.lag + refPoint - cueSample,
			});
			// what else sounds within the measured window (±0.1 s around the peak) and the clip itself, if it fails
			const docSec = docPoint / SR;
			const near = Object.values(seq.clips)
				.filter((o) => o.id !== c.id && o.mediaId)
				.filter((o) => {
					const s0 = (o.start * F) / FLICKS;
					const len = ((o as unknown as { duration: number }).duration * F) / FLICKS;
					return s0 < docSec + 0.1 && s0 + len > docSec - 0.1;
				})
				.map((o) => o.id);
			const why = JSON.stringify({ row: report.at(-1), near, clip: c });
			// the sound itself (a chance match over 9 600 samples is a few hundredths), at its sub-sample position
			expect(fine.r, why).toBeGreaterThan(0.95);
			expect(Math.abs(found.lag + refPoint - docPoint), why).toBeLessThanOrEqual(2);
		}
	}
	writeFileSync(join(outDir, 'peaks.json'), JSON.stringify(report, null, 2));
	test.info().annotations.push({ type: 'peaks', description: JSON.stringify(report) });
	expect(report.length).toBeGreaterThanOrEqual(3);
});
