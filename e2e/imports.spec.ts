import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	createProject,
	enableAgentBridge,
	FIXTURES,
	importFiles,
	programPixels,
	query,
	ROOT,
	serverInfo,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const OUT = join(ROOT, 'test-results', 'e2e-imports');
mkdirSync(OUT, { recursive: true });

let page: Page;
let projectId = '';

type Media = {
	id: string;
	originalName: string;
	kind: string;
	interpretation?: Record<string, unknown>;
	vector?: { format: string; page?: number };
	lottie?: { fps: number };
	imageSequence?: { frames: number; missing: number[] };
	layerSource?: { name: string };
};
type Doc = {
	items: Record<string, { id: string; kind: string; name: string; mediaId?: string; sequenceId?: string }>;
	media: Record<string, Media>;
	sequences: Record<
		string,
		{ id: string; videoTracks: unknown[]; clips: Record<string, { kind: string; blendMode?: string }> }
	>;
};
const doc = () => query<Doc>(page, 'doc.get');
const mediaNamed = async (name: string) =>
	Object.values((await doc()).media).filter((m) => m.originalName === name);

async function chooseFiles(paths: string[]) {
	await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Control+KeyI');
	await (await chooser).setFiles(paths);
}

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	await page?.close();
});

test('imports Lottie, SVG, EXR and interlaced video; the Program monitor draws them', async () => {
	projectId = await createProject(page, 'E2E Imports');
	await importFiles(page, [
		'imports-anim.json',
		'imports-logo.svg',
		'imports-still.exr',
		'imports-interlaced.mkv',
	]);
	const d = await doc();
	const byName = (n: string) => Object.values(d.media).find((m) => m.originalName === n)!;
	expect(byName('imports-anim.json').lottie?.fps).toBeGreaterThan(0);
	expect(byName('imports-logo.svg').vector?.format).toBe('svg');
	expect(byName('imports-still.exr').kind).toBe('image');
	const r = await transact(page, [
		{
			type: 'clip.place',
			source: { mediaId: byName('imports-still.exr').id },
			at: 0,
			tracks: { video: 'V1' },
		},
		{
			type: 'clip.place',
			source: { mediaId: byName('imports-logo.svg').id },
			at: 0,
			tracks: { video: 'V2' },
		},
		{
			type: 'clip.place',
			source: { mediaId: byName('imports-anim.json').id },
			at: 0,
			tracks: { video: 'V3' },
		},
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	await expect.poll(async () => (await programPixels(page)).std, { timeout: 60_000 }).toBeGreaterThan(5);
	// The EXR display picture and the SVG are <img>s, the Lottie player draws an <svg>.
	await expect
		.poll(async () => (await programPixels(page)).layers, { timeout: 60_000 })
		.toBeGreaterThanOrEqual(2);
	await expect(page.getByTestId('program-player-wrapper').locator('svg g').first()).toBeAttached({
		timeout: 60_000,
	});
	await page.screenshot({ path: join(OUT, '1-program.png') });
});

test('a two-page PDF asks which pages; each becomes an item', async () => {
	await chooseFiles([join(FIXTURES, 'imports-doc.pdf')]);
	const dlg = page.getByTestId('pdf-pages-dialog');
	await expect(dlg).toBeVisible({ timeout: 60_000 });
	await dlg.getByText(/^Page 2/).click();
	await page.screenshot({ path: join(OUT, '2-pdf-pages.png') });
	await dlg.getByRole('button', { name: 'Import' }).click();
	await expect
		.poll(async () => (await mediaNamed('imports-doc.pdf')).map((m) => m.vector?.page).sort())
		.toEqual([1, 2]);
	await expect(page.getByTestId('project-row').filter({ hasText: 'imports-doc.pdf (page 2)' })).toBeVisible();
});

test('a PSD imports as a sequence of its layers', async () => {
	await chooseFiles([join(FIXTURES, 'imports-layers.psd')]);
	const dlg = page.getByTestId('layered-import-dialog');
	await expect(dlg).toBeVisible({ timeout: 60_000 });
	await expect(dlg.getByTestId('layered-layers')).toContainText('Badge');
	await page.screenshot({ path: join(OUT, '3-layered.png') });
	await dlg.getByRole('button', { name: 'OK' }).click();
	await expect
		.poll(async () => Object.values((await doc()).media).filter((m) => m.layerSource).length, {
			timeout: 60_000,
		})
		.toBeGreaterThan(2);
	const d = await doc();
	const seqItem = Object.values(d.items).find((i) => i.kind === 'sequence' && i.name === 'imports-layers');
	expect(seqItem).toBeTruthy();
	const seq = d.sequences[seqItem!.sequenceId!]!;
	expect(seq.videoTracks.length).toBeGreaterThan(2);
	expect(Object.values(seq.clips).some((c) => c.blendMode && c.blendMode !== 'normal')).toBe(true);
});

test('numbered stills import as one image sequence clip', async () => {
	const dir = join(FIXTURES, 'imports-seq');
	await chooseFiles(readdirSync(dir).map((f) => join(dir, f)));
	const dlg = page.getByTestId('image-sequence-dialog');
	await expect(dlg).toBeVisible({ timeout: 60_000 });
	await expect(dlg.getByTestId('image-sequence-groups')).toContainText('1 missing (held)');
	await dlg.getByTestId('image-sequence-rate').fill('12');
	await dlg.getByRole('button', { name: 'Import' }).click();
	await expect
		.poll(async () => Object.values((await doc()).media).find((m) => m.imageSequence)?.imageSequence, {
			timeout: 120_000,
		})
		.toMatchObject({ frames: 12, missing: [7] });
});

type El = { id: string; stable: boolean; role: string; name: string; tag: string };

test('Modify ▸ Interpret Footage… applies in one undoable step; its controls have stable automation ids', async () => {
	await page
		.locator('.dv-tab')
		.filter({ hasText: /^Project$/ })
		.first()
		.click();
	await page
		.getByTestId('project-row')
		.filter({ hasText: 'imports-interlaced.mkv' })
		.click({ button: 'right' });
	// The Project panel menu has Modify ▸ Interpret Footage… (a labelled section); the long menu runs past the bottom of
	// this viewport, so the dialog is opened from Clip ▸ Modify, which acts on the same Project panel selection.
	await expect(page.getByRole('menuitem', { name: 'Interpret Footage…' })).toBeAttached();
	await page.keyboard.press('Escape');
	await page.getByTestId('project-row').filter({ hasText: 'imports-interlaced.mkv' }).click();
	await page.getByTestId('title-bar').getByRole('menuitem', { name: 'Clip', exact: true }).click();
	await page.getByRole('menuitem', { name: /^Modify$/ }).hover();
	await page.getByRole('menuitem', { name: 'Interpret Footage…' }).click();
	const dlg = page.getByTestId('interpret-footage-dialog');
	await expect(dlg).toBeVisible();
	await expect(dlg.getByTestId('interpret-field-order')).toContainText('Upper Field First');
	const { port } = serverInfo();
	const res = await page.request.post(`http://127.0.0.1:${port}/api/agent/ui`, {
		data: { projectId, action: 'elements', args: { limit: 2000 } },
	});
	expect(res.ok()).toBe(true);
	const els = ((await res.json()).result as { elements: El[] }).elements;
	const inDialog = els.filter((e) => e.id.includes('Interpret Footage') || e.id.includes('interpret-'));
	expect(inDialog.length).toBeGreaterThan(5);
	expect(els.filter((e) => !e.stable).map((e) => `${e.id} (${e.tag} ${e.role} "${e.name}")`)).toEqual([]);
	await dlg.getByTestId('interpret-fr-assume').check();
	await dlg.getByTestId('interpret-fr-value').fill('25');
	await dlg.getByTestId('interpret-loop-value').fill('2');
	await page.screenshot({ path: join(OUT, '4-interpret.png') });
	await dlg.getByRole('button', { name: 'OK' }).click();
	await expect(dlg).toBeHidden();
	const m = (await mediaNamed('imports-interlaced.mkv'))[0]!;
	expect(m.interpretation).toEqual({ frameRate: { num: 25, den: 1 }, loop: 2 });
	expect((await appliedLabels(page)).at(-1)).toBe('Interpret Footage');
	await page.keyboard.press('Control+KeyZ');
	await expect
		.poll(async () => (await mediaNamed('imports-interlaced.mkv'))[0]!.interpretation)
		.toBeUndefined();
});

test('File ▸ Export ▸ Lottie… exports the sequence and lists what was not carried', async () => {
	const d = await doc();
	const seq01 = Object.values(d.items).find((i) => i.kind === 'sequence' && i.name === 'Sequence 01')!;
	const r = await transact(page, [
		{
			type: 'clip.addText',
			sequenceId: seq01.sequenceId,
			at: 300,
			duration: 30,
			track: 'V2',
			content: { text: 'Lottie' },
		},
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	await page.getByTestId('project-row').filter({ hasText: 'Sequence 01' }).click();
	await page.getByTestId('title-bar').getByRole('menuitem', { name: 'File', exact: true }).click();
	await page.getByRole('menuitem', { name: /^Export$/ }).hover();
	await page.getByRole('menuitem', { name: /^Lottie…/ }).click();
	const dlg = page.getByTestId('lottie-export-dialog');
	await expect(dlg).toBeVisible();
	await dlg.getByRole('button', { name: 'Export', exact: true }).click();
	await expect(dlg.getByTestId('lottie-export-result')).toBeVisible({ timeout: 60_000 });
	await page.screenshot({ path: join(OUT, '5-lottie-export.png') });
	const download = page.waitForEvent('download');
	await dlg.getByTestId('lottie-export-download').click();
	const file = join(OUT, 'export.json');
	await (await download).saveAs(file);
	const json = JSON.parse(readFileSync(file, 'utf8'));
	expect(json.v).toBe('5.12.0');
	const types = (json.layers as { ty: number }[]).map((l) => l.ty);
	expect(types).toContain(5);
	expect(types).toContain(0);
	await dlg.getByRole('button', { name: 'Done' }).click();
});
