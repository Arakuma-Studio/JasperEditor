import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clipElement,
	createProject,
	enableAgentBridge,
	expectTransaction,
	focusTimeline,
	query,
	ROOT,
} from './support.ts';

const FIXTURE_PROJECT = join(ROOT, 'fixtures', 'mg-project');

test.describe.configure({ mode: 'serial' });

let page: Page;
let clipId = '';

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	if (page && !page.isClosed()) await page.screenshot({ path: 'test-results/e2e-composition-texts.png' });
	await page?.close();
});

/** Text of an element of the LowerThird's live host page in the Program monitor. */
async function hostText(testId: string): Promise<string | null> {
	// Security review MG-1: the host page is a sandboxed frame; it is read from inside (the editor cannot reach in).
	return page
		.frameLocator('[data-testid="program-monitor"] iframe[data-mg-host]')
		.locator(`[data-testid="${testId}"]`)
		.first()
		.textContent({ timeout: 2000 })
		.catch(() => null);
}

async function props(): Promise<Record<string, unknown>> {
	const seqs = await query<Record<string, { clips: Record<string, { props?: Record<string, unknown> }> }>>(
		page,
		'doc.get',
		{ path: ['sequences'] },
	);
	for (const seq of Object.values(seqs)) if (seq.clips[clipId]) return seq.clips[clipId]!.props ?? {};
	return {};
}

/** Screen point of a composition pixel (the LowerThird is 1920×1080 at 100 % in a 1080p sequence). */
async function screenPoint(x: number, y: number): Promise<{ x: number; y: number }> {
	const r = await page.getByTestId('program-player-wrapper').boundingBox();
	if (!r) throw new Error('no player');
	return { x: r.x + (x * r.width) / 1920, y: r.y + (y * r.height) / 1080 };
}

test('Properties text editors: live preview while typing, one History step, layout warnings, embedded font', async ({
	request,
}) => {
	test.setTimeout(900_000);
	await createProject(page, 'E2E Composition Texts');
	const imported = await request.post('/api/mg-bundles/import', { data: { path: FIXTURE_PROJECT } });
	expect(imported.status(), await imported.text()).toBe(200);
	const reg = await imported.json();
	const res = await page.evaluate(async (r) => {
		const api = window.jasper!;
		return api.transact({
			label: 'Import Remotion Project',
			commands: [
				{
					type: 'media.register',
					asset: {
						kind: r.kind,
						fingerprint: r.fingerprint,
						originalName: r.originalName,
						sizeBytes: r.sizeBytes,
						container: r.container,
						probe: r.probe,
						locators: [{ type: 'engine-store', engineId: 'local', key: r.mediaKey }],
						mgBundle: r.mgBundle,
					},
					name: r.mgBundle.source.name,
					ref: '$bundle',
				},
				{
					type: 'clip.addComposition',
					composition: { mediaId: '$bundle', id: 'LowerThird' },
					at: 0,
					track: 'V1',
					ref: '$lt',
				},
			],
		});
	}, reg);
	expectTransaction(res);
	clipId = res.refs.$lt!;
	await clipElement(page, clipId).click();
	await query(page, 'playhead.set', { frame: 60 });

	await expect.poll(() => hostText('lt-name'), { timeout: 60_000 }).toBe('Ada Lovelace');
	const before = (await appliedLabels(page)).length;
	const field = page.getByTestId('text-name.text');
	await field.click();
	await field.press('Control+a');
	await field.pressSequentially('Augusta Ada King, Countess of Lovelace', { delay: 5 });
	await expect
		.poll(() => hostText('lt-name'), { timeout: 5_000 })
		.toBe('Augusta Ada King, Countess of Lovelace');
	expect(await appliedLabels(page)).toHaveLength(before);
	await field.press('Enter');
	await expect.poll(async () => (await appliedLabels(page)).slice(before)).toEqual(['Edit Text «Name»']);
	expect(await props()).toMatchObject({ name: { text: 'Augusta Ada King, Countess of Lovelace' } });
	// Soft limit and measured layout: designed for 24 characters, cut off by the name panel.
	const issues = page.getByTestId('text-name.text-issues');
	await expect(issues.locator('[data-code="MG_TEXT_LONG"]')).toBeVisible();
	await expect(issues.locator('[data-code="MG_TEXT_CLIPPED"]')).toBeVisible({ timeout: 60_000 });
	// Schema errors are not applied: 61 characters.
	await field.click();
	await field.press('Control+a');
	await field.pressSequentially('x'.repeat(61));
	await expect(page.getByTestId('text-name.text-error')).toContainText('60');
	await field.press('Enter');
	await expect(page.getByTestId('composition-message')).toContainText('Not applied');
	expect(await props()).toMatchObject({ name: { text: 'Augusta Ada King, Countess of Lovelace' } });
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(() => hostText('lt-name'), { timeout: 10_000 }).toBe('Ada Lovelace');
	await expect(field).toHaveValue('Ada Lovelace');
});

test('double-click a text in the Program monitor edits it in place in the bundle font', async () => {
	test.setTimeout(600_000);
	await query(page, 'playhead.set', { frame: 60 });
	await expect.poll(() => hostText('lt-quote'), { timeout: 60_000 }).toMatch(/Analytical Engine/);
	const p = await screenPoint(400, 150);
	await page.mouse.dblclick(p.x, p.y);
	const input = page.getByTestId('mg-text-canvas-input');
	await expect(input).toBeVisible({ timeout: 30_000 });
	await expect(input).toHaveAttribute('data-text-path', 'quote');
	await expect(input).toBeFocused();
	expect(await input.evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Inter');
	expect(await input.evaluate((el) => document.fonts.check(`16px ${getComputedStyle(el).fontFamily}`))).toBe(
		true,
	);
	const before = (await appliedLabels(page)).length;
	await input.press('Escape');
	await expect(input).toBeHidden();
	expect((await appliedLabels(page)).length).toBe(before);

	await page.mouse.dblclick(p.x, p.y);
	await expect(input).toBeVisible({ timeout: 30_000 });
	await input.press('Control+a');
	await input.pressSequentially('Imagination is the Discovering Faculty,');
	await input.press('Enter'); // a new row in a multi-line text
	await input.pressSequentially('*pre-eminently.*');
	await input.press('Control+Enter');
	await expect(input).toBeHidden();
	await expect.poll(async () => (await appliedLabels(page)).slice(before)).toEqual(['Edit Text «Quote»']);
	expect((await props()).quote).toBe('Imagination is the Discovering Faculty,\n*pre-eminently.*');
	await expect
		.poll(() => hostText('lt-quote'), { timeout: 10_000 })
		.toBe('Imagination is the Discovering Faculty,\npre-eminently.');
	await expect(page.getByTestId('text-quote')).toHaveValue(
		'Imagination is the Discovering Faculty,\n*pre-eminently.*',
	);
	// DOCS_SCREENSHOTS=1: the applied on-canvas edit for docs/wp-notes/wp-m3-mgtext.md (fixture project and
	// generated media only; sidecar docs/screenshots/m3-mgtext/fixture-applied.jpg.attribution).
	if (process.env.DOCS_SCREENSHOTS === '1')
		await page.screenshot({
			path: join(ROOT, 'docs', 'screenshots', 'm3-mgtext', 'fixture-applied.jpg'),
			type: 'jpeg',
			quality: 85,
		});
});
