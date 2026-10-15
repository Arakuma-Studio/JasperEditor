import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	clips,
	createProject,
	enableAgentBridge,
	ffprobe,
	focusTimeline,
	importFiles,
	playheadFrame,
	query,
	ROOT,
	regionLuma,
	transact,
	waitForJob,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const OUT = join(ROOT, 'test-results', 'e2e-captions');
mkdirSync(OUT, { recursive: true });

let page: Page;

type Doc = {
	items: Record<string, { id: string; kind: string; name: string; mediaId?: string }>;
	transcripts: Record<string, { id: string; mediaId: string | null; words: { text: string }[] }>;
	sequences: Record<
		string,
		{
			inPoint: number | null;
			outPoint: number | null;
			captionTracks: { id: string; name: string | null; language?: string }[];
			clips: Record<
				string,
				{ id: string; kind: string; trackId: string; start: number; duration: number; transcriptId?: string }
			>;
		}
	>;
};
const doc = () => query<Doc>(page, 'doc.get');
const seqOf = async () => Object.values((await doc()).sequences)[0]!;
const captionClips = async () =>
	Object.values((await seqOf()).clips)
		.filter((c) => c.kind === 'captions')
		.sort((a, b) => a.start - b.start);
const textOfCaption = async (id: string) => {
	const d = await doc();
	const c = Object.values(d.sequences)[0]!.clips[id]!;
	return d.transcripts[c.transcriptId!]!.words.map((w) => w.text).join(' ');
};

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	if (page && !page.isClosed()) await page.screenshot({ path: join(OUT, 'final.png') });
	await page?.close();
});

test('File ▸ Import puts an SRT on a caption track; the Timeline shows the captions', async () => {
	await createProject(page, 'E2E Captions');
	await importFiles(page, ['clip-a.mp4']);
	const item = Object.values((await doc()).items).find((i) => i.kind === 'media')!;
	const r = await transact(page, [
		{
			type: 'clip.place',
			source: { projectItemId: item.id },
			at: 0,
			sourceRange: { in: { seconds: 0 }, out: { seconds: 6 } },
		},
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	const srt = join(OUT, 'english.srt');
	writeFileSync(
		srt,
		'1\r\n00:00:00,500 --> 00:00:02,000\r\nHello from JasperEditor\r\n\r\n2\r\n00:00:02,500 --> 00:00:04,000\r\nSecond caption\r\n',
	);
	await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Control+KeyI');
	await (await chooser).setFiles(srt);
	await expect.poll(async () => (await captionClips()).length).toBe(2);
	const seq = await seqOf();
	expect(seq.captionTracks[0]!.name).toBe('english');
	await expect(page.getByTestId('timeline-caption-area')).toBeVisible();
	const [c1] = await captionClips();
	await expect(page.getByTestId(`timeline.caption.${c1!.id}`)).toContainText('Hello from JasperEditor');
	// at 29.97 fps: 0.5 s → frame 15, 2 s → frame 60
	expect([c1!.start, c1!.start + c1!.duration]).toEqual([15, 60]);
});

test('Text ▸ Captions: edit text, search and replace, add a caption at the playhead, style the track', async () => {
	const [c1, c2] = await captionClips();
	await page.getByTestId(`timeline.caption.${c1!.id}`).dblclick();
	await expect(page.getByTestId('text-captions')).toBeVisible();
	const field = page.getByTestId(`text.captions.${c1!.id}.text`);
	await expect(field).toHaveValue('Hello from JasperEditor');
	await field.fill('Hello from the captions panel');
	await field.press('Control+Enter');
	await expect.poll(() => textOfCaption(c1!.id)).toBe('Hello from the captions panel');
	await page.getByTestId('text.captions.search').fill('Second');
	await page.getByTestId('text.captions.replace').fill('Last');
	await page.getByTestId('text.captions.replaceAll').click();
	await expect.poll(() => textOfCaption(c2!.id)).toBe('Last caption');
	await page.getByTestId('text.captions.search').fill('');
	await focusTimeline(page);
	await page.keyboard.press('End');
	const end = await playheadFrame(page);
	expect(end).toBeGreaterThan(120);
	await page.keyboard.press('Control+Alt+KeyC');
	await expect.poll(async () => (await captionClips()).length).toBe(3);
	const added = (await captionClips())[2]!;
	expect(added.start).toBe(end);
	const size = page.getByTestId('text.captions.style.size');
	await size.fill('64');
	await size.blur();
	await expect
		.poll(async () => (await seqOf()).captionTracks[0] as { styleDefaults?: { sizePx: number } })
		.toMatchObject({ styleDefaults: { sizePx: 64 } });
	// undo the extra caption (keeps the export range at the clip)
	await page.getByTestId(`text.captions.${added.id}.row`).click();
	await page.getByTestId('text.captions.delete').click();
	await expect.poll(async () => (await captionClips()).length).toBe(2);
});

test('the Program monitor draws the caption under the playhead', async () => {
	await focusTimeline(page);
	await page.keyboard.press('Home');
	for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight');
	await expect(page.locator('[data-caption-page]').first()).toContainText('Hello from the captions panel', {
		timeout: 30_000,
	});
});

test('Text ▸ Transcript: import, seek, search, select → Mark In/Out, Remove Fillers, Create Captions', async () => {
	await page.getByTestId('text.tab.Transcript').click();
	const json = join(OUT, 'clip-a.transcript.json');
	writeFileSync(
		json,
		JSON.stringify({
			language: 'en',
			speakers: { s1: { name: 'Host' } },
			words: [
				['Welcome', 0.3, 0.7],
				['um', 0.8, 1.1],
				['to', 1.2, 1.4],
				['the', 1.4, 1.6],
				['show.', 1.6, 2.0],
				['Rivers', 3.2, 3.7],
				['are', 3.7, 3.9],
				['long.', 3.9, 4.5],
			].map(([text, a, b]) => ({
				text,
				start: Math.round((a as number) * 705_600_000),
				end: Math.round((b as number) * 705_600_000),
				speaker: 's1',
			})),
		}),
	);
	const chooser = page.waitForEvent('filechooser');
	await page.getByTestId('text.transcript.importFile').click();
	await (await chooser).setFiles(json);
	await expect(page.getByTestId('text.transcript.word.0')).toHaveText('Welcome');
	await expect(page.getByTestId('text.transcript.speaker').first()).toHaveText('Host');
	await page.getByTestId('text.transcript.word.5').click();
	await expect.poll(() => playheadFrame(page)).toBe(Math.floor(3.2 * 29.97));
	await page.getByTestId('text.transcript.search').fill('the show');
	await expect(page.getByTestId('text.transcript.matches')).toHaveText('1/1');
	await page.getByTestId('text.transcript.word.0').click();
	await page.getByTestId('text.transcript.word.4').click({ modifiers: ['Shift'] });
	await page.getByTestId('text.transcript.markInOut').click();
	await expect.poll(async () => [(await seqOf()).inPoint, (await seqOf()).outPoint]).toEqual([8, 60]);
	await page.getByTestId('text.transcript.fillers').click();
	await expect(page.getByTestId('text.transcript.fillerCount')).toContainText('1 found');
	await page.getByTestId('text.transcript.fillersApply').click();
	await expect(page.getByTestId('text.transcript.word.1')).toHaveText('to');
	expect((await clips(page, ['V1'])).length).toBe(2);
	await page.getByTestId('text.transcript.createCaptions').click();
	await page.getByTestId('text.transcript.captionsApply').click();
	await expect.poll(async () => (await seqOf()).captionTracks.length).toBe(2);
	await expect(page.getByTestId('text-captions')).toBeVisible();
	const c2Id = (await seqOf()).captionTracks[1]!.id;
	const created = (await captionClips()).filter((c) => c.trackId === c2Id);
	expect(await Promise.all(created.map((c) => textOfCaption(c.id)))).toEqual([
		'Welcome to the show.',
		'Rivers are long.',
	]);
});

test('export: burned-in captions, embedded mov_text streams and an SRT sidecar', async ({ request }) => {
	// a clean sequence for the export: hide the transcript captions track (C2), keep C1 visible
	const seq = await seqOf();
	const c2 = seq.captionTracks[1]!;
	const r = await transact(page, [
		{ type: 'track.update', trackId: c2.id, patch: { visible: false, language: 'en' } },
		{ type: 'track.update', trackId: seq.captionTracks[0]!.id, patch: { language: 'en' } },
		{ type: 'sequence.setInOut', in: null, out: null },
		{ type: 'caption.setActiveTrack', trackId: seq.captionTracks[0]!.id },
		// A fixed background makes the timed pixel difference independent of the moving source video.
		{ type: 'clip.addSolid', at: 0, duration: 180, track: 'V3', color: [0, 0, 0, 1] },
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyM');
	await expect(page.getByTestId('export-mode')).toBeVisible();
	await expect(page.getByTestId('export-captions')).toBeVisible();
	await page.getByTestId('export-captions-embed').check();
	await page.getByTestId('export-captions-sidecar').selectOption('srt');
	await page.getByTestId('export-filename').fill('captions-e2e');
	await expect(page.getByTestId('plan-path')).toContainText(/Hybrid|Remotion/, { timeout: 60_000 });
	const before = new Set(
		((await (await request.get('/api/jobs')).json()).jobs as { id: string }[]).map((j) => j.id),
	);
	await page.getByTestId('export-start').click();
	let jobId = '';
	await expect
		.poll(async () => {
			const jobs = (await (await request.get('/api/jobs')).json()).jobs as { id: string; kind: string }[];
			jobId = jobs.find((j) => j.kind === 'export' && !before.has(j.id))?.id ?? '';
			return jobId;
		})
		.not.toBe('');
	const job = await waitForJob(request, jobId, 400_000);
	expect(job.state, JSON.stringify(job.error ?? null)).toBe('succeeded');
	const row = page.getByTestId('jobs-panel').locator(`[data-testid="job-row"][data-job-id="${jobId}"]`);
	await expect(row.getByTestId('job-download-captions')).toBeVisible({ timeout: 30_000 });
	const dl = page.waitForEvent('download');
	await row.getByTestId('job-download').click();
	const file = join(OUT, 'captions-e2e.mp4');
	await (await dl).saveAs(file);
	const sdl = page.waitForEvent('download');
	await row.getByTestId('job-download-captions').first().click();
	const sidecar = join(OUT, 'captions-e2e.srt');
	await (await sdl).saveAs(sidecar);

	const probe = ffprobe(file) as unknown as {
		streams: {
			codec_type: string;
			codec_name: string;
			tags?: { language?: string };
			disposition?: { default?: number };
		}[];
	};
	const subs = probe.streams.filter((s) => s.codec_type === 'subtitle');
	expect(subs.map((s) => [s.codec_name, s.tags?.language, s.disposition?.default])).toEqual([
		['mov_text', 'eng', 1],
		['mov_text', 'eng', 0],
	]);
	const embedded = execFileSync(
		process.env.JASPER_FFMPEG ?? 'ffmpeg',
		['-v', 'error', '-i', file, '-map', '0:s:0', '-f', 'srt', '-'],
		{
			encoding: 'utf8',
		},
	);
	expect(embedded).toContain('Hello from the captions panel');
	// the filler removal shortened the first caption (a ripple cut through it keeps one caption)
	expect(readFileSync(sidecar, 'utf8')).toMatch(
		/^1\n00:00:00,501 --> 00:00:01,\d{3}\nHello from the captions panel\n/,
	);
	const band = { x: 0.3, y: 0.82, w: 0.4, h: 0.08 };
	const withCaption = regionLuma(file, 1.2, band);
	const without = regionLuma(file, 1.95, band);
	expect(without).toBeLessThan(5);
	expect(withCaption - without).toBeGreaterThan(8);
	execFileSync(process.env.JASPER_FFMPEG ?? 'ffmpeg', [
		'-v',
		'error',
		'-y',
		'-ss',
		'1.2',
		'-i',
		file,
		'-frames:v',
		'1',
		join(OUT, 'burned.png'),
	]);
});

test.afterEach(async () => {
	await test
		.info()
		.attach('captions-document', { body: JSON.stringify(await doc()), contentType: 'application/json' });
});
