// Spec 15 EA-050 in the built app: Sequence ▸ Automate ▸ Decorate Cuts… on a generated sequence (three flat pictures
// with a small square over them: two cuts) → the dialog's dry run (2 of 2 cuts get a kit, Remotion export) → Propose →
// the Review panel with the Cut kits group and its ghosts → ⟳ Reroll on one kit → Accept all → Apply (ONE History
// entry) → export → the extracted frames around each cut differ from the same frames of the undecorated edit (the kits
// render), and the kit's adjustment clips sit on a new FX track centred on the cuts. Screenshots:
// test-results/e2e-automation.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	browserLaunch,
	createProject,
	enableAgentBridge,
	exportViaUi,
	focusTimeline,
	query,
	ROOT,
	transact,
} from './support.ts';

test.use({ launchOptions: browserLaunch([]) });
test.describe.configure({ mode: 'serial' });

const outDir = join(ROOT, 'test-results', 'e2e-automation');
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
type Seq = { clips: Record<string, Clip>; videoTracks: { id: string; name: string | null }[] };
async function sequence(p: Page): Promise<Seq> {
	const seqs = await query<Record<string, Seq>>(p, 'doc.get', { path: ['sequences'] });
	return Object.values(seqs)[0]!;
}

/** The frame at `frame` of a 29.97 fps file as 32 × 18 RGB bytes. */
function thumb(file: string, frame: number): Buffer {
	return execFileSync(
		process.env.JASPER_FFMPEG ?? 'ffmpeg',
		[
			...['-v', 'error', '-i', file, '-vf'],
			`select=eq(n\\,${frame}),scale=32:18:flags=area,format=rgb24`,
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

test('Decorate Cuts: dialog → proposal → review (reroll, accept) → apply → export shows the kits', async ({
	request,
}) => {
	test.setTimeout(1_200_000);
	await createProject(page, 'E2E Decorate Cuts');
	const r = await transact(page, [
		// Kit params scale with the sequence; preserve the same 16:9 composition at one ninth of the pixels.
		{ type: 'sequence.updateSettings', settings: { width: 640, height: 360 } },
		{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [0.1, 0.2, 0.8, 1] },
		{ type: 'clip.addSolid', at: 60, duration: 60, track: 'V1', color: [0.15, 0.6, 0.2, 1] },
		{ type: 'clip.addSolid', at: 120, duration: 60, track: 'V1', color: [0.7, 0.2, 0.3, 1] },
		{ type: 'clip.addSolid', at: 0, duration: 180, track: 'V2', color: [0.95, 0.8, 0.1, 1], ref: '$sq' },
		{ type: 'param.set', target: ['clip', '$sq', 'transform', 'scale'], value: 20 },
		{ type: 'param.set', target: ['clip', '$sq', 'transform', 'position'], value: [700 / 3, 400 / 3] },
	] as never);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	// the undecorated edit, exported for reference
	const plain = await exportViaUi(page, request, {
		engine: 'auto',
		fileName: 'automation-plain.mp4',
		expectPath: /native/i,
		outDir,
	});
	const before = await appliedLabels(page);

	// Sequence ▸ Automate ▸ Decorate Cuts…
	await focusTimeline(page);
	const menubar = page.getByTestId('title-bar').getByRole('menubar');
	await menubar.getByRole('menuitem', { name: 'Sequence', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Automate' }).hover();
	await page.getByRole('menuitem', { name: 'Decorate Cuts…' }).click();
	const dialog = page.getByTestId('automation-dialog-decorate-cuts');
	await expect(dialog).toBeVisible();
	await expect(dialog.getByTestId('automation-summary-count')).toHaveText('2 of 2 cuts get a kit (100 %)', {
		timeout: 30_000,
	});
	await expect(dialog.getByTestId('automation-summary-cost')).toContainText('Remotion');
	// no Jolt (its jiggle is a few pixels): every kit is a large move the frame comparison sees
	await dialog.getByRole('slider', { name: 'Jolt' }).focus();
	await page.keyboard.press('Home');
	await expect(dialog.getByTestId('automation-family-jolt')).toContainText('0 %');
	await dialog.screenshot({ path: join(outDir, 'dialog.png') });
	await dialog.getByRole('button', { name: 'Propose' }).click();
	await expect(dialog).toBeHidden({ timeout: 120_000 });

	// the Review panel on the new proposal: the Cut kits group, two kits, the FX track setup item
	const panel = page.locator('[data-panel-kind="review"][data-instance-id]');
	await expect(panel).toBeVisible();
	await expect(panel).toContainText('Cut kits');
	const kit = (f: number) => page.locator(`[data-review-row="kit:${f}"]`);
	await expect(kit(60)).toBeVisible();
	await expect(kit(120)).toBeVisible();
	await page.screenshot({ path: join(outDir, 'review.png') });
	// Reroll the first kit: it comes back pending (maybe another family)
	await kit(60).click();
	await page.getByTestId('review-details').locator('[data-review-detail="reroll"]').click();
	await expect(page.getByTestId('toast').filter({ hasText: 'Rerolled' })).toBeVisible({ timeout: 30_000 });
	// accept both and apply: ONE History entry
	await page.getByTestId('review-accept-all').click();
	await kit(60).click();
	await page.keyboard.press('Control+Enter');
	await expect
		.poll(async () => (await appliedLabels(page)).length, { timeout: 60_000 })
		.toBe(before.length + 1);
	expect((await appliedLabels(page)).at(-1)).toMatch(/^Accept Decorate Cuts/);
	await page.screenshot({ path: join(outDir, 'applied.png') });
	const seq = await sequence(page);
	const fx = seq.videoTracks.find((t) => t.name === 'FX')!;
	expect(fx).toBeDefined();
	const adj = Object.values(seq.clips).filter((c) => c.trackId === fx.id && c.kind === 'adjustment');
	for (const cut of [60, 120]) {
		const mine = adj.filter((c) => c.start < cut + 30 && c.start + c.duration > cut - 30);
		const lo = Math.min(...mine.map((c) => c.start));
		const hi = Math.max(...mine.map((c) => c.start + c.duration));
		expect(lo).toBeLessThan(cut);
		expect(hi).toBeGreaterThan(cut);
		expect(mine.every((c) => c.start === lo || c.start === cut)).toBe(true);
	}

	// export: the kits render through the Remotion path and the frames around the cuts show them
	const decorated = await exportViaUi(page, request, {
		engine: 'auto',
		fileName: 'automation-kits.mp4',
		expectPath: /remotion/i,
		outDir,
		jobTimeoutMs: 900_000,
	});
	let moved = 0;
	for (const f of [56, 59, 60, 63, 116, 119, 120, 123])
		moved = Math.max(moved, meanDiff(thumb(plain.file, f), thumb(decorated.file, f)));
	expect(moved).toBeGreaterThan(6);
	// far from the cuts the picture is the same (both paths' encodes)
	expect(meanDiff(thumb(plain.file, 30), thumb(decorated.file, 30))).toBeLessThan(3);
});
