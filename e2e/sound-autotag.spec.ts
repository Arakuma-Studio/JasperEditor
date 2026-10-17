// Essential Sound Auto Tag in the built app (spec 12 P6-R3; wp-note "Phase 6 → WP6.3"): import speech (LJ Speech, public
// domain), generated music and a starter-kit effect → select the three clips → Clip ▸ Audio Options ▸ Auto Tag Audio
// Types (an `audio-classify` job) → each clip's badge shows its type, dotted "auto" → click the speech badge →
// Essential Sound's banner → Confirm → the badge is solid. Then two full-frame solids slam to a stop, one under the
// speech and one after it → Sequence ▸ Sound Design ▸ Suggest Cues… → the land under speech is a support cue ("under
// dialogue"), the other stays a hero. Screenshots go to test-results/e2e-sound-autotag.
import { spawnSync } from 'node:child_process';
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
	mediaIdForFile,
	query,
	ROOT,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const outDir = join(ROOT, 'test-results', 'e2e-sound-autotag');
let page: Page;
let dir = '';

type Cue = { id: string; frame: number; kind: string; weight: string; reason?: string };

async function cues(p: Page): Promise<Cue[]> {
	const seqs = await query<Record<string, { soundDesign?: { cues?: Record<string, Cue> } }>>(p, 'doc.get', {
		path: ['sequences'],
	});
	const seq = Object.values(seqs)[0]!;
	return Object.values(seq.soundDesign?.cues ?? {}).sort((a, b) => a.frame - b.frame);
}

async function essentialOf(
	p: Page,
	clipId: string,
): Promise<{ type?: string; tagged?: { by: string } } | undefined> {
	const seqs = await query<
		Record<string, { clips: Record<string, { essential?: { type?: string; tagged?: { by: string } } }> }>
	>(p, 'doc.get', { path: ['sequences'] });
	return Object.values(seqs)[0]!.clips[clipId]?.essential;
}

function ffmpeg(): string {
	return process.env.JASPER_FFMPEG ?? 'ffmpeg';
}

test.beforeAll(async ({ browser }) => {
	mkdirSync(outDir, { recursive: true });
	dir = mkdtempSync(join(tmpdir(), 'jasper-e2e-autotag-'));
	// speech: the first 12 s of the LJ Speech fixture at 48 kHz
	const r = spawnSync(
		ffmpeg(),
		[
			'-v',
			'error',
			'-y',
			'-t',
			'12',
			'-i',
			join(ROOT, 'fixtures', 'speech', 'lj-composite.flac'),
			'-ar',
			'48000',
			'-ac',
			'1',
			join(dir, 'speech.wav'),
		],
		{
			encoding: 'utf8',
		},
	);
	if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
	writeFileSync(join(dir, 'music.wav'), encodeWav(testMusic(48_000, 120, 10, 3).audio, 48_000, 's16'));
	copyFileSync(join(ROOT, 'apps', 'engine', 'sounds', 'starter', 'hit-metal-01.ogg'), join(dir, 'hit.ogg'));
	page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
	await enableAgentBridge(page);
});
test.afterAll(async () => {
	await page?.close();
});

test('Auto Tag tags speech, music and an effect; Suggest Cues puts no hero under the speech', async () => {
	test.setTimeout(420_000);
	await createProject(page, 'E2E Auto Tag');
	await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Control+KeyI');
	await (await chooser).setFiles(['speech.wav', 'music.wav', 'hit.ogg'].map((f) => join(dir, f)));
	for (const n of ['speech.wav', 'music.wav', 'hit.ogg'])
		await expect(page.getByTestId('project-row').filter({ hasText: n })).toBeVisible({ timeout: 60_000 });
	const speech = await mediaIdForFile(page, 'speech.wav');
	const music = await mediaIdForFile(page, 'music.wav');
	const hit = await mediaIdForFile(page, 'hit.ogg');
	const placed = await transact(page, [
		{
			type: 'clip.place',
			source: { mediaId: speech },
			sourceRange: { in: { seconds: 0 }, out: { seconds: 9 } },
			at: 0,
			tracks: { audio: 'A1' },
			ref: '$s',
		},
		{ type: 'clip.place', source: { mediaId: music }, at: 0, tracks: { audio: 'A2' }, ref: '$m' },
		{ type: 'clip.place', source: { mediaId: hit }, at: 240, tracks: { audio: 'A3' }, ref: '$h' },
	] as never);
	expect(placed.ok, JSON.stringify(placed)).toBe(true);
	const ids = (placed as unknown as { refs: Record<string, string> }).refs;
	const placedRows = await clips(page);

	// select the three clips and run Clip ▸ Audio Options ▸ Auto Tag Audio Types
	const pick = async (id: string, add: boolean) => {
		const b = await clipBox(page, id);
		if (add) await page.keyboard.down('Shift');
		await page.mouse.click(b.x + 8, b.y + b.height / 2);
		if (add) await page.keyboard.up('Shift');
	};
	await pick(ids.$s!, false);
	await pick(ids.$m!, true);
	await pick(ids.$h!, true);
	await expect
		.poll(async () => {
			const sel = JSON.stringify(await query(page, 'selection.get'));
			return [ids.$s!, ids.$m!, ids.$h!].every((id) => sel.includes(id));
		})
		.toBe(true);
	const menubar = page.getByTestId('title-bar').getByRole('menubar');
	await menubar.getByRole('menuitem', { name: 'Clip', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Audio Options' }).hover();
	await page.getByRole('menuitem', { name: 'Auto Tag Audio Types' }).click();
	await expect.poll(async () => (await essentialOf(page, ids.$h!))?.type, { timeout: 120_000 }).toBe('sfx');
	expect((await essentialOf(page, ids.$s!))?.type).toBe('dialogue');
	expect((await essentialOf(page, ids.$m!))?.type).toBe('music');
	expect((await essentialOf(page, ids.$s!))?.tagged?.by).toBe('auto');
	expect((await appliedLabels(page)).at(-1)).toBe('Auto Tag Audio Types');
	const badge = (id: string, type: string) =>
		clipElement(page, id).locator(`[data-sound-badge="type-${type}"]`);
	await expect(badge(ids.$s!, 'dialogue')).toHaveAttribute('data-auto-tag', 'true');
	await expect(badge(ids.$m!, 'music')).toHaveAttribute('data-auto-tag', 'true');
	await page.screenshot({ path: join(outDir, 'tagged.png') });

	// the speech badge opens Essential Sound with the auto banner; Confirm makes it the user's type
	await badge(ids.$s!, 'dialogue').click();
	const banner = page.getByTestId('essential-auto-tag-banner');
	await expect(banner).toBeVisible();
	await expect(banner).toContainText('Auto-tagged as Dialogue');
	await page.screenshot({ path: join(outDir, 'essential-banner.png') });
	await page.getByTestId('essential-auto-tag-confirm').click();
	await expect(banner).toBeHidden();
	await expect(badge(ids.$s!, 'dialogue')).not.toHaveAttribute('data-auto-tag', 'true');
	expect((await essentialOf(page, ids.$s!))?.tagged).toBeUndefined();
	// tagging and confirming moved nothing
	expect(await clips(page)).toEqual(placedRows);
	await page.waitForTimeout(500);
	await page.screenshot({ path: join(outDir, 'confirmed.png') });

	// two full-frame solids slam to a stop: at frame ≈ 98 (under the speech) and ≈ 458 (after it)
	const solids = await transact(page, [
		{
			type: 'clip.addSolid',
			at: 90,
			duration: 60,
			track: 'V2',
			color: [0.9, 0.3, 0.2, 1],
			ref: '$a',
		},
		{
			type: 'clip.addSolid',
			at: 450,
			duration: 60,
			track: 'V2',
			color: [0.2, 0.4, 0.9, 1],
			ref: '$b',
		},
		{
			type: 'keyframe.add',
			target: ['clip', '$a', 'transform', 'position'],
			at: { frames: 0 },
			value: [-960, 540],
			interpolation: 'linear',
		},
		{
			type: 'keyframe.add',
			target: ['clip', '$a', 'transform', 'position'],
			at: { frames: 8 },
			value: [960, 540],
			interpolation: 'linear',
		},
		{
			type: 'keyframe.add',
			target: ['clip', '$b', 'transform', 'position'],
			at: { frames: 0 },
			value: [-960, 540],
			interpolation: 'linear',
		},
		{
			type: 'keyframe.add',
			target: ['clip', '$b', 'transform', 'position'],
			at: { frames: 8 },
			value: [960, 540],
			interpolation: 'linear',
		},
	] as never);
	expect(solids.ok, JSON.stringify(solids)).toBe(true);
	await menubar.getByRole('menuitem', { name: 'Sequence', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Sound Design' }).hover();
	await page.getByRole('menuitem', { name: 'Suggest Cues…' }).click();
	const dialog = page.getByTestId('suggest-cues-dialog');
	await expect(dialog).toBeVisible();
	await dialog.screenshot({ path: join(outDir, 'suggest.png') });
	await dialog.getByRole('button', { name: /^Suggest \d+ Cues?$/ }).click();
	await expect(dialog).toBeHidden();
	const all = await cues(page);
	const lands = all.filter((c) => c.kind === 'land');
	const under = lands.find((c) => Math.abs(c.frame - 98) <= 2);
	const after = lands.find((c) => Math.abs(c.frame - 458) <= 2);
	expect(under, JSON.stringify(all)).toBeTruthy();
	expect(after, JSON.stringify(all)).toBeTruthy();
	expect(under!.weight).toBe('support');
	expect(under!.reason).toContain('under dialogue');
	expect(after!.weight).toBe('hero');
	// no hero anywhere in the speech (0 … 9 s)
	expect(all.filter((c) => c.weight === 'hero' && c.frame < 9 * 29.97)).toEqual([]);
	await page.screenshot({ path: join(outDir, 'cues.png') });
});
