// Spec 19 TL-085, TL-093, TL-110, TL-111 in the real editor: type in place on Program, double-click a text, a look drawn
// as you type, a visible caret, real IME composition (through the DevTools protocol), per-word styles, vertical text and
// Warp Text from Properties and Effect Controls. Screenshots: test-results/e2e-text-entry.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, chromium, expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	browserLaunch,
	clips,
	createProject,
	enableAgentBridge,
	expectTransaction,
	focusTimeline,
	playheadFrame,
	query,
	ROOT,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const OUT = join(ROOT, 'test-results', 'e2e-text-entry');
mkdirSync(OUT, { recursive: true });

let browser: Browser;
let page: Page;

test.beforeAll(async ({ storageState, baseURL }) => {
	// A look reaches GL through HTML-in-Canvas.
	browser = await chromium.launch(browserLaunch(['--enable-features=CanvasDrawElement']));
	const context = await browser.newContext({
		baseURL: baseURL ?? undefined,
		viewport: { width: 1600, height: 1000 },
		...(storageState ? { storageState } : {}),
	});
	page = await context.newPage();
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	await browser?.close();
});

const input = () => page.getByTestId('text-entry-input');
const caret = () => page.getByTestId('text-entry-caret');
const viewport = () => page.getByTestId('program-viewport');

async function shot(name: string): Promise<void> {
	writeFileSync(join(OUT, `${name}.png`), await viewport().screenshot());
}

async function textOf(id: string): Promise<{
	text: string;
	runs?: { from: number; to: number; style: Record<string, unknown>; finish?: string }[];
	writingMode?: string;
}> {
	const { sequenceId } = await query<{ sequenceId: string }>(page, 'sequence.summary');
	const c = await query<{ content: never }>(page, 'doc.get', {
		path: ['sequences', sequenceId, 'clips', id],
	});
	return c.content;
}

async function clickProgram(fx: number, fy: number): Promise<void> {
	const vp = (await viewport().boundingBox())!;
	await page.mouse.click(vp.x + vp.width * fx, vp.y + vp.height * fy);
}

async function typeTool(fx = 0.5, fy = 0.5): Promise<void> {
	await page.getByRole('button', { name: 'Type Tool', exact: true }).click();
	await clickProgram(fx, fy);
	await expect(input()).toBeFocused();
}

/** The screen centre of the drawn text of a clip. */
async function textCentre(id: string): Promise<{ x: number; y: number }> {
	const b = await page
		.getByTestId('program-player-wrapper')
		.locator(`[data-clip-id="${id}"]`)
		.first()
		.boundingBox();
	if (!b) throw new Error('not drawn');
	return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

const textClips = async () => (await clips(page)).filter((c) => c.kind === 'text');

test('the Type tool types in place; the entry is one undo step; an empty one leaves nothing', async () => {
	await createProject(page, 'E2E Text Entry');
	await typeTool();
	await expect(caret()).toBeVisible();
	await shot('caret-empty');
	await page.keyboard.type('In place');
	await expect(input()).toHaveAttribute('data-value', 'In place');
	expect(await textClips()).toHaveLength(0);
	await shot('typing');
	await page.keyboard.press('Escape');
	await expect(input()).toHaveCount(0);
	await expect.poll(textClips).toHaveLength(1);
	const [c] = await textClips();
	expect((await textOf(c!.id)).text).toBe('In place');
	expect((await query<{ clips: string[] }>(page, 'selection.get')).clips).toEqual([c!.id]);
	expect((await appliedLabels(page)).at(-1)).toBe('Add Text');
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(textClips).toHaveLength(0);

	// A caret left empty.
	await typeTool(0.3, 0.3);
	await page.keyboard.press('Escape');
	await expect(input()).toHaveCount(0);
	expect(await textClips()).toHaveLength(0);
	// A click away with nothing typed.
	await typeTool(0.3, 0.3);
	await page.getByTestId('timeline-track-area').click({ position: { x: 5, y: 5 } });
	await expect(input()).toHaveCount(0);
	expect(await textClips()).toHaveLength(0);
});

test('no shortcut fires while typing', async () => {
	await typeTool();
	const frame = await playheadFrame(page);
	const labels = (await appliedLabels(page)).length;
	// Tool keys, transport, razor, delete, navigation.
	await page.keyboard.type('vcbjkl qwe rtyu');
	await page.keyboard.press('Space');
	await page.keyboard.press('ArrowLeft');
	await page.keyboard.press('Delete');
	await page.keyboard.press('Home');
	await page.keyboard.press('Control+KeyK');
	await page.keyboard.press('Control+KeyS');
	expect(await playheadFrame(page)).toBe(frame);
	await expect(page.getByRole('button', { name: 'Selection Tool', exact: true })).toBeVisible();
	expect((await appliedLabels(page)).length).toBe(labels);
	await expect(input()).toBeFocused();
	await page.keyboard.press('Escape');
	await expect.poll(textClips).toHaveLength(1);
	const [c] = await textClips();
	expect((await textOf(c!.id)).text).toContain('vcbjkl qwe rtyu');
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(textClips).toHaveLength(0);
});

test('real IME composition enters text, in Japanese, Chinese and Korean', async () => {
	const cdp = await page.context().newCDPSession(page);
	const compose = async (parts: string[], final: string) => {
		for (const text of parts)
			await cdp.send('Input.imeSetComposition', {
				text,
				selectionStart: text.length,
				selectionEnd: text.length,
			});
		await expect(input()).toHaveAttribute('data-mode', 'plain');
		await cdp.send('Input.insertText', { text: final });
	};
	await typeTool();
	await compose(['に', 'にほ', 'にほん', 'にほんご'], '日本語');
	await expect(input()).toHaveAttribute('data-value', '日本語');
	await shot('ime-japanese');
	await compose(['zhong', '中文'], '中文');
	await compose(['ㅎ', '하', '한', '한글'], '한글');
	await expect(input()).toHaveAttribute('data-value', '日本語中文한글');
	// Esc during a composition belongs to the IME: the entry stays open.
	await cdp.send('Input.imeSetComposition', { text: 'か', selectionStart: 1, selectionEnd: 1 });
	await cdp.send('Input.insertText', { text: 'か' });
	await page.keyboard.press('Escape');
	await expect(input()).toHaveCount(0);
	await expect.poll(textClips).toHaveLength(1);
	const [c] = await textClips();
	expect((await textOf(c!.id)).text).toBe('日本語中文한글か');
	await cdp.detach();
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(textClips).toHaveLength(0);
});

test('double-click edits text under a look: the caret shows and the look draws what is typed', async () => {
	const tx = await transact(page, [
		{
			type: 'clip.addText',
			at: 0,
			duration: 300,
			track: 'V1',
			content: { text: 'LOOK', style: { sizePx: 180, weight: 700 } },
			ref: '$t',
		} as never,
		{
			type: 'look.apply',
			clipIds: ['$t'],
			look: {
				name: 'Edit test',
				recipe: {
					palette: { face: [0.98, 0.82, 0.25, 1], keyline: [0.1, 0.1, 0.5, 1] },
					layers: [
						{ type: 'rim', params: { width: 8, paint: { kind: 'role', role: 'keyline' } } },
						{ type: 'face', params: { paint: { kind: 'role', role: 'face' } } },
					],
				},
			},
		} as never,
	]);
	expectTransaction(tx);
	const id = tx.refs.$t!;
	const at = await textCentre(id);
	await shot('look-before');
	await page.mouse.dblclick(at.x, at.y);
	await expect(input()).toBeFocused();
	await expect(input()).toHaveAttribute('data-mode', 'ghost');
	await expect(caret()).toBeVisible();
	await page.keyboard.press('End');
	await page.keyboard.type('S!');
	await expect(input()).toHaveAttribute('data-value', 'LOOKS!');
	// The look draws the edit through the transient document, before anything is committed.
	await expect
		.poll(async () =>
			page
				.getByTestId('program-player-wrapper')
				.locator(`[data-clip-id="${id}"]`)
				.first()
				.evaluate((el) => el.getBoundingClientRect().width),
		)
		.toBeGreaterThan((await input().boundingBox())!.width * 0.5);
	await page.waitForTimeout(1500);
	await shot('look-typing');
	await page.mouse.click(5, 5);
	await expect(input()).toHaveCount(0);
	expect((await textOf(id)).text).toBe('LOOKS!');
	expect((await appliedLabels(page)).at(-1)).toBe('Edit Text');
	await shot('look-committed');
});

test('a word selected in place gets its own style, in the same undo step', async () => {
	const [c] = await textClips();
	const at = await textCentre(c!.id);
	await page.mouse.dblclick(at.x, at.y);
	await expect(input()).toBeFocused();
	await input().evaluate((el) => {
		const t = el.firstChild as Text;
		const r = document.createRange();
		r.setStart(t, 0);
		r.setEnd(t, 2);
		const s = document.getSelection()!;
		s.removeAllRanges();
		s.addRange(r);
	});
	const bar = page.getByTestId('text-run-toolbar');
	await expect(bar).toBeVisible();
	await shot('run-toolbar');
	await bar.locator('[data-run-action="italic"]').click();
	await bar.locator('[data-run-action="larger"]').click();
	await expect(input()).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(input()).toHaveCount(0);
	const { runs } = await textOf(c!.id);
	expect(runs).toEqual([{ from: 0, to: 2, style: { italic: true, sizePx: 216 } }]);
	await page.waitForTimeout(1500);
	await shot('run-under-look');
});

test('vertical text and Warp Text come from Properties, and Warp Text keys in Effect Controls', async () => {
	const [c] = await textClips();
	await page.getByRole('tab', { name: 'Properties', exact: true }).click();
	await page.getByTestId('text-orientation').selectOption('vertical');
	await expect.poll(async () => (await textOf(c!.id)).writingMode).toBe('vertical');
	await page.waitForTimeout(1500);
	await shot('vertical-look');
	await page.getByTestId('text-warp-style').selectOption('arch');
	await expect(page.getByText('Bend', { exact: true }).first()).toBeVisible();
	await page.waitForTimeout(2000);
	await shot('vertical-warp-look');
	// Editing it: the warp stands aside so the caret sits on the letters.
	const at = await textCentre(c!.id);
	await page.mouse.dblclick(at.x, at.y);
	await expect(input()).toBeFocused();
	await page.waitForTimeout(1500);
	await shot('vertical-warp-editing');
	await page.keyboard.press('Escape');
	await expect(input()).toHaveCount(0);
	await page.getByRole('tab', { name: 'Effect Controls', exact: true }).click();
	await expect(page.getByText('Warp Text', { exact: true }).first()).toBeVisible();
});
