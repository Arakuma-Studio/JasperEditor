// Sound Library (spec 12 §2.7, P1-R7/R8) in the built app: the panel in the Audio workspace indexes the bundled
// starter kit; search → audition (Space, aria-live, the Mix meters move, no history entry) → insert peak-aligned at the
// playhead (Enter, one undo step, Essential Sound SFX, "Sound Effects" bin) → undo → drag onto the timeline with the
// peak snapping to the playhead (ghost with peak tick) → File ▸ Export ▸ Sound Credits…. Screenshots of the panel
// (normal, high contrast) and of the drag ghost go to test-results/e2e-sound-library.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	browserLaunch,
	createProject,
	enableAgentBridge,
	exportViaUi,
	query,
	ROOT,
} from './support.ts';

test.use({ launchOptions: browserLaunch(['--autoplay-policy=no-user-gesture-required']) });
test.describe.configure({ mode: 'serial' });

const outDir = join(ROOT, 'test-results', 'e2e-sound-library');
let page: Page;

type Clip = {
	id: string;
	kind: string;
	trackId: string;
	start: number;
	duration: number;
	sourceIn: number;
	mediaId: string;
};
type Seq = {
	clips: Record<string, Clip>;
	audioTracks: { id: string; name: string | null }[];
	settings: { frameRate: { num: number; den: number } };
};

async function sequence(p: Page): Promise<Seq> {
	const seqs = await query<Record<string, Seq>>(p, 'doc.get', { path: ['sequences'] });
	return Object.values(seqs)[0]!;
}
type Lib = {
	soundId: string;
	title?: string;
	source?: { type: string; file?: string };
	leadSilenceSec?: number;
	descriptors?: { peakSec: number; onsetSec: number };
};
type Media = { id: string; library?: Lib };
async function media(p: Page): Promise<Record<string, Media>> {
	return query(p, 'doc.get', { path: ['media'] });
}

/** The first channel of an audio file as 48 kHz float samples (ffmpeg). */
function decodeMono(file: string): Float32Array {
	const raw = execFileSync(
		process.env.JASPER_FFMPEG ?? 'ffmpeg',
		['-v', 'error', '-i', file, '-map', '0:a:0', '-af', 'pan=mono|c0=c0', '-ar', '48000', '-f', 'f32le', '-'],
		{ maxBuffer: 256 * 1024 * 1024 },
	);
	return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
}

/**
 * Where `ref[w0, w1)` sits in `mix`, searching lags around `guess` (± `span` samples): the lag of the largest
 * normalised cross-correlation. Sample-exact for a sound mixed in alone (other sounds are seconds away).
 */
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
const FLICKS = 705_600_000;

test.beforeAll(async ({ browser }) => {
	mkdirSync(outDir, { recursive: true });
	page = await browser.newPage();
	await enableAgentBridge(page);
});
test.afterAll(async () => {
	await page?.close();
});

test('search, audition, insert peak-aligned, undo, drag with peak snapping, credits', async () => {
	test.setTimeout(600_000);
	await createProject(page, 'E2E Sound Library');
	await page.keyboard.press('Alt+Shift+Digit7');
	const tab = page.locator('.dv-tab', { hasText: 'Sound Library' }).first();
	await tab.click();
	// (the dock tab and body carry the panel kind too: the panel is the element with the instance id)
	const panel = page.locator('[data-panel-kind="soundLibrary"][data-instance-id]');
	await expect(panel).toBeVisible({ timeout: 60_000 });
	// the throwaway appdir indexes the starter kit on first use
	const list = panel.getByRole('listbox', { name: 'Sounds' });
	await expect(list.getByRole('option').first()).toBeVisible({ timeout: 360_000 });
	await expect(panel.getByTestId('sound-status')).toContainText('Starter kit', { timeout: 360_000 });
	await expect(panel.locator('[data-waveform="ready"]').first()).toBeVisible({ timeout: 60_000 });
	await panel.screenshot({ path: join(outDir, 'panel.png') });

	// search
	await panel.getByTestId('sound-search').fill('crunch');
	const first = list.getByRole('option', { name: /^Crunchy impact/ }).first();
	await expect(first).toBeVisible({ timeout: 30_000 });

	// audition: Space plays alone (aria-live), the Mix meters show it, no history entry
	await query(page, 'playhead.set', { frame: 45 });
	const historyBefore = await appliedLabels(page);
	await first.click();
	await page.keyboard.press('Space');
	await expect(panel.getByTestId('sound-live')).toHaveText(/^Playing /, { timeout: 30_000 });
	await expect(page.getByTestId('audio-meters')).toHaveAttribute('data-live', 'true', { timeout: 10_000 });
	await page.keyboard.press('Space');
	await expect(panel.getByTestId('sound-live')).toHaveText('Audition stopped');
	expect(await appliedLabels(page)).toEqual(historyBefore);

	// insert at the playhead with the peak on frame 45 (one undo step)
	await first.click();
	await page.keyboard.press('Enter');
	await expect
		.poll(async () => Object.keys((await sequence(page)).clips).length, { timeout: 60_000 })
		.toBe(1);
	let seq = await sequence(page);
	const clip = Object.values(seq.clips)[0]!;
	const m = (await media(page))[clip.mediaId]!;
	expect(m.library?.soundId).toMatch(/^snd_/);
	const F = (FLICKS * seq.settings.frameRate.den) / seq.settings.frameRate.num;
	// This impact's peak plays exactly on frame45, including the silence prepended during registration.
	const peakAt = clip.start * F + m.library!.descriptors!.peakSec * FLICKS - clip.sourceIn;
	expect(Math.abs(peakAt - 45 * F)).toBeLessThanOrEqual(2);
	expect(JSON.stringify(clip)).toContain('"sfx"');
	expect((await appliedLabels(page)).at(-1)).toMatch(/^Add Sound /);
	expect(await page.locator('[data-testid="project-panel"]').innerText()).toContain('Sound Effects');
	await page.screenshot({ path: join(outDir, 'inserted.png') });

	// undo removes the clip, the media and the bin in one step
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => Object.keys((await sequence(page)).clips).length).toBe(0);
	expect(Object.keys(await media(page))).toHaveLength(0);

	// drag onto A1 near the playhead: the ghost shows, the peak snaps to the playhead
	const head = await page.getByTestId('timeline-playhead').boundingBox();
	const row = await page
		.locator(`[data-testid="timeline-track-area"] [data-track-id="${seq.audioTracks[0]!.id}"]`)
		.first()
		.boundingBox();
	expect(head && row).toBeTruthy();
	const src = await first.boundingBox();
	await page.mouse.move(src!.x + 60, src!.y + src!.height / 2);
	await page.mouse.down();
	await page.mouse.move(src!.x + 80, src!.y + src!.height / 2, { steps: 4 });
	const target = { x: head!.x + head!.width / 2 + 3, y: row!.y + row!.height / 2 };
	await page.mouse.move(target.x, target.y, { steps: 12 });
	await page.mouse.move(target.x + 1, target.y, { steps: 2 });
	const ghost = page.locator('[data-sound-ghost]');
	await expect(ghost).toBeVisible({ timeout: 10_000 });
	await expect(page.locator('[data-sound-ghost-peak]')).toBeVisible();
	await expect(page.locator('[data-snap-indicator]')).toBeVisible();
	await page.screenshot({ path: join(outDir, 'drag-ghost.png') });
	await page.mouse.up();
	await expect
		.poll(async () => Object.keys((await sequence(page)).clips).length, { timeout: 60_000 })
		.toBe(1);
	seq = await sequence(page);
	const dropped = Object.values(seq.clips)[0]!;
	const dm = (await media(page))[dropped.mediaId]!;
	const droppedPeak = dropped.start * F + dm.library!.descriptors!.peakSec * FLICKS - dropped.sourceIn;
	expect(Math.abs(droppedPeak - 45 * F)).toBeLessThanOrEqual(2);
	// dropped on A1: the drop target is the user's explicit choice
	expect(dropped.trackId).toBe(seq.audioTracks[0]!.id);

	// File ▸ Export ▸ Sound Credits…
	await page.getByRole('menuitem', { name: 'File' }).click();
	await page.getByRole('menuitem', { name: 'Export' }).hover();
	await page.getByRole('menuitem', { name: 'Sound Credits…' }).click();
	const dialog = page.getByTestId('sound-credits-dialog');
	await expect(dialog).toBeVisible();
	await expect(dialog.getByTestId('sound-credits-preview')).toHaveValue(/## Sound credits/);
	await page.screenshot({ path: join(outDir, 'credits.png') });
	const download = page.waitForEvent('download');
	await dialog.getByRole('button', { name: 'Save…' }).click();
	expect((await download).suggestedFilename()).toMatch(/sound-credits\.md$/);

	// high contrast
	await page.evaluate(() => document.documentElement.setAttribute('data-pr-contrast', 'high'));
	await panel.screenshot({ path: join(outDir, 'panel-high-contrast.png') });
	await page.evaluate(() => document.documentElement.removeAttribute('data-pr-contrast'));
});

test('inserted library sounds play their aligned point exactly on the frame in a Remotion export (ffmpeg)', async ({
	request,
}) => {
	test.setTimeout(900_000);
	await createProject(page, 'E2E Sound Peaks');
	await page.keyboard.press('Alt+Shift+Digit9');
	const panel = page.locator('[data-panel-kind="soundLibrary"][data-instance-id]');
	await expect(panel).toBeVisible({ timeout: 60_000 });
	const list = panel.getByRole('listbox', { name: 'Sounds' });
	await expect(list.getByRole('option').first()).toBeVisible({ timeout: 360_000 });
	await page.screenshot({ path: join(outDir, 'sound-design-workspace.png') });
	// title → cue frame; the aligned point is the type's (peak, start for UI, end for risers)
	const plan: { title: string; cue: number; align: 'peak' | 'start' | 'end' }[] = [
		{ title: 'Heavy metal hit', cue: 30, align: 'peak' },
		{ title: 'Punch', cue: 75, align: 'peak' },
		{ title: 'Air whoosh, low', cue: 120, align: 'peak' },
		{ title: 'Confirm blip', cue: 170, align: 'start' },
		{ title: 'Computer hum riser', cue: 290, align: 'end' },
	];
	// latest cue first: the playhead cannot go past the end of the sequence (an empty one: 10 s)
	for (const [i, p] of [...plan].sort((a, b) => b.cue - a.cue).entries()) {
		await panel.getByTestId('sound-search').fill(p.title);
		const option = list.getByRole('option', { name: new RegExp(`^${p.title}`) }).first();
		await expect(option).toBeVisible({ timeout: 30_000 });
		await query(page, 'playhead.set', { frame: p.cue });
		await expect
			.poll(async () => (await query<{ frame: number }>(page, 'playhead.get', {})).frame)
			.toBe(p.cue);
		await option.click();
		await page.keyboard.press('Enter');
		await expect
			.poll(async () => Object.keys((await sequence(page)).clips).length, { timeout: 60_000 })
			.toBe(i + 1);
	}
	const seq = await sequence(page);
	const all = await media(page);
	const F = (FLICKS * seq.settings.frameRate.den) / seq.settings.frameRate.num;
	const placed = plan.map((p) => {
		const clip = Object.values(seq.clips).find((c) => all[c.mediaId]?.library?.title === p.title);
		expect(
			clip,
			`${p.title}: ${JSON.stringify(Object.values(seq.clips).map((c) => [c.start, c.duration, all[c.mediaId]?.library?.title]))}`,
		).toBeTruthy();
		if (!clip) throw new Error('unreachable');
		const lib = all[clip.mediaId]!.library!;
		const lead = lib.leadSilenceSec ?? 0;
		const d = lib.descriptors!;
		const kit = join(ROOT, 'apps', 'engine', 'sounds', 'starter', lib.source!.file!);
		const ref = decodeMono(kit);
		// End alignment leaves the original sound's last sample on the cue; registration's padding is not the sound.
		const point =
			p.align === 'peak' ? d.peakSec : p.align === 'start' ? d.onsetSec : lead + ref.length / 48_000;
		// the document: the aligned point plays exactly at the cue frame
		const at = clip.start * F + point * FLICKS - clip.sourceIn;
		expect(
			Math.abs(at - p.cue * F),
			`${p.title} ${JSON.stringify({ clip, lib, at: at / F })}`,
		).toBeLessThanOrEqual(2);
		return { ...p, clip, lib, lead, point, ref };
	});
	// the loud-headed hits were registered with lead silence; nothing went on A1–A3
	expect(placed[0]!.lead).toBe(0.05);
	expect(placed.every((x) => seq.audioTracks.findIndex((t) => t.id === x.clip.trackId) >= 3)).toBe(true);
	await page.screenshot({ path: join(outDir, 'peaks-timeline.png') });

	// Native timing is owned by sound-fill and the engine placement oracle; this scenario owns the Remotion path.
	const { file } = await exportViaUi(page, request, {
		engine: 'remotion',
		fileName: 'sound-p1-peaks.mp4',
		expectPath: /remotion/i,
		outDir,
		jobTimeoutMs: 600_000,
	});
	const mix = decodeMono(file);
	const SR = 48_000;
	const report: Record<string, unknown>[] = [];
	for (const x of placed) {
		const ref = x.ref;
		// the aligned point in the library file (the media's descriptors include the lead silence)
		const refPoint = Math.round((x.point - x.lead) * SR);
		// 100 ms of the sound next to its aligned point: long enough to hold its envelope, so a tonal sound cannot match
		// one period off (AAC smears a sharp attack a little; a 20 ms window then preferred a later period)
		const W = 4800;
		const from = x.align === 'end' ? refPoint - W : x.align === 'start' ? refPoint : refPoint - W / 2;
		const w0 = Math.max(0, Math.min(ref.length - W, from));
		const w1 = Math.min(ref.length, w0 + W);
		const cueSample = (x.cue * F * SR) / FLICKS;
		const found = locate(mix, ref, w0, w1, Math.round(cueSample - refPoint), 3300);
		const errorSamples = found.lag + refPoint - cueSample;
		report.push({ title: x.title, align: x.align, cueSample, errorSamples, r: found.r, lead: x.lead });
		expect(found.r, x.title).toBeGreaterThan(0.9);
		// AAC and the 29.97 fps sample grid (1601.6 samples per frame): within 2 samples (≈ 0.04 ms)
		expect(Math.abs(errorSamples), JSON.stringify(report)).toBeLessThanOrEqual(2);
	}
	test.info().annotations.push({ type: 'export alignment', description: JSON.stringify(report) });
	console.log('export alignment', JSON.stringify(report));
});

test('Preferences ▸ Sound Library adds a user folder with its licence; its sound is found and inserted exactly', async () => {
	test.setTimeout(600_000);
	// a folder with one hit that starts at once (a loud head: registered with lead silence)
	const dir = mkdtempSync(join(tmpdir(), 'jasper-e2e-sfx-'));
	const sr = 48_000;
	const n = Math.round(0.5 * sr);
	const pcm = Buffer.alloc(44 + n * 2);
	pcm.write('RIFF', 0);
	pcm.writeUInt32LE(36 + n * 2, 4);
	pcm.write('WAVEfmt ', 8);
	pcm.writeUInt32LE(16, 16);
	pcm.writeUInt16LE(1, 20);
	pcm.writeUInt16LE(1, 22);
	pcm.writeUInt32LE(sr, 24);
	pcm.writeUInt32LE(sr * 2, 28);
	pcm.writeUInt16LE(2, 32);
	pcm.writeUInt16LE(16, 34);
	pcm.write('data', 36);
	pcm.writeUInt32LE(n * 2, 40);
	for (let i = 0; i < n; i++) {
		const t = i / sr;
		const v = Math.exp(-t * 14) * Math.sin(2 * Math.PI * 220 * t) * 0.8;
		pcm.writeInt16LE(Math.round(v * 32000), 44 + i * 2);
	}
	mkdirSync(join(dir, 'Impacts'), { recursive: true });
	writeFileSync(join(dir, 'Impacts', 'door slam e2e.wav'), pcm);

	await page.getByTestId('title-bar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
	await page.getByRole('menuitem', { name: /^Preferences$/ }).hover();
	await page.getByRole('menuitem', { name: /^Preferences…/ }).click();
	const prefs = page.getByTestId('preferences-dialog');
	await expect(prefs).toBeVisible();
	await prefs.getByTestId('prefs-page-sound-library').click();
	await expect(prefs.getByTestId('prefs-sound-library')).toBeVisible();
	// (the engine's folders outlive a test: a repeat in the same server finds the earlier run's folder there)
	const folders = prefs.getByRole('list', { name: 'Sound folders' }).getByRole('listitem');
	const foldersBefore = await folders.count();
	await prefs.getByTestId('sound-prefs-new-path').fill(dir);
	await prefs.getByTestId('sound-prefs-add-folder').click();
	await expect(folders).toHaveCount(foldersBefore + 1, { timeout: 30_000 });
	await expect(folders.filter({ hasText: dir })).toHaveCount(1);
	await prefs.screenshot({ path: join(outDir, 'preferences-folder.png') });
	await page.keyboard.press('Escape');
	await expect(prefs).toBeHidden();

	// not declared → "user-provided": hidden by Commercial-safe, found with it off (the export left the Jobs tab in front)
	await page.locator('.dv-tab', { hasText: 'Sound Library' }).first().click();
	const panel = page.locator('[data-panel-kind="soundLibrary"][data-instance-id]');
	const list = panel.getByRole('listbox', { name: 'Sounds' });
	await panel.getByTestId('sound-search').fill('door slam e2e');
	await panel.getByRole('button', { name: /Commercial-safe/ }).click();
	const option = list.getByRole('option', { name: /^door slam e2e/i }).first();
	await expect(option).toBeVisible({ timeout: 180_000 });
	await expect(option).toHaveAccessibleName(/Hit/);
	await panel.screenshot({ path: join(outDir, 'panel-user-folder.png') });
	await query(page, 'playhead.set', { frame: 20 });
	await expect.poll(async () => (await query<{ frame: number }>(page, 'playhead.get', {})).frame).toBe(20);
	const before = Object.keys((await sequence(page)).clips).length;
	await option.click();
	await page.keyboard.press('Enter');
	await expect
		.poll(async () => Object.keys((await sequence(page)).clips).length, { timeout: 60_000 })
		.toBe(before + 1);
	const seq = await sequence(page);
	const all = await media(page);
	const clip = Object.values(seq.clips).find((c) => all[c.mediaId]?.library?.source?.type === 'folder')!;
	const m = all[clip.mediaId]!;
	expect(m.library!.leadSilenceSec).toBe(0.05);
	const F = (FLICKS * seq.settings.frameRate.den) / seq.settings.frameRate.num;
	expect(
		Math.abs(clip.start * F + m.library!.descriptors!.peakSec * FLICKS - clip.sourceIn - 20 * F),
	).toBeLessThanOrEqual(2);
	await panel.getByRole('button', { name: /Commercial-safe/ }).click();

	// Remove the folder again (Preferences ▸ Sound Library ▸ Remove, Save Folders): the engine is as the test found it
	await page.getByTestId('title-bar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
	await page.getByRole('menuitem', { name: /^Preferences$/ }).hover();
	await page.getByRole('menuitem', { name: /^Preferences…/ }).click();
	await expect(prefs).toBeVisible();
	await prefs.getByTestId('prefs-page-sound-library').click();
	await folders.filter({ hasText: dir }).getByRole('button', { name: 'Remove' }).click();
	await prefs.getByTestId('sound-prefs-folders').getByRole('button', { name: 'Save Folders' }).click();
	await expect(folders).toHaveCount(foldersBefore, { timeout: 30_000 });
	await expect(
		prefs.getByTestId('sound-prefs-folders').getByRole('button', { name: 'Save Folders' }),
	).toBeDisabled({
		timeout: 30_000,
	});
	await page.keyboard.press('Escape');
	await expect(prefs).toBeHidden();
});
