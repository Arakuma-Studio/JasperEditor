// spec 13 AS-060 / AS-030: multi-clip styling in the running editor — 100 subtitles selected, a stroke added and its
// width changed in Properties, each one History entry; undo restores all 100 clips.
import { expect, test } from '@playwright/test';
import type { ProjectDocument } from '../packages/project/src/index.ts';
import {
	appliedLabels,
	createProject,
	enableAgentBridge,
	expectTransaction,
	focusTimeline,
	query,
	sequenceSummary,
	transact,
} from './support.ts';

const N = 100;

async function strokeWidths(page: Parameters<typeof query>[0]): Promise<(number | null)[]> {
	const doc = await query<ProjectDocument>(page, 'doc.get');
	const seqId = (await sequenceSummary(page)).sequenceId;
	return Object.values(doc.sequences[seqId]!.clips)
		.filter((c) => c.kind === 'text')
		.map((c) => (c.kind === 'text' ? (c.content.style.strokes[0]?.widthPx ?? null) : null));
}

test('select 100 text clips → add a stroke and set its width in Properties → one undo step each', async ({
	page,
}, testInfo) => {
	test.setTimeout(180_000);
	await enableAgentBridge(page);
	await createProject(page, 'E2E Multi-clip Styling');
	const setup = await transact(
		page,
		Array.from({ length: N }, (_, i) => ({
			type: 'clip.addText' as const,
			at: i * 10,
			duration: 10,
			track: 'V2',
			content: { text: `word ${i}` },
		})),
	);
	expectTransaction(setup);
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyA');
	await expect(page.getByTestId('clip-properties')).toContainText(`${N} clips selected`);

	const before = (await appliedLabels(page)).length;
	await page.getByTestId('text-stroke-add').click();
	await expect.poll(async () => (await strokeWidths(page)).filter((w) => w === 4).length).toBe(N);
	expect((await appliedLabels(page)).at(-1)).toBe(`Add Stroke (${N} clips)`);

	const width = page.getByTestId('prop-text.stroke.0.width');
	await width.click();
	const input = page.getByTestId('prop-text.stroke.0.width-input');
	await input.fill('11.5');
	await input.press('Enter');
	await expect.poll(async () => (await strokeWidths(page)).filter((w) => w === 11.5).length).toBe(N);
	const labels = await appliedLabels(page);
	expect(labels.length).toBe(before + 2);
	expect(labels.at(-1)).toBe(`Stroke 1 Width (${N} clips)`);
	await testInfo.attach('properties', { body: await page.screenshot(), contentType: 'image/png' });

	// One undo step puts all 100 widths back.
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await strokeWidths(page)).filter((w) => w === 4).length).toBe(N);
	expect((await appliedLabels(page)).length).toBe(before + 1);
});
