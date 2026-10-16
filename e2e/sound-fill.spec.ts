// WP2.4b in the built app (spec 12 §2.7, P2-R7): Suggest Cues → fill the cut cue from the Sound Library with Enter (Fill
// mode from a double-click on the glyph) → Next Variation ×3 = ONE history entry "Swap Sound ×3" → Swap Sound… (Replace
// banner, Enter) → Add Layer… (linked, next free track) → moving one layer moves the other (undone) → In Context
// audition (Shift+Space: the Program chip, no document or history change) → Fill Unfilled Cues (a proposal, applied
// from review as one entry; WP3.3b) → native
// export: the peak of every peak-aligned single-layer fill is measured (ffmpeg) on its cue frame. Screenshots of the
// badges, Essential Sound ▸ Sound Design, Properties ▸ Sound / Cue, the cue menu's Fill With ▸, the Replace banner and the
// overlay chip go to test-results/e2e-sound-fill.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clipBox,
	createProject,
	enableAgentBridge,
	exportViaUi,
	focusTimeline,
	pointerDrag,
	query,
	ROOT,
	transact,
} from './support.ts';

test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });
test.describe.configure({ mode: 'serial' });

const outDir = join(ROOT, 'test-results', 'e2e-sound-fill');
const FLICKS = 705_600_000;
let page: Page;

type Sfx = {
	cueId: string | null;
	soundId: string | null;
	layer: number;
	role: string;
	alternatives?: string[];
	placement: { align: string; peakFlicks: number; errorFlicks: number };
};
type Clip = {
	id: string;
	kind: string;
	trackId: string;
	start: number;
	duration: number;
	sourceIn: number;
	mediaId: string;
	linkId?: string | null;
	speed: { rate: number };
	sfx?: Sfx;
};
type Cue = { id: string; frame: number; kind: string; weight: string; placedClipIds?: string[] };
type Seq = {
	clips: Record<string, Clip>;
	audioTracks: { id: string }[];
	settings: { frameRate: { num: number; den: number } };
	soundDesign?: { cues?: Record<string, Cue> };
};

async function sequence(p: Page): Promise<Seq> {
	const seqs = await query<Record<string, Seq>>(p, 'doc.get', { path: ['sequences'] });
	return Object.values(seqs)[0]!;
}
async function cues(p: Page): Promise<Cue[]> {
	return Object.values((await sequence(p)).soundDesign?.cues ?? {}).sort((a, b) => a.frame - b.frame);
}
const sfxClips = (s: Seq) => Object.values(s.clips).filter((c) => c.sfx);
/** Sequence frame (fractional) where a clip's aligned point plays. */
function pointFrame(s: Seq, c: Clip): number {
	const F = (FLICKS * s.settings.frameRate.den) / s.settings.frameRate.num;
	return c.start + (c.sfx!.placement.peakFlicks - c.sourceIn) / c.speed.rate / F;
}

/** The aligned point plays in [cue, cue + 1 frame) (sub-frame rest; 1e-6 frame of float slack). */
function expectOnCue(at: number, cue: number): void {
	expect(at).toBeGreaterThanOrEqual(cue - 1e-6);
	expect(at).toBeLessThan(cue + 1);
}

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

/**
 * Where `ref[w0, w1)` sits in `mix`, searching lags around `guess` (± `span` samples): the lag of the largest
 * normalised cross-correlation (as the Sound Library e2e measures inserts).
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

test.beforeAll(async ({ browser }) => {
	mkdirSync(outDir, { recursive: true });
	page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
	await enableAgentBridge(page);
});
test.afterAll(async () => {
	await page?.close();
});

test('fill, variation ×3 = one entry, swap, layer, link move, in context, fill unfilled, export peaks', async ({
	request,
}) => {
	test.setTimeout(1_200_000);
	await createProject(page, 'E2E Sound Fill');
	const r = await transact(page, [
		{ type: 'clip.addSolid', at: 0, duration: 75, track: 'V1', color: [0.8, 0.2, 0.2, 1], ref: '$a' },
		{ type: 'clip.addSolid', at: 75, duration: 75, track: 'V1', color: [0.2, 0.6, 0.2, 1], ref: '$b' },
		{ type: 'clip.addSolid', at: 150, duration: 75, track: 'V1', color: [0.2, 0.3, 0.8, 1], ref: '$c' },
		{ type: 'clip.addSolid', at: 225, duration: 75, track: 'V1', color: [0.7, 0.7, 0.2, 1] },
		{ type: 'marker.add', frame: 270, name: 'sfx: boom' },
	] as never);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	// the Sound Design workspace: Library, timeline with the seam, Essential Sound, Properties
	await page.keyboard.press('Alt+Shift+Digit9');
	const panel = page.locator('[data-panel-kind="soundLibrary"][data-instance-id]');
	await expect(panel).toBeVisible({ timeout: 60_000 });
	const list = panel.getByRole('listbox', { name: 'Sounds' });
	await expect(list.getByRole('option').first()).toBeVisible({ timeout: 360_000 });

	// Suggest Cues (edits + markers)
	const menubar = page.getByTestId('title-bar').getByRole('menubar');
	await menubar.getByRole('menuitem', { name: 'Sequence', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Sound Design' }).hover();
	await page.getByRole('menuitem', { name: 'Suggest Cues…' }).click();
	const dialog = page.getByTestId('suggest-cues-dialog');
	await dialog.getByRole('button', { name: /^Suggest \d+ Cues$/ }).click();
	await expect(dialog).toBeHidden();
	const all = await cues(page);
	const cut75 = all.find((c) => c.frame === 75)!;
	const cut150 = all.find((c) => c.frame === 150)!;
	expect(cut75 && cut150, JSON.stringify(all)).toBeTruthy();

	// fill the cut at 75: double-click its glyph (Fill mode, chips preset), Enter in the Library
	const seam = page.getByTestId('cue-seam');
	await expect(seam).toBeVisible();
	await focusTimeline(page);
	await page.keyboard.press('Backslash');
	await page.waitForTimeout(300);
	const glyphBox = async (id: string) => (await seam.locator(`[data-cue-id="${id}"]`).boundingBox())!;
	let g = await glyphBox(cut75.id);
	await page.mouse.dblclick(g.x + g.width / 2, g.y + g.height / 2);
	await expect(panel.getByTestId('sound-fill-chip')).toBeVisible();
	await expect(list.getByRole('option').first()).toBeVisible({ timeout: 30_000 });
	await list.getByRole('option').first().click();
	await page.keyboard.press('Enter');
	await expect
		.poll(async () => (await appliedLabels(page)).at(-1), { timeout: 60_000 })
		.toMatch(/^Fill Cue /);
	let seq = await sequence(page);
	const filled = sfxClips(seq).find((c) => c.sfx!.cueId === cut75.id)!;
	expect(filled, JSON.stringify(seq.clips)).toBeTruthy();
	expect(filled.sfx!.alternatives?.length ?? 0).toBeGreaterThanOrEqual(1);
	expectOnCue(pointFrame(seq, filled), 75);
	await expect(panel.getByTestId('sound-fill-chip')).toHaveCount(0);

	// select the clip; badges, Essential Sound ▸ Sound Design, Properties ▸ Sound
	/** Clicks a clip's body (zooming in around it first when it is too narrow to hit). */
	const clipBodyClick = async (id: string, button: 'left' | 'right' = 'left') => {
		let b = await clipBox(page, id).catch(() => null);
		for (let i = 0; (!b || b.width < 40) && i < 10; i++) {
			const c = (await sequence(page)).clips[id]!;
			await query(page, 'playhead.set', { frame: c.start });
			await focusTimeline(page);
			await page.keyboard.press('Equal');
			await page.waitForTimeout(200);
			b = await clipBox(page, id).catch(() => null);
		}
		if (!b) throw new Error(`clip ${id} is not visible`);
		await page.mouse.click(b.x + Math.min(20, b.width / 3), b.y + b.height - 6, { button });
	};
	const zoomToSequence = async () => {
		await focusTimeline(page);
		await page.keyboard.press('Backslash');
		await page.waitForTimeout(300);
	};
	await clipBodyClick(filled.id);
	await expect
		.poll(
			async () =>
				(await query<{ selection: { timeline: { clips: string[] } } }>(page, 'selection.get')).selection
					.timeline.clips,
		)
		.toContain(filled.id);
	const badges = page.locator(`[data-sound-badges="${filled.id}"]`);
	await expect(badges.locator('[data-sound-badge="type-sfx"]')).toBeVisible();
	await page.screenshot({ path: join(outDir, 'filled-badges.png') });
	// Essential Sound ▸ Sound Design ▸ Role: Hero (the clip gets the "H" badge)
	await page.getByTestId('essential-role').getByRole('radio', { name: /Hero/ }).click();
	await expect.poll(async () => (await appliedLabels(page)).at(-1)).toBe('Sound Role');
	expect((await sequence(page)).clips[filled.id]!.sfx!.role).toBe('hero');
	// zoom in on it for a close-up of the badges (the hero / layer glyphs need ≥ 80 px)
	await query(page, 'playhead.set', { frame: filled.start });
	for (let i = 0; i < 3; i++) {
		await clipBodyClick(filled.id);
		await page.keyboard.press('Equal');
		await page.waitForTimeout(250);
	}
	await page
		.locator(`[data-testid="timeline-track-area"] [data-clip-id="${filled.id}"]`)
		.first()
		.screenshot({
			path: join(outDir, 'clip-badges-closeup.png'),
		});
	const essential = page.getByTestId('essential-section-sound-design');
	if (await essential.isVisible().catch(() => false))
		await essential.screenshot({ path: join(outDir, 'essential-sfx.png') });

	// Next Variation ×3 = ONE history entry "Swap Sound ×3"; the peak stays on the cue
	const before = (await appliedLabels(page)).length;
	const original = filled.sfx!.soundId;
	for (let i = 1; i <= 3; i++) {
		await focusTimeline(page);
		await clipBodyClick(filled.id);
		await page.keyboard.press('Control+Alt+Period');
		await expect
			.poll(async () => (await appliedLabels(page)).at(-1), { timeout: 60_000 })
			.toBe(i === 1 ? 'Swap Sound' : `Swap Sound ×${i}`);
		await page.keyboard.press('Escape');
	}
	expect(await appliedLabels(page)).toHaveLength(before + 1);
	seq = await sequence(page);
	expect(seq.clips[filled.id]!.sfx!.soundId).not.toBe(original);
	expectOnCue(pointFrame(seq, seq.clips[filled.id]!), 75);

	// Swap Sound… (Alt+Shift+S): the Replace banner; Enter swaps
	await clipBodyClick(filled.id);
	await page.keyboard.press('Alt+Shift+KeyS');
	const banner = panel.getByTestId('sound-replace-banner');
	await expect(banner).toBeVisible();
	await expect(banner).toContainText(
		/^Replacing .* on A\d at 00[:;]00[:;]02[:;]15 · Enter to swap · Esc to cancel/,
	);
	await expect(list.getByRole('option').nth(1)).toBeVisible({ timeout: 30_000 });
	await panel.screenshot({ path: join(outDir, 'replace-banner.png') });
	await list.getByRole('option').nth(1).click();
	await page.keyboard.press('Enter');
	await expect
		.poll(async () => (await appliedLabels(page)).at(-1), { timeout: 60_000 })
		.toMatch(/^Swap Sound \S/);
	await expect(banner).toHaveCount(0);
	// leaving Replace mode clears the similarity ranking it set
	await expect(panel.getByTestId('sound-similar-chip')).toHaveCount(0);
	seq = await sequence(page);
	expectOnCue(pointFrame(seq, seq.clips[filled.id]!), 75);

	// Add Layer… from the clip menu: Fill mode with layer intent; Enter adds a linked layer on another track
	await clipBodyClick(filled.id, 'right');
	const menu = page.getByTestId('timeline-context-menu');
	await expect(menu).toBeVisible();
	await page.screenshot({ path: join(outDir, 'clip-menu.png') });
	await menu.getByRole('menuitem', { name: 'Add Layer…' }).click();
	await expect(panel.getByTestId('sound-fill-chip')).toContainText('Add layer:');
	await list.getByRole('option').nth(2).click();
	await page.keyboard.press('Enter');
	await expect
		.poll(async () => (await appliedLabels(page)).at(-1), { timeout: 60_000 })
		.toMatch(/^Add Layer /);
	seq = await sequence(page);
	const layer = sfxClips(seq).find((c) => c.sfx!.cueId === cut75.id && c.id !== filled.id)!;
	expect(layer.trackId).not.toBe(seq.clips[filled.id]!.trackId);
	expect(layer.linkId).toBeTruthy();
	expect(layer.linkId).toBe(seq.clips[filled.id]!.linkId);
	expectOnCue(pointFrame(seq, layer), 75);

	// moving one layer moves the other (linked); undo. The first layer is dragged (the new one went to a track below)
	await clipBodyClick(filled.id);
	const lb = await clipBox(page, filled.id);
	const ppf = lb.width / seq.clips[filled.id]!.duration;
	const start0 = { a: seq.clips[filled.id]!.start, b: layer.start };
	await pointerDrag(
		page,
		{ x: lb.x + lb.width / 2, y: lb.y + lb.height - 6 },
		{ x: lb.x + lb.width / 2 + 10 * ppf, y: lb.y + lb.height - 6 },
	);
	await expect.poll(async () => (await sequence(page)).clips[filled.id]!.start).not.toBe(start0.a);
	seq = await sequence(page);
	expect(seq.clips[layer.id]!.start - start0.b).toBe(seq.clips[filled.id]!.start - start0.a);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await sequence(page)).clips[layer.id]!.start).toBe(start0.b);

	// Properties ▸ Sound (the selected layer) and ▸ Cue (a selected cue)
	await page.getByRole('tab', { name: 'Properties' }).click();
	const soundSection = page.getByTestId('properties-sound-section');
	await expect(soundSection).toBeVisible();
	await expect(page.getByTestId('sound-section-credit')).not.toBeEmpty();
	await page.getByTestId('properties-panel').screenshot({ path: join(outDir, 'properties-sound.png') });
	await zoomToSequence();
	g = await glyphBox(cut150.id);
	await page.mouse.click(g.x + g.width / 2, g.y + g.height / 2);
	const cueSection = page.getByTestId('properties-cue-section');
	await expect(cueSection).toBeVisible();
	await expect(page.getByTestId('cue-section-timecode')).toHaveText(/^00[:;]00[:;]05[:;]00$/);
	await page.getByTestId('properties-panel').screenshot({ path: join(outDir, 'properties-cue.png') });
	await page.getByRole('tab', { name: 'Essential Sound' }).click();

	// In Context: Shift+Space in the Library with the cut at 150 selected → the Program chip; nothing is written
	const revision = await query<{ revision: number }>(page, 'doc.revision');
	const labels0 = await appliedLabels(page);
	await list.getByRole('option').first().click();
	await page.mouse.click(g.x + g.width / 2, g.y + g.height / 2); // the click on the list selected nothing else
	await list.focus();
	await page.keyboard.press('Shift+Space');
	const chip = page.getByTestId('sound-audition-chip');
	await expect(chip).toBeVisible({ timeout: 30_000 });
	await expect(chip).toContainText(/Auditioning: /);
	await page.screenshot({ path: join(outDir, 'in-context-chip.png') });
	await expect(chip).toBeHidden({ timeout: 30_000 });
	expect(await query<{ revision: number }>(page, 'doc.revision')).toEqual(revision);
	expect(await appliedLabels(page)).toEqual(labels0);
	expect((await query<{ frame: number }>(page, 'playhead.get')).frame).toBe(150);

	// Fill With ▸ in the cue menu (screenshot)
	await page.mouse.click(g.x + g.width / 2, g.y + g.height / 2, { button: 'right' });
	await expect(menu).toBeVisible();
	await menu.getByText('Fill With', { exact: true }).hover();
	await expect(page.getByRole('menuitem').filter({ hasText: / · / }).first()).toBeVisible({
		timeout: 30_000,
	});
	await page.screenshot({ path: join(outDir, 'fill-with-menu.png') });
	await page.keyboard.press('Escape');

	// Sequence ▸ Sound Design ▸ Fill Unfilled Cues proposes (WP3.3b): review opens on the proposal, nothing changes
	// until Apply; Accept all + Apply = one entry
	const n0 = (await appliedLabels(page)).length;
	const unfilled = (await cues(page)).filter((c) => !(c.placedClipIds ?? []).length).length;
	await menubar.getByRole('menuitem', { name: 'Sequence', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Sound Design' }).hover();
	await page.getByRole('menuitem', { name: 'Fill Unfilled Cues' }).click();
	await expect(page.getByTestId('review-bar')).toBeVisible({ timeout: 120_000 });
	await expect(page.getByTestId('review-bar-title')).toContainText('Fill Unfilled Cues');
	expect(await appliedLabels(page)).toHaveLength(n0);
	await page.getByTestId('review-bar-accept-all').click();
	await expect(page.getByTestId('review-bar-apply')).toHaveText(`Apply ${unfilled} of ${unfilled}`);
	await page.getByTestId('review-bar-apply').click();
	await expect
		.poll(async () => (await appliedLabels(page)).at(-1), { timeout: 120_000 })
		.toMatch(/^Accept Fill Unfilled Cues \(\d+ of \d+\)$/);
	expect(await appliedLabels(page)).toHaveLength(n0 + 1);
	// the apply toast would cover the export dialog's footer
	await page
		.getByTestId('toast')
		.filter({ hasText: /^Applied/ })
		.getByRole('button', { name: 'Dismiss' })
		.click();
	await page.getByTestId('review-bar-exit').click();
	const after = await cues(page);
	expect(after.filter((c) => (c.placedClipIds ?? []).length).length).toBe(after.length);
	expect(unfilled).toBeGreaterThan(0);
	await page.screenshot({ path: join(outDir, 'filled-all.png') });

	// export: every single-layer, peak-aligned fill has its peak on the cue frame
	seq = await sequence(page);
	const { file } = await exportViaUi(page, request, {
		engine: 'native',
		fileName: 'sound-fill.mp4',
		expectPath: /native/i,
		outDir,
		jobTimeoutMs: 600_000,
	});
	const mix = decodeMono(file);
	const SR = 48_000;
	const F = (FLICKS * seq.settings.frameRate.den) / seq.settings.frameRate.num;
	const report: Record<string, unknown>[] = [];
	type MediaRow = {
		locators: { type: string; key?: string }[];
		library?: { descriptors?: { peakSec: number } };
	};
	const mediaDoc = await query<Record<string, MediaRow>>(page, 'doc.get', { path: ['media'] });
	for (const cue of Object.values(seq.soundDesign?.cues ?? {})) {
		const ids = (cue.placedClipIds ?? []).filter((id) => seq.clips[id]);
		if (ids.length !== 1) continue;
		const c = seq.clips[ids[0]!]!;
		if (c.sfx!.placement.align !== 'peak') continue;
		// the registered media file (lead silence included), varispeed like the clip
		const m = mediaDoc[c.mediaId]!;
		const key = m.locators.find((l) => l.type === 'engine-store')?.key;
		expect(key, JSON.stringify(m.locators)).toBeTruthy();
		const res = await request.get(`/media/${encodeURIComponent(key!)}`);
		expect(res.ok()).toBe(true);
		const local = join(outDir, `${c.id}.media`);
		writeFileSync(local, await res.body());
		const ref = decodeMono(local, c.speed.rate);
		const refPoint = Math.round(((c.sfx!.placement.peakFlicks / FLICKS) * SR) / c.speed.rate);
		const W = 4800;
		const w0 = Math.max(0, Math.min(ref.length - W, refPoint - W / 2));
		const w1 = Math.min(ref.length, w0 + W);
		const expected = pointFrame(seq, c) * (F / FLICKS) * SR;
		const cueSample = (cue.frame * F * SR) / FLICKS;
		const found = locate(mix, ref, w0, w1, Math.round(expected - refPoint), 2400);
		const peakAt = found.lag + refPoint;
		report.push({
			cue: cue.frame,
			rate: c.speed.rate,
			expected,
			peakAt,
			errorSamples: peakAt - expected,
			r: found.r,
		});
		expect(found.r, JSON.stringify(report)).toBeGreaterThan(0.9);
		// the peak plays where the document puts it (≤ 2 samples: AAC, the 29.97 fps grid, varispeed resampling)…
		expect(Math.abs(peakAt - expected), JSON.stringify(report)).toBeLessThanOrEqual(2);
		// …which is on the cue frame: in [cue, cue + 1 frame)
		expect(peakAt, JSON.stringify(report)).toBeGreaterThanOrEqual(cueSample - 2);
		expect(peakAt, JSON.stringify(report)).toBeLessThan(cueSample + (F / FLICKS) * SR);
	}
	expect(report.length).toBeGreaterThanOrEqual(2);
	test.info().annotations.push({ type: 'export peaks', description: JSON.stringify(report) });
	console.log('export peaks', JSON.stringify(report));
});
