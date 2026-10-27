// Spec 15 EA-023 / EA-050 in the built app: Sequence ▸ Automate ▸ Reactions… on a generated edit (three flat pictures:
// two cuts; a "reaction" marker 4 frames after the first cut; the generated still.png fixture in a "Reactions" bin) →
// the dialog's dry run (one reaction, the bin found by its name, export native with the wobbled picture baked) →
// Propose → the Review panel with the Reactions group → Accept all → Apply (ONE History entry) → the picture sits on a
// new Reactions track, starting on the cut (snapped within 0.5 s), with S_Shake → export through the hybrid route →
// the extracted frames under the reaction differ from the undecorated export, the frames before it match.
// Screenshots: test-results/e2e-automation-overlays.
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
	importFiles,
	query,
	ROOT,
	transact,
} from './support.ts';

test.use({ launchOptions: browserLaunch([]) });
test.describe.configure({ mode: 'serial' });

const outDir = join(ROOT, 'test-results', 'e2e-automation-overlays');
let page: Page;

test.beforeAll(async ({ browser }) => {
	mkdirSync(outDir, { recursive: true });
	page = await browser.newPage({ viewport: { width: 1800, height: 1050 } });
	await enableAgentBridge(page);
});
test.afterAll(async () => {
	await page?.close();
});

type Clip = {
	id: string;
	kind: string;
	trackId: string;
	start: number;
	duration: number;
	effects?: { effectId: string }[];
};
type Seq = { clips: Record<string, Clip>; videoTracks: { id: string; name: string | null }[] };
async function sequence(p: Page): Promise<Seq> {
	const seqs = await query<Record<string, Seq>>(p, 'doc.get', { path: ['sequences'] });
	return Object.values(seqs)[0]!;
}

/** The frame at `frame` of the export as 32 × 18 RGB bytes. */
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

test('Reactions: dialog → proposal → review (accept) → apply → export shows the picture', async ({
	request,
}) => {
	test.setTimeout(1_200_000);
	await createProject(page, 'E2E Reactions');
	const r = await transact(page, [
		// The 1080p still is height-capped to 45% of either 16:9 frame; its normalized placement is unchanged.
		{ type: 'sequence.updateSettings', settings: { width: 640, height: 360 } },
		{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [0.1, 0.2, 0.8, 1] },
		{ type: 'clip.addSolid', at: 60, duration: 60, track: 'V1', color: [0.15, 0.6, 0.2, 1] },
		{ type: 'clip.addSolid', at: 120, duration: 120, track: 'V1', color: [0.7, 0.2, 0.3, 1] },
		{ type: 'marker.add', frame: 64, name: 'reaction' },
	] as never);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	// the user's reaction picture (a generated fixture) in a bin named for it
	await importFiles(page, ['still.png']);
	const items = await query<Record<string, { id: string; kind: string; name: string }>>(page, 'doc.get', {
		path: ['items'],
	});
	const still = Object.values(items).find((it) => it.kind === 'media' && it.name.startsWith('still'))!;
	expect(still).toBeDefined();
	const b = await transact(page, [
		{ type: 'bin.create', name: 'Reactions', ref: '$bin' },
		{ type: 'item.move', itemIds: [still.id], toBinId: '$bin' },
	] as never);
	expect(b.ok, JSON.stringify(b)).toBe(true);
	const plain = await exportViaUi(page, request, {
		engine: 'auto',
		fileName: 'reactions-plain.mp4',
		expectPath: /native/i,
		outDir,
	});
	const before = await appliedLabels(page);

	// Sequence ▸ Automate ▸ Reactions…
	await focusTimeline(page);
	const menubar = page.getByTestId('title-bar').getByRole('menubar');
	await menubar.getByRole('menuitem', { name: 'Sequence', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Automate' }).hover();
	await page.getByRole('menuitem', { name: 'Reactions…' }).click();
	const dialog = page.getByTestId('automation-dialog-reactions');
	await expect(dialog).toBeVisible();
	await expect(dialog.getByTestId('automation-summary-count')).toHaveText('1 of 1 triggers get a reaction', {
		timeout: 30_000,
	});
	await expect(dialog.getByTestId('automation-summary-assets')).toContainText('1 files: still');
	await expect(dialog.getByTestId('automation-summary-cost')).toContainText('baked by the Remotion renderer');
	await dialog.screenshot({ path: join(outDir, 'dialog.png') });
	await dialog.getByRole('button', { name: 'Propose' }).click();
	await expect(dialog).toBeHidden({ timeout: 120_000 });

	// the Review panel: the Reactions group and its item
	const panel = page.locator('[data-panel-kind="review"][data-instance-id]');
	await expect(panel).toBeVisible();
	await expect(panel).toContainText('Reactions');
	const row = page.locator('[data-review-row^="react:"]').first();
	await expect(row).toBeVisible();
	await page.screenshot({ path: join(outDir, 'review.png') });
	await page.getByTestId('review-accept-all').click();
	await row.click();
	await page.keyboard.press('Control+Enter');
	await expect
		.poll(async () => (await appliedLabels(page)).length, { timeout: 60_000 })
		.toBe(before.length + 1);
	expect((await appliedLabels(page)).at(-1)).toMatch(/^Accept Reactions/);
	await page.screenshot({ path: join(outDir, 'applied.png') });
	const seq = await sequence(page);
	const track = seq.videoTracks.find((t) => t.name === 'Reactions')!;
	expect(track).toBeDefined();
	const placed = Object.values(seq.clips).filter((c) => c.trackId === track.id);
	expect(placed.map((c) => [c.kind, c.start])).toEqual([['still', 60]]);
	// 2.6 s at the sequence rate
	expect(placed[0]!.duration).toBeGreaterThanOrEqual(77);
	expect(placed[0]!.duration).toBeLessThanOrEqual(79);
	expect((placed[0]!.effects ?? []).map((e) => e.effectId)).toContain('jasper.s.shake');

	// export: native with the wobbled picture baked; the frames under the reaction show it
	const decorated = await exportViaUi(page, request, {
		engine: 'auto',
		fileName: 'reactions.mp4',
		expectPath: /hybrid|native/i,
		outDir,
		jobTimeoutMs: 900_000,
	});
	let shown = 0;
	for (const f of [62, 80, 100, 130])
		shown = Math.max(shown, meanDiff(thumb(plain.file, f), thumb(decorated.file, f)));
	expect(shown).toBeGreaterThan(8);
	// before the reaction the picture is the same (both encodes)
	expect(meanDiff(thumb(plain.file, 30), thumb(decorated.file, 30))).toBeLessThan(3);
	execFileSync(process.env.JASPER_FFMPEG ?? 'ffmpeg', [
		...['-v', 'error', '-y', '-i', decorated.file, '-vf', 'select=eq(n\\,90)', '-frames:v', '1'],
		join(outDir, 'reaction-frame-90.png'),
	]);
});
