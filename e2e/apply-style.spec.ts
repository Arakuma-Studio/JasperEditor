// Spec 15 EA-012 / EA-050 in the built app: Sequence ▸ Automate ▸ Apply Style… on a generated talking clip
// (`cleanup-voice.mp4`, scripts/fixtures/cleanup.mjs: synthetic voiced words with an abandoned take, a filler and long
// pauses, and its transcript) with a library recipe made from Fast Long-form (no Jolt), steps cleanup + subtitles + cut kits → the dialog's dry run per step
// → Propose (the engine's voice analysis and cleanup analysis run in the job) → the Review panel with the Voice
// cleanup, Subtitles and Cut kits groups → Accept all → Apply (ONE History entry) → the clip is cut (shorter), the
// subtitles and the kits sit on the cleaned-up timeline (each kit on a cut of the new timeline) → export through the
// Remotion path; the reference is the same edit with the FX track's output off, exported on the native path (native or
// hybrid layer bake): the frames around the kits differ, the frames away from them match (the picture's top half, away
// from the subtitles) — the paths show the same source frames and colours (docs/wp-notes/time.md §15). Screenshots and frames: test-results/e2e-apply-style.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { cleanupVoiceWords } from '../scripts/fixtures/cleanup.mjs';
import {
	appliedLabels,
	browserLaunch,
	createProject,
	enableAgentBridge,
	expectTransaction,
	exportViaUi,
	focusTimeline,
	importFiles,
	mediaIdForFile,
	query,
	ROOT,
	transact,
} from './support.ts';

test.use({ launchOptions: browserLaunch([]) });
test.describe.configure({ mode: 'serial' });

const outDir = join(ROOT, 'test-results', 'e2e-apply-style');
const F = 705_600_000;
let page: Page;

test.beforeAll(async ({ browser }) => {
	mkdirSync(outDir, { recursive: true });
	page = await browser.newPage({ viewport: { width: 1800, height: 1050 } });
	await enableAgentBridge(page);
});
test.afterAll(async () => {
	await page?.close();
});

type Clip = { id: string; kind: string; trackId: string; start: number; duration: number };
type Seq = {
	clips: Record<string, Clip>;
	videoTracks: { id: string; name: string | null }[];
	captionGroups?: Record<string, unknown>;
};
async function sequence(p: Page): Promise<Seq> {
	const seqs = await query<Record<string, Seq>>(p, 'doc.get', { path: ['sequences'] });
	return Object.values(seqs)[0]!;
}

/** The top half of the frame at `frame` of the export as 32 × 9 RGB bytes (away from the subtitles). */
function topThumb(file: string, frame: number): Buffer {
	return execFileSync(
		process.env.JASPER_FFMPEG ?? 'ffmpeg',
		[
			...['-v', 'error', '-i', file, '-vf'],
			`select=eq(n\\,${frame}),crop=iw:ih/2:0:0,scale=32:9:flags=area,format=rgb24`,
			...['-fps_mode', 'passthrough', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'],
		],
		{ maxBuffer: 1 << 20 },
	);
}
const meanDiff = (a: Buffer, b: Buffer) => {
	let s = 0;
	for (let i = 0; i < Math.min(a.length, b.length); i++) s += Math.abs(a[i]! - b[i]!);
	return s / Math.max(1, a.length);
};

test('Apply Style: dialog → one proposal (cleanup, subtitles, kits) → review → apply → export shows the kits', async ({
	request,
}) => {
	test.setTimeout(1_500_000);
	await createProject(page, 'E2E Apply Style');
	await importFiles(page, ['cleanup-voice.mp4']);
	const mediaId = await mediaIdForFile(page, 'cleanup-voice.mp4');
	const items = await query<Record<string, { id: string; kind: string; mediaId?: string }>>(page, 'doc.get', {
		path: ['items'],
	});
	const item = Object.values(items).find((i) => i.kind === 'media' && i.mediaId === mediaId)!;
	// the 640 × 360 test pattern fills the 1920 × 1080 frame (so its cuts are picture cuts of the whole frame)
	const placed = await transact(page, [{ type: 'clip.place', source: { projectItemId: item.id }, at: 0 }]);
	expectTransaction(placed);
	const vid = (placed as { results: { clipIds: string[] }[] }).results[0]!.clipIds[0]!;
	expectTransaction(
		await transact(page, [
			{ type: 'param.set', target: ['clip', vid, 'transform', 'scale'], value: 300 },
		] as never),
	);
	expectTransaction(
		await transact(page, [
			{
				type: 'transcript.create',
				mediaId,
				language: 'es',
				origin: 'manual',
				words: cleanupVoiceWords().map((w) => ({
					text: w.text,
					start: Math.round(w.s * F),
					end: Math.round((w.e + 0.03) * F),
					confidence: 0.9,
				})),
			},
		] as never),
	);
	// a library recipe from Fast Long-form without the Jolt (its jiggle is a few pixels: every kit is a large move)
	const base = await (await request.get('/api/style-recipes/builtin:fast-long-form')).json();
	const made = await request.post('/api/style-recipes', {
		data: {
			recipe: {
				...base.recipe,
				builtIn: undefined,
				name: 'E2E Big Moves',
				passes: {
					...base.recipe.passes,
					'decorate-cuts': { enabled: true, params: { pack: 'long-pack', families: { jolt: 0 } } },
				},
			},
		},
	});
	expect(made.status(), await made.text()).toBe(201);
	const seq0 = await sequence(page);
	const end0 = Math.max(...Object.values(seq0.clips).map((c) => c.start + c.duration));
	const before = await appliedLabels(page);

	// Sequence ▸ Automate ▸ Apply Style…
	await focusTimeline(page);
	const menubar = page.getByTestId('title-bar').getByRole('menubar');
	await menubar.getByRole('menuitem', { name: 'Sequence', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Automate' }).hover();
	await page.getByRole('menuitem', { name: 'Apply Style…' }).click();
	const dialog = page.getByTestId('apply-style-dialog');
	await expect(dialog).toBeVisible();
	await expect(dialog.getByTestId('apply-style-recipe')).toContainText('Fast Long-form');
	await dialog.getByRole('combobox', { name: 'Recipe' }).click();
	await page.getByRole('option', { name: /E2E Big Moves/ }).click();
	await expect(dialog.getByTestId('apply-style-recipe')).toContainText('E2E Big Moves');
	// this run: the cleanup, the subtitles and the kits
	for (const s of ['punch-ins', 'ken-burns', 'slides', 'music'])
		await dialog.getByTestId(`apply-style-switch-${s}`).getByRole('checkbox').click();
	await expect(dialog.getByTestId('apply-style-stage-cleanup')).toHaveAttribute('data-status', 'planned', {
		timeout: 60_000,
	});
	await expect(dialog.getByTestId('apply-style-stage-subtitles')).toHaveAttribute('data-status', 'planned');
	await expect(dialog.getByTestId('apply-style-stage-decorate-cuts')).toHaveAttribute(
		'data-status',
		'planned',
	);
	await expect(dialog.getByTestId('apply-style-stage-music')).toHaveAttribute('data-status', 'off');
	await expect(dialog.getByTestId('apply-style-cost')).toContainText('Remotion');
	await dialog.screenshot({ path: join(outDir, 'dialog.png') });
	await dialog.getByRole('button', { name: 'Propose' }).click();
	await expect(dialog).toBeHidden({ timeout: 300_000 });

	// the Review panel: one proposal with the three groups
	const panel = page.locator('[data-panel-kind="review"][data-instance-id]');
	await expect(panel).toBeVisible();
	await expect(panel).toContainText('Voice cleanup');
	await expect(panel).toContainText('Subtitles');
	await expect(panel).toContainText('Cut kits');
	await expect(page.locator('[data-review-row="cleanup"]')).toBeVisible();
	const kitRow = page.locator('[data-review-row^="kit:"]').first();
	await expect(kitRow).toBeVisible();
	await page.screenshot({ path: join(outDir, 'review.png') });
	await page.getByTestId('review-accept-all').click();
	await kitRow.click();
	await page.keyboard.press('Control+Enter');
	await expect
		.poll(async () => (await appliedLabels(page)).length, { timeout: 120_000 })
		.toBe(before.length + 1);
	expect((await appliedLabels(page)).at(-1)).toMatch(/^Accept Apply Style: E2E Big Moves/);
	await page.screenshot({ path: join(outDir, 'applied.png') });

	// the cleaned-up timeline: shorter, with subtitles, kits on its cuts
	const seq = await sequence(page);
	const v1 = seq.videoTracks[0]!.id;
	const pieces = Object.values(seq.clips)
		.filter((c) => c.trackId === v1 && c.kind === 'video')
		.sort((a, b) => a.start - b.start);
	const end = Math.max(...pieces.map((c) => c.start + c.duration));
	expect(end).toBeLessThan(end0);
	expect(pieces.length).toBeGreaterThan(1);
	expect(Object.keys(seq.captionGroups ?? {})).toHaveLength(1);
	const fx = seq.videoTracks.find((t) => t.name === 'FX')!;
	expect(fx).toBeDefined();
	const kits = Object.values(seq.clips).filter((c) => c.trackId === fx.id && c.kind === 'adjustment');
	expect(kits.length).toBeGreaterThan(0);
	const cuts = pieces.slice(1).map((c) => c.start);
	for (const k of kits) expect(cuts.some((f) => k.start <= f && k.start + k.duration >= f)).toBe(true);

	// export (the kits: Remotion path) and the reference: the same edit with the FX track's output off
	const decorated = await exportViaUi(page, request, {
		engine: 'auto',
		fileName: 'apply-style.mp4',
		expectPath: /remotion/i,
		outDir,
		jobTimeoutMs: 1_200_000,
	});
	expectTransaction(
		await transact(page, [{ type: 'track.update', trackId: fx.id, patch: { output: false } }] as never),
	);
	// the reference goes through the native path: the cleaned-up pieces start between source frames, which it shows
	// as the Remotion path does (same source frame, same colour), so only the kits differ
	const plain = await exportViaUi(page, request, {
		engine: 'auto',
		fileName: 'apply-style-no-kits.mp4',
		expectPath: /native|hybrid/i,
		outDir,
		jobTimeoutMs: 1_200_000,
	});
	let moved = 0;
	const kitFrames: number[] = [];
	for (const k of kits)
		for (const f of [k.start + 2, k.start + Math.floor(k.duration / 2), k.start + k.duration - 3])
			kitFrames.push(f);
	for (const f of kitFrames)
		moved = Math.max(moved, meanDiff(topThumb(plain.file, f), topThumb(decorated.file, f)));
	expect(moved).toBeGreaterThan(4);
	// a frame away from every kit is the same picture
	const free = Array.from({ length: end }, (_, f) => f).find(
		(f) => f > 5 && kits.every((k) => f < k.start - 5 || f > k.start + k.duration + 5),
	);
	if (free !== undefined)
		expect(meanDiff(topThumb(plain.file, free), topThumb(decorated.file, free))).toBeLessThan(3);
	const k0 = kits[0]!;
	execFileSync(process.env.JASPER_FFMPEG ?? 'ffmpeg', [
		...[
			'-v',
			'error',
			'-y',
			'-i',
			decorated.file,
			'-vf',
			`select=eq(n\\,${k0.start + Math.floor(k0.duration / 2)})`,
		],
		...['-frames:v', '1', join(outDir, 'kit-frame.png')],
	]);
});
