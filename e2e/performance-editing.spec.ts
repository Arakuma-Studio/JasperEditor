import { expect, test } from '@playwright/test';
import {
	clipBox,
	clips,
	createProject,
	enableAgentBridge,
	expectTransaction,
	focusTimeline,
	playheadFrame,
	query,
	transact,
} from './support.ts';

test('snapping, cuts and edit navigation stay current after edits and undo', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await enableAgentBridge(page);
	await createProject(page, 'Performance editing checks');
	const result = await transact(page, [
		{ type: 'clip.addSolid', at: 0, duration: 400, track: 'V1', color: [0.9, 0.3, 0.1, 1], ref: '$base' },
		{ type: 'clip.addSolid', at: 100, duration: 100, track: 'V2', color: [0.1, 0.6, 0.9, 1], ref: '$top' },
		{ type: 'marker.add', frame: 153, name: 'Snap check' },
	]);
	expectTransaction(result);
	await focusTimeline(page);
	await query(page, 'playhead.set', { frame: 50 });
	await page.keyboard.press('KeyC');
	const base = await clipBox(page, result.refs.$base!);
	const pxPerFrame = base.width / 400;
	const hover = async (frame: number, expected: number) => {
		await page.mouse.move(base.x + frame * pxPerFrame, base.y + base.height / 2);
		await expect
			.poll(async () => {
				const line = await page.locator('[data-razor-line]').boundingBox();
				return line ? Math.round((line.x - base.x) / pxPerFrame) : null;
			})
			.toBe(expected);
	};
	await hover(102, 100);
	await hover(103, 100);
	await query(page, 'playhead.set', { frame: 60 });
	await hover(58, 60);
	const moved = await transact(page, [{ type: 'clip.move', clipIds: [result.refs.$top!], deltaFrames: 10 }]);
	expectTransaction(moved);
	await hover(108, 110);
	await page.screenshot({ path: 'test-results/e2e/performance-razor.png' });
	await page.mouse.click(base.x + 108 * pxPerFrame, base.y + base.height / 2);
	const spans = async () => (await clips(page, ['V1'])).map((clip) => [clip.start, clip.end]);
	await expect.poll(spans).toEqual([
		[0, 110],
		[110, 400],
	]);
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(spans).toEqual([[0, 400]]);
	await page.keyboard.press('Control+Shift+KeyZ');
	await expect.poll(spans).toEqual([
		[0, 110],
		[110, 400],
	]);
	await page.keyboard.press('KeyV');
	await query(page, 'playhead.set', { frame: 0 });
	await page.keyboard.press('Shift+ArrowDown');
	await expect.poll(() => playheadFrame(page)).toBe(110);
	await page.keyboard.press('Shift+ArrowDown');
	await expect.poll(() => playheadFrame(page)).toBe(210);
	await page.keyboard.press('Shift+ArrowUp');
	await expect.poll(() => playheadFrame(page)).toBe(110);
	const ruler = (await page.getByTestId('timeline-ruler').boundingBox())!;
	await page.keyboard.down('Shift');
	await page.mouse.click(ruler.x + 151 * pxPerFrame, ruler.y + 10);
	await page.keyboard.up('Shift');
	await expect.poll(() => playheadFrame(page)).toBe(153);
	await page.screenshot({ path: 'test-results/e2e/performance-marker-snap.png' });
	expect(errors).toEqual([]);
});
