// Texts inside composition clips (M3, wp-m3-mgtext, S08 §8 test 9 — UI part): Properties ▸ Composition ▸ Text
// lists the fixture LowerThird's texts with their style props and the bundle's embedded font; typing previews in
// the Program monitor before the edit is applied, Enter applies it as one History step and the layout warnings
// come from the bundle's own page; a double-click on the quote in the Program monitor edits it in place in the
// bundle font (the rendered text is hidden meanwhile), Ctrl+Enter applies, Esc cancels.
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clipElement,
	createProject,
	enableAgentBridge,
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
	await page?.close();
});

/** Text of an element of the LowerThird's live host page in the Program monitor. */
async function hostText(testId: string): Promise<string | null> {
	return page
		.locator('[data-testid="program-monitor"] iframe[data-mg-host]')
		.evaluate(
			(f, id) =>
				(f as HTMLIFrameElement).contentDocument?.querySelector(`[data-testid="${id}"]`)?.textContent ?? null,
			testId,
		)
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
		const api = (window as unknown as { jasper: { transact(tx: unknown): Promise<Record<string, unknown>> } })
			.jasper;
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
	expect(res.ok, JSON.stringify(res)).toBe(true);
	clipId = (res.refs as Record<string, string>).$lt!;
	await clipElement(page, clipId).click();
	await query(page, 'playhead.set', { frame: 60 });

	// The three texts of the composition, in manifest order, with their style props.
	const texts = page.getByTestId('composition-texts');
	await expect(texts).toBeVisible({ timeout: 60_000 });
	await expect(texts.locator('[data-text-layer]')).toHaveCount(3);
	await expect(page.getByTestId('text-name.text')).toHaveValue('Ada Lovelace');
	await expect(page.getByTestId('text-name.text-count')).toHaveText('12/24');
	await expect(page.getByTestId('text-quote')).toHaveValue(/Analytical Engine/);
	const nameStyle = page.getByTestId('text-name.text-style');
	await expect(nameStyle.locator('[data-prop="props.name.fontSize"]')).toBeVisible();
	await expect(nameStyle.locator('[data-prop="props.name.color"]')).toBeVisible();
	await expect(page.getByTestId('prop-props.name.align-left')).toHaveAttribute('aria-pressed', 'true');
	// The font menu offers the family embedded in the bundle (measured in its page).
	await expect(texts).toHaveAttribute('data-measure', 'done', { timeout: 120_000 });
	await expect(page.getByTestId('prop-props.name.fontFamily').locator('option')).toContainText(['Inter']);
	// The generic form keeps only what no text editor owns.
	await expect(page.locator('[data-testid="composition-props"] [data-prop]')).toHaveCount(1); // accent

	await expect.poll(() => hostText('lt-name'), { timeout: 60_000 }).toBe('Ada Lovelace');
	const before = (await appliedLabels(page)).length;
	const field = page.getByTestId('text-name.text');
	await field.click();
	await field.press('Control+a');
	await field.pressSequentially('Augusta Ada King, Countess of Lovelace', { delay: 5 });
	// Live while typing: the Program monitor shows it before anything is applied.
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
	// Undo restores the text (one step).
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
	expect(await input.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/jmg-.*Inter/);
	// The rendered quote is hidden while its editor replaces it.
	const hidden = () =>
		page
			.locator('[data-testid="program-monitor"] iframe[data-mg-host]')
			.evaluate(
				(f) =>
					(f as HTMLIFrameElement).contentDocument?.querySelector<HTMLElement>('[data-testid="lt-quote"]')
						?.style.visibility ?? null,
			);
	expect(await hidden()).toBe('hidden');
	// Esc cancels: nothing applied, the quote is back.
	const before = (await appliedLabels(page)).length;
	await input.press('Escape');
	await expect(input).toBeHidden();
	expect(await hidden()).toBe('');
	expect((await appliedLabels(page)).length).toBe(before);

	await page.mouse.dblclick(p.x, p.y);
	await expect(input).toBeVisible({ timeout: 30_000 });
	await input.press('Control+a');
	await input.pressSequentially('Imagination is the Discovering Faculty,');
	await input.press('Enter'); // a new row in a multi-line text
	await input.pressSequentially('*pre-eminently.*');
	// Accent markup (manifest `accent: "accent"`): the span is drawn in the accent colour; its asterisks show only
	// while the caret is between them.
	const accentSpan = input.locator('[data-accent]');
	await expect(accentSpan).toHaveText('pre-eminently.');
	expect(await accentSpan.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(51, 102, 255)');
	// The caret after the closing asterisk is outside the span: the markup is hidden.
	const marks = input.locator('[data-mark]');
	await expect(marks).toHaveCount(2);
	const display = () => marks.evaluateAll((els) => els.map((e) => getComputedStyle(e).display));
	await expect.poll(display).toEqual(['none', 'none']);
	await input.press('ArrowLeft'); // into the span: its asterisks show (dimmed) and can be edited
	await expect.poll(display).toEqual(['inline', 'inline']);
	await input.press('Control+Home'); // out again
	await expect.poll(display).toEqual(['none', 'none']);
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
});

test('more than 4 composition clips: editing on canvas takes a live host from the clip farthest from the playhead', async () => {
	test.setTimeout(900_000);
	const mediaId = await page.evaluate(async () => {
		const api = (window as unknown as { jasper: { query(n: string, a: unknown): Promise<unknown> } }).jasper;
		const m = (await api.query('media.list', {})) as { media: { mediaId: string; kind: string }[] };
		return m.media.find((x) => x.kind === 'mg-bundle')!.mediaId;
	});
	const transact = (commands: unknown[]) =>
		page.evaluate(
			async (c) =>
				(
					window as unknown as { jasper: { transact(tx: unknown): Promise<Record<string, unknown>> } }
				).jasper.transact({ label: 'setup', commands: c }),
			commands,
		);
	// Four badges mount first and take the four live hosts…
	const r1 = await transact(
		['V2', 'V3', 'V4', 'V5'].map((track) => ({
			type: 'clip.addComposition',
			composition: { mediaId, id: 'Badge' },
			at: 200,
			track,
		})),
	);
	expect(r1.ok, JSON.stringify(r1)).toBe(true);
	await query(page, 'playhead.set', { frame: 230 });
	const hosts = page.locator('[data-testid="program-monitor"] iframe[data-mg-host]');
	await expect(hosts).toHaveCount(4, { timeout: 60_000 });
	// …so a fifth composition (the LowerThird on top) shows the idle card.
	const r2 = await transact([
		{
			type: 'clip.addComposition',
			composition: { mediaId, id: 'LowerThird' },
			at: 200,
			track: 'V6',
			ref: '$lt',
		},
	]);
	expect(r2.ok, JSON.stringify(r2)).toBe(true);
	const lt = (r2.refs as Record<string, string>).$lt!;
	await query(page, 'playhead.set', { frame: 240 }); // badges are 60 frames long: 200–259
	await expect(page.locator('[data-testid="program-monitor"] [data-mg-card="idle"]')).toHaveCount(1, {
		timeout: 30_000,
	});
	await expect(page.locator(`iframe[data-mg-host-clip="${lt}"]`)).toHaveCount(0);

	// Double-click its quote: it gets a live host (still 4 in all) and the editor opens on the text.
	const p = await screenPoint(400, 150);
	await page.mouse.dblclick(p.x, p.y);
	const input = page.getByTestId('mg-text-canvas-input');
	await expect(input).toBeVisible({ timeout: 60_000 });
	await expect(input).toHaveAttribute('data-text-path', 'quote');
	await expect(page.locator(`iframe[data-mg-host-clip="${lt}"]`)).toHaveCount(1);
	await expect(hosts).toHaveCount(4);
	await expect(page.locator('[data-testid="program-monitor"] [data-mg-card="idle"]')).toHaveCount(1);
	// Done editing: the budget goes back to first-come.
	await input.press('Escape');
	await expect(input).toBeHidden();
	await expect(page.locator(`iframe[data-mg-host-clip="${lt}"]`)).toHaveCount(0, { timeout: 30_000 });
	await expect(hosts).toHaveCount(4);
});
