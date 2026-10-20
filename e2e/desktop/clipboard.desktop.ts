// Run with `pnpm e2e:desktop-clipboard` (e2e/desktop-clipboard.mjs builds and starts a headless X server).
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, chromium, expect, type Page, test } from '@playwright/test';
import {
	clipBox,
	expectTransaction,
	FIXTURES,
	focusTimeline,
	playheadFrame,
	query,
	ROOT,
} from '../support.ts';

test.describe.configure({ mode: 'serial' });

const DESKTOP = join(ROOT, 'apps/desktop');
const electron = createRequire(join(DESKTOP, 'package.json'))('electron') as string;

type App = { proc: ChildProcess; browser: Browser; page: Page };
const apps: App[] = [];
const temps: string[] = [];
const helpers: ChildProcess[] = [];
let A: App;
let B: App;

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const s = createServer();
		s.once('error', reject);
		s.listen(0, '127.0.0.1', () => {
			const { port } = s.address() as { port: number };
			s.close(() => resolve(port));
		});
	});
}

function collect(proc: ChildProcess): string[] {
	const out: string[] = [];
	proc.stdout?.on('data', (d) => out.push(String(d)));
	proc.stderr?.on('data', (d) => out.push(String(d)));
	return out;
}

async function waitForLine(
	out: string[],
	proc: ChildProcess,
	re: RegExp,
	ms: number,
): Promise<RegExpExecArray> {
	const t0 = Date.now();
	for (;;) {
		const m = re.exec(out.join(''));
		if (m) return m;
		if (proc.exitCode !== null) throw new Error(`exited ${proc.exitCode}: ${out.join('').slice(-2000)}`);
		if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${re}: ${out.join('').slice(-2000)}`);
		await new Promise((r) => setTimeout(r, 200));
	}
}

/** Launches one packaged-like desktop app (it forks its own engine) and attaches to its window over CDP. */
async function launch(name: string): Promise<App> {
	const appdir = mkdtempSync(join(tmpdir(), `jasper-desk-${name}-`));
	const userData = mkdtempSync(join(tmpdir(), `jasper-desk-profile-${name}-`));
	temps.push(appdir, userData);
	const cdp = await freePort();
	const proc = spawn(electron, [DESKTOP, `--user-data-dir=${userData}`, `--remote-debugging-port=${cdp}`], {
		cwd: DESKTOP,
		env: {
			...process.env,
			ELECTRON_DISABLE_SANDBOX: '1',
			JASPER_DESKTOP_MODE: 'packaged-like',
			JASPER_APPDIR: appdir,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const out = collect(proc);
	const origin = (
		await waitForLine(out, proc, /\[desktop\] loaded (http:\/\/127\.0\.0\.1:\d+)\//, 120_000)
	)[1]!;
	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdp}`);
	let page: Page | undefined;
	for (let i = 0; i < 100 && !page; i++) {
		page = browser
			.contexts()[0]
			?.pages()
			.find((p) => p.url().startsWith(origin));
		if (!page) await new Promise((r) => setTimeout(r, 200));
	}
	if (!page) throw new Error(`no window on ${origin}`);
	const app: App = { proc, browser, page };
	apps.push(app);
	return app;
}

async function newProject(page: Page, name: string): Promise<void> {
	await expect(page.getByTestId('home')).toBeVisible({ timeout: 60_000 });
	await page.getByTestId('home-new').click();
	await page.getByTestId('new-project-name').fill(name);
	await page.getByTestId('new-project-create').click();
	await expect(page.getByTestId('editor-shell')).toBeVisible();
	await expect(page.getByTestId('timeline-track-area')).toBeVisible();
	await expect.poll(() => page.evaluate(() => !!window.jasper)).toBe(true);
}

type DocClip = { id: string; kind: string; start: number; mediaId?: string; content?: { text: string } };
async function docClips(page: Page): Promise<DocClip[]> {
	const seqId = (await query<{ sequenceId: string }>(page, 'sequence.summary')).sequenceId;
	const s = await query<{ clips: Record<string, DocClip> }>(page, 'doc.get', { path: ['sequences', seqId] });
	return Object.values(s.clips);
}

type Media = { id: string; locators: { type: string; path?: string }[] };
async function mediaAt(page: Page, path: string): Promise<Media | undefined> {
	const media = await query<Record<string, Media>>(page, 'doc.get', { path: ['media'] });
	return Object.values(media).find((m) => m.locators.some((l) => l.type === 'path' && l.path === path));
}

/** The custom format as the desktop bridge reads it from the OS clipboard (null when absent). */
const bridgeRead = (page: Page) =>
	page.evaluate(() =>
		(
			window as unknown as { jasperDesktop: { clipboard: { read(): Promise<string | null> } } }
		).jasperDesktop.clipboard.read(),
	);

/** Playhead to the sequence end (where nothing is overwritten) with the Timeline focused; returns the frame. */
async function atEnd(page: Page): Promise<number> {
	await query(page, 'playhead.set', { frame: 1_000_000 });
	await focusTimeline(page);
	return playheadFrame(page);
}

async function editPaste(page: Page): Promise<void> {
	await page.getByTestId('title-bar').getByRole('menubar').getByRole('menuitem', { name: 'Edit' }).click();
	await page
		.getByRole('menuitem', { name: /^Paste(\s|$)/ })
		.first()
		.click();
}

/** Runs the helper ("another app"), which owns the OS clipboard until it is stopped. */
async function external(kind: 'text' | 'image' | 'files', data: string): Promise<() => void> {
	const proc = spawn(electron, [join(ROOT, 'e2e/desktop/clipboard-helper.cjs')], {
		env: {
			...process.env,
			ELECTRON_DISABLE_SANDBOX: '1',
			JASPER_HELPER_KIND: kind,
			JASPER_HELPER_DATA: data,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	helpers.push(proc);
	await waitForLine(collect(proc), proc, /\[helper\] ready/, 30_000);
	return () => proc.kill('SIGTERM');
}

test.beforeAll(async () => {
	test.setTimeout(300_000);
	[A, B] = await Promise.all([launch('a'), launch('b')]);
	await Promise.all([newProject(A.page, 'Desktop A'), newProject(B.page, 'Desktop B')]);
});

test.afterEach(async () => {
	if (B?.page && !B.page.isClosed())
		await test.info().attach('desktop-document', {
			body: JSON.stringify(await query(B.page, 'doc.get'), null, 2),
			contentType: 'application/json',
		});
});

test.afterAll(async () => {
	for (const h of helpers) h.kill('SIGTERM');
	const stopped = apps.map(
		(a) =>
			new Promise<void>((resolve) => {
				if (a.proc.exitCode !== null || a.proc.signalCode !== null) resolve();
				else a.proc.once('close', () => resolve());
			}),
	);
	for (const a of apps) {
		await a.browser.close().catch(() => undefined);
		a.proc.kill('SIGTERM');
	}
	await Promise.race([Promise.all(stopped), new Promise((r) => setTimeout(r, 1500))]);
	for (const a of apps) if (a.proc.exitCode === null && a.proc.signalCode === null) a.proc.kill('SIGKILL');
	await Promise.all(stopped);
	for (const d of temps) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('copy in app A, paste in app B through application/x-jasper-clipboard (CLB-002)', async () => {
	const r = await A.page.evaluate(() =>
		window.jasper!.transact({
			label: 'Setup',
			commands: [
				{
					type: 'clip.addText',
					at: 0,
					duration: 60,
					track: 'V1',
					content: { text: 'Desktop copy' },
					ref: '$t',
				},
			],
		}),
	);
	expectTransaction(r);
	const id = r.refs.$t!;
	await expect
		.poll(async () => {
			const box = await clipBox(A.page, id);
			await A.page.mouse.click(box.x + Math.min(20, box.width / 2), box.y + box.height / 2);
			return (await query<{ selection: { timeline: { clips: string[] } } }>(A.page, 'selection.get'))
				.selection.timeline.clips;
		})
		.toEqual([id]);
	await A.page.keyboard.press('Control+KeyC');
	await expect.poll(() => bridgeRead(B.page), { timeout: 15_000 }).toContain('"format":"jasper-clipboard"');
	expect(await bridgeRead(B.page)).toContain('Desktop copy');
	// Edit ▸ Paste in B goes through the bridge (no paste event, no web clipboard permission involved).
	let at = await atEnd(B.page);
	await editPaste(B.page);
	await expect.poll(async () => (await docClips(B.page)).length).toBe(1);
	const pasted = (await docClips(B.page))[0]!;
	expect([pasted.kind, pasted.start, pasted.content?.text]).toEqual(['text', at, 'Desktop copy']);
	// Ctrl+V in B goes through the paste event (the HTML form of the same payload).
	at = await atEnd(B.page);
	await B.page.keyboard.press('Control+KeyV');
	await expect
		.poll(async () => (await docClips(B.page)).find((c) => c.start === at)?.content?.text)
		.toBe('Desktop copy');
	await B.page.screenshot({ path: 'test-results/e2e-desktop-clipboard.png' });
});

test('external text from another app: Ctrl+V adds a text clip (CLB-010)', async () => {
	const stop = await external('text', 'Desktop external text');
	try {
		const at = await atEnd(B.page);
		await B.page.keyboard.press('Control+KeyV');
		await expect
			.poll(async () => (await docClips(B.page)).find((c) => c.start === at)?.content?.text)
			.toBe('Desktop external text');
	} finally {
		stop();
	}
});

test('external image data: Ctrl+V and Edit ▸ Paste import a new still at the playhead (CLB-010)', async () => {
	// Two different images: the same bytes twice would ask "use existing / import again" (S04:IN-007).
	for (const [png, how] of [
		['still.png', 'keys'],
		['chart.png', 'menu'],
	] as const) {
		const existingMedia = await query<Record<string, Media>>(B.page, 'doc.get', { path: ['media'] });
		const stop = await external('image', join(FIXTURES, png));
		try {
			const at = await atEnd(B.page);
			if (how === 'menu') await editPaste(B.page);
			else await B.page.keyboard.press('Control+KeyV');
			await expect
				.poll(async () => (await docClips(B.page)).find((c) => c.start === at)?.kind, { timeout: 60_000 })
				.toBe('still');
			const clip = (await docClips(B.page)).find((c) => c.start === at)!;
			const media = await query<Record<string, Media>>(B.page, 'doc.get', { path: ['media'] });
			expect(clip.mediaId).toBeDefined();
			expect(media[clip.mediaId!]).toBeDefined();
			expect(existingMedia[clip.mediaId!]).toBeUndefined();
		} finally {
			stop();
		}
	}
});

test('files copied in a file manager: Edit ▸ Paste and Ctrl+V register them in place and place them (CLB-010)', async () => {
	for (const [file, how] of [
		[join(FIXTURES, 'tone.wav'), 'menu'],
		[join(FIXTURES, 'clip-b.mp4'), 'keys'],
	] as const) {
		const stop = await external('files', file);
		try {
			const at = await atEnd(B.page);
			expect(
				await B.page.evaluate(() =>
					(
						window as unknown as { jasperDesktop: { clipboard: { readFiles(): Promise<string[]> } } }
					).jasperDesktop.clipboard.readFiles(),
				),
			).toEqual([file]);
			if (how === 'menu') await editPaste(B.page);
			else await B.page.keyboard.press('Control+KeyV');
			await expect.poll(async () => !!(await mediaAt(B.page, file)), { timeout: 60_000 }).toBe(true);
			const mediaId = (await mediaAt(B.page, file))!.id;
			await expect
				.poll(async () => (await docClips(B.page)).some((c) => c.start === at && c.mediaId === mediaId))
				.toBe(true);
		} finally {
			stop();
		}
	}
});
