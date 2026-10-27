// WP6.5a carry-over polish in the built app (wp-note "Phase 6 → WP6.5a"):
//   1. Preferences ▸ Audio ▸ "Auto-tag audio types in the timeline": a clip dropped from the Project panel is tagged by
//      itself; Essential Sound lists the tags in the sequence and a click selects that tag's clips.
//   2. The Razor inside a cross dissolve (video) and a crossfade (audio) cuts the clips and shortens the transitions
//      (it used to be refused with E_INVARIANT).
//   3. Essential Sound ▸ Role: one Tab stop, arrow keys choose.
// Screenshots go to test-results/e2e-sound-p65a.
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { encodeWav } from '../packages/audio-dsp/src/index.ts';
import { testMusic } from '../packages/audio-fx/test/music.ts';
import {
	appliedLabels,
	clipBox,
	clipElement,
	clips,
	createProject,
	enableAgentBridge,
	FIXTURES,
	focusTimeline,
	mediaIdForFile,
	query,
	ROOT,
	timelineArea,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const outDir = join(ROOT, 'test-results', 'e2e-sound-p65a');
let page: Page;
let dir = '';

type Clip = {
	id: string;
	trackId: string;
	start: number;
	duration: number;
	essential?: { type?: string; tagged?: { by: string } };
	sfx?: { role?: string };
};
type Seq = {
	id: string;
	clips: Record<string, Clip>;
	transitions: Record<
		string,
		{ duration: number; trackId: string; outgoingClipId: string | null; incomingClipId: string | null }
	>;
};

async function sequence(p: Page): Promise<Seq> {
	const seqs = await query<Record<string, Seq>>(p, 'doc.get', { path: ['sequences'] });
	return Object.values(seqs)[0]!;
}

async function importInto(p: Page, files: string[]): Promise<void> {
	await p.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = p.waitForEvent('filechooser');
	await p.keyboard.press('Control+KeyI');
	await (await chooser).setFiles(files);
	for (const f of files)
		await expect(p.getByTestId('project-row').filter({ hasText: f.split('/').pop()! })).toBeVisible({
			timeout: 60_000,
		});
}

test.beforeAll(async ({ browser }) => {
	mkdirSync(outDir, { recursive: true });
	dir = mkdtempSync(join(tmpdir(), 'jasper-e2e-p65a-'));
	writeFileSync(join(dir, 'music.wav'), encodeWav(testMusic(48_000, 120, 10, 3).audio, 48_000, 's16'));
	copyFileSync(join(ROOT, 'apps', 'engine', 'sounds', 'starter', 'hit-metal-01.ogg'), join(dir, 'hit.ogg'));
	page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
	await enableAgentBridge(page);
	// the preference is off by default; this run turns it on before the editor loads
	await page.addInitScript(() =>
		window.localStorage.setItem('jasper:audio-prefs', JSON.stringify({ autoTagInTimeline: true })),
	);
});
test.afterAll(async () => {
	await page?.close();
});

test('auto-tag in the timeline tags a dropped clip; Essential Sound selects all clips of a tag', async () => {
	test.setTimeout(300_000);
	await createProject(page, 'E2E WP6.5a');
	await importInto(page, [join(dir, 'music.wav')]);
	const row = page.getByTestId('project-row').filter({ hasText: 'music.wav' });
	await row.click();
	const box = (await timelineArea(page).boundingBox())!;
	await row.dragTo(timelineArea(page), { targetPosition: { x: 0, y: box.height - 60 } });
	await expect.poll(async () => (await clips(page)).length).toBe(1);
	const id = (await clips(page))[0]!.id;
	// no click on Auto Tag: the preference listens to what was added
	await expect
		.poll(async () => (await sequence(page)).clips[id]?.essential?.type, { timeout: 120_000 })
		.toBe('music');
	expect((await sequence(page)).clips[id]!.essential!.tagged?.by).toBe('auto');
	expect((await appliedLabels(page)).slice(-1)).toEqual(['Auto Tag Audio Types']);
	await expect(clipElement(page, id).locator('[data-sound-badge="type-music"]')).toHaveAttribute(
		'data-auto-tag',
		'true',
	);
	await page.screenshot({ path: join(outDir, 'auto-tagged-on-drop.png') });

	// Essential Sound: the tags of the sequence; a click selects the music clips
	await page.keyboard.press('Escape');
	await page.keyboard.press('Alt+Shift+Digit9'); // Sound Design workspace (Essential Sound in it)
	const tags = page.getByTestId('essential-tags');
	await expect(tags).toBeVisible({ timeout: 30_000 });
	await expect(tags).toContainText('Music 1');
	await page.getByTestId('essential-tag-music').click();
	await expect
		.poll(async () =>
			JSON.stringify(
				(await query<{ selection: { timeline: { clips: string[] } } }>(page, 'selection.get')).selection
					.timeline.clips,
			),
		)
		.toBe(JSON.stringify([id]));
	await expect(page.getByTestId('essential-current-type')).toHaveText('Music');
	await page.screenshot({ path: join(outDir, 'essential-tags.png') });
});

test('the Razor inside a video and an audio transition cuts and shortens them', async () => {
	test.setTimeout(240_000);
	await page.keyboard.press('Alt+Shift+Digit1'); // Editing (the Project panel)
	await expect(page.getByTestId('project-panel')).toBeVisible();
	await importInto(page, [join(FIXTURES, 'clip-a.mp4')]);
	const a = await mediaIdForFile(page, 'clip-a.mp4');
	const r0 = await transact(page, [
		{ type: 'track.add', kind: 'video', count: 1 },
		{ type: 'track.add', kind: 'audio', count: 2 },
		{
			type: 'clip.place',
			source: { mediaId: a },
			at: 400,
			sourceRange: { in: { seconds: 1 }, out: { seconds: 4.5 } },
			tracks: { video: 'V3', audio: 'A5' },
			ref: '$a',
		},
	] as never);
	expect(r0.ok, JSON.stringify(r0)).toBe(true);
	// the next clip starts where the first ends (29.97 fps sequence, 30 fps media: read it back)
	const v2 = (await clips(page, ['V3']))[0]!;
	const a3 = (await clips(page, ['A5']))[0]!;
	expect(a3.end).toBe(v2.end);
	const cut = v2.end;
	const r = await transact(page, [
		{
			type: 'clip.place',
			source: { mediaId: a },
			at: cut,
			sourceRange: { in: { seconds: 3 }, out: { seconds: 6.5 } },
			tracks: { video: 'V3', audio: 'A5' },
			ref: '$b',
		},
		{ type: 'transition.add', at: cut, trackId: 'V3', effectId: 'jasper.cross-dissolve', duration: 30 },
		{ type: 'transition.add', at: cut, trackId: 'A5', effectId: 'jasper.constant-power', duration: 30 },
	] as never);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	const ids = (r as unknown as { refs: Record<string, string> }).refs;
	const durations = async () =>
		Object.values((await sequence(page)).transitions)
			.map((t) => t.duration)
			.sort();
	const made = Object.values((await sequence(page)).transitions);
	expect(
		made.map((t) => [t.duration, !!t.outgoingClipId && !!t.incomingClipId]),
		JSON.stringify({ made, warnings: (r as unknown as { warnings: unknown }).warnings }),
	).toEqual([
		[30, true],
		[30, true],
	]);
	// zoom in around the cut so a frame is several pixels wide
	await query(page, 'playhead.set', { frame: cut });
	await focusTimeline(page);
	await page.keyboard.press('Backslash'); // the whole sequence (the playhead in view), then zoom in on it
	await page.waitForTimeout(300);
	for (let i = 0; i < 6; i++) {
		await page.keyboard.press('Equal');
		await page.waitForTimeout(150);
	}
	const inc = await clipBox(page, ids.$b!);
	const seq = await sequence(page);
	const pxPerFrame = inc.width / seq.clips[ids.$b!]!.duration;
	expect(pxPerFrame).toBeGreaterThan(2);
	await page.screenshot({ path: join(outDir, 'razor-before.png') });
	// Razor (C) 8 frames after the cut, inside the 30-frame span (cut − 15 … cut + 15), on the video: the linked audio
	// is cut too
	await focusTimeline(page);
	await page.keyboard.press('KeyC');
	await page.mouse.click(inc.x + 8 * pxPerFrame + pxPerFrame / 2, inc.y + inc.height * 0.75);
	await page.keyboard.press('KeyV');
	await expect.poll(async () => (await clips(page, ['V3'])).length).toBe(3);
	expect((await clips(page, ['A5'])).length).toBe(3);
	expect((await appliedLabels(page)).at(-1)).toBe('Razor');
	const after = await durations();
	expect(after).toHaveLength(2);
	for (const d of after) expect(d).toBeLessThanOrEqual(8);
	await expect(page.getByText(/E_INVARIANT|INV-010/)).toHaveCount(0);
	await page.screenshot({ path: join(outDir, 'razor-after.png') });
});

test('Essential Sound Role: arrow keys move and choose', async () => {
	test.setTimeout(240_000);
	await importInto(page, [join(dir, 'hit.ogg')]);
	await page.keyboard.press('Alt+Shift+Digit9'); // Sound Design (Essential Sound)
	const hit = await mediaIdForFile(page, 'hit.ogg');
	const r = await transact(page, [
		{ type: 'soundDesign.place', frame: 60, layers: [{ mediaId: hit, track: 'A2', align: 'start' }] },
	] as never);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	const sfx = Object.values((await sequence(page)).clips).find((c) => c.sfx)!;
	expect(sfx).toBeTruthy();
	// select it through Essential Sound's tags ("SFX 1": the placed sound is the only SFX clip)
	await page.getByTestId('essential-tag-sfx').click();
	await expect
		.poll(async () =>
			JSON.stringify(
				(await query<{ selection: { timeline: { clips: string[] } } }>(page, 'selection.get')).selection
					.timeline.clips,
			),
		)
		.toBe(JSON.stringify([sfx.id]));
	const role = page.getByTestId('essential-role');
	await expect(role).toBeVisible({ timeout: 30_000 });
	const before = (await sequence(page)).clips[sfx.id]!.sfx!.role;
	const radios = role.getByRole('radio');
	expect(await radios.evaluateAll((els) => els.filter((e) => (e as HTMLElement).tabIndex === 0).length)).toBe(
		1,
	);
	await role.locator('[tabindex="0"]').focus();
	await page.keyboard.press('ArrowRight');
	await expect.poll(async () => (await sequence(page)).clips[sfx.id]!.sfx!.role).not.toBe(before);
	expect((await appliedLabels(page)).at(-1)).toBe('Sound Role');
	await page.keyboard.press('Home');
	await expect.poll(async () => (await sequence(page)).clips[sfx.id]!.sfx!.role).toBe('hero');
	await expect(role.locator('[aria-checked="true"]')).toBeFocused();
	await page.screenshot({ path: join(outDir, 'role-keyboard.png') });
});
