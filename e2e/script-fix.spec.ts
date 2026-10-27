// Fix Transcript end to end in the editor (spec 17 SC-104) with a REAL speech model: the public-domain LJ fixture
// (fixtures/speech/lj-composite.flac) on A1; the engine transcribes it with whisper-tiny.en (provisioned by
// scripts/e2e-prepare.mjs from the pinned, sha256-verified catalogue — a missing model FAILS this spec); the sequence
// gets that transcript with three words corrupted by typical recognition confusions (`transcript.create`, like
// scripts/fixtures/cleanup.mjs), and styled subtitles (Pixel Pop) are made from it. Then through the UI: Text ▸
// Transcript ▸ Script… attaches the true text; Fix Transcript… dry-runs and Runs; the Review panel lists the fixes;
// Accept all → Apply: ONE History entry, the transcript and the styled subtitle are fixed in place (same clip, style
// kept), the patch report is shown; one undo restores both.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type EngineJob, EngineJobSchema, type TranscriptionResult } from '@jasper/api';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	createProject,
	enableAgentBridge,
	expectTransaction,
	focusTimeline,
	query,
	ROOT,
	transact,
	waitForJob,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const OUT = join(ROOT, 'test-results', 'e2e-script-fix');
mkdirSync(OUT, { recursive: true });
const FIXTURE = join(ROOT, 'fixtures', 'speech', 'lj-composite.flac');
const MODEL = 'whisper-tiny.en';
/** Recognition confusions of fixture words (the engine e2e's list): the script says the first, the transcript the second. */
const CONFUSIONS: Array<[string, string]> = [
	['block', 'black'],
	['wall', 'war'],
	['carton', 'cartoon'],
];

type Word = { text: string; start: number; end: number; confidence: number | null };
type TextClipRow = {
	id: string;
	kind: string;
	trackId: string;
	content: { text: string; style?: unknown };
	effects?: unknown;
	caption?: { groupId: string };
};

let page: Page;

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	if (page && !page.isClosed()) await page.screenshot({ path: join(OUT, 'final.png') });
	await page?.close();
});

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9']/g, '');
const swap = (text: string, to: string) =>
	text.replace(/[A-Za-z']+/, (m) => (m[0] === m[0]!.toUpperCase() ? to[0]!.toUpperCase() + to.slice(1) : to));

async function transcriptWords(transcriptId: string): Promise<string[]> {
	const t = await query<{ words: Word[] }>(page, 'doc.get', { path: ['transcripts', transcriptId] });
	return t.words.map((w) => w.text);
}

async function subtitleClips(): Promise<TextClipRow[]> {
	const seq = await query<{ sequenceId: string }>(page, 'sequence.summary');
	const clips = await query<Record<string, TextClipRow>>(page, 'doc.get', {
		path: ['sequences', seq.sequenceId, 'clips'],
	});
	return Object.values(clips).filter((c) => c.kind === 'text' && !!c.caption);
}

test('Script… → Fix Transcript → Review → Apply fixes the transcript and a styled subtitle in place; one undo', async () => {
	test.setTimeout(600_000);
	const projectId = await createProject(page, 'E2E Fix Transcript');

	// the real model must be there (provisioned by `pnpm e2e`): fail, never skip
	const models = (await (await page.request.get('/api/speech/models')).json()) as {
		models: { id: string; installed: boolean }[];
	};
	expect(
		models.models.find((m) => m.id === MODEL)?.installed,
		`${MODEL} is not installed: run \`pnpm e2e\` (scripts/e2e-prepare.mjs provisions it)`,
	).toBe(true);

	// import the fixture and place it on A1
	await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Control+KeyI');
	await (await chooser).setFiles([FIXTURE]);
	await expect(page.getByTestId('project-row').filter({ hasText: 'lj-composite.flac' })).toBeVisible({
		timeout: 60_000,
	});
	const items = await query<Record<string, { id: string; kind: string; mediaId?: string; name?: string }>>(
		page,
		'doc.get',
		{ path: ['items'] },
	);
	const item = Object.values(items).find((i) => i.kind === 'media' && i.mediaId)!;
	const mediaId = item.mediaId!;
	const asset = await query<{ locators: { type: string; key?: string }[] }>(page, 'doc.get', {
		path: ['media', mediaId],
	});
	const key = asset.locators.find((l) => l.type === 'engine-store')!.key!;
	expectTransaction(
		await transact(page, [{ type: 'clip.place', source: { projectItemId: item.id }, at: 0 }]),
	);

	// the true words: the engine transcribes the fixture with the real model
	const started = await page.request.post(`/api/media/${encodeURIComponent(key)}/transcribe`, {
		data: { model: MODEL, language: 'en', projectId },
	});
	expect(started.ok(), await started.text()).toBe(true);
	let job: EngineJob = EngineJobSchema.parse(await started.json());
	job = await waitForJob(page.request, job.id, 300_000);
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	const truth = (job.result as TranscriptionResult).words;
	expect(truth.length).toBeGreaterThan(100);

	// the transcript with three confusions, attached like a recogniser's
	const words: Word[] = truth.map((w) => ({
		text: w.text,
		start: w.start,
		end: w.end,
		confidence: w.confidence,
	}));
	const corrupted = new Map<number, [string, string]>();
	for (const pair of CONFUSIONS) {
		const i = words.findIndex((w) => norm(w.text) === pair[0]);
		expect(i, `fixture word ${pair[0]}`).toBeGreaterThanOrEqual(0);
		corrupted.set(i, pair);
		words[i] = { ...words[i]!, text: swap(words[i]!.text, pair[1]) };
	}
	const created = await transact(page, [
		{ type: 'transcript.create', mediaId, language: 'en', origin: 'whisper-local', words } as never,
	]);
	expectTransaction(created);
	const transcriptId = (created.results[0] as { transcriptId: string }).transcriptId;
	// styled subtitles made from it (spec 13 text clips, Pixel Pop)
	expectTransaction(
		await transact(page, [
			{
				type: 'captions.generate',
				template: 'builtin:pixel-pop',
				cutAware: false,
				rules: { maxWords: 6 },
			} as never,
		]),
	);
	const subs0 = await subtitleClips();
	const styled = subs0.find((c) => /\bblack\b/i.test(c.content.text))!;
	expect(styled, 'a subtitle shows the corrupted word').toBeTruthy();

	// Text ▸ Transcript ▸ Script…: paste the true text, attach
	await focusTimeline(page);
	const menubar = page.getByTestId('title-bar').getByRole('menubar');
	await menubar.getByRole('menuitem', { name: 'Sequence', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Captions', exact: true }).hover();
	await page.getByRole('menuitem', { name: 'Transcript', exact: true }).click();
	await page.getByTestId('text.transcript.script').click();
	const script = truth
		.map((w) => w.text)
		.join(' ')
		.replace(/([.!?]) /g, '$1\n');
	await page.getByTestId('text.cleanup.script.text').fill(script);
	await expect(page.getByTestId('text.cleanup.script.summary')).toContainText('words read');
	await page.getByTestId('text.cleanup.script.attach').click();
	await expect.poll(async () => (await appliedLabels(page)).at(-1)).toBe('Attach Script');

	// Fix Transcript…: the dry run, then Run with progress; the proposal opens in Review
	await page.getByTestId('text.transcript.fix').click();
	const dialog = page.getByTestId('fix-transcript-dialog');
	await expect(dialog.getByTestId('fix-dry-summary')).toBeVisible({ timeout: 120_000 });
	await expect(dialog.getByTestId('fix-dry-candidates')).toContainText('possible fixes');
	await test.info().attach('dialog', { body: await dialog.screenshot(), contentType: 'image/png' });
	await dialog.getByRole('button', { name: 'Fix Transcript', exact: true }).click();
	await expect(dialog).toBeHidden({ timeout: 300_000 });
	const review = page.getByTestId('review-panel');
	await expect(review.locator('[data-review-row]').first()).toBeVisible({ timeout: 60_000 });
	for (const [, [right, wrong]] of corrupted) {
		const row = review
			.locator('[data-review-row]')
			.filter({ has: page.locator('[data-fix-after]', { hasText: right }) });
		await expect(row.first().locator('[data-fix-before]')).toHaveText(new RegExp(wrong, 'i'));
	}
	await test.info().attach('review', { body: await review.screenshot(), contentType: 'image/png' });

	// Accept all → Apply: one History entry, the report
	const labels0 = await appliedLabels(page);
	await review.getByTestId('review-accept-all').click();
	await review.getByTestId('review-apply').click();
	await expect
		.poll(async () => (await appliedLabels(page)).length, { timeout: 60_000 })
		.toBe(labels0.length + 1);
	expect((await appliedLabels(page)).at(-1)).toMatch(/^Fix transcript: \d+ fix(es)?$/);
	await expect(review.getByTestId('review-fix-report')).toContainText('fixes applied');
	const fixed = await transcriptWords(transcriptId);
	for (const [i, [right]] of corrupted) expect(norm(fixed[i]!)).toBe(right);
	const subs1 = await subtitleClips();
	const after = subs1.find((c) => c.id === styled.id)!;
	expect(after, 'the subtitle is patched in place (same clip)').toBeTruthy();
	expect(after.content.text).toMatch(/\bblock\b/i);
	expect(after.content.text).not.toMatch(/\bblack\b/i);
	expect(after.content.style).toEqual(styled.content.style);
	expect(after.effects).toEqual(styled.effects);
	expect(subs1.map((c) => c.id).sort()).toEqual(subs0.map((c) => c.id).sort());
	await test.info().attach('applied', { body: await page.screenshot(), contentType: 'image/png' });

	// one undo restores the transcript and the subtitle
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await appliedLabels(page)).length).toBe(labels0.length);
	const undone = await transcriptWords(transcriptId);
	for (const [i, [, wrong]] of corrupted) expect(norm(undone[i]!)).toBe(wrong);
	const restored = (await subtitleClips()).find((c) => c.id === styled.id)!;
	expect(restored.content.text).toBe(styled.content.text);
});
