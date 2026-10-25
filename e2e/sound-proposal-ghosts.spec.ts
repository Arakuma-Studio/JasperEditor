// Spec 12 Phase 3, WP3.3a in the built app: an agent creates a sound proposal through the engine route on the Phase 2
// fixture (plus a click bed on A1) → Review Proposal draws its ghosts at the right places with the right styles (a ghost
// track header for the new SFX track, dashed ghost clips with the agent bar) → "Hear proposal" changes the Program
// audio, also when switched while playing (the bed's clicks keep their exact spacing: playback is not restarted; the
// proposal's hit lands sample-exactly where it will after Apply) → accept 2, reject 1 on the ghost cards → Apply (a
// trusted click) = ONE History entry → Ctrl+Z → the items are back in review with their decisions.
// Screenshots (normal, decided, high contrast, reduced motion, after undo) go to test-results/e2e-sound-proposal-ghosts.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { FIXTURE_COMMANDS } from '../apps/mcp/test/sound-cues-fixture.ts';
import { arm, disarm, mark, peaks, TAP } from './sound-tap.ts';
import {
	appliedLabels,
	browserLaunch,
	clipBox,
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

const outDir = join(ROOT, 'test-results', 'e2e-sound-proposal-ghosts');
const SR = 48_000;
/** The hit's click is 0.25 s into hit.wav; the bed clicks every 0.5 s from 0.1 s (after the 30 ms start fade). */
const HIT_OFFSET = 12_000;
const BED_OFFSET = 4_800;
const FPS = 30_000 / 1001;
let page: Page;
let projectId = '';

test.beforeAll(async ({ browser }) => {
	mkdirSync(outDir, { recursive: true });
	page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
	await page.addInitScript(TAP);
	await enableAgentBridge(page);
});
test.afterAll(async () => {
	await page?.close();
});

function wav(name: string, expr: string, seconds: number): string {
	const file = join(outDir, name);
	const r = spawnSync(process.env.JASPER_FFMPEG ?? 'ffmpeg', [
		'-v',
		'error',
		'-y',
		'-f',
		'lavfi',
		'-i',
		`aevalsrc='${expr}':s=48000:d=${seconds}`,
		'-ac',
		'2',
		'-c:a',
		'pcm_s16le',
		file,
	]);
	expect(r.status, String(r.stderr)).toBe(0);
	return file;
}

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
			'x-jasper-agent': 'e2e-sound-agent',
			'content-type': 'application/json',
		},
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	});
	return { status: r.status, json: (await r.json()) as T };
}

/** Live-UI automation of this window (POST /api/agent/ui): runs a UI command. */
async function runCommand(id: string, args?: unknown) {
	const { port } = serverInfo();
	const r = await page.request.post(`http://127.0.0.1:${port}/api/agent/ui`, {
		data: { projectId, action: 'command', args: { id, ...(args ? { args } : {}) } },
	});
	expect(r.ok(), await r.text()).toBe(true);
}

type ItemState = { id: string; state: string; selectedAlternative?: number };
async function storedStates(proposalId: string): Promise<Record<string, string>> {
	const r = await asAgent<{ proposal: { items: ItemState[] } }>(
		'GET',
		`/api/projects/${projectId}/proposals/${proposalId}`,
	);
	expect(r.status).toBe(200);
	return Object.fromEntries(r.json.proposal.items.map((i) => [i.id, i.state]));
}

const ghost = (item: string) => page.locator(`[data-ghost-clip][data-ghost-item="${item}"]`);
const card = () => page.getByTestId('proposal-ghost-card');

type Peaks = { at: number; v: number }[];
type Play = {
	peaks: Peaks;
	/** The playhead when paused (the transport was not restarted by the switch). */
	frameAtPause: number;
};
/** Records each Hear state once, including a switch 1.2 s into uninterrupted playback. */
async function playChecked(name: string, start: boolean, switchTo: boolean | null, check: (p: Play) => void) {
	await runCommand('proposals.toggleHear', { on: start });
	await focusTimeline(page);
	await page.keyboard.press('Home');
	await page.waitForTimeout(500);
	await arm(page);
	await page.keyboard.press('Space');
	if (switchTo !== null) {
		await page.waitForTimeout(1200);
		await runCommand('proposals.toggleHear', { on: switchTo });
		await page.waitForTimeout(2500);
	} else await page.waitForTimeout(3700);
	await mark(page, 'pause');
	const frameAtPause = (await query<{ frame: number }>(page, 'playhead.get')).frame;
	await focusTimeline(page);
	await page.keyboard.press('Space');
	await page.waitForTimeout(200);
	const rec = await disarm(page);
	const until = rec.marks.pause ?? Number.POSITIVE_INFINITY;
	const p = peaks(rec, 0.1)
		.filter((x) => x.t <= until)
		.map((x) => ({ at: Math.round(x.t * rec.rate), v: x.v }));
	const first = p[0]?.at ?? 0;
	const play: Play = {
		peaks: p.map((x) => ({ at: x.at - first, v: Number(x.v.toFixed(4)) })),
		frameAtPause,
	};
	const note = { name, ...play };
	console.log('play', JSON.stringify(note));
	test.info().annotations.push({ type: 'play', description: JSON.stringify(note) });
	check(play);
	return play;
}

const bedClicks = (p: { at: number; v: number }[]) => p.filter((x) => x.v > 0.1 && x.v < 0.2);
const hits = (p: { at: number; v: number }[]) => p.filter((x) => x.v > 0.28);
/** Where the cut's hit plays (frame 87 + 0.25 s) in samples after the bed's first click (0.1 s). */
const CUT_HIT = Math.round((87 / FPS) * SR) + HIT_OFFSET - BED_OFFSET;

function expectBedIntact(p: { at: number; v: number }[]) {
	const bed = bedClicks(p);
	expect(bed.length, JSON.stringify(p)).toBeGreaterThanOrEqual(7);
	for (let i = 1; i < bed.length; i++)
		expect(Math.abs(bed[i]!.at - bed[i - 1]!.at - 24_000), JSON.stringify(p)).toBeLessThanOrEqual(2);
}

test('an agent proposal reviewed as ghosts, heard, partly accepted, applied as one undo step and undone back into review', async () => {
	test.setTimeout(900_000);
	projectId = await createProject(page, 'E2E Sound Proposal Ghosts');
	const bed = wav('bed.wav', 'if(eq(mod(n\\,24000)\\,4800)\\,0.25\\,0)', 20);
	const hit = wav('hit.wav', 'if(between(n\\,12000\\,12000)\\,0.6\\,0)', 1);
	await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Control+KeyI');
	await (await chooser).setFiles([bed, hit]);
	for (const n of ['bed.wav', 'hit.wav'])
		await expect(page.getByTestId('project-row').filter({ hasText: n })).toBeVisible({ timeout: 60_000 });
	const items = await query<Record<string, { id: string; name: string }>>(page, 'doc.get', {
		path: ['items'],
	});
	const itemOf = (n: string) => Object.values(items).find((i) => i.name === n)!.id;
	const setup = await transact(page, [
		...(FIXTURE_COMMANDS as never[]),
		{
			type: 'clip.place',
			source: { projectItemId: itemOf('bed.wav') },
			at: 0,
			tracks: { audio: 'A1' },
		} as never,
	]);
	expect(setup.ok, JSON.stringify(setup)).toBe(true);
	const seqs = await query<Record<string, { id: string; audioTracks: { id: string }[] }>>(page, 'doc.get', {
		path: ['sequences'],
	});
	const seq = Object.values(seqs)[0]!;
	const audioTracks = seq.audioTracks.length;

	const setupLabels = await appliedLabels(page);
	// 1. the agent proposes (it cannot apply: the policy is off by default)
	const place = (at: number) => ({
		type: 'clip.place',
		source: { projectItemId: itemOf('hit.wav') },
		at,
		tracks: { audio: '$sfx' },
	});
	const created = await asAgent<{ proposal: { id: string; items: ItemState[]; author: unknown } }>(
		'POST',
		`/api/projects/${projectId}/proposals`,
		{
			feature: 'sound-design',
			title: 'E2E sound pass',
			summary: 'hits on the cut, the push and the marker',
			sequenceId: seq.id,
			items: [
				{
					id: 'trk',
					label: 'SFX track',
					group: 'tracks',
					commands: [{ type: 'track.add', kind: 'audio', name: 'SFX 1', ref: '$sfx' }],
					meta: { why: 'A track for the new sounds' },
				},
				{
					id: 'cut',
					label: 'Hit on the cut',
					group: 'support',
					requires: ['trk'],
					commands: [place(87)],
					meta: { why: 'Cut from Shot A to Shot B', facts: ['support · Impacts'] },
					alternatives: [{ label: 'Hit, a frame later', commands: [place(88)] }],
				},
				{
					id: 'push',
					label: 'Hit on the push',
					group: 'support',
					requires: ['trk'],
					commands: [place(177)],
					meta: { why: 'Push into Shot C' },
				},
				{
					id: 'boom',
					label: 'Boom on the marker',
					group: 'hero',
					requires: ['trk'],
					commands: [place(247)],
					meta: { why: 'Marker "sfx: boom+swoosh"' },
				},
			],
		},
	);
	expect(created.status, JSON.stringify(created.json)).toBe(200);
	const proposalId = created.json.proposal.id;
	expect(created.json.proposal.author).toEqual({ agent: 'e2e-sound-agent' });
	const refused = await asAgent<{ code: string }>(
		'POST',
		`/api/projects/${projectId}/proposals/${proposalId}/accept`,
		{
			itemIds: 'all',
		},
	);
	expect([refused.status, refused.json.code]).toEqual([403, 'APPROVAL_REQUIRED']);

	// 2. review: ghosts where the items go
	await runCommand('proposals.review', { proposalId });
	await expect(ghost('cut')).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('[data-ghost-clip]')).toHaveCount(3);
	const header = page.locator('[data-ghost-header]');
	await expect(header).toHaveText(`A${audioTracks + 1} · SFX 1 (new)`);
	const shotA = await clipBox(
		page,
		Object.values(
			(
				await query<{ clips: Record<string, { id: string; name: string }> }>(page, 'doc.get', {
					path: ['sequences', seq.id],
				})
			).clips,
		).find((c) => c.name === 'Shot A')!.id,
	);
	const pxPerFrame = shotA.width / 90;
	for (const [item, frame] of [
		['cut', 87],
		['push', 177],
		['boom', 247],
	] as const) {
		const b = (await ghost(item).boundingBox())!;
		expect(Math.abs(b.x - (shotA.x + frame * pxPerFrame)), `${item} at ${frame}`).toBeLessThan(2);
		await expect(ghost(item)).toHaveAttribute('data-ghost-state', 'pending');
		await expect(ghost(item)).toHaveAttribute('data-ghost-new-track', 'true');
	}
	await page.getByTestId('timeline-panel').screenshot({ path: join(outDir, 'ghosts.png') });

	// 3. Hear proposal: off → the bed only; on → the cut's hit exactly where it will play; switched while playing →
	//    the bed keeps its spacing (playback goes on) and the hit is heard / not heard after the switch
	const noHit = ({ peaks: p }: Play) => {
		expect(hits(p), JSON.stringify(p)).toEqual([]);
		expectBedIntact(p);
	};
	const cutHit = ({ peaks: p }: Play) => {
		expect(
			hits(p).map((x) => x.at),
			JSON.stringify(p),
		).toEqual([CUT_HIT]);
		expectBedIntact(p);
	};
	// switched while playing: the transport goes on (not restarted: the playhead is where 3.7 s of play take it); the
	// proposal's hit is heard (or not) after the switch, on its sample relative to the bed; the bed's clicks keep their
	// exact spacing throughout the switch.
	const switched = (heard: boolean) => (play: Play) => {
		expect(play.frameAtPause, JSON.stringify(play)).toBeGreaterThan(95);
		const h = hits(play.peaks);
		if (heard) {
			expect(h, JSON.stringify(play.peaks)).toHaveLength(1);
			const before = bedClicks(play.peaks)
				.filter((x) => x.at < h[0]!.at)
				.at(-1)!;
			expect(
				Math.abs(h[0]!.at - before.at - (CUT_HIT % 24_000)),
				JSON.stringify(play.peaks),
			).toBeLessThanOrEqual(2);
		} else expect(h, JSON.stringify(play.peaks)).toEqual([]);
		expectBedIntact(play.peaks);
	};
	await playChecked('hear off', false, null, noHit);
	await playChecked('hear on', true, null, cutHit);
	await expect(page.getByTestId('proposal-hear-chip')).toHaveText('Hearing proposal: E2E sound pass');
	// (E2E_HEAR_PLAYS: more switched plays in one run, for the wp-note's counts)
	for (let i = 0; i < Number(process.env.E2E_HEAR_PLAYS ?? 1); i++) {
		await playChecked('switched on while playing', false, true, switched(true));
		await playChecked('switched off while playing', true, false, switched(false));
	}
	await runCommand('proposals.toggleHear', { on: false });
	await expect(page.getByTestId('proposal-hear-chip')).toHaveCount(0);
	// the session document never changed
	expect(await appliedLabels(page)).toEqual(setupLabels);

	// 4. decisions on the ghost cards: accept 2, reject 1
	const decide = async (item: string, action: 'accept' | 'reject') => {
		await ghost(item).click();
		await expect(card()).toHaveAttribute('data-ghost-card', item);
		await card().locator(`[data-ghost-action="${action}"]`).click();
		await expect(ghost(item)).toHaveAttribute(
			'data-ghost-state',
			action === 'accept' ? 'accepted' : 'rejected',
		);
	};
	await decide('cut', 'accept');
	await expect(card()).toContainText('Cut from Shot A to Shot B');
	await decide('push', 'accept');
	await decide('boom', 'reject');
	expect(await storedStates(proposalId)).toEqual({
		trk: 'pending',
		cut: 'pending',
		push: 'pending',
		boom: 'rejected',
	});
	await page.getByTestId('timeline-panel').screenshot({ path: join(outDir, 'decided.png') });
	// reduced motion: nothing of the review moves
	await page.emulateMedia({ reducedMotion: 'reduce' });
	const moving = await page.evaluate(
		() =>
			[...document.querySelectorAll('[data-ghost-item]')].filter((el) => {
				const cs = getComputedStyle(el);
				return cs.animationName !== 'none' || Number.parseFloat(cs.transitionDuration) > 0;
			}).length,
	);
	expect(moving).toBe(0);
	await page.getByTestId('timeline-panel').screenshot({ path: join(outDir, 'reduced-motion.png') });
	await page.emulateMedia({ reducedMotion: 'no-preference' });

	// 5. Apply: a trusted click on the card's Apply → ONE History entry
	await ghost('cut').click();
	const apply = card().locator('[data-ghost-action="apply"]');
	await expect(apply).toHaveText('Apply 3 of 4');
	const before = await appliedLabels(page);
	await apply.click();
	await expect
		.poll(() => appliedLabels(page), { timeout: 30_000 })
		.toEqual([...before, 'Accept E2E sound pass (3 of 4)']);
	expect(await storedStates(proposalId)).toEqual({
		trk: 'accepted',
		cut: 'accepted',
		push: 'accepted',
		boom: 'rejected',
	});
	await expect(page.locator('[data-ghost-clip]')).toHaveCount(1); // the rejected boom stays in review
	const placed = await query<{ clips: Record<string, { start: number; trackId: string; kind: string }> }>(
		page,
		'doc.get',
		{
			path: ['sequences', seq.id],
		},
	);
	expect(
		Object.values(placed.clips)
			.filter((c) => c.kind === 'audio')
			.map((c) => c.start)
			.sort((a, b) => a - b),
	).toEqual([0, 87, 177]);
	await page.getByTestId('timeline-panel').screenshot({ path: join(outDir, 'applied.png') });

	// 6. Ctrl+Z: one step removes the whole apply; the items are back in review with their decisions
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(() => appliedLabels(page)).toEqual(before);
	await expect(ghost('cut')).toHaveAttribute('data-ghost-state', 'accepted', { timeout: 15_000 });
	await expect(ghost('push')).toHaveAttribute('data-ghost-state', 'accepted');
	await expect(ghost('boom')).toHaveAttribute('data-ghost-state', 'rejected');
	await expect(page.locator('[data-ghost-header]')).toHaveCount(1);
	await expect
		.poll(() => storedStates(proposalId))
		.toEqual({ trk: 'pending', cut: 'pending', push: 'pending', boom: 'rejected' });
	await page.getByTestId('timeline-panel').screenshot({ path: join(outDir, 'undone.png') });
});
