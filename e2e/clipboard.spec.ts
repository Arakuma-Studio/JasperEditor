import { expect, test } from '@playwright/test';
import type { MediaAsset, ProjectDocument } from '../packages/project/src/index.ts';
import {
	clipElement,
	clips,
	createProject,
	enableAgentBridge,
	expectTransaction,
	focusTimeline,
	importFiles,
	query,
	sequenceSummary,
	transact,
} from './support.ts';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('cross-project paste in another tab through the system clipboard resolves linked media by fingerprint', async ({
	page,
}, testInfo) => {
	await enableAgentBridge(page);
	await createProject(page, 'E2E Clipboard A');
	await importFiles(page, ['clip-a.mp4']);
	const media = await query<Record<string, MediaAsset>>(page, 'doc.get', { path: ['media'] });
	const source = Object.values(media).find((m) => m.originalName === 'clip-a.mp4')!;
	const placed = await transact(page, [
		{
			type: 'clip.place',
			source: { mediaId: source.id },
			at: 0,
			tracks: { video: 'V1', audio: 'A1' },
			sourceRange: { in: { seconds: 0 }, out: { seconds: 2 } },
			matchSequence: 'keep',
		},
	]);
	expectTransaction(placed);
	const original = (await clips(page, ['V1']))[0]!;
	await clipElement(page, original.id).click();
	await page.keyboard.press('Control+KeyC');

	const other = await page.context().newPage();
	await enableAgentBridge(other);
	await createProject(other, 'E2E Clipboard B');
	await focusTimeline(other);
	await other.keyboard.press('Control+KeyV');
	await expect.poll(async () => (await clips(other)).length).toBe(2);
	const rows = await clips(other);
	expect(rows.map((r) => r.kind).sort()).toEqual(['audio', 'video']);
	const video = rows.find((r) => r.kind === 'video')!;
	const audio = rows.find((r) => r.kind === 'audio')!;
	expect(video.linked).toContain(audio.id);
	const doc = await query<ProjectDocument>(other, 'doc.get');
	const seqId = (await sequenceSummary(other)).sequenceId;
	const pasted = doc.sequences[seqId]!.clips[video.id]!;
	expect(pasted.kind).toBe('video');
	if (pasted.kind !== 'video') throw new Error('Expected pasted video');
	expect(doc.media[pasted.mediaId]!.fingerprint).toBe(source.fingerprint);
	expect(pasted.mediaId).not.toBe(source.id);
	await testInfo.attach('destination-project', {
		body: JSON.stringify(doc, null, 2),
		contentType: 'application/json',
	});
	await testInfo.attach('destination-editor', { body: await other.screenshot(), contentType: 'image/png' });
});

test('Edit Paste imports an image from the browser clipboard and places it at the playhead', async ({
	page,
}, testInfo) => {
	await enableAgentBridge(page);
	await createProject(page, 'E2E Image Clipboard');
	await page.evaluate(async () => {
		const canvas = document.createElement('canvas');
		canvas.width = 64;
		canvas.height = 48;
		const g = canvas.getContext('2d')!;
		g.fillStyle = '#3080ff';
		g.fillRect(0, 0, 64, 48);
		const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
		await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
	});
	await focusTimeline(page);
	await page.getByTestId('title-bar').getByRole('menubar').getByRole('menuitem', { name: 'Edit' }).click();
	await page
		.getByRole('menuitem', { name: /^Paste(\s|$)/ })
		.first()
		.click();
	await page
		.getByRole('dialog', { name: 'Clip Mismatch Warning' })
		.getByRole('button', { name: 'Keep existing settings' })
		.click();
	await expect.poll(async () => (await clips(page)).length, { timeout: 60_000 }).toBe(1);
	const [clip] = await clips(page);
	expect(clip).toMatchObject({ kind: 'still', start: 0 });
	const doc = await query<ProjectDocument>(page, 'doc.get');
	const image = Object.values(doc.media).find((m) => m.kind === 'image')!;
	expect(image.probe.streams).toEqual(
		expect.arrayContaining([expect.objectContaining({ width: 64, height: 48 })]),
	);
	const seqId = (await sequenceSummary(page)).sequenceId;
	expect(doc.sequences[seqId]!.clips[clip!.id]).toMatchObject({ mediaId: image.id });
	await testInfo.attach('pasted-project', {
		body: JSON.stringify(doc, null, 2),
		contentType: 'application/json',
	});
	await testInfo.attach('pasted-image-editor', { body: await page.screenshot(), contentType: 'image/png' });
});
