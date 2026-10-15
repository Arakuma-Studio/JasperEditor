import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { createProject, enableAgentBridge, FIXTURES, query, ROOT } from './support.ts';

test.describe.configure({ mode: 'serial' });

const OUT = join(ROOT, 'test-results', 'e2e-imports');
mkdirSync(OUT, { recursive: true });

let page: Page;

type Media = {
	id: string;
	originalName: string;
	kind: string;
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
async function chooseFiles(paths: string[]) {
	await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Control+KeyI');
	await (await chooser).setFiles(paths);
}

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
	await createProject(page, 'E2E Imports');
});

test.afterAll(async () => {
	await page?.close();
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
	await dlg.getByTestId('image-sequence-rate').fill('12');
	await dlg.getByRole('button', { name: 'Import' }).click();
	await expect
		.poll(async () => Object.values((await doc()).media).find((m) => m.imageSequence)?.imageSequence, {
			timeout: 120_000,
		})
		.toMatchObject({ frames: 12, missing: [7] });
});

test.afterEach(async () => {
	await test
		.info()
		.attach('imported-document', { body: JSON.stringify(await doc()), contentType: 'application/json' });
});
