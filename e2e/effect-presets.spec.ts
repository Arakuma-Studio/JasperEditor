import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clipElement,
	createProject,
	enableAgentBridge,
	query,
	ROOT,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

let page: Page;
let seqId = '';

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	if (page && !page.isClosed()) await page.screenshot({ path: 'test-results/e2e-effect-presets-final.png' });
	await page?.close();
});

type Clip = {
	id: string;
	start: number;
	duration: number;
	sourceIn: number;
	opacity: { keyframes: { time: number; value: number }[] };
};
const F = (705_600_000 * 1001) / 30000;

async function clipsOnV1(): Promise<Clip[]> {
	const c = await query<Record<string, Clip & { trackId: string }>>(page, 'doc.get', {
		path: ['sequences', seqId, 'clips'],
	});
	return Object.values(c ?? {}).sort((a, b) => a.start - b.start);
}

const tab = (name: string) =>
	page
		.locator('.dv-tab')
		.filter({ hasText: new RegExp(`^${name}$`) })
		.first();

test('a built-in preset applies by double-click with clips selected', async () => {
	await createProject(page, 'E2E Effect Presets');
	seqId = (await query<{ sequenceId: string }>(page, 'sequence.summary')).sequenceId;
	const r = await transact(page, [
		{ type: 'clip.addSolid', at: 0, duration: 90, track: 'V1', color: [1, 0, 0, 1] },
		{ type: 'clip.addSolid', at: 120, duration: 150, track: 'V1', color: [0, 0, 1, 1] },
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	const [a] = await clipsOnV1();
	await clipElement(page, a!.id).click();
	await tab('Effects').click();
	const panel = page.getByTestId('effects-panel');
	await panel.getByTestId('effects-search').fill('fade in');
	await panel.locator('[data-preset-id="builtin.fade-in"]').dblclick();
	await expect.poll(async () => (await clipsOnV1())[0]!.opacity.keyframes.length).toBe(2);
	expect((await appliedLabels(page)).at(-1)).toBe('Apply Preset Fade In (1 s)');
});

test('Save Preset… from Effect Controls stores a preset that survives a reload and applies Anchor to Out', async () => {
	await tab('Effect Controls').click();
	const ec = page.getByTestId('effect-controls-panel');
	const [a] = await clipsOnV1();
	await ec.locator(`[data-ec-header="${a!.id}:opacity"] > div`).first().click({ button: 'right' });
	await page.getByTestId('ec-header-menu').getByRole('menuitem', { name: 'Save Preset…' }).click();
	const dialog = page.getByTestId('save-preset-dialog');
	await dialog.getByTestId('save-preset-name').fill('E2E Fade');
	await dialog.getByTestId('save-preset-type-anchor-out').click();
	await dialog.getByRole('button', { name: 'OK' }).click();
	await expect(dialog).toBeHidden();

	await page.reload();
	await expect(page.getByTestId('timeline-track-area')).toBeVisible();
	// Reload can leave the old page's lease alive until expiry; resume editing through the UI.
	const takeOver = page.getByRole('button', { name: 'Take over editing', exact: true });
	if (await takeOver.isVisible()) await takeOver.click();
	await expect(page.getByTestId('banner-read-only')).toBeHidden();
	const b = (await clipsOnV1())[1]!;
	await clipElement(page, b.id).click();
	await tab('Effects').click();
	const panel = page.getByTestId('effects-panel');
	await panel.getByTestId('effects-search').fill('E2E Fade');
	const row = panel.locator('[data-preset-id^="fxp_"]').filter({ hasText: 'E2E Fade' });
	await expect(row).toBeVisible();
	await row.dblclick();
	// Anchor to Out: the 0 / 30 frame keys of a 90-frame clip keep their distance from its last frame (89).
	await expect
		.poll(async () => {
			const c = (await clipsOnV1())[1]!;
			return c.opacity.keyframes.map((k) => Math.round((k.time - c.sourceIn) / F));
		})
		.toEqual([149 - 89, 149 - 59]);
	await page.screenshot({ path: join(ROOT, 'test-results', 'e2e-effect-presets.png') });
});
