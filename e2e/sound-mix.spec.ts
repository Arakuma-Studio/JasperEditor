// Spec 12 Phase 4 in the built app (WP4.2b, P4-R4 / P4-R5): the Phase 2 fixture with generated music on A1 and dialogue
// (4–8 s) on A2 → Sequence ▸ Sound Design ▸ Auto Sound Pass… with Room glue, Stop before heroes, Build into heroes and
// the web delivery → review → Accept all → Apply (ONE History entry) → the room bus, the dip and the build are in the
// mix, and the Cue Seam draws the hero's written span bars → Essential Sound ▸ Sound Design shows a placed sound's
// solver gain and why → the music gets 6 dB louder → Rebalance SFX Levels: ONE History entry that Ctrl+Z takes back
// whole → Delivery Target… (web) applies with its measured summary → export: ffmpeg ebur128 integrated −14 ± 1 LUFS,
// true peak ≤ −1 dBTP. Screenshots: test-results/e2e-sound-mix.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { FIXTURE_COMMANDS } from '../apps/mcp/test/sound-cues-fixture.ts';
import {
	appliedLabels,
	clipBox,
	clipElement,
	enableAgentBridge,
	exportViaUi,
	focusTimeline,
	query,
	ROOT,
	transact,
} from './support.ts';

test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });
test.describe.configure({ mode: 'serial' });

const outDir = join(ROOT, 'test-results', 'e2e-sound-mix');
const FFMPEG = process.env.JASPER_FFMPEG ?? 'ffmpeg';
let page: Page;

test.beforeAll(async ({ browser }) => {
	mkdirSync(outDir, { recursive: true });
	page = await browser.newPage({ viewport: { width: 1800, height: 1050 } });
	await enableAgentBridge(page);
});
test.afterAll(async () => {
	await page?.close();
});

/** A generated stereo 48 kHz WAV (ffmpeg lavfi). */
function wav(name: string, source: string, seconds: number): string {
	const file = join(outDir, name);
	const r = spawnSync(FFMPEG, [
		'-v',
		'error',
		'-y',
		'-f',
		'lavfi',
		'-i',
		source,
		'-t',
		String(seconds),
		'-ar',
		'48000',
		'-ac',
		'2',
		'-c:a',
		'pcm_s16le',
		file,
	]);
	expect(r.status, String(r.stderr)).toBe(0);
	return file;
}

/** ffmpeg's EBU R 128 summary of a file: integrated loudness and true peak. */
function ebur128(file: string): { integrated: number; truePeak: number } {
	const r = spawnSync(
		FFMPEG,
		[
			'-nostats',
			'-hide_banner',
			'-i',
			file,
			'-vn',
			'-filter_complex',
			'ebur128=peak=true',
			'-f',
			'null',
			'-',
		],
		{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
	);
	const text = r.stderr;
	const summary = text.slice(text.lastIndexOf('Summary:'));
	const i = /I:\s+(-?[\d.]+) LUFS/.exec(summary);
	const p = /True peak:\s+Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(summary);
	if (!i || !p) throw new Error(`ebur128 output not understood: ${summary.slice(0, 500)}`);
	return { integrated: Number(i[1]), truePeak: Number(p[1]) };
}

/** `createProject` with timeouts for a loaded host (the editor can take more than 15 s to open). */
async function createProject(p: Page, name: string): Promise<string> {
	await p.goto('/');
	await expect(p.getByTestId('home')).toBeVisible({ timeout: 120_000 });
	await p.getByTestId('home-new').click();
	await p.getByTestId('new-project-name').fill(name);
	await p.getByTestId('new-project-create').click();
	await expect(p.getByTestId('editor-shell')).toBeVisible({ timeout: 180_000 });
	await expect(p.getByTestId('timeline-track-area')).toBeVisible({ timeout: 120_000 });
	await expect.poll(() => p.evaluate(() => !!window.jasper), { timeout: 120_000 }).toBe(true);
	const m = /\/project\/([^/?#]+)/.exec(p.url());
	if (!m) throw new Error(`Unexpected editor URL ${p.url()}`);
	return decodeURIComponent(m[1]!);
}

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

type Level = { by: string; gainDb: number; limitedBy?: string[]; reason?: string };
type Clip = {
	id: string;
	kind: string;
	start: number;
	duration: number;
	trackId: string;
	gainDb: number;
	essential?: { type?: string };
	sfx?: { cueId: string | null; level?: Level };
};
type Seq = {
	id: string;
	clips: Record<string, Clip>;
	audioTracks: {
		id: string;
		volumeDb?: { keyframes: unknown[] };
		mixer?: { sends?: { target: string }[] };
	}[];
	submixTracks?: { id: string; name: string }[];
	soundDesign?: {
		cues?: Record<string, { id: string; frame: number; weight: string; placedClipIds?: string[] }>;
		mix?: { cues?: Record<string, { stopBefore?: unknown; build?: unknown }>; room?: { busId: string } };
		settings?: { delivery?: string };
	};
};
async function sequence(p: Page): Promise<Seq> {
	const seqs = await query<Record<string, Seq>>(p, 'doc.get', { path: ['sequences'] });
	return Object.values(seqs)[0]!;
}
const sfxClips = (s: Seq) => Object.values(s.clips).filter((c) => !!c.sfx);

async function menu(p: Page, item: string) {
	const menubar = p.getByTestId('title-bar').getByRole('menubar');
	await menubar.getByRole('menuitem', { name: 'Sequence', exact: true }).click();
	await p.getByRole('menuitem', { name: 'Sound Design' }).hover();
	await p.getByRole('menuitem', { name: item }).click();
}

/**
 * Clicks a clip's body (zooming in around it first when it is too narrow or out of view). A clip outside the rendered
 * window is not in the DOM: never wait for it (boundingBox would wait forever).
 */
async function clipBodyClick(id: string) {
	const inView = async (b: { x: number; y: number; width: number; height: number } | null) => {
		if (!b) return false;
		const area = await page.getByTestId('timeline-clip-area').boundingBox();
		return (
			!area ||
			(b.x + 8 >= area.x &&
				b.x + Math.min(20, b.width / 3) <= area.x + area.width - 8 &&
				b.y + b.height - 6 <= area.y + area.height &&
				b.y + b.height - 6 >= area.y)
		);
	};
	const box = async () =>
		(await clipElement(page, id).count()) ? await clipBox(page, id).catch(() => null) : null;
	let b = await box();
	for (let i = 0; (!b || b.width < 40 || !(await inView(b))) && i < 10; i++) {
		const c = (await sequence(page)).clips[id]!;
		await query(page, 'playhead.set', { frame: c.start });
		await focusTimeline(page);
		await page.keyboard.press(i === 0 ? 'Backslash' : 'Equal');
		await page.waitForTimeout(300);
		b = await box();
	}
	if (!b || !(await inView(b))) throw new Error(`clip ${id} is not visible`);
	await page.mouse.click(b.x + Math.min(20, b.width / 3), b.y + b.height - 6);
}

test('Auto Sound Pass with mix options → review → apply → Essential solver gain → Rebalance → Delivery → export at −14 LUFS', async ({
	request,
}) => {
	test.setTimeout(3_600_000);
	await createProject(page, 'E2E Sound Mix');
	// music: 14 s of pink noise; dialogue: 4 s of a 1.5 kHz tone with a 4 Hz syllable envelope, placed at 4 s
	const music = wav('music.wav', 'anoisesrc=d=14:c=pink:a=0.08:seed=7', 14);
	const speech = wav(
		'speech.wav',
		"aevalsrc='0.25*sin(2*PI*1500*t)*(0.55+0.45*sin(2*PI*4*t))':s=48000:d=4",
		4,
	);
	await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Control+KeyI');
	await (await chooser).setFiles([music, speech]);
	for (const n of ['music.wav', 'speech.wav'])
		await expect(page.getByTestId('project-row').filter({ hasText: n })).toBeVisible({ timeout: 120_000 });
	const items = await query<Record<string, { id: string; name: string }>>(page, 'doc.get', {
		path: ['items'],
	});
	const itemOf = (n: string) => Object.values(items).find((i) => i.name === n)!.id;
	// The whole Phase 2 fixture, its fframes motion graphic included, when the fframes renderer is built (`pnpm
	// mg:build`; `pnpm e2e` builds it when cargo is installed): the native export renders it through jasper-mg.
	// Without it the native path refuses the graphic with a named blocker (planner, AGENTS.md §4), so the spec leaves
	// the graphic out and says so.
	const caps = (await (await request.get('/api/capabilities')).json()) as {
		render: { fframes: string; fframesReason?: string };
	};
	const withGraphic = caps.render.fframes === 'ready';
	if (!withGraphic)
		test.info().annotations.push({
			type: 'fframes',
			description: `the fixture's fframes graphic is left out: ${caps.render.fframesReason ?? 'jasper-mg is not built'}`,
		});
	const setup = await transact(page, [
		...((FIXTURE_COMMANDS as { type: string }[]).filter(
			(c) => withGraphic || c.type !== 'clip.addMotionGraphic',
		) as never[]),
		{
			type: 'clip.place',
			source: { projectItemId: itemOf('music.wav') },
			at: 0,
			tracks: { audio: 'A1' },
			ref: '$m',
		},
		{ type: 'essentialSound.setType', clipIds: ['$m'], audioType: 'music' },
		{
			type: 'clip.place',
			source: { projectItemId: itemOf('speech.wav') },
			at: 120,
			tracks: { audio: 'A2' },
			ref: '$d',
		},
		{ type: 'essentialSound.setType', clipIds: ['$d'], audioType: 'dialogue' },
	] as never);
	expect(setup.ok, JSON.stringify(setup)).toBe(true);
	await libraryReady(request);
	await page.keyboard.press('Alt+Shift+Digit9');
	await expect(page.locator('[data-panel-kind="review"][data-instance-id]')).toBeVisible({ timeout: 60_000 });

	// 1. Auto Sound Pass… with the Phase 4 options
	await menu(page, 'Auto Sound Pass…');
	const dialog = page.getByTestId('auto-sound-pass-dialog');
	await expect(dialog).toBeVisible();
	const mix = dialog.getByTestId('auto-pass-mix');
	await mix.getByRole('checkbox', { name: /Room glue/ }).click();
	await mix.getByRole('checkbox', { name: /Stop before heroes/ }).click();
	await mix.getByRole('checkbox', { name: /Build into heroes/ }).click();
	await mix.getByRole('combobox', { name: 'Delivery' }).click();
	await page.getByRole('option', { name: 'Web / streaming · −14 LUFS · −1 dBTP' }).click();
	await dialog.screenshot({ path: join(outDir, 'auto-pass-mix-options.png'), timeout: 60_000 });
	const before = await appliedLabels(page);
	await dialog.getByRole('button', { name: 'Propose' }).click();
	// review opens; a plan whose solve has notes (conflicts, dialogue-band advice) keeps the dialog open listing them
	// until Close (Phase 4 verification)
	await expect(page.getByTestId('review-bar')).toBeVisible({ timeout: 1_500_000 });
	const notes = dialog.getByTestId('auto-pass-notes');
	if (await notes.isVisible()) {
		const items = await dialog.getByTestId('auto-pass-notes-list').getByRole('listitem').allTextContents();
		console.log('plan notes', JSON.stringify(items));
		test.info().annotations.push({ type: 'plan notes', description: JSON.stringify(items) });
		expect(items.length).toBeGreaterThan(0);
		await dialog.screenshot({ path: join(outDir, 'auto-pass-notes.png'), timeout: 60_000 });
		await dialog.locator('[data-dialog-primary]').click();
	}
	await expect(dialog).toBeHidden();
	expect(await appliedLabels(page)).toEqual(before);
	await page.screenshot({ path: join(outDir, 'review.png') });
	await page.getByTestId('review-bar-accept-all').click();
	await page.getByTestId('review-bar-apply').click();
	await expect
		.poll(async () => (await appliedLabels(page)).length, { timeout: 120_000 })
		.toBe(before.length + 1);
	await page.getByTestId('review-bar-exit').click();
	await expect(page.getByTestId('review-bar')).toBeHidden();

	// the mix setup is there: the room bus with its sends, the hero's dip and build recorded as written
	let seq = await sequence(page);
	const room = seq.soundDesign?.mix?.room;
	expect(room, JSON.stringify(seq.soundDesign?.mix ?? null)).toBeTruthy();
	expect(seq.submixTracks?.some((t) => t.id === room!.busId && t.name === 'SFX Room')).toBe(true);
	expect(seq.audioTracks.some((t) => t.mixer?.sends?.some((s) => s.target === room!.busId))).toBe(true);
	expect(seq.soundDesign?.settings?.delivery).toBe('web');
	const hero = Object.values(seq.soundDesign!.cues!).find(
		(c) => c.weight === 'hero' && seq.soundDesign?.mix?.cues?.[c.id]?.stopBefore,
	);
	expect(hero, JSON.stringify(seq.soundDesign)).toBeTruthy();
	expect(seq.soundDesign!.mix!.cues![hero!.id]!.build).toBeTruthy();
	// the Cue Seam draws the hero's dip and build as written (solid)
	const seam = page.getByTestId('cue-seam');
	await expect(seam).toBeVisible();
	await expect(seam.locator(`[data-cue-stop="${hero!.id}"]`)).toHaveAttribute('data-written', 'true');
	await expect(seam.locator(`[data-cue-build="${hero!.id}"]`)).toHaveAttribute('data-written', 'true');
	await query(page, 'playhead.set', { frame: hero!.frame });
	await focusTimeline(page);
	for (let i = 0; i < 3; i++) await page.keyboard.press('Equal');
	await page.waitForTimeout(400);
	await seam.screenshot({ path: join(outDir, 'cue-span-bars.png'), timeout: 60_000 });
	await page
		.getByTestId('timeline-track-area')
		.screenshot({ path: join(outDir, 'timeline-mix.png'), timeout: 60_000 });

	// 2. Essential Sound ▸ Sound Design: a placed sound's solver gain and why
	// a solved sound on the first sound-effect track (visible without scrolling the audio tracks), the longest
	const trackIndex = (c: Clip) => seq.audioTracks.findIndex((t) => t.id === c.trackId);
	const solved = sfxClips(seq)
		.filter((c) => c.sfx?.level?.by === 'solver')
		.sort((a, b) => trackIndex(a) - trackIndex(b) || b.duration - a.duration)[0];
	expect(solved, JSON.stringify(sfxClips(seq).map((c) => c.sfx?.level))).toBeTruthy();
	await clipBodyClick(solved!.id);
	await expect
		.poll(
			async () =>
				(await query<{ selection: { timeline: { clips: string[] } } }>(page, 'selection.get')).selection
					.timeline.clips,
		)
		.toContain(solved!.id);
	const essentialTab = page.getByRole('tab', { name: 'Essential Sound' });
	if (await essentialTab.isVisible().catch(() => false)) await essentialTab.click();
	const level = page.getByTestId('essential-auto-gain-level');
	await expect(level).toBeVisible({ timeout: 30_000 });
	await expect(level).toContainText('Solver');
	const gainText = (await page.getByTestId('essential-auto-gain-text').textContent()) ?? '';
	expect(gainText).toMatch(/^[−+]?\d+\.\d dB · /);
	await page.getByTestId('essential-sfx-mix').scrollIntoViewIfNeeded();
	await page
		.getByTestId('essential-section-sound-design')
		.screenshot({ path: join(outDir, 'essential-sfx.png') });

	// 3. The music 6 dB louder → Rebalance SFX Levels: ONE History entry; Ctrl+Z takes all of it back
	const music0 = Object.values(seq.clips).find((c) => c.essential?.type === 'music')!;
	const louder = await transact(page, [
		{ type: 'audio.setGain', clipIds: [music0.id], mode: 'adjust', db: 6 },
	] as never);
	expect(louder.ok).toBe(true);
	const gainsBefore = Object.fromEntries(sfxClips(await sequence(page)).map((c) => [c.id, c.gainDb]));
	const n0 = (await appliedLabels(page)).length;
	await menu(page, 'Rebalance SFX Levels');
	await expect.poll(async () => (await appliedLabels(page)).length, { timeout: 900_000 }).toBe(n0 + 1);
	expect((await appliedLabels(page)).at(-1)).toBe('Rebalance SFX Levels');
	await expect(page.getByTestId('toast').filter({ hasText: /Rebalanced \d+ sound effects?/ })).toBeVisible();
	const gainsAfter = Object.fromEntries(sfxClips(await sequence(page)).map((c) => [c.id, c.gainDb]));
	const changed = Object.keys(gainsAfter).filter(
		(id) => Math.abs(gainsAfter[id]! - gainsBefore[id]!) >= 0.01,
	);
	expect(changed.length).toBeGreaterThan(0);
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect
		.poll(async () => Object.fromEntries(sfxClips(await sequence(page)).map((c) => [c.id, c.gainDb])))
		.toEqual(gainsBefore);
	await page.keyboard.press('Control+Shift+KeyZ');
	await expect
		.poll(async () => Object.fromEntries(sfxClips(await sequence(page)).map((c) => [c.id, c.gainDb])))
		.toEqual(gainsAfter);

	// 4. Room Glue… shows the room (looked at; nothing changed)
	await menu(page, 'Room Glue…');
	const glue = page.getByTestId('room-glue-dialog');
	await expect(glue).toBeVisible();
	await expect(glue.getByTestId('room-glue-tracks')).toContainText('Sends from:');
	await expect(glue.getByTestId('room-glue-tracks')).toContainText('Bus: SFX Room (made by sound design)');
	await glue.screenshot({ path: join(outDir, 'room-glue-dialog.png'), timeout: 60_000 });
	await glue.getByRole('button', { name: 'Cancel' }).click();
	await expect(glue).toBeHidden();

	// 5. Delivery Target… (web): one transaction, the measured summary, Undo in the toast
	await menu(page, 'Delivery Target…');
	const delivery = page.getByTestId('delivery-dialog');
	await expect(delivery).toBeVisible();
	await expect(delivery.getByTestId('delivery-numbers')).toContainText('−14.0 LUFS');
	const n1 = (await appliedLabels(page)).length;
	await delivery.getByRole('button', { name: 'Apply' }).click();
	await expect(delivery.getByTestId('delivery-summary')).toContainText('Export:', { timeout: 1_500_000 });
	const summary = (await delivery.getByTestId('delivery-summary').textContent()) ?? '';
	console.log('delivery summary', summary);
	test.info().annotations.push({ type: 'delivery', description: summary });
	expect(summary).toContain('Music under the voice:');
	await delivery.screenshot({ path: join(outDir, 'delivery-dialog.png'), timeout: 60_000 });
	expect((await appliedLabels(page)).length).toBe(n1 + 1);
	expect((await appliedLabels(page)).at(-1)).toBe('Apply Delivery Preset: Web / streaming (−14 LUFS)');
	await expect(
		page.getByTestId('toast').filter({ hasText: 'Applied Web / streaming · −14 LUFS · −1 dBTP' }),
	).toBeVisible();
	await delivery.getByRole('button', { name: 'Close' }).last().click();
	await expect(delivery).toBeHidden();
	// (a toast without such a button — the rebalance toast's actions are Undo and Solver Notes… — must not hang the spec)
	for (const t of await page.getByTestId('toast').all())
		await t
			.getByRole('button', { name: /Dismiss|Close/ })
			.first()
			.click({ timeout: 5_000 })
			.catch(() => undefined);

	// 6. Export: the delivered mix measured by ffmpeg
	seq = await sequence(page);
	const { file } = await exportViaUi(page, request, {
		engine: 'native',
		fileName: 'sound-mix.mp4',
		expectPath: /native/i,
		outDir,
		jobTimeoutMs: 1_200_000,
	});
	const m = ebur128(file);
	console.log('export loudness', JSON.stringify(m));
	test.info().annotations.push({ type: 'loudness', description: JSON.stringify(m) });
	expect(Math.abs(m.integrated + 14), JSON.stringify(m)).toBeLessThanOrEqual(1);
	expect(m.truePeak, JSON.stringify(m)).toBeLessThanOrEqual(-1);
	// an unfilled cue's stop-before and build are only stored: the seam draws them dashed
	const stored = await transact(page, [
		{
			type: 'soundCue.add',
			cues: [
				{
					frame: 390,
					kind: 'manual',
					weight: 'hero',
					source: 'user',
					stopBefore: { seconds: 0.5, depthDb: -24 },
					build: { seconds: 2, fromHz: 150, toHz: 2000 },
				},
			],
		},
	] as never);
	expect(stored.ok, JSON.stringify(stored)).toBe(true);
	const unfilled = Object.values((await sequence(page)).soundDesign!.cues!).find((c) => c.frame === 390)!;
	await expect(seam.locator(`[data-cue-stop="${unfilled.id}"]`)).toHaveAttribute('data-written', 'false');
	await expect(seam.locator(`[data-cue-build="${unfilled.id}"]`)).toHaveAttribute('data-written', 'false');
	await query(page, 'playhead.set', { frame: 360 });
	await focusTimeline(page);
	await page.waitForTimeout(400);
	await seam.screenshot({ path: join(outDir, 'cue-span-bars-stored.png'), timeout: 60_000 });
	// a frame of the picture at the hero (the export renders it)
	spawnSync(FFMPEG, [
		'-v',
		'error',
		'-y',
		'-ss',
		String(hero!.frame / 29.97),
		'-i',
		file,
		'-frames:v',
		'1',
		join(outDir, 'export-hero-frame.png'),
	]);
});
