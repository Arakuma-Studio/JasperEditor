// Spec 12 P6-E10 (WP-E6) in the built app with the bundled starter kit: Preferences ▸ Sound Library ▸ Sound design
// style sets the sequence's personality (one undo step); Sequence ▸ Sound Design ▸ Auto Sound Pass… starts from it,
// shows the description, and proposes; review → Accept all → Apply: the four staggered Pop cards climb 0 / +1 / +2 / +3
// semitones by varispeed, the three click markers share one sound at one gain, the typewriter's ticks play at speed 1.
// Screenshots: test-results/e2e-sound-grammar.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { appliedLabels, createProject, enableAgentBridge, query, ROOT, transact } from './support.ts';

test.describe.configure({ mode: 'serial' });

const outDir = join(ROOT, 'test-results', 'e2e-sound-grammar');
let page: Page;

test.beforeAll(async ({ browser }) => {
	mkdirSync(outDir, { recursive: true });
	page = await browser.newPage({ viewport: { width: 1800, height: 1050 } });
	await enableAgentBridge(page);
});
test.afterAll(async () => {
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
	kind: string;
	gainDb: number;
	speed: { rate: number; maintainPitch?: boolean };
	sfx?: { soundId: string | null };
};
type Seq = {
	clips: Record<string, Clip>;
	soundDesign?: {
		cues?: Record<string, { id: string; frame: number; placedClipIds?: string[] }>;
		settings?: { style?: Record<string, unknown> };
	};
};
async function sequence(p: Page): Promise<Seq> {
	const seqs = await query<Record<string, Seq>>(p, 'doc.get', { path: ['sequences'] });
	return Object.values(seqs)[0]!;
}

const reviewPanel = () => page.locator('[data-panel-kind="review"][data-instance-id]');

test('style in Preferences → Auto Sound Pass → apply: climbing cards, one click voice, ticks at speed 1', async ({
	request,
}) => {
	test.setTimeout(1_200_000);
	await createProject(page, 'E2E Sound Grammar');
	const cards = [150, 165, 180, 195];
	const clicks = [300, 330, 360];
	const r = await transact(page, [
		{ type: 'clip.addSolid', at: 0, duration: 420, track: 'V1', color: [0.12, 0.12, 0.16, 1] },
		{
			type: 'clip.addText',
			at: 30,
			duration: 90,
			track: 'V2',
			content: { text: 'HELLO THERE' },
			textAnimation: { in: { preset: 'typewriter', durationFrames: 45 } },
		},
		...cards.map((at, i) => ({
			type: 'clip.addText',
			at,
			duration: 60,
			track: `V${i + 3}`,
			content: { text: `Card ${i + 1}` },
			textAnimation: { in: { preset: 'pop', durationFrames: 10 } },
		})),
		...clicks.map((frame) => ({ type: 'marker.add', frame, name: 'sfx: click' })),
	] as never);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	await libraryReady(request);

	// Preferences ▸ Sound Library ▸ Sound design style: the personality of the sequence
	const before = await appliedLabels(page);
	await page.getByTestId('title-bar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
	await page.getByRole('menuitem', { name: /^Preferences$/ }).hover();
	await page.getByRole('menuitem', { name: /^Preferences…/ }).click();
	const prefs = page.getByTestId('preferences-dialog');
	await expect(prefs).toBeVisible();
	await prefs.getByTestId('prefs-page-sound-library').click();
	const style = prefs.getByTestId('prefs-sound-style');
	await style.scrollIntoViewIfNeeded();
	await style.getByRole('combobox', { name: 'Personality' }).click();
	await page.getByRole('option', { name: 'Bright' }).click();
	await expect(style.getByTestId('sound-style-personality-description')).toHaveText(
		'Light and sparkling: chimes, pops and UI blips, glass and metal, no low booms.',
	);
	await prefs.screenshot({ path: join(outDir, '1-preferences-style.png') });
	await page.keyboard.press('Escape');
	await expect(prefs).toBeHidden();
	expect((await appliedLabels(page)).slice(before.length)).toEqual(['Sound Design Style']);
	expect((await sequence(page)).soundDesign?.settings?.style).toEqual({ personality: 'bright' });

	// Auto Sound Pass… starts from the sequence's style
	await page.keyboard.press('Alt+Shift+Digit9');
	await expect(reviewPanel()).toBeVisible({ timeout: 60_000 });
	const menubar = page.getByTestId('title-bar').getByRole('menubar');
	await menubar.getByRole('menuitem', { name: 'Sequence', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Sound Design' }).hover();
	await page.getByRole('menuitem', { name: 'Auto Sound Pass…' }).click();
	const dialog = page.getByTestId('auto-sound-pass-dialog');
	await expect(dialog).toBeVisible();
	const dstyle = dialog.getByTestId('auto-pass-style');
	await expect(dstyle.getByRole('combobox', { name: 'Personality' })).toHaveText('Bright');
	// only the text animations and the markers (the cards' edges would add exit cues)
	await dialog.locator('[data-cue-source="clipEdges"]').getByRole('checkbox').click();
	await dstyle.scrollIntoViewIfNeeded();
	await dialog.screenshot({ path: join(outDir, '2-auto-pass-style.png') });
	const n0 = (await appliedLabels(page)).length;
	await dialog.getByRole('button', { name: 'Propose' }).click();
	await expect(dialog).toBeHidden({ timeout: 300_000 });
	await expect(page.getByTestId('review-bar')).toBeVisible();
	await expect(reviewPanel().locator('[data-review-row]').first()).toBeVisible();
	await page.screenshot({ path: join(outDir, '3-review.png') });
	await page.getByTestId('review-bar-accept-all').click();
	await page.getByTestId('review-bar-apply').click();
	await expect.poll(async () => (await appliedLabels(page)).length, { timeout: 60_000 }).toBe(n0 + 1);
	await page.getByTestId('review-bar-exit').click();
	await expect(page.getByTestId('review-bar')).toBeHidden();
	await page.screenshot({ path: join(outDir, '4-applied.png') });

	const seq = await sequence(page);
	const cues = Object.values(seq.soundDesign?.cues ?? {});
	const clipAt = (frame: number) => {
		const cue = cues.find((c) => c.frame === frame);
		expect(cue, `a cue at ${frame}`).toBeDefined();
		return seq.clips[cue!.placedClipIds![0]!]!;
	};
	// the cards climb by varispeed (speed 2^(st/12), pitch not kept)
	const rates = cards.map((f) => clipAt(f).speed.rate);
	console.log('card speeds', JSON.stringify(rates));
	for (const [i, rate] of rates.entries())
		expect(Math.abs(rate - 2 ** (i / 12)), `card ${i + 1}`).toBeLessThan(1e-4);
	for (const f of cards.slice(1)) expect(clipAt(f).speed.maintainPitch).toBe(false);
	// one click voice at one level
	const cl = clicks.map(clipAt);
	expect(new Set(cl.map((c) => c.sfx?.soundId)).size).toBe(1);
	expect(new Set(cl.map((c) => c.gainDb)).size).toBe(1);
	for (const c of cl) expect(c.speed.rate).toBe(1);
	// the typewriter's keys (ticks in the starter kit) at speed 1
	const keys = cues.filter((c) => c.frame >= 30 && c.frame < 90);
	expect(keys.length).toBeGreaterThan(3);
	for (const k of keys) expect(seq.clips[k.placedClipIds![0]!]!.speed.rate).toBe(1);
});
