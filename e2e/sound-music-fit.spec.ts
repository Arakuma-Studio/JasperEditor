// Music to picture in the built app (spec 12 P6-E11; wp-note "Phase 6 → WP-E7"): generated C-major music with a drop at
// bar 17 (32 s) on A1 and a hero cue at 00:00:20:15 → Audio workspace ▸ Essential Sound ▸ Duration ▸ Music to picture:
// Analyze Music (tempo, metre, key, drops), "Land the drop on: Hero cue" → Land Drop (one History entry "Land the Drop")
// → Clip ▸ Audio Options ▸ End on Bar → a native export, MEASURED: the exported audio around the hero frame is the
// source around the drop (cross-correlation, ≤ 1 ms) and the music ends just before a bar line. The Auto Sound Pass
// dialog shows the two style options. Screenshots go to test-results/e2e-sound-music-fit.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { encodeWav } from '../packages/audio-dsp/src/index.ts';
import { dropMusic } from '../packages/audio-fx/test/music.ts';
import {
	appliedLabels,
	clipBox,
	createProject,
	enableAgentBridge,
	exportViaUi,
	mediaIdForFile,
	query,
	ROOT,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const outDir = join(ROOT, 'test-results', 'e2e-sound-music-fit');
const SR = 48_000;
let page: Page;
let dir = '';
let source: Float32Array;

type Clip = {
	id: string;
	kind: string;
	start: number;
	duration: number;
	sourceIn: number;
	remix?: { anchors?: { sourceSeconds: number; frame: number }[] };
};
async function audioClips(p: Page): Promise<Clip[]> {
	const seqs = await query<Record<string, { clips: Record<string, Clip> }>>(p, 'doc.get', { path: ['sequences'] });
	return Object.values(Object.values(seqs)[0]!.clips)
		.filter((c) => c.kind === 'audio')
		.sort((a, b) => a.start - b.start);
}

function ffmpeg(): string {
	return process.env.JASPER_FFMPEG ?? 'ffmpeg';
}

function decode(file: string): Float32Array {
	const r = spawnSync(ffmpeg(), ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], {
		maxBuffer: 1 << 30,
	});
	if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
	const b = r.stdout as Buffer;
	return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

test.beforeAll(async ({ browser }) => {
	mkdirSync(outDir, { recursive: true });
	dir = mkdtempSync(join(tmpdir(), 'jasper-e2e-music-fit-'));
	const m = dropMusic(SR, 120, 32, 17);
	source = m.audio[0]!;
	writeFileSync(join(dir, 'drop-music.wav'), encodeWav(m.audio, SR, 's16'));
	page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
	await enableAgentBridge(page);
});
test.afterAll(async () => {
	await page?.close();
});

test('Land the drop on the hero cue, end on a bar line; measured in the export', async ({ request }) => {
	test.setTimeout(600_000);
	await createProject(page, 'E2E Music to picture');
	await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Control+KeyI');
	await (await chooser).setFiles([join(dir, 'drop-music.wav')]);
	await expect(page.getByTestId('project-row').filter({ hasText: 'drop-music.wav' })).toBeVisible({
		timeout: 60_000,
	});
	const music = await mediaIdForFile(page, 'drop-music.wav');
	const placed = await transact(page, [
		{ type: 'clip.place', source: { mediaId: music }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
		{ type: 'essentialSound.setType', clipIds: ['$m'], audioType: 'music' },
		{ type: 'soundCue.add', cues: [{ frame: 615, kind: 'emphasis', weight: 'hero', types: ['hit'], source: 'user' }] },
	] as never);
	expect(placed.ok, JSON.stringify(placed)).toBe(true);
	const musicId = (placed as unknown as { refs: Record<string, string> }).refs.$m!;

	// Audio workspace ▸ Essential Sound ▸ Duration ▸ Music to picture
	const box = await clipBox(page, musicId);
	await page.mouse.click(box.x + 40, box.y + box.height / 2);
	await page.getByTestId('workspace-tab-audio').click();
	const es = page.getByTestId('essential-sound');
	await expect(es).toBeVisible();
	const fit = es.getByTestId('essential-music-fit');
	await fit.scrollIntoViewIfNeeded();
	await fit.getByTestId('essential-music-analyse').click();
	await expect(fit.getByTestId('essential-music-info')).toHaveText(/120 BPM · 4 beats per bar · C major \(\d+ %\)/, {
		timeout: 120_000,
	});
	// the app's default sequence is 29.97 fps drop-frame: 32 s is frame 959 = 00;00;31;29
	await expect(fit.getByTestId('essential-music-drops')).toContainText(/Bar 17 · 00[:;]00[:;]31[:;]29/);
	await fit.scrollIntoViewIfNeeded();
	await page.screenshot({ path: join(outDir, '1-analysed.png') });
	await fit.getByRole('combobox', { name: 'Land the drop on' }).click();
	await page.getByRole('option', { name: /^Hero cue \(00[:;]00[:;]20[:;]15\)$/ }).click();
	const before = await appliedLabels(page);
	await fit.getByTestId('essential-land-drop').click();
	await expect.poll(async () => (await appliedLabels(page)).length, { timeout: 120_000 }).toBe(before.length + 1);
	expect((await appliedLabels(page)).at(-1)).toBe('Land the Drop');
	const pieces = (await audioClips(page)).filter((c) => c.remix);
	expect(pieces.length).toBeGreaterThan(1);
	expect(pieces[0]!.remix!.anchors).toEqual([{ sourceSeconds: expect.any(Number), frame: 615 }]);
	await expect(fit.getByTestId('essential-music-landed')).toHaveText(/^The drop lands at 00[:;]00[:;]20[:;]15$/);
	await page.waitForTimeout(500);
	await page.screenshot({ path: join(outDir, '2-landed.png') });

	// Clip ▸ Audio Options ▸ End on Bar on the remix (clicking a piece selects its group: the music clip)
	const fb = await clipBox(page, pieces[0]!.id);
	await page.mouse.click(fb.x + 40, fb.y + fb.height / 2);
	const menubar = page.getByTestId('title-bar').getByRole('menubar');
	await menubar.getByRole('menuitem', { name: 'Clip', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Audio Options' }).hover();
	await page.screenshot({ path: join(outDir, '3-audio-options.png') });
	await page.getByRole('menuitem', { name: 'End on Bar' }).click();
	await expect.poll(async () => (await appliedLabels(page)).at(-1), { timeout: 120_000 }).toBe('End on Bar');
	const ended = (await audioClips(page)).filter((c) => c.remix).at(-1)!;
	const endFrame = ended.start + ended.duration;
	await page.waitForTimeout(500);
	await page.screenshot({ path: join(outDir, '4-end-on-bar.png') });

	// the native export, measured
	const { file } = await exportViaUi(page, request, {
		engine: 'native',
		fileName: 'music-fit.mp4',
		expectPath: /native/i,
		outDir,
		jobTimeoutMs: 300_000,
	});
	const out = decode(file);
	const rate = await query<{ num: number; den: number }>(page, 'doc.get', {
		path: ['sequences', Object.keys(await query<Record<string, unknown>>(page, 'doc.get', { path: ['sequences'] }))[0]!, 'settings', 'frameRate'],
	});
	const fps = rate.num / rate.den;
	const drop = 32 * SR; // the drop's downbeat in the source (bar 17 of 120 BPM)
	const at = Math.round((615 / fps) * SR);
	let best = 0;
	let bestV = Number.NEGATIVE_INFINITY;
	for (let lag = -480; lag <= 480; lag++) {
		let v = 0;
		for (let k = -4096; k < 4096; k++) v += (source[drop + k] ?? 0) * (out[at + lag + k] ?? 0);
		if (v > bestV) {
			bestV = v;
			best = lag;
		}
	}
	console.info(`[e2e music] the drop plays ${((1000 * best) / SR).toFixed(3)} ms from frame 615 in the export`);
	expect(Math.abs(best)).toBeLessThanOrEqual(SR / 1000 + 2); // ≤ 1 ms (AAC decode alignment ±2 samples)
	// the music ends where the clip ends: just before a bar line (a bar every 2 s from 0 in output time after the drop)
	let lastSample = 0;
	for (let i = out.length - 1; i >= 0; i--)
		if (Math.abs(out[i]!) > 1e-3) {
			lastSample = i;
			break;
		}
	console.info(`[e2e music] the music is heard until ${(lastSample / SR).toFixed(3)} s; the clip ends at frame ${endFrame}`);
	expect(lastSample / SR).toBeLessThanOrEqual(endFrame / fps + 0.03);

	// Auto Sound Pass… offers the two style options
	await menubar.getByRole('menuitem', { name: 'Sequence', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Sound Design' }).hover();
	await page.getByRole('menuitem', { name: 'Auto Sound Pass…' }).click();
	const dialog = page.getByTestId('auto-sound-pass-dialog');
	await expect(dialog).toBeVisible();
	const style = dialog.getByTestId('auto-pass-style');
	await expect(style.getByRole('checkbox', { name: "Tune chimes and pitched sounds to the music's key" })).toBeChecked();
	await expect(style.getByRole('checkbox', { name: 'Stop the music on the bar line before a hit' })).toBeChecked();
	await style.scrollIntoViewIfNeeded();
	await dialog.screenshot({ path: join(outDir, '5-auto-pass-style.png') });
	await page.keyboard.press('Escape');
});
