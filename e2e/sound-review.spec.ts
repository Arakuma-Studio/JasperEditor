// Spec 12 Phase 3 "Done when" (WP3.3b) in the built app: an agent's proposal (the engine's sound-design plan, run by an
// agent with the token and no editor key) appears as a card ("… proposes …: n sounds on k new tracks", "… is waiting for
// your review" while it polls) → Review → in the Review panel accept two, reject one, cycle an alternate, write a note →
// Ctrl+Enter applies them as ONE History entry ("Applied n of m sounds from <agent>") → Ctrl+Z → Reopen review: the
// decisions are intact → a cue moves under an accepted item → it shows stale with why, and Apply reports it stale.
// Screenshots: test-results/e2e-sound-review.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { FIXTURE_COMMANDS } from '../apps/mcp/test/sound-cues-fixture.ts';
import {
	appliedLabels,
	browserLaunch,
	createProject,
	enableAgentBridge,
	focusTimeline,
	query,
	ROOT,
	serverInfo,
	transact,
} from './support.ts';

test.use({ launchOptions: browserLaunch(['--autoplay-policy=no-user-gesture-required']) });
test.describe.configure({ mode: 'serial' });

const outDir = join(ROOT, 'test-results', 'e2e-sound-review');
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
	await expect(row(cut.id)).toContainText(/Cut cue at 00[:;]00[:;]03[:;]00 moved to 00[:;]00[:;]03[:;]10/);
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

	// The review toast must not obstruct Export at the smaller window size of the historical regression.
	await page.setViewportSize({ width: 1280, height: 720 });
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyM');
	await expect(page.getByTestId('export-mode')).toBeVisible();
	const start = page.getByTestId('export-start');
	await expect(start).toBeEnabled({ timeout: 30_000 });
	await expect(toast2).toBeVisible();
	await start.click({ trial: true, timeout: 10_000 });
	await page.screenshot({ path: join(outDir, 'export-with-review-toast.png') });
	await page.keyboard.press('Escape');
});
