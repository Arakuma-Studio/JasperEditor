import { expect, type Page, test } from '@playwright/test';
import {
	browserLaunch,
	createProject,
	enableAgentBridge,
	expectTransaction,
	importFiles,
	mediaIdForFile,
	query,
	transact,
} from './support.ts';

test.use({
	launchOptions: browserLaunch([
		'--enable-features=CanvasDrawElement',
		'--autoplay-policy=no-user-gesture-required',
	]),
});
test.describe.configure({ mode: 'serial' });

let page: Page;
let clipId = '';

const bar = () =>
	page.evaluate(() =>
		[...document.querySelectorAll('[data-testid="timeline-render-bar"] [data-render-state]')].map((e) =>
			e.getAttribute('data-render-state'),
		),
	);

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
	await enableAgentBridge(page);
	await createProject(page, 'E2E Previews');
	await importFiles(page, ['clip-a.mp4']);
	await page.waitForFunction(() => !!(window as { __jasperMonitor?: unknown }).__jasperMonitor, null, {
		timeout: 120_000,
	});
});
test.afterAll(async () => {
	await page?.close();
});

test('render bar, Render Effects In to Out, green bar and preview playback', async () => {
	test.setTimeout(600_000);
	const r = await transact(page, [
		{
			type: 'clip.place',
			source: { mediaId: await mediaIdForFile(page, 'clip-a.mp4') },
			at: 0,
			sourceRange: { in: { seconds: 0 }, out: { seconds: 3 } },
		},
	]);
	expectTransaction(r);
	clipId = r.created.find((id) => id.startsWith('clp_'))!;
	// a 30 fps clip in the 29.97 sequence (conformed): yellow; an effect keeps it yellow or red
	await expect.poll(bar).toEqual(['yellow']);
	await transact(page, [{ type: 'effect.add', target: { clipId }, effectId: 'jasper.gaussian-blur' }]);
	await expect.poll(bar).not.toEqual([]);
	expect((await bar()).every((s) => s === 'yellow' || s === 'red')).toBe(true);
	await page.getByRole('menuitem', { name: 'Sequence' }).click();
	await page.getByRole('menuitem', { name: 'Render Effects In to Out' }).click();
	await expect.poll(bar, { timeout: 480_000, intervals: [1000] }).toEqual(['green']);
	await expect(page.locator('[data-render-preview]').first()).toBeAttached({ timeout: 30_000 });
	const src = await page.locator('[data-render-preview]').first().getAttribute('data-render-preview');
	expect(src).toMatch(/^\/renders\/previews\/[0-9a-f]{16}\/[0-9a-f]{32}\.mp4$/);
	await page.screenshot({ path: 'test-results/previews-green.png' });

	await transact(page, [{ type: 'clip.move', clipIds: [clipId], deltaFrames: 30 }]);
	await expect.poll(bar).toEqual(['green']);
	await transact(page, [{ type: 'param.set', target: ['clip', clipId, 'opacity'], value: 60 }]);
	await expect.poll(bar).not.toEqual(['green']);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(bar).toEqual(['green']);

	const seq = await query<{ sequenceId: string }>(page, 'sequence.summary');
	expect(seq.sequenceId).toBeTruthy();
});

test('seek-and-play cycles never stall', async () => {
	test.setTimeout(300_000);
	const stats = await page.evaluate(async () => {
		const { session, driver } = (
			window as unknown as {
				__jasperMonitor: {
					session: {
						transport: {
							pause(): void;
							seek(f: number): void;
							play(r: number): void;
							getState(): { frame: number };
						};
					};
					driver: { stats: { stallsRecovered: number } };
				};
			}
		).__jasperMonitor;
		const t = session.transport;
		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
		let minAdvance = Number.POSITIVE_INFINITY;
		for (let i = 0; i < 12; i++) {
			t.pause();
			t.seek(30 + ((i * 17) % 80));
			await sleep(100 + (i % 4) * 90);
			const f0 = t.getState().frame;
			t.play(1);
			await sleep(1500);
			minAdvance = Math.min(minAdvance, t.getState().frame - f0);
		}
		t.pause();
		return { minAdvance, stallsRecovered: driver.stats.stallsRecovered };
	});
	expect(stats.stallsRecovered).toBe(0);
	expect(stats.minAdvance).toBeGreaterThan(3);
});

test('Delete Render Files clears the green bar', async () => {
	await page.getByRole('menuitem', { name: 'Sequence' }).click();
	await page.getByRole('menuitem', { name: 'Delete Render Files', exact: true }).click();
	await expect.poll(bar).not.toEqual(['green']);
});
