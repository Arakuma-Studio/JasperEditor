// Cue Seam (spec 12 §2.7, P2-R7 timeline parts) in the built app: a fixture with cuts, a push transition, a keyframed
// logo, a typewriter title and an `sfx:` marker → Sequence ▸ Sound Design ▸ Suggest Cues… (counts per source, one undo
// step) → the glyphs sit at their frames on the 18 px seam → role change from the cue menu, drag (moves the cue, one
// undo step), Delete + undo, Alt+Shift+C (Markers ▸ Add Sound Cue). Screenshots (normal, high contrast, reduced motion)
// go to test-results/e2e-sound-cues.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clipBox,
	createProject,
	enableAgentBridge,
	focusTimeline,
	pointerDrag,
	query,
	ROOT,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const outDir = join(ROOT, 'test-results', 'e2e-sound-cues');
let page: Page;

type Cue = {
	id: string;
	frame: number;
	kind: string;
	weight: string;
	source: string;
	reason?: string;
	anchor?: unknown;
};

async function cues(p: Page): Promise<Cue[]> {
	const seqs = await query<Record<string, { soundDesign?: { cues?: Record<string, Cue> } }>>(p, 'doc.get', {
		path: ['sequences'],
	});
	const seq = Object.values(seqs)[0]!;
	return Object.values(seq.soundDesign?.cues ?? {}).sort(
		(a, b) => a.frame - b.frame || a.id.localeCompare(b.id),
	);
}

const glyph = (p: Page, id: string) => p.locator(`[data-testid="cue-seam"] [data-cue-id="${id}"]`);
async function centerX(p: Page, id: string): Promise<number> {
	const b = await glyph(p, id).boundingBox();
	if (!b) throw new Error(`cue ${id} is not drawn`);
	return b.x + b.width / 2;
}

test.beforeAll(async ({ browser }) => {
	mkdirSync(outDir, { recursive: true });
	page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
	await enableAgentBridge(page);
});
test.afterAll(async () => {
	await page?.close();
});

test('Suggest Cues finds each event; glyphs at their frames; edit role, drag, delete, undo', async () => {
	test.setTimeout(300_000);
	await createProject(page, 'E2E Sound Cues');
	const r = await transact(page, [
		{ type: 'clip.addSolid', at: 0, duration: 90, track: 'V1', color: [0.8, 0.2, 0.2, 1], ref: '$a' },
		{ type: 'clip.addSolid', at: 90, duration: 90, track: 'V1', color: [0.2, 0.6, 0.2, 1], ref: '$b' },
		{ type: 'clip.addSolid', at: 180, duration: 150, track: 'V1', color: [0.2, 0.3, 0.8, 1], ref: '$c' },
		{
			type: 'transition.add',
			clipId: '$c',
			edge: 'in',
			effectId: 'jasper.push',
			duration: 20,
			alignment: 'center',
			params: { direction: 'westToEast' },
		},
		{ type: 'clip.addText', at: 30, duration: 120, track: 'V2', content: { text: 'LOGO' }, ref: '$l' },
		{
			type: 'keyframe.add',
			target: ['clip', '$l', 'transform', 'position'],
			at: { frames: 10 },
			value: [200, 540],
		},
		{
			type: 'keyframe.add',
			target: ['clip', '$l', 'transform', 'position'],
			at: { frames: 22 },
			value: [1010, 540],
		},
		{
			type: 'keyframe.add',
			target: ['clip', '$l', 'transform', 'position'],
			at: { frames: 27 },
			value: [960, 540],
		},
		{
			type: 'clip.addText',
			at: 200,
			duration: 90,
			track: 'V3',
			content: { text: 'HELLO WORLD' },
			textAnimation: { in: { preset: 'typewriter', durationFrames: 45 } },
		},
		{ type: 'marker.add', frame: 250, name: 'sfx: boom+swoosh' },
	] as never);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	const refs = (r as { refs: Record<string, string> }).refs;
	// no cues yet and not in the Sound Design workspace: no seam
	await expect(page.getByTestId('cue-seam')).toHaveCount(0);

	// Sequence ▸ Sound Design ▸ Suggest Cues…
	const menubar = page.getByTestId('title-bar').getByRole('menubar');
	await menubar.getByRole('menuitem', { name: 'Sequence', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Sound Design' }).hover();
	await page.getByRole('menuitem', { name: 'Suggest Cues…' }).click();
	const dialog = page.getByTestId('suggest-cues-dialog');
	await expect(dialog).toBeVisible();
	const count = (s: string) => dialog.locator(`[data-cue-source-count="${s}"]`);
	await expect(count('edits')).toHaveText('1 found · 1 kept');
	await expect(count('transitions')).toHaveText('1 found · 1 kept');
	await expect(count('keyframes')).toHaveText('2 found · 2 kept');
	await expect(count('markers')).toHaveText('1 found · 1 kept');
	await expect(count('text')).toContainText('found');
	await dialog.screenshot({ path: join(outDir, 'dialog.png') });
	const button = dialog.getByRole('button', { name: /^Suggest \d+ Cues$/ });
	const n = Number(/(\d+)/.exec((await button.textContent()) ?? '')![1]);
	await button.click();
	await expect(dialog).toBeHidden();
	expect((await appliedLabels(page)).at(-1)).toBe(`Suggest Cues (${n})`);
	const all = await cues(page);
	expect(all).toHaveLength(n);
	for (const c of all) {
		expect(c.reason, JSON.stringify(c)).toBeTruthy();
		expect(['derived', 'marker']).toContain(c.source);
	}
	const at = (frame: number, kind: string) => all.find((c) => c.frame === frame && c.kind === kind);
	const cut = at(90, 'cut')!;
	const push = at(180, 'transition') ?? at(180, 'move');
	const move = all.find((c) => c.kind === 'move' && c.frame > 30 && c.frame < 60)!;
	const land = all.find((c) => c.kind === 'land' && c.frame > 30 && c.frame < 60)!;
	const marker = at(250, 'manual')!;
	expect(cut, JSON.stringify(all)).toBeTruthy();
	expect(push, JSON.stringify(all)).toBeTruthy();
	expect(move && land, JSON.stringify(all)).toBeTruthy();
	expect(marker.weight).toBe('hero');
	expect(all.some((c) => c.frame >= 200 && c.frame < 245 && c.kind === 'appear')).toBe(true);

	// the seam shows (the sequence has cues) and every glyph sits on its frame
	const seam = page.getByTestId('cue-seam');
	await expect(seam).toBeVisible();
	expect((await seam.boundingBox())!.height).toBe(18);
	await focusTimeline(page);
	await page.keyboard.press('Backslash'); // zoom to sequence
	await page.waitForTimeout(300);
	const a = await clipBox(page, refs.$a!);
	const b = await clipBox(page, refs.$b!);
	const ppf = (b.x - a.x) / 90;
	const xOf = (f: number) => a.x + f * ppf;
	for (const c of [cut, push!, move, land, marker])
		expect(Math.abs((await centerX(page, c.id)) - xOf(c.frame)), `${c.kind} at ${c.frame}`).toBeLessThan(1.5);
	expect(await glyph(page, cut.id).getAttribute('aria-label')).toMatch(/^Support Cut cue at .*unfilled/);
	await page.screenshot({ path: join(outDir, 'seam.png') });
	await page.evaluate(() => document.documentElement.setAttribute('data-pr-contrast', 'high'));
	await page.screenshot({ path: join(outDir, 'seam-high-contrast.png') });
	await page.evaluate(() => document.documentElement.removeAttribute('data-pr-contrast'));
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.screenshot({ path: join(outDir, 'seam-reduced-motion.png') });
	await page.emulateMedia({ reducedMotion: null });

	// the suggestion selected every new cue; a click selects the cut alone
	expect(await seam.locator('[data-selected]').count()).toBe(n);
	const cx = await centerX(page, cut.id);
	const sb = (await seam.boundingBox())!;
	await page.mouse.click(cx, sb.y + 9);
	await expect(seam.locator('[data-selected]')).toHaveCount(1);
	// role from the cue menu
	await page.mouse.click(cx, sb.y + 9, { button: 'right' });
	const menu = page.getByTestId('timeline-context-menu');
	await expect(menu).toBeVisible();
	await page.screenshot({ path: join(outDir, 'cue-menu.png') });
	await menu.getByText('Role', { exact: true }).hover();
	await page.getByRole('menuitem', { name: /Hero$/ }).click();
	await expect.poll(async () => (await cues(page)).find((c) => c.id === cut.id)?.weight).toBe('hero');
	expect(
		(await cues(page))
			.filter((c) => c.weight === 'hero')
			.map((c) => c.id)
			.sort(),
	).toEqual([cut.id, marker.id].sort());
	expect((await appliedLabels(page)).at(-1)).toBe('Cue Role');

	// drag the cut cue 12 frames right (snapping off so nothing pulls it: S in the timeline)
	await focusTimeline(page);
	await page.keyboard.press('KeyS');
	await pointerDrag(page, { x: cx, y: sb.y + 9 }, { x: cx + 12 * ppf, y: sb.y + 9 });
	await expect.poll(async () => (await cues(page)).find((c) => c.id === cut.id)?.frame).not.toBe(90);
	const moved = (await cues(page)).find((c) => c.id === cut.id)!;
	expect(Math.abs(moved.frame - 102)).toBeLessThanOrEqual(1);
	expect((await appliedLabels(page)).at(-1)).toBe('Move Cue');
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await cues(page)).find((c) => c.id === cut.id)?.frame).toBe(90);

	// Delete removes the selected cue; undo brings it back
	await page.mouse.click(await centerX(page, cut.id), sb.y + 9);
	await page.keyboard.press('Delete');
	await expect.poll(async () => (await cues(page)).some((c) => c.id === cut.id)).toBe(false);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await cues(page)).some((c) => c.id === cut.id)).toBe(true);

	// Markers ▸ Add Sound Cue (Alt+Shift+C) at the playhead
	await query(page, 'playhead.set', { frame: 120 });
	// focus the timeline with a click on empty track space (below the last audio track)
	const area = (await page.getByTestId('timeline-clip-area').boundingBox())!;
	await page.mouse.click(area.x + area.width - 40, area.y + area.height - 30);
	const before = (await cues(page)).length;
	await page.keyboard.press('Alt+Shift+KeyC');
	await expect.poll(async () => (await cues(page)).length).toBe(before + 1);
	const added = (await cues(page)).find((c) => c.kind === 'manual' && c.source === 'user')!;
	expect(added).toMatchObject({ weight: 'support', frame: 120 });
	expect((await appliedLabels(page)).at(-1)).toBe('Add Sound Cue');

	// a cue filled by soundDesign.place: solid glyph, a connector to the clip's peak, the peak handle on the cue frame
	const fill = await transact(page, [
		{
			type: 'media.register',
			asset: {
				kind: 'audio',
				fingerprint: 'q1:e2e-cue-sound',
				originalName: 'thump.wav',
				sizeBytes: 1,
				container: 'wav',
				probe: {
					durationFlicks: 705_600_000,
					startTimecode: null,
					streams: [
						{
							index: 0,
							type: 'audio',
							codec: 'pcm_s16le',
							sampleRate: 48_000,
							channels: 2,
							channelLayout: 'stereo',
						},
					],
					rotationDegrees: 0,
					hasAlpha: false,
					variableFrameRate: false,
				},
				locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_e2e_cue_sound' }],
				library: {
					soundId: 'snd_00000000000000e2',
					title: 'Thump',
					types: ['thump'],
					source: { type: 'synth', recipe: 'thump', seed: 1 },
					license: 'LicenseRef-JasperEditor',
					author: 'JasperEditor',
					attribution: null,
					descriptors: {
						peakSec: 0.3,
						onsetSec: 0.28,
						headQuietSec: 0.28,
						durationSec: 1,
						octaveBandsDb: [-30, -25, -20, -18, -19, -24, -33],
						centroidHz: 400,
						maxMomentaryLufs: -14,
					},
					leadSilenceSec: 0.05,
				},
			},
			ref: '$m',
		},
		{ type: 'soundDesign.place', cueId: land.id, layers: [{ mediaId: '$m' }] },
	] as never);
	expect(fill.ok, JSON.stringify(fill)).toBe(true);
	const placed = (fill as { results: { clips?: { clipId: string }[] }[] }).results[1]!.clips![0]!.clipId;
	await expect(glyph(page, land.id)).toHaveAttribute('data-cue-state', /^filled/);
	await expect(page.locator(`[data-cue-connector="${land.id}:${placed}"]`)).toHaveCount(1);
	const peak = (await page.locator(`[data-peak-line="${placed}"]`).boundingBox())!;
	expect(Math.abs(peak.x + peak.width / 2 - xOf(land.frame))).toBeLessThan(ppf + 1);
	expect(await glyph(page, land.id).getAttribute('aria-label')).toContain('filled with A');
	await page.screenshot({ path: join(outDir, 'seam-after-edits.png') });
});
