// Spec 12 Phase 3 "Done when" (WP3.3b) in the built app: an agent's proposal (the engine's sound-design plan, run by an
// agent with the token and no editor key) appears as a card ("… proposes …: n sounds on k new tracks", "… is waiting for
// your review" while it polls) → Review → in the Review panel accept two, reject one, cycle an alternate, write a note →
// Ctrl+Enter applies them as ONE History entry ("Applied n of m sounds from <agent>") → Ctrl+Z → Reopen review: the
// decisions are intact → a cue moves under an accepted item → it shows stale with why, and Apply reports it stale. Then
// Sequence ▸ Sound Design ▸ Auto Sound Pass… → Propose → review → Accept all → Apply → native export: every placed,
// peak-aligned sound peaks on its cue frame (ffmpeg + cross-correlation). Screenshots: test-results/e2e-sound-review.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { FIXTURE_COMMANDS } from '../apps/mcp/test/sound-cues-fixture.ts';
import {
	appliedLabels,
	createProject,
	enableAgentBridge,
	exportViaUi,
	focusTimeline,
	query,
	ROOT,
	serverInfo,
	transact,
} from './support.ts';

test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });
test.describe.configure({ mode: 'serial' });

const outDir = join(ROOT, 'test-results', 'e2e-sound-review');
const FLICKS = 705_600_000;
const AGENT = 'e2e-sound-agent';
let page: Page;

test.beforeAll(async ({ browser }) => {
	mkdirSync(outDir, { recursive: true });
	page = await browser.newPage({ viewport: { width: 1800, height: 1050 } });
	await enableAgentBridge(page);
});
test.afterAll(async () => {
	await page?.close();
});

/** The engine as an agent (jasper-mcp's way): the token, no editor key. */
async function asAgent<T>(
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; json: T }> {
	const { port } = serverInfo();
	const r = await fetch(`http://127.0.0.1:${port}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${process.env.E2E_TOKEN}`,
			'x-jasper-agent': AGENT,
			'content-type': 'application/json',
		},
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	});
	return { status: r.status, json: (await r.json()) as T };
}

/** The starter kit is indexed by the throwaway engine on start; wait for it. */
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

type Item = {
	id: string;
	state: string;
	selectedAlternative?: number;
	note?: string;
	label: string;
	meta?: { setup?: boolean; frame?: number; cueId?: string; soundId?: string; title?: string };
	alternatives?: { label: string; meta?: { soundId?: string } }[];
};
type Proposal = { id: string; title: string; items: Item[] };

async function stored(projectId: string, proposalId: string): Promise<Proposal> {
	const r = await asAgent<{ proposal: Proposal }>(
		'GET',
		`/api/projects/${projectId}/proposals/${proposalId}?revalidate=1`,
	);
	expect(r.status).toBe(200);
	return r.json.proposal;
}

type Clip = {
	id: string;
	kind: string;
	start: number;
	sourceIn: number;
	mediaId: string;
	speed: { rate: number };
	sfx?: { cueId: string | null; soundId: string | null; placement: { align: string; peakFlicks: number } };
};
type Seq = {
	clips: Record<string, Clip>;
	settings: { frameRate: { num: number; den: number } };
	soundDesign?: { cues?: Record<string, { id: string; frame: number; placedClipIds?: string[] }> };
};
async function sequence(p: Page): Promise<Seq> {
	const seqs = await query<Record<string, Seq>>(p, 'doc.get', { path: ['sequences'] });
	return Object.values(seqs)[0]!;
}

const reviewPanel = () => page.locator('[data-panel-kind="review"][data-instance-id]');
const row = (id: string) => page.locator(`[data-review-row="${id}"]`);

test('agent proposal → card → review: accept, reject, alternate, note → Apply (one step) → undo → reopen → stale', async ({
	request,
}) => {
	test.setTimeout(900_000);
	const projectId = await createProject(page, 'E2E Sound Review');
	const r = await transact(page, FIXTURE_COMMANDS as never);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	await libraryReady(request);
	// four stored cues the agent fills (a stored cue anchors its placement: moving it makes the item stale)
	const cues = await transact(page, [
		{
			type: 'soundCue.add',
			cues: [
				{ frame: 90, kind: 'cut', weight: 'support', types: ['hit'], source: 'user' },
				{ frame: 180, kind: 'transition', weight: 'support', types: ['whoosh'], source: 'user' },
				{ frame: 250, kind: 'manual', weight: 'hero', types: ['boom'], source: 'user' },
				{ frame: 300, kind: 'cut', weight: 'support', types: ['hit'], source: 'user' },
			],
		},
	] as never);
	expect(cues.ok, JSON.stringify(cues)).toBe(true);
	const cueIds = Object.values((await sequence(page)).soundDesign!.cues!)
		.sort((a, b) => a.frame - b.frame)
		.map((c) => c.id);
	// the Sound Design workspace: Review below the Library
	await page.keyboard.press('Alt+Shift+Digit9');
	await expect(reviewPanel()).toBeVisible({ timeout: 60_000 });

	// the agent plans (POST /api/sound-design/plan as an agent): a proposal, nothing applied
	const before = await appliedLabels(page);
	const plan = await asAgent<{ id: string }>('POST', '/api/sound-design/plan', {
		projectId,
		cues: cueIds,
		style: { seed: 7 },
	});
	expect(plan.status, JSON.stringify(plan.json)).toBe(202);
	let job: { state: string; result?: { proposalId: string | null }; error?: unknown } = { state: 'queued' };
	await expect
		.poll(
			async () => {
				job = (await asAgent<typeof job>('GET', `/api/jobs/${plan.json.id}`)).json;
				return job.state;
			},
			{ timeout: 240_000, intervals: [500] },
		)
		.toMatch(/succeeded|failed/);
	expect(job.state, JSON.stringify(job.error ?? null)).toBe('succeeded');
	const proposalId = job.result!.proposalId!;
	expect(proposalId).toMatch(/^prp_/);
	expect(await appliedLabels(page)).toEqual(before);

	// the card; the agent waits (wait_for_proposal polls the proposal without revalidating)
	let polling = true;
	const poll = (async () => {
		while (polling) {
			await asAgent('GET', `/api/projects/${projectId}/proposals/${proposalId}`);
			await new Promise((res) => setTimeout(res, 800));
		}
	})();
	const card = page.locator(`[data-testid="proposal-card"][data-proposal-id="${proposalId}"]`);
	await expect(card).toBeVisible({ timeout: 30_000 });
	await expect(card.getByTestId('proposal-card-text')).toHaveText(
		new RegExp(`^${AGENT} proposes Sound design: .+: \\d+ sounds? on \\d+ new tracks?$`),
		{ timeout: 30_000 },
	);
	await expect(card.getByTestId('proposal-card-waiting')).toHaveText(`${AGENT} is waiting for your review`, {
		timeout: 15_000,
	});
	await page.screenshot({ path: join(outDir, 'card.png') });
	await card.getByTestId('proposal-card-review').click();
	await expect(page.getByTestId('review-bar')).toBeVisible();
	await expect(card).toBeHidden();
	await expect(page.getByTestId('review-bar-waiting')).toContainText('is waiting for your review');
	polling = false;
	await poll;

	const p0 = await stored(projectId, proposalId);
	const place = p0.items
		.filter((i) => !i.meta?.setup)
		.sort((a, b) => (a.meta!.frame ?? 0) - (b.meta!.frame ?? 0));
	expect(place).toHaveLength(4);
	const [cut, push, boom, last] = place as [Item, Item, Item, Item];
	await expect(reviewPanel().locator('[data-review-row]')).toHaveCount(4);
	// entering review zoomed the timeline to the proposal: every ghost is inside the track area
	const area = (await page.getByTestId('timeline-clip-area').boundingBox())!;
	const ghosts = page.locator('[data-ghost-clip]');
	await expect(ghosts).toHaveCount(4);
	for (const g of await ghosts.all()) {
		const b = (await g.boundingBox())!;
		expect(b.x).toBeGreaterThanOrEqual(area.x - 1);
		expect(b.x + b.width).toBeLessThanOrEqual(area.x + area.width + 1);
	}
	await page.screenshot({ path: join(outDir, 'review.png') });

	// decisions in the Review panel (keyboard in the list: the Review scope)
	await row(cut.id).click();
	expect(await query<{ frame: number }>(page, 'playhead.get')).toMatchObject({ frame: 90 });
	await expect(page.getByTestId('review-details')).toContainText(cut.label);
	await page.keyboard.press('Enter');
	await expect(row(cut.id)).toHaveAttribute('data-review-state', 'accepted');
	await row(push.id).click();
	await page.keyboard.press('Enter');
	await expect(row(push.id)).toHaveAttribute('data-review-state', 'accepted');
	await row(boom.id).click();
	await page.keyboard.press('Backspace');
	await expect(row(boom.id)).toHaveAttribute('data-review-state', 'rejected');
	// alternate on the cut: ⇄ in the details
	await row(cut.id).click();
	await page.getByTestId('review-details').getByRole('button', { name: 'Next alternate' }).click();
	await expect(page.getByTestId('review-details').locator('[data-review-alt-label]')).toContainText(
		'Alternate 2/',
	);
	// a note on the push
	await row(push.id).click();
	await page.getByTestId('review-details').locator('[data-review-detail="note"]').click();
	await page.getByLabel('Note for the agent').fill('A bit softer, please');
	await page.getByTestId('review-details').locator('[data-review-detail="save-note"]').click();
	await expect(row(push.id)).toHaveAttribute('aria-label', /note: A bit softer, please/);
	await expect(page.getByTestId('review-apply')).toHaveText('Apply 2 of 4');
	await page.screenshot({ path: join(outDir, 'decided.png') });
	// high contrast: state by glyph and word, 2 px solid ghost strokes
	await page.evaluate(() => document.documentElement.setAttribute('data-pr-contrast', 'high'));
	await page.screenshot({ path: join(outDir, 'decided-high-contrast.png') });
	await page.evaluate(() => document.documentElement.removeAttribute('data-pr-contrast'));
	let s = await stored(projectId, proposalId);
	const st = (id: string) => s.items.find((i) => i.id === id)!;
	expect(st(boom.id).state).toBe('rejected');
	expect(st(cut.id).selectedAlternative).toBe(1);
	expect(st(push.id).note).toBe('A bit softer, please');

	// Apply with Ctrl+Enter (a real key press) = ONE History entry
	await row(cut.id).click();
	await page.keyboard.press('Control+Enter');
	await expect
		.poll(async () => (await appliedLabels(page)).length, { timeout: 60_000 })
		.toBe(before.length + 1);
	expect((await appliedLabels(page)).at(-1)).toMatch(/^Accept Sound design: /);
	const toast = page.getByTestId('toast').filter({ hasText: `Applied 2 of 4 sounds from ${AGENT}` });
	await expect(toast).toBeVisible();
	await page.screenshot({ path: join(outDir, 'applied.png') });
	s = await stored(projectId, proposalId);
	expect([st(cut.id).state, st(push.id).state, st(boom.id).state, st(last.id).state]).toEqual([
		'accepted',
		'accepted',
		'rejected',
		'pending',
	]);
	// the cut got its alternate's sound
	let seq = await sequence(page);
	const cutClip = Object.values(seq.clips).find((c) => c.sfx?.cueId === cut.meta!.cueId)!;
	expect(cutClip).toBeTruthy();
	const altSound = cut.alternatives?.[0]?.meta?.soundId;
	if (altSound) expect(cutClip.sfx!.soundId).toBe(altSound);

	// leave review, Ctrl+Z, then the toast's Reopen review: decisions intact. The toast lasts 15 s; on a loaded host the
	// steps in between can take longer, so the pointer rests on it (hovering pauses it, as for a user reading it).
	await page.getByTestId('review-bar-exit').click();
	await expect(page.getByTestId('review-bar')).toBeHidden();
	await focusTimeline(page);
	await toast.hover();
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await appliedLabels(page)).length).toBe(before.length);
	await toast.getByRole('button', { name: 'Reopen review' }).click();
	await expect(page.getByTestId('review-bar')).toBeVisible();
	await expect(row(cut.id)).toHaveAttribute('data-review-state', 'accepted');
	await expect(row(push.id)).toHaveAttribute('data-review-state', 'accepted');
	await expect(row(boom.id)).toHaveAttribute('data-review-state', 'rejected');
	await expect(row(last.id)).toHaveAttribute('data-review-state', 'pending');
	s = await stored(projectId, proposalId);
	expect([st(cut.id).state, st(push.id).state]).toEqual(['pending', 'pending']);
	expect(st(cut.id).selectedAlternative).toBe(1);
	expect(st(push.id).note).toBe('A bit softer, please');
	await page.screenshot({ path: join(outDir, 'reopened.png') });

	// the document changes under an accepted item: its cue moves → stale with why; Apply reports it
	const moved = await transact(page, [
		{ type: 'soundCue.update', cueId: cut.meta!.cueId, frame: 100 },
	] as never);
	expect(moved.ok, JSON.stringify(moved)).toBe(true);
	await expect(row(cut.id)).toHaveAttribute('data-review-state', 'stale', { timeout: 15_000 });
	await expect(row(cut.id)).toContainText(/cue at 00:00:03:00 moved to 00:00:03:10/);
	await page.screenshot({ path: join(outDir, 'stale.png') });
	const n = (await appliedLabels(page)).length;
	await row(push.id).click();
	await page.keyboard.press('Control+Enter');
	await expect.poll(async () => (await appliedLabels(page)).length, { timeout: 60_000 }).toBe(n + 1);
	const toast2 = page.getByTestId('toast').filter({ hasText: /Applied 1 of 4 sounds/ });
	await expect(toast2).toBeVisible();
	await expect(toast2).toContainText('stale items left in review');
	s = await stored(projectId, proposalId);
	expect(st(push.id).state).toBe('accepted');
	expect(['stale', 'pending']).toContain(st(cut.id).state);
	seq = await sequence(page);
	expect(Object.values(seq.clips).some((c) => c.sfx?.cueId === cut.meta!.cueId)).toBe(false);
	await page.getByTestId('review-bar-exit').click();
});

/** The first channel as 48 kHz float samples (ffmpeg); `rate` ≠ 1 plays it varispeed like a clip speed. */
function decodeMono(file: string, rate = 1): Float32Array {
	const af = rate === 1 ? 'pan=mono|c0=c0' : `pan=mono|c0=c0,asetrate=48000*${rate},aresample=48000`;
	const raw = execFileSync(
		process.env.JASPER_FFMPEG ?? 'ffmpeg',
		['-v', 'error', '-i', file, '-map', '0:a:0', '-af', af, '-ar', '48000', '-f', 'f32le', '-'],
		{ maxBuffer: 256 * 1024 * 1024 },
	);
	return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
}

/** The lag of `ref[w0, w1)` in `mix` around `guess` (± `span` samples) with the largest normalised correlation. */
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

test('Auto Sound Pass… → Propose → review → Accept all → Apply → export: peaks on the cue frames', async ({
	request,
}) => {
	test.setTimeout(1_200_000);
	await createProject(page, 'E2E Auto Sound Pass');
	const r = await transact(page, [
		{ type: 'clip.addSolid', at: 0, duration: 75, track: 'V1', color: [0.8, 0.2, 0.2, 1] },
		{ type: 'clip.addSolid', at: 75, duration: 75, track: 'V1', color: [0.2, 0.6, 0.2, 1] },
		{ type: 'clip.addSolid', at: 150, duration: 75, track: 'V1', color: [0.2, 0.3, 0.8, 1] },
		{ type: 'clip.addSolid', at: 225, duration: 75, track: 'V1', color: [0.7, 0.7, 0.2, 1] },
	] as never);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	await libraryReady(request);
	await page.keyboard.press('Alt+Shift+Digit9');
	await expect(reviewPanel()).toBeVisible({ timeout: 60_000 });
	const menubar = page.getByTestId('title-bar').getByRole('menubar');
	await menubar.getByRole('menuitem', { name: 'Sequence', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Sound Design' }).hover();
	await page.getByRole('menuitem', { name: 'Auto Sound Pass…' }).click();
	const dialog = page.getByTestId('auto-sound-pass-dialog');
	await expect(dialog).toBeVisible();
	await expect(dialog.locator('[data-cue-source-count="edits"]')).toHaveText('3 found · 3 kept');
	await page.screenshot({ path: join(outDir, 'auto-pass-dialog.png') });
	const before = await appliedLabels(page);
	await dialog.getByRole('button', { name: 'Propose' }).click();
	await expect(dialog).toBeHidden({ timeout: 240_000 });
	await expect(page.getByTestId('review-bar')).toBeVisible();
	// the user's own proposal: no card, review opened directly; nothing applied yet
	await expect(page.getByTestId('proposal-card')).toHaveCount(0);
	expect(await appliedLabels(page)).toEqual(before);
	await expect(reviewPanel().locator('[data-review-row]')).toHaveCount(3);
	await page.screenshot({ path: join(outDir, 'auto-pass-review.png') });
	await page.getByTestId('review-bar-accept-all').click();
	await expect(page.getByTestId('review-bar-apply')).toHaveText('Apply 3 of 3');
	await page.getByTestId('review-bar-apply').click();
	await expect
		.poll(async () => (await appliedLabels(page)).length, { timeout: 60_000 })
		.toBe(before.length + 1);
	const applied = page.getByTestId('toast').filter({ hasText: 'Applied 3 of 3 sounds from you' });
	await expect(applied).toBeVisible();
	await expect(applied.getByRole('button', { name: 'Reopen review' })).toBeVisible();
	// every item applied: the rows say so; Exit ends the review
	await expect(reviewPanel().locator('[data-review-state="applied"]')).toHaveCount(3);
	await page.getByTestId('review-bar-exit').click();
	await expect(page.getByTestId('review-bar')).toBeHidden();
	await page.screenshot({ path: join(outDir, 'auto-pass-applied.png') });

	// export: each single-layer, peak-aligned placement peaks on its cue frame (the toast would cover the footer)
	await applied.getByRole('button', { name: /Dismiss|Close/ }).click();
	await expect(applied).toBeHidden();
	const seq = await sequence(page);
	const cues = Object.values(seq.soundDesign?.cues ?? {});
	expect(cues.map((c) => c.frame).sort((a, b) => a - b)).toEqual([75, 150, 225]);
	const { file } = await exportViaUi(page, request, {
		engine: 'native',
		fileName: 'sound-review.mp4',
		expectPath: /native/i,
		outDir,
		jobTimeoutMs: 600_000,
	});
	const mix = decodeMono(file);
	const SR = 48_000;
	const F = (FLICKS * seq.settings.frameRate.den) / seq.settings.frameRate.num;
	type MediaRow = { locators: { type: string; key?: string }[] };
	const mediaDoc = await query<Record<string, MediaRow>>(page, 'doc.get', { path: ['media'] });
	const report: Record<string, unknown>[] = [];
	for (const cue of cues) {
		const ids = (cue.placedClipIds ?? []).filter((id) => seq.clips[id]);
		expect(ids).toHaveLength(1);
		const c = seq.clips[ids[0]!]!;
		if (c.sfx!.placement.align !== 'peak') continue;
		const key = mediaDoc[c.mediaId]!.locators.find((l) => l.type === 'engine-store')?.key;
		expect(key).toBeTruthy();
		const res = await request.get(`/media/${encodeURIComponent(key!)}`);
		expect(res.ok()).toBe(true);
		const local = join(outDir, `${c.id}.media`);
		writeFileSync(local, await res.body());
		const ref = decodeMono(local, c.speed.rate);
		const refPoint = Math.round(((c.sfx!.placement.peakFlicks / FLICKS) * SR) / c.speed.rate);
		const W = 4800;
		const w0 = Math.max(0, refPoint - W);
		const w1 = Math.min(ref.length, refPoint + W);
		const clipStart = Math.round(((c.start * F - c.sourceIn / c.speed.rate) / FLICKS) * SR);
		const found = locate(mix, ref, w0, w1, clipStart, 960);
		const cueSample = Math.round(((cue.frame * F) / FLICKS) * SR);
		const peakAt = found.lag + refPoint;
		// where the document puts the aligned point
		const docPoint = Math.round(
			((c.start * F + (c.sfx!.placement.peakFlicks - c.sourceIn) / c.speed.rate) / FLICKS) * SR,
		);
		report.push({
			cue: cue.frame,
			r: found.r,
			peakOffsetSamples: peakAt - cueSample,
			vsDocument: peakAt - docPoint,
		});
		expect(Math.abs(peakAt - docPoint)).toBeLessThanOrEqual(2);
		expect(found.r).toBeGreaterThan(0.95);
		// on the cue frame: within one frame after it (the placement keeps the sub-frame rest), 1 ms of slack before
		expect(peakAt - cueSample).toBeGreaterThanOrEqual(-48);
		expect(peakAt - cueSample).toBeLessThan(
			SR / (seq.settings.frameRate.num / seq.settings.frameRate.den) + 48,
		);
	}
	console.log('export peaks', JSON.stringify(report));
	test.info().annotations.push({ type: 'peaks', description: JSON.stringify(report) });
	expect(report.length).toBeGreaterThan(0);
});
