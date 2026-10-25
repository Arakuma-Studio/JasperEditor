// spec 13 AS-060: Create Subtitles with Pixel Pop on a generated video with a picture cut — through the editor UI
// (Text ▸ Transcript import, Create Subtitles…, Create), then: no subtitle runs across the cut, a subtitle starts
// exactly on the cut frame, one History entry, and the exported frames show the subtitles around the cut.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	createProject,
	enableAgentBridge,
	exportViaUi,
	query,
	ROOT,
	regionLuma,
	sequenceSummary,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const OUT = join(ROOT, 'test-results', 'e2e-subtitles');
mkdirSync(OUT, { recursive: true });
const FFMPEG = process.env.JASPER_FFMPEG ?? 'ffmpeg';

/** The fixture recipes' H.264 encoder choice (libopenh264 under JASPER_FFMPEG_LGPL_ONLY=1). */
function h264Args(): string[] {
	const enc = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? '';
	if (process.env.JASPER_FFMPEG_LGPL_ONLY !== '1' && /\blibx264\b/.test(enc))
		return ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '30'];
	return ['-c:v', 'libopenh264', '-b:v', '1M', '-allow_skip_frames', '0', '-pix_fmt', 'yuv420p', '-g', '30'];
}

/** A 6 s 1280×720 clip of one flat colour with a tone (lavfi color + sine; the fixture recipes' encoder). */
function makeClip(name: string, color: string): string {
	const file = join(OUT, name);
	execFileSync(FFMPEG, [
		'-v',
		'error',
		'-y',
		...['-f', 'lavfi', '-i', `color=c=${color}:s=1280x720:r=30:d=6`],
		...['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6'],
		...h264Args(),
		...['-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', file],
	]);
	return file;
}

let page: Page;
type Clip = {
	id: string;
	kind: string;
	trackId: string;
	start: number;
	duration: number;
	content?: { text: string };
	caption?: { groupId: string; words: { text: string }[] };
};
const clipsNow = async () =>
	Object.values(
		(await query<{ sequences: Record<string, { clips: Record<string, Clip> }> }>(page, 'doc.get')).sequences,
	)[0]!.clips;

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
});
test.afterAll(async () => {
	if (page && !page.isClosed()) await page.screenshot({ path: join(OUT, 'final.png') });
	await page?.close();
});

let cut = 0;
let rate = 30;

test('a video with a cut and its transcript', async () => {
	await createProject(page, 'E2E Subtitles');
	const a = makeClip('shot-a.mp4', 'black');
	const b = makeClip('shot-b.mp4', '0x101030');
	await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Control+KeyI');
	await (await chooser).setFiles([a, b]);
	for (const n of ['shot-a.mp4', 'shot-b.mp4'])
		await expect(page.getByTestId('project-row').filter({ hasText: n })).toBeVisible({ timeout: 60_000 });
	const media = await query<Record<string, { id: string; originalName: string }>>(page, 'doc.get', {
		path: ['media'],
	});
	const idOf = (n: string) => Object.values(media).find((m) => m.originalName === n)!.id;
	const s = await sequenceSummary(page);
	rate = s.settings.frameRate.num / s.settings.frameRate.den;
	cut = Math.round(3 * rate);
	// shot A (picture + its sound) for 6 s, shot B's picture from 3 s: a picture cut with continuous speech
	const r = await transact(page, [
		{ type: 'clip.place', source: { mediaId: idOf('shot-a.mp4') }, at: 0, tracks: { video: 'V1', audio: ['A1'] } },
		{ type: 'clip.place', source: { mediaId: idOf('shot-b.mp4') }, at: cut, tracks: { video: 'V1' }, audio: false },
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	// the transcript of shot A (Text ▸ Transcript ▸ Import…): a phrase whose first word starts 0.2 s after the cut
	await page.getByTestId('text.tab.Transcript').click().catch(() => undefined);
	const json = join(OUT, 'shot-a.transcript.json');
	const F = 705_600_000;
	writeFileSync(
		json,
		JSON.stringify({
			language: 'es',
			words: [
				['Hola', 0.3, 0.6],
				['a', 0.6, 0.7],
				['todos', 0.7, 1.1],
				['hoy', 1.9, 2.3],
				['hice', 2.3, 2.7],
				['el', 3.2, 3.3],
				['juego', 3.3, 3.7],
				['de', 3.7, 3.8],
				['Doors.', 3.8, 4.3],
			].map(([text, x, y]) => ({ text, start: Math.round((x as number) * F), end: Math.round((y as number) * F) })),
		}),
	);
	await page.getByTestId('text.transcript.import').click();
	const fc = page.waitForEvent('filechooser');
	await page.getByTestId('text.transcript.importFile').click();
	await (await fc).setFiles(json);
	await expect(page.getByTestId('text.transcript.word.0')).toHaveText('Hola');
});

test('Create Subtitles with Pixel Pop: one History entry, cut-aligned subtitles', async () => {
	await page.getByTestId('text.transcript.createSubtitles').click();
	const dialog = page.getByTestId('subtitles-dialog');
	await expect(dialog).toBeVisible();
	// Pixel Pop is the default template; the user's pixel font is not installed in this app: the notice says so
	await expect(page.getByTestId('subtitles-font-notice')).toBeVisible();
	await expect(page.getByTestId('subtitles-count')).not.toHaveText('0', { timeout: 30_000 });
	await expect(page.getByTestId('subtitles-preview-frame')).toBeVisible();
	await test.info().attach('create-subtitles-dialog', { body: await dialog.screenshot(), contentType: 'image/png' });
	const count = Number(await page.getByTestId('subtitles-count').textContent());
	await dialog.getByRole('button', { name: 'Create' }).click();
	await expect(dialog).toBeHidden();
	await expect.poll(async () => Object.values(await clipsNow()).filter((c) => c.caption).length).toBe(count);
	expect((await appliedLabels(page)).at(-1)).toBe('Create Subtitles');
	const subs = Object.values(await clipsNow())
		.filter((c) => c.caption)
		.sort((x, y) => x.start - y.start);
	// never across the cut; the phrase after it starts on the cut frame (look-back 0.5 s)
	for (const c of subs) expect(c.start >= cut || c.start + c.duration <= cut, `${c.content?.text}`).toBe(true);
	const onCut = subs.find((c) => c.start === cut);
	expect(onCut?.content?.text).toBe('el juego');
	expect(subs.find((c) => c.start + c.duration === cut)).toBeTruthy();
	// 1–3 words, one line
	for (const c of subs) {
		expect(c.caption!.words.length).toBeLessThanOrEqual(3);
		expect(c.content!.text).not.toContain('\n');
	}
	// the Subtitles tab lists them
	await expect(page.getByTestId('text.subtitles')).toBeVisible();
	await expect(page.getByTestId('subtitles.list')).toHaveAttribute('data-rows', String(count));
});

test('the exported frames show the subtitles on both sides of the cut', async ({ request }) => {
	const out = await exportViaUi(page, request, {
		engine: 'auto',
		fileName: 'subtitles-e2e.mp4',
		expectPath: /Hybrid|Remotion|Native/,
		outDir: OUT,
		jobTimeoutMs: 600_000,
	});
	// Pixel Pop sits at 0.83 of a 16:9 frame: white text with a purple outline over a dark picture
	const region = { x: 0.3, y: 0.76, w: 0.4, h: 0.14 };
	const at = (frame: number) => regionLuma(out.file, (frame + 0.5) / rate, region);
	const before = at(cut - 2);
	const after = at(cut + 10);
	const empty = at(Math.round(5.6 * rate));
	writeFileSync(join(OUT, 'luma.json'), JSON.stringify({ before, after, empty }));
	expect(before).toBeGreaterThan(empty + 8);
	expect(after).toBeGreaterThan(empty + 8);
	for (const [name, f] of [
		['before-cut', cut - 2],
		['after-cut', cut + 10],
	] as const)
		execFileSync(FFMPEG, ['-v', 'error', '-y', '-ss', String((f + 0.5) / rate), '-i', out.file, '-frames:v', '1', join(OUT, `${name}.png`)]);
});
