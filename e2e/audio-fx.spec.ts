// audio-fx through the real UI of the built app (docs/wp-notes/audio-fx.md): an audio effect applied from the
// Effects panel's Audio Effects bin with its EQ curve in Effect Controls, Essential Sound (Dialogue, Repair, Loudness
// Auto-Match measured on the engine, Music ▸ Duration ▸ Remix), the Remix tool dragging a music clip's out edge, and
// a native export with the effects, the remix and the matched loudness.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	clipBox,
	clips,
	createProject,
	enableAgentBridge,
	exportViaUi,
	ffprobe,
	focusTimeline,
	importFiles,
	pointerDrag,
	query,
	ROOT,
	sequenceSummary,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

let page: Page;
const outDir = join(ROOT, 'test-results', 'e2e-audio-fx');

type Fx = { id: string; effectId: string; essential?: string };
type AClip = {
	id: string;
	kind: string;
	name: string;
	start: number;
	duration: number;
	gainDb: number;
	effects: Fx[];
	essential?: { type: string; loudness: { gainDb: number; measuredLufs: number | null } };
	remix?: { index: number; count: number };
};
type Doc = {
	items: Record<string, { id: string; kind: string; name: string }>;
	sequences: Record<string, { clips: Record<string, AClip> }>;
};
const doc = () => query<Doc>(page, 'doc.get');
let seqId = '';
let voiceId = '';
let musicId = '';
const clip = async (id: string) => (await doc()).sequences[seqId]!.clips[id]!;
const fpsOf = async () => {
	const r = (await sequenceSummary(page)).settings.frameRate;
	return r.num / r.den;
};
const audioClips = async () =>
	Object.values((await doc()).sequences[seqId]!.clips).filter((c) => c.kind === 'audio');

test.beforeAll(async ({ browser }) => {
	mkdirSync(outDir, { recursive: true });
	page = await browser.newPage();
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	if (page && !page.isClosed()) await page.screenshot({ path: join(outDir, 'final.png') });
	await page?.context().close();
});

/** Integrated loudness (LUFS) of a file, ffmpeg ebur128. */
function integratedLufs(file: string): number {
	const r = spawnSync(
		process.env.JASPER_FFMPEG ?? 'ffmpeg',
		['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128', '-f', 'null', '-'],
		{ encoding: 'utf8' },
	);
	const all = [...String(r.stderr).matchAll(/I:\s+(-?[\d.]+) LUFS/g)];
	return Number(all.at(-1)?.[1] ?? Number.NaN);
}

test('an audio effect from the Effects panel shows its EQ curve in Effect Controls', async () => {
	await createProject(page, 'E2E Audio FX');
	await importFiles(page, ['voice-hum.wav', 'music-beat.wav']);
	const d = await doc();
	const voice = Object.values(d.items).find((i) => i.name === 'voice-hum.wav')!;
	const music = Object.values(d.items).find((i) => i.name === 'music-beat.wav')!;
	const r = await transact(page, [
		{ type: 'clip.place', source: { projectItemId: voice.id }, at: 0, tracks: { audio: 'A1' } },
		{ type: 'clip.place', source: { projectItemId: music.id }, at: 0, tracks: { audio: 'A2' } },
	]);
	expect(r.ok, JSON.stringify(r.errors)).toBe(true);
	seqId = (await sequenceSummary(page)).sequenceId;
	voiceId = (await clips(page, ['A1']))[0]!.id;
	musicId = (await clips(page, ['A2']))[0]!.id;

	const box = await clipBox(page, voiceId);
	await page.mouse.click(box.x + 20, box.y + box.height / 2);
	await page.keyboard.press('Shift+Digit7'); // Window ▸ Effects
	const panel = page.getByTestId('effects-panel');
	await expect(panel).toBeVisible();
	await panel.getByTestId('effects-search').fill('parametric equalizer');
	await panel.locator('[data-effect-id="jasper.audio.parametric-equalizer"]').dblclick();
	await expect
		.poll(async () => (await clip(voiceId)).effects.map((e) => e.effectId))
		.toContain('jasper.audio.parametric-equalizer');
	await page.keyboard.press('Shift+Digit5'); // Window ▸ Effect Controls
	const ec = page.getByTestId('effect-controls-panel');
	await expect(ec).toBeVisible();
	// A flat curve has an empty box; the band handles are what is drawn.
	await expect(ec.getByTestId('audio-eq-curve')).toHaveCount(1);
	await expect(ec.locator('[data-testid^="audio-eq-band-"]').first()).toBeVisible();
	await page.screenshot({ path: join(outDir, 'eq-curve.png') });
});

test('Essential Sound: Dialogue, Reduce Noise, Auto-Match on the engine', async () => {
	const box = await clipBox(page, voiceId);
	await page.mouse.click(box.x + 20, box.y + box.height / 2);
	await page.getByTestId('workspace-tab-audio').click();
	const es = page.getByTestId('essential-sound');
	await expect(es).toBeVisible();
	await es.getByTestId('essential-type-dialogue').click();
	await expect(es.getByTestId('essential-current-type')).toContainText('Dialogue');
	await es.getByTestId('essential-slot-repair.noise').getByRole('checkbox').click();
	await expect
		.poll(async () => (await clip(voiceId)).effects.find((e) => e.essential === 'noise')?.effectId)
		.toBe('jasper.audio.denoise');
	await es.getByTestId('essential-auto-match').click();
	await expect
		.poll(async () => (await clip(voiceId)).essential?.loudness.measuredLufs ?? null, { timeout: 60_000 })
		.not.toBeNull();
	const c = await clip(voiceId);
	expect(c.gainDb).toBeCloseTo(-23 - c.essential!.loudness.measuredLufs!, 1);
	await page.screenshot({ path: join(outDir, 'essential-dialogue.png') });
});

test('Essential Sound ▸ Duration ▸ Remix makes the music 20 s on its beats', async () => {
	const box = await clipBox(page, musicId);
	await page.mouse.click(box.x + 20, box.y + box.height / 2);
	const es = page.getByTestId('essential-sound');
	await es.getByTestId('essential-type-music').click();
	await expect(es.getByTestId('essential-current-type')).toContainText('Music');
	// The target (seconds) slider is set through its command, then the panel's Remix button plans on the engine.
	const r = await transact(page, [
		{ type: 'essentialSound.set', clipIds: [musicId], values: { 'duration.targetSeconds': 20 } },
	]);
	expect(r.ok, JSON.stringify(r.errors)).toBe(true);
	await es.getByTestId('essential-duration-apply').click();
	await expect
		.poll(async () => (await audioClips()).filter((c) => c.remix).length, { timeout: 60_000 })
		.toBeGreaterThan(1);
	const pieces = (await audioClips()).filter((c) => c.remix);
	const end = Math.max(...pieces.map((c) => c.start + c.duration));
	const fps = await fpsOf();
	expect(Math.abs(end / fps - 20)).toBeLessThan(0.6); // within about a beat (120 BPM)
	await page.screenshot({ path: join(outDir, 'remix-panel.png') });
});

test('the Remix tool remixes on an out-edge drag', async () => {
	const pieces = (await audioClips()).filter((c) => c.remix).sort((a, b) => a.start - b.start);
	const last = pieces.at(-1)!;
	const before = last.start + last.duration;
	await page
		.getByTestId('tools-panel')
		.locator('[data-tool="rateStretch"], [data-tool="ripple"]')
		.first()
		.click({
			button: 'right',
		});
	await page.getByTestId('tools-flyout').locator('[data-tool-option="remix"]').click();
	// Whole sequence in view, then one step out so there is room to drag the out edge to the right.
	await focusTimeline(page);
	await page.keyboard.press('Backslash');
	await page.keyboard.press('Minus');
	await page.waitForTimeout(300);
	const box = await clipBox(page, last.id);
	await pointerDrag(
		page,
		{ x: box.x + box.width - 2, y: box.y + box.height / 2 },
		{
			x: box.x + box.width + 120,
			y: box.y + box.height / 2,
		},
	);
	await expect
		.poll(
			async () => {
				const all = (await audioClips()).filter((c) => c.remix);
				return Math.max(...all.map((c) => c.start + c.duration));
			},
			{ timeout: 60_000 },
		)
		.toBeGreaterThan(before + 10);
	await page.screenshot({ path: join(outDir, 'remix-tool.png') });
	await focusTimeline(page);
	await page.keyboard.press('KeyV');
});

test('native export carries the effects, the remix and the matched loudness', async ({ request }) => {
	const all = await audioClips();
	const end = Math.max(...all.map((c) => c.start + c.duration));
	const fps = await fpsOf();
	const { file } = await exportViaUi(page, request, {
		engine: 'native',
		fileName: 'audio-fx.mp4',
		expectPath: /native/i,
		outDir,
		jobTimeoutMs: 300_000,
	});
	const probe = ffprobe(file);
	expect(Math.abs(Number(probe.format.duration) - end / fps)).toBeLessThan(0.2);
	expect(integratedLufs(file)).toBeLessThan(-12);
});
