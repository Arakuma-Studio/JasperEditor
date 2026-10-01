// Source ranges (M3, wp-m3-inpoint, S07:PRC-015…019, PRU-005; spec §8 item 11): Process Clip… on a sub-range of
// `frame-code.mp4` (each frame burns its number in as a 6-bit code) with handles → the clip swaps onto the
// shorter processed version; `render_frame` (agent query `frame.capture`, the engine's still render) shows the
// same frame codes at several timeline frames before and after; the Media Version section shows the range and
// the handles; switching back to the original keeps the codes; Replace Footage with a render of frames 10…63
// plus a source-range sidecar keeps source timing.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clipElement,
	createProject,
	enableAgentBridge,
	FIXTURES,
	importFiles,
	query,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const F = 23_520_000; // flicks per frame at 30 fps
const PROBE_FRAMES = [0, 5, 10, 19];

let page: Page;
let clipId = '';
let originalId = '';
let versionId = '';
let tmp = '';

type Doc = {
	media: Record<
		string,
		{
			id: string;
			originalName: string;
			sourceRange?: { firstFrame: number; frames: number; mediaId: string | null };
		}
	>;
	sequences: Record<
		string,
		{
			clips: Record<
				string,
				{ id: string; kind: string; mediaId?: string; sourceIn: number; start: number; duration: number }
			>;
		}
	>;
};

const doc = () => query<Doc>(page, 'doc.get');

async function clip() {
	const d = await doc();
	for (const s of Object.values(d.sequences)) if (s.clips[clipId]) return s.clips[clipId]!;
	throw new Error('clip gone');
}

/** The frame code shown at a timeline frame, read from the engine's still render (render_frame). */
async function codeAt(frame: number): Promise<number> {
	const r = await query<{ url: string }>(page, 'frame.capture', { frame, width: 640 });
	return page.evaluate(async (url) => {
		const img = new Image();
		img.src = url;
		await img.decode();
		const c = document.createElement('canvas');
		c.width = img.naturalWidth;
		c.height = img.naturalHeight;
		const g = c.getContext('2d')!;
		g.drawImage(img, 0, 0);
		const k = img.naturalWidth / 1920;
		let code = 0;
		for (let b = 0; b < 6; b++) {
			const px = g.getImageData(Math.round((70 + 70 * b) * k), Math.round(70 * k), 1, 1).data;
			if (px[0]! > 127) code |= 1 << b;
		}
		return code;
	}, r.url);
}

const codes = () => Promise.all(PROBE_FRAMES.map((f) => codeAt(f)));

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
	tmp = mkdtempSync(join(tmpdir(), 'jasper-e2e-range-'));
});

test.afterAll(async () => {
	await page?.close();
	if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('Process Clip… on the clip range + handles swaps onto the range with identical frames', async () => {
	await createProject(page, 'E2E Source Ranges');
	await importFiles(page, ['frame-code.mp4']);
	originalId = Object.values((await doc()).media).find((m) => m.originalName === 'frame-code.mp4')!.id;
	const seqId = Object.keys((await doc()).sequences)[0]!;
	const placed = await page.evaluate(
		([mediaId, sequenceId]) =>
			(
				window as unknown as {
					jasper: { transact(tx: unknown): Promise<{ ok: boolean; refs: Record<string, string> }> };
				}
			).jasper.transact({
				label: 'Place frame-code',
				commands: [
					// 30 fps like the fixture, so timeline frame k shows source frame 20 + k.
					{
						type: 'sequence.updateSettings',
						sequenceId,
						settings: { width: 1920, height: 1080, frameRate: { num: 30, den: 1 }, dropFrame: false },
					},
					{
						type: 'clip.place',
						source: { mediaId },
						at: 0,
						sourceRange: { in: { sourceFrames: 20 }, out: { sourceFrames: 40 } },
						matchSequence: 'keep',
						ref: '$c',
					},
				],
			}),
		[originalId, seqId] as const,
	);
	expect(placed.ok).toBe(true);
	clipId = Object.values(Object.values((await doc()).sequences)[0]!.clips).find(
		(c) => c.kind === 'video',
	)!.id;
	await expect(clipElement(page, clipId)).toBeVisible();
	const before = await codes();
	expect(before).toEqual([20, 25, 30, 39]);

	await clipElement(page, clipId).click({ button: 'right', position: { x: 20, y: 20 } });
	await page.getByRole('menuitem', { name: 'Process Clip…' }).dispatchEvent('click');
	const dialog = page.getByTestId('process-dialog');
	await expect(dialog).toBeVisible();
	const range = dialog.getByTestId('process-range');
	await expect(range.getByRole('button', { name: 'Clip range + handles' })).toHaveAttribute(
		'aria-pressed',
		'true',
	);
	await expect(range.getByTestId('process-range-info')).toContainText('Source frames 8–51 (44 frames)');
	await range.getByTestId('process-handles').fill('6');
	await expect(range.getByTestId('process-range-info')).toContainText('Source frames 14–45 (32 frames)');
	await dialog.getByRole('checkbox', { name: 'Deblock' }).click();
	await page.screenshot({ path: 'test-results/e2e/source-range-process-dialog.png' });
	await dialog.getByRole('button', { name: 'Start' }).click();
	await expect(dialog).toBeHidden();

	await expect
		.poll(() => appliedLabels(page), { timeout: 240_000, intervals: [1000] })
		.toContain('Process Clip');
	const c = await clip();
	versionId = c.mediaId!;
	expect(versionId).not.toBe(originalId);
	const d = await doc();
	expect(d.media[versionId]!.sourceRange).toMatchObject({ mediaId: originalId, firstFrame: 14, frames: 32 });
	expect([c.start, c.duration, c.sourceIn]).toEqual([0, 20, 6 * F]);
	// render_frame: the same source frames at the same timeline frames.
	expect(await codes()).toEqual(before);

	await clipElement(page, clipId).click({ position: { x: 20, y: 20 } });
	await expect(page.getByTestId('media-version-info')).toContainText('Deblocked · frames 14–45');
	await expect(page.getByTestId('media-version-handles')).toHaveText('Handles 6 / 6 frames');
	await page
		.getByTestId('media-version')
		.screenshot({ path: 'test-results/e2e/source-range-media-version.png' });
});

test('switching back to the original (and to the range again) keeps the frames', async () => {
	const section = page.getByTestId('media-version');
	await section.getByRole('combobox', { name: 'Media version' }).click();
	await page.getByRole('option', { name: 'Original' }).click();
	await expect.poll(async () => (await clip()).mediaId).toBe(originalId);
	expect((await clip()).sourceIn).toBe(20 * F);
	expect((await appliedLabels(page)).at(-1)).toBe('Use Original Version');
	expect(await codes()).toEqual([20, 25, 30, 39]);
	await expect(page.getByTestId('media-version-handles')).toHaveText('Handles 20 / 24 frames');
	await section.getByRole('combobox', { name: 'Media version' }).click();
	await page.getByRole('option', { name: 'Deblocked · frames 14–45' }).click();
	await expect.poll(async () => (await clip()).mediaId).toBe(versionId);
	expect(await codes()).toEqual([20, 25, 30, 39]);
	// Back to the original for Replace Footage.
	await section.getByRole('combobox', { name: 'Media version' }).click();
	await page.getByRole('option', { name: 'Original' }).click();
	await expect.poll(async () => (await clip()).mediaId).toBe(originalId);
});

test('Replace Footage with a render of frames 10…63 and its sidecar keeps source timing', async () => {
	// The "render": frames 10…63 of frame-code.mp4, with a source-range sidecar.
	const render = join(tmp, 'frame-code-from10.mp4');
	const r = spawnSync('ffmpeg', [
		...['-v', 'error', '-y', '-i', join(FIXTURES, 'frame-code.mp4')],
		...['-vf', 'select=gte(n\\,10),setpts=N/30/TB', '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast'],
		...['-crf', '12', '-pix_fmt', 'yuv420p', '-an', render],
	]);
	expect(r.status, String(r.stderr)).toBe(0);
	const sidecar = join(tmp, 'frame-code-from10.json');
	writeFileSync(sidecar, JSON.stringify({ first_src_frame: 10, frames: 54, source: 'frame-code.mp4' }));

	const row = page.getByTestId('project-row').filter({ hasText: 'frame-code.mp4' }).first();
	await row.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Replace Footage…' }).click();
	const dialog = page.getByTestId('replace-footage-dialog');
	await expect(dialog).toBeVisible();
	const chooser = page.waitForEvent('filechooser');
	await dialog.getByTestId('replace-choose').click();
	await (await chooser).setFiles([render, sidecar]);
	await expect(dialog.getByTestId('replace-sidecar')).toContainText(
		'frame-code-from10.json: starts at frame 10 of frame-code.mp4',
		{
			timeout: 60_000,
		},
	);
	await expect(dialog.getByTestId('replace-keep-timing').getByRole('checkbox')).toBeChecked();
	await expect(dialog.getByTestId('replace-timing')).toContainText('In-points move by -10 frames');
	await expect(dialog.getByTestId('replace-coverage')).toContainText('holds every frame');
	await page.screenshot({ path: 'test-results/e2e/source-range-replace-footage.png' });
	await dialog.getByRole('button', { name: 'Replace' }).click();
	await expect(dialog).toBeHidden();
	expect((await appliedLabels(page)).at(-1)).toBe('Replace Footage');
	const c = await clip();
	expect(c.mediaId).toBe(originalId);
	expect(c.sourceIn).toBe(10 * F);
	const m = (await doc()).media[originalId]!;
	expect(m.originalName).toBe('frame-code-from10.mp4');
	expect(m.sourceRange).toMatchObject({ firstFrame: 10, frames: 54 });
	expect(await codes()).toEqual([20, 25, 30, 39]);
	// One undo restores the original file and in-point.
	await page.getByTestId('timeline-track-area').click({ position: { x: 5, y: 5 } });
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await clip()).sourceIn).toBe(20 * F);
	expect((await doc()).media[originalId]!.originalName).toBe('frame-code.mp4');
});
