// Expressions end to end (docs/wp-notes/expressions.md): Alt-click a stopwatch in Effect Controls, type an
// expression in the editor, see the post-expression value (red) and the Program preview follow it, an error under
// the field, a preset from the language menu, the post-expression graph, and one undo per edit.
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clipBox,
	createProject,
	enableAgentBridge,
	focusTimeline,
	query,
	timelineArea,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

let page: Page;
let seqId = '';
let clipId = '';

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
	await createProject(page, 'E2E Expressions');
	seqId = (await query<{ sequenceId: string }>(page, 'sequence.summary')).sequenceId;
});

test.afterAll(async () => {
	await page?.close();
});

const rotation = async () =>
	(
		await query<{ transform: { rotation: { expression?: { text: string; enabled: boolean } } } }>(page, 'doc.get', {
			path: ['sequences', seqId, 'clips', clipId],
			fields: ['transform'],
		})
	).transform.rotation.expression;

/** Rotation (degrees) of the clip's layer in the Program preview, from its CSS matrix. */
const previewRotation = () =>
	page.locator(`[data-testid="program-player-wrapper"] [data-clip-id="${clipId}"]`).first().evaluate((el) => {
		const m = new DOMMatrix(getComputedStyle(el).transform);
		return Math.round((Math.atan2(m.b, m.a) * 180) / Math.PI);
	});

test('Alt-click adds an expression; typing drives the value, the preview and the graph', async () => {
	const r = (await transact(page, [
		{ type: 'clip.addSolid', at: 0, duration: 150, track: 'V1', color: [0.9, 0.3, 0.1, 1] },
	])) as { ok: boolean; created?: string[] };
	clipId = r.created!.find((id) => id.startsWith('clp_'))!;
	await transact(page, [{ type: 'param.set', target: ['clip', clipId, 'transform', 'scale'], value: 30 }]);
	const b = await clipBox(page, clipId);
	const area = (await timelineArea(page).boundingBox())!;
	await page.mouse.click((Math.max(b.x, area.x + 4) + Math.min(b.x + b.width, area.x + area.width - 4)) / 2, b.y + b.height / 2);
	await page.getByTestId('tab-effectControls').click();
	const ec = page.getByTestId('ec-content');

	await ec.getByTestId('stopwatch-transform.rotation').click({ modifiers: ['Alt'] });
	await expect.poll(rotation).toEqual({ text: 'transform.rotation', enabled: true });
	const pathId = `clip-${clipId}-transform-rotation`;
	const field = ec.locator(`[data-testid="expr-row-${pathId}"] .cm-content`);
	await expect(field).toBeVisible();
	await field.click();
	await page.keyboard.press('Control+KeyA');
	await page.keyboard.type('time * 90');
	await page.keyboard.press('Control+Enter');
	await expect.poll(rotation).toEqual({ text: 'time * 90', enabled: true });
	expect((await appliedLabels(page)).at(-1)).toBe('Edit Expression: Rotation');

	await query(page, 'playhead.set', { frame: 30 });
	await expect(ec.getByTestId('prop-transform.rotation')).toContainText('90');
	await expect(ec.locator('[data-expression="active"]').first()).toBeVisible();
	await expect.poll(previewRotation).toBe(90);
	await query(page, 'playhead.set', { frame: 15 });
	await expect.poll(previewRotation).toBe(45);

	// The post-expression graph.
	await ec.getByTestId('twirl-transform.rotation').click();
	await expect(ec.getByTestId('graph-post-curve-transform.rotation-0')).toBeVisible();
	await page.screenshot({ path: 'test-results/e2e/expressions-effect-controls.png' });
});

test('errors show under the field; a preset from the language menu replaces the text; undo', async () => {
	const ec = page.getByTestId('ec-content');
	const pathId = `clip-${clipId}-transform-rotation`;
	const field = ec.locator(`[data-testid="expr-row-${pathId}"] .cm-content`);
	await field.click();
	await page.keyboard.press('Control+KeyA');
	await page.keyboard.type('nope(');
	// The editor closes the bracket: nope() is a call of an undefined function (a runtime error).
	await page.keyboard.press('Control+Enter');
	await expect(ec.getByTestId(`expr-error-${pathId}`)).toContainText('Error at line 1');
	// The property falls back to its keyframed value (0).
	await expect.poll(previewRotation).toBe(0);

	await ec.getByTestId(`expr-menu-${pathId}`).click();
	const menu = page.getByTestId('expr-language-menu');
	await menu.getByText('Presets', { exact: true }).hover();
	await page.getByText('Time', { exact: true }).hover();
	await page.getByText('Rotate over time', { exact: true }).click();
	await expect.poll(rotation).toEqual({ text: 'value + time * 90', enabled: true });
	await expect(ec.getByTestId(`expr-error-${pathId}`)).toHaveCount(0);

	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await rotation())?.text).toBe('nope()');
});
