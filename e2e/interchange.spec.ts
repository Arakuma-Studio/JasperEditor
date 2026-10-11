import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { createProject, enableAgentBridge, FIXTURES, importFiles, query, ROOT, transact } from './support.ts';

test.describe.configure({ mode: 'serial' });

const OUT = join(ROOT, 'test-results', 'e2e-interchange');
mkdirSync(OUT, { recursive: true });

let page: Page;

type Doc = {
	items: Record<string, { id: string; kind: string; name: string; mediaId?: string; sequenceId?: string }>;
	media: Record<string, { id: string; originalName: string; fingerprint: string }>;
	sequences: Record<
		string,
		{ clips: Record<string, { id: string; kind: string; start: number; duration: number }> }
	>;
};
const doc = () => query<Doc>(page, 'doc.get');

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	await page?.close();
});

async function fileMenu(entry: RegExp, sub?: RegExp) {
	await page.getByTestId('title-bar').getByRole('menuitem', { name: 'File', exact: true }).click();
	if (sub) {
		await page.getByRole('menuitem', { name: sub }).hover();
		await page.getByRole('menuitem', { name: entry }).click();
	} else await page.getByRole('menuitem', { name: entry }).click();
}

test('File ▸ Export ▸ Final Cut Pro XML: options, job, report and download', async () => {
	await createProject(page, 'E2E Interchange');
	await importFiles(page, ['clip-a.mp4', 'clip-b.mp4']);
	const d = await doc();
	const items = Object.values(d.items).filter((i) => i.kind === 'media');
	const r = await transact(page, [
		{
			type: 'clip.place',
			source: { projectItemId: items[0]!.id },
			at: 0,
			sourceRange: { in: { seconds: 0 }, out: { seconds: 2 } },
		},
		{
			type: 'clip.place',
			source: { projectItemId: items[1]!.id },
			at: 60,
			sourceRange: { in: { seconds: 1 }, out: { seconds: 3 } },
		},
		{ type: 'clip.addText', at: 10, duration: 30, track: 'V2', content: { text: 'Interchange' } },
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	await fileMenu(/^Final Cut Pro XML…/, /^Export$/);
	const dialog = page.getByTestId('interchange-export-dialog');
	await expect(dialog).toBeVisible();
	await expect(page.getByTestId('ix-prerender-plan')).toContainText('text clip');
	await page.screenshot({ path: join(OUT, '1-export-dialog.png') });
	await dialog.getByRole('button', { name: 'Export', exact: true }).click();
	const report = page.getByTestId('interchange-report');
	await expect(report).toBeVisible({ timeout: 150_000 });
	await expect(report).toContainText('1 clip(s) pre-rendered');
	await page.screenshot({ path: join(OUT, '2-export-report.png') });
	const link = report.getByRole('link', { name: /\.xml$/ });
	const download = page.waitForEvent('download');
	await link.click();
	const file = join(OUT, 'export.xml');
	await (await download).saveAs(file);
	const xml = readFileSync(file, 'utf8');
	expect(xml).toContain('<xmeml version="4">');
	expect(xml).toContain('clip-a.mp4');
	expect(xml).toMatch(/Interchange%20clp_[0-9A-Za-z]+\.mov/);
	await report.getByRole('button', { name: 'OK' }).click();
});

test('File ▸ Export ▸ AAF with embedded audio', async () => {
	await fileMenu(/^AAF…/, /^Export$/);
	const dialog = page.getByTestId('interchange-export-dialog');
	await expect(dialog).toBeVisible();
	await dialog.getByRole('combobox', { name: 'Audio' }).click();
	await page.getByRole('option', { name: 'Embed audio' }).click();
	await dialog.getByRole('combobox', { name: 'Pre-render' }).click();
	await page.getByRole('option', { name: 'None (report them)' }).click();
	await dialog.getByRole('button', { name: 'Export', exact: true }).click();
	const report = page.getByTestId('interchange-report');
	await expect(report).toBeVisible({ timeout: 120_000 });
	await expect(page.getByTestId('interchange-report-warnings')).toContainText('text clip');
	await page.screenshot({ path: join(OUT, '3-aaf-report.png') });
	await report.getByRole('button', { name: 'OK' }).click();
});

test('File ▸ Import of an EDL whose media moved, then Link Media by folder', async () => {
	const edl = join(OUT, 'Moved.edl');
	writeFileSync(
		edl,
		[
			'TITLE: Moved Cut',
			'FCM: NON-DROP FRAME',
			'',
			'001  CLIPA    V     C        00:00:00:00 00:00:02:00 00:00:00:00 00:00:02:00',
			'* FROM CLIP NAME: clip-a.mp4',
			'* SOURCE FILE: /nowhere/media/clip-a.mp4',
			'002  CLIPB    V     C        00:00:01:00 00:00:03:00 00:00:02:00 00:00:04:00',
			'* FROM CLIP NAME: clip-b.mp4',
			'* SOURCE FILE: /nowhere/media/clip-b.mp4',
			'',
		].join('\r\n'),
	);
	await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Control+KeyI');
	await (await chooser).setFiles(edl);
	const report = page.getByTestId('interchange-report');
	await expect(report).toBeVisible({ timeout: 60_000 });
	await expect(page.getByTestId('interchange-report-missing')).toContainText('clip-a.mp4');
	await page.screenshot({ path: join(OUT, '4-import-report.png') });
	const pending = async () =>
		Object.values((await doc()).media).filter((m) => m.fingerprint.startsWith('pending:interchange:')).length;
	expect(await pending()).toBe(2);
	await page.getByTestId('interchange-report-link-media').click();
	const dlg = page.getByTestId('link-media-dialog');
	await expect(dlg).toBeVisible();
	await page.getByTestId('link-media-folder').fill(FIXTURES);
	await page.getByTestId('link-media-search').click();
	await expect(dlg.getByRole('button', { name: 'Link 2' })).toBeEnabled({ timeout: 60_000 });
	await page.screenshot({ path: join(OUT, '5-link-media.png') });
	await dlg.getByRole('button', { name: 'Link 2' }).click();
	await expect(dlg).toBeHidden();
	await expect.poll(pending).toBe(0);
	const d = await doc();
	const seqItem = Object.values(d.items).find((i) => i.kind === 'sequence' && i.name === 'Moved Cut')!;
	const clips = Object.values(d.sequences[seqItem.sequenceId!]!.clips).filter((c) => c.kind === 'video');
	// two 2-second events, back to back (at the rate the EDL was read at)
	const sorted = clips.sort((a, b) => a.start - b.start);
	expect(sorted.length).toBe(2);
	expect(sorted[0]!.start).toBe(0);
	expect(sorted[1]!.start).toBe(sorted[0]!.duration);
	expect(sorted[1]!.duration).toBe(sorted[0]!.duration);
	await page.screenshot({ path: join(OUT, '6-linked.png') });
});
