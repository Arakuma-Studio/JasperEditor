// wp speech through the real UI of the built app (docs/wp-notes/speech.md): import the public-domain speech fixture,
// Sequence ▸ Captions ▸ Transcript, Text ▸ Transcript ▸ Generate Transcript… (model, speaker labels; a model that is
// not on the machine downloads in the dialog after its licence is shown), the Whisper job in the Jobs panel, the
// transcript in the Text panel (one undo step), the Project panel context menu entry and Preferences ▸ Transcription.
//
// The model comes from the speech model cache (`$JASPER_SPEECH_MODELS_DIR`, else `target/speech-models`) when it is
// there (linked into the server's appdir); otherwise — or with SPEECH_E2E_DOWNLOAD=1 — it is downloaded through the
// dialog (154 MB from Hugging Face).
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	createProject,
	enableAgentBridge,
	focusTimeline,
	query,
	ROOT,
	serverInfo,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const OUT = join(ROOT, 'test-results', 'e2e-speech');
mkdirSync(OUT, { recursive: true });
const MODEL = 'whisper-tiny.en';
const CACHE = process.env.JASPER_SPEECH_MODELS_DIR ?? join(ROOT, 'target', 'speech-models');
const FIXTURE = join(ROOT, 'fixtures', 'speech', 'lj-composite.flac');

let page: Page;

type Doc = {
	items: Record<string, { id: string; kind: string; name: string; mediaId?: string }>;
	transcripts: Record<
		string,
		{ id: string; mediaId: string | null; model?: string; words: { text: string; speaker: string | null }[] }
	>;
};
const doc = () => query<Doc>(page, 'doc.get');

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
	const cached = join(CACHE, MODEL, 'install.json');
	if (existsSync(cached) && process.env.SPEECH_E2E_DOWNLOAD !== '1') {
		const dir = join(serverInfo().appdir, 'models', 'speech');
		mkdirSync(dir, { recursive: true });
		if (!existsSync(join(dir, MODEL))) symlinkSync(join(CACHE, MODEL), join(dir, MODEL), 'dir');
	}
});

test.afterAll(async () => {
	if (page && !page.isClosed()) await page.screenshot({ path: join(OUT, 'final.png') });
	await page?.close();
});

const menubar = () => page.getByTestId('title-bar').getByRole('menubar');

async function choose(label: string, option: string) {
	await page.getByRole('combobox', { name: label }).click();
	await page.getByRole('option', { name: option }).click();
}

test('import the speech fixture and place it', async () => {
	await createProject(page, 'E2E Speech');
	await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Control+KeyI');
	await (await chooser).setFiles([FIXTURE]);
	await expect(page.getByTestId('project-row').filter({ hasText: 'lj-composite.flac' })).toBeVisible({
		timeout: 60_000,
	});
	const item = Object.values((await doc()).items).find((i) => i.kind === 'media')!;
	const r = await transact(page, [{ type: 'clip.place', source: { projectItemId: item.id }, at: 0 }]);
	expect(r.ok, JSON.stringify(r.errors)).toBe(true);
});

test('Text ▸ Transcript ▸ Generate Transcript… transcribes with Whisper and shows the words', async () => {
	await menubar().getByRole('menuitem', { name: 'Sequence', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Captions' }).hover();
	await page.getByRole('menuitem', { name: 'Transcript', exact: true }).click();
	await expect(page.getByTestId('text-transcript')).toBeVisible();
	await page.getByTestId('text.transcript.generate').first().click();
	const dialog = page.getByTestId('speech-dialog');
	await expect(dialog).toBeVisible();
	await choose('Model', 'Whisper tiny (English)');
	await choose('Speaker labels', 'Yes, separate speakers');
	if (await page.getByTestId('speech-download').isVisible()) {
		await expect(page.getByTestId(`speech-licence-${MODEL}`)).toContainText('MIT');
		await page.screenshot({ path: join(OUT, 'dialog-download.png') });
		await page.getByTestId('speech-download-button').click();
		await expect(page.getByTestId('speech-download')).toBeHidden({ timeout: 300_000 });
	}
	await page.screenshot({ path: join(OUT, 'dialog.png') });
	await dialog.getByRole('button', { name: 'Transcribe' }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByTestId('text.transcript.words')).toContainText(
		'immediate predecessors of the true printed book',
		{
			timeout: 180_000,
		},
	);
	const d = await doc();
	const t = Object.values(d.transcripts)[0]!;
	expect(t.model).toBe(MODEL);
	expect(t.words.length).toBeGreaterThan(140);
	expect(t.words.every((w) => w.speaker === 'S1')).toBe(true);
	expect((await appliedLabels(page)).at(-1)).toBe('Generate Transcript');
	await page.getByTestId('text-transcript').screenshot({ path: join(OUT, 'transcript.png') });
});

test('undo removes the transcript, redo brings it back', async () => {
	await page.getByTestId('text-transcript').click({ position: { x: 5, y: 5 } });
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => Object.keys((await doc()).transcripts).length).toBe(0);
	await page.keyboard.press('Control+Shift+KeyZ');
	await expect.poll(async () => Object.keys((await doc()).transcripts).length).toBe(1);
});

test('the Project panel menu offers Generate Transcript Again…; Preferences ▸ Transcription lists the models', async () => {
	await page
		.locator('.dv-tab')
		.filter({ hasText: /^Project$/ })
		.first()
		.click();
	await page.getByTestId('project-row').filter({ hasText: 'lj-composite.flac' }).click({ button: 'right' });
	await expect(page.getByRole('menuitem', { name: 'Generate Transcript Again…' })).toBeVisible();
	await page.keyboard.press('Escape');
	await menubar().getByRole('menuitem', { name: 'Edit', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Preferences' }).hover();
	await page.getByRole('menuitem', { name: 'Transcription…' }).click();
	await expect(page.getByTestId('prefs-speech')).toBeVisible();
	await expect(page.getByTestId(`speech-model-${MODEL}-state`)).toHaveText('Downloaded');
	await expect(page.getByTestId('speech-licence-whisper-base')).toContainText('MIT');
	await page.screenshot({ path: join(OUT, 'preferences.png') });
	await page.keyboard.press('Escape');
});

test('Create Captions turns the Whisper transcript into captions the Program monitor draws', async () => {
	await page
		.locator('.dv-tab')
		.filter({ hasText: /^Text$/ })
		.first()
		.click();
	await page.getByTestId('text.tab.Transcript').click();
	await page.getByTestId('text.transcript.createCaptions').click();
	await page.getByTestId('text.transcript.captionsApply').click();
	await expect
		.poll(async () => {
			const d = await query<{ sequences: Record<string, { clips: Record<string, { kind: string }> }> }>(
				page,
				'doc.get',
			);
			return Object.values(Object.values(d.sequences)[0]!.clips).filter((c) => c.kind === 'captions').length;
		})
		.toBeGreaterThan(10);
	await focusTimeline(page);
	await page.keyboard.press('Home');
	for (let i = 0; i < 45; i++) await page.keyboard.press('ArrowRight');
	await expect(page.locator('[data-caption-page]').first()).toBeVisible({ timeout: 30_000 });
	await page.screenshot({ path: join(OUT, 'captions.png') });
});
