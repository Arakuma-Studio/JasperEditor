// Takes in the built app (spec 12 P6-E9; wp-note "Phase 6 → WP-E5"): a user folder holding a typing run (8 key
// presses, each a down- and an up-stroke) is indexed; the Sound Library row says "8 takes", its disclosure lists the
// takes with their own mini waveforms; a take auditions alone and inserts its own copy peak-aligned at the playhead
// (one undo step, provenance naming the recording and the take); the Material pill filters by material. Screenshots
// go to test-results/e2e-sound-takes. `E2E_TAKES_EXTRA` may name a folder of real recordings to add (screenshots).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { appliedLabels, createProject, enableAgentBridge, query, ROOT, waitForJob } from './support.ts';

test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });
test.describe.configure({ mode: 'serial' });

const outDir = join(ROOT, 'test-results', 'e2e-sound-takes');
const SR = 48_000;
const FLICKS = 705_600_000;
let page: Page;

function lcg(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 0x80000000 - 1;
	};
}

/** 16-bit stereo WAV of a typing run: 8 key presses 0.5 s apart (down, up 80 ms later 6 dB weaker), −70 dBFS floor. */
function typingWav(): Buffer {
	const n = Math.round(4.6 * SR);
	const x = new Float32Array(n);
	const r = lcg(3);
	for (let i = 0; i < n; i++) x[i] = 3e-4 * r();
	const click = (at: number, amp: number, tauMs: number, seed: number) => {
		const q = lcg(seed);
		for (let i = 0; i < 0.06 * SR && at + i < n; i++)
			x[at + i] =
				x[at + i]! +
				amp *
					Math.exp(-i / ((tauMs / 1000) * SR)) *
					(0.6 * q() + 0.4 * Math.sin((2 * Math.PI * 3000 * i) / SR));
	};
	for (let k = 0; k < 8; k++) {
		const down = Math.round((0.25 + k * 0.5) * SR);
		click(down, 0.6, 5, 10 + k);
		click(down + Math.round(0.08 * SR), 0.3, 4, 20 + k);
	}
	const data = Buffer.alloc(n * 4);
	for (let i = 0; i < n; i++) {
		const v = Math.round(Math.max(-1, Math.min(1, x[i]!)) * 32767);
		data.writeInt16LE(v, i * 4);
		data.writeInt16LE(v, i * 4 + 2);
	}
	const h = Buffer.alloc(44);
	h.write('RIFF', 0, 'ascii');
	h.writeUInt32LE(36 + data.length, 4);
	h.write('WAVEfmt ', 8, 'ascii');
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(1, 20);
	h.writeUInt16LE(2, 22);
	h.writeUInt32LE(SR, 24);
	h.writeUInt32LE(SR * 4, 28);
	h.writeUInt16LE(4, 32);
	h.writeUInt16LE(16, 34);
	h.write('data', 36, 'ascii');
	h.writeUInt32LE(data.length, 40);
	return Buffer.concat([h, data]);
}

test.beforeAll(async ({ browser }) => {
	mkdirSync(outDir, { recursive: true });
	page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
	await enableAgentBridge(page);
});
test.afterAll(async () => {
	await page?.close();
});

test('a typing run’s takes: listed under it, auditioned and inserted peak-aligned; the Material pill', async ({
	request,
}) => {
	test.setTimeout(900_000);
	const folder = mkdtempSync(join(tmpdir(), 'jasper-e2e-takes-'));
	writeFileSync(join(folder, 'Wooden keyboard typing.wav'), typingWav());
	const current = (await (await request.get('/api/sounds/roots')).json()) as {
		roots: { id: string; path: string }[];
	};
	const extra = process.env.E2E_TAKES_EXTRA
		? [{ path: process.env.E2E_TAKES_EXTRA, label: 'Real', license: 'CC0-1.0' }]
		: [];
	const put = await request.put('/api/sounds/roots', {
		data: {
			roots: [
				...current.roots.map((r) => ({ id: r.id, path: r.path })),
				{ path: folder, label: 'E2E Takes', license: 'CC0-1.0' },
				...extra,
			],
		},
	});
	expect(put.status(), await put.text()).toBe(200);
	const started = (await put.json()) as { job: { id: string } | null };
	if (started.job) expect((await waitForJob(request, started.job.id, 600_000)).state).toBe('succeeded');

	await createProject(page, 'E2E Sound Takes');
	await page.keyboard.press('Alt+Shift+Digit9');
	const panel = page.locator('[data-panel-kind="soundLibrary"][data-instance-id]');
	await expect(panel).toBeVisible({ timeout: 60_000 });
	const list = panel.getByRole('listbox', { name: 'Sounds' });
	await expect(list.getByRole('option').first()).toBeVisible({ timeout: 360_000 });
	await panel.getByTestId('sound-search').fill('typing');
	const rec = list.getByRole('option', { name: /^Wooden keyboard typing/ }).first();
	await expect(rec).toBeVisible({ timeout: 60_000 });
	await expect(rec).toHaveAttribute('aria-label', /8 takes \(→ shows them\)/);
	const recId = (await rec.getAttribute('data-sound-id'))!;
	const toggle = panel.locator(`[data-takes-toggle="${recId}"]`);
	await expect(toggle).toContainText('8 takes');
	await panel.screenshot({ path: join(outDir, 'collapsed.png') });

	// the disclosure: eight take rows with their own mini waveforms
	await rec.click();
	await page.keyboard.press('ArrowRight');
	await expect(panel.locator('[data-take]')).toHaveCount(8, { timeout: 30_000 });
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');
	await expect(panel.locator('[data-take] [data-waveform="ready"]').first()).toBeVisible({ timeout: 60_000 });
	await expect(panel.locator('[data-take="3"]')).toContainText('Take 3');
	await panel.screenshot({ path: join(outDir, 'expanded.png') });

	// a take auditions alone (its own audio route) and inserts peak-aligned at the playhead, one undo step
	await query(page, 'playhead.set', { frame: 45 });
	const historyBefore = await appliedLabels(page);
	const t3 = panel.locator('[data-take="3"]');
	await t3.click();
	await page.keyboard.press('Space');
	await expect(panel.getByTestId('sound-live')).toHaveText(/^Playing /, { timeout: 30_000 });
	await page.keyboard.press('Space');
	expect(await appliedLabels(page)).toEqual(historyBefore);
	await t3.click();
	await page.keyboard.press('Enter');
	type Clip = { start: number; sourceIn: number; mediaId: string };
	type Seq = { clips: Record<string, Clip>; settings: { frameRate: { num: number; den: number } } };
	const seqOf = async () =>
		Object.values(await query<Record<string, Seq>>(page, 'doc.get', { path: ['sequences'] }))[0]!;
	await expect.poll(async () => Object.keys((await seqOf()).clips).length, { timeout: 60_000 }).toBe(1);
	const seq = await seqOf();
	const clip = Object.values(seq.clips)[0]!;
	type Media = {
		originalName: string;
		library?: {
			soundId: string;
			take?: { soundId: string; index: number };
			descriptors?: { peakSec: number };
		};
	};
	const m = (await query<Record<string, Media>>(page, 'doc.get', { path: ['media'] }))[clip.mediaId]!;
	expect(m.library).toMatchObject({ soundId: `${recId}~t3`, take: { soundId: recId, index: 3 } });
	expect(m.originalName).toContain('take 3');
	const F = (FLICKS * seq.settings.frameRate.den) / seq.settings.frameRate.num;
	const peakAt = clip.start * F + m.library!.descriptors!.peakSec * FLICKS - clip.sourceIn;
	expect(Math.abs(peakAt - 45 * F)).toBeLessThanOrEqual(2);
	expect((await appliedLabels(page)).length).toBe(historyBefore.length + 1);
	await page.screenshot({ path: join(outDir, 'inserted.png') });

	// ← back on the recording, ← closes the takes
	await panel.locator('[data-take="2"]').click();
	await page.keyboard.press('ArrowLeft');
	await page.keyboard.press('ArrowLeft');
	await expect(panel.locator('[data-take]')).toHaveCount(0);

	// Material: "Wooden" names wood
	await panel.getByTestId('sound-search').fill('');
	if ((await panel.getByTestId('sound-refine-toggle').getAttribute('aria-expanded')) !== 'true')
		await panel.getByTestId('sound-refine-toggle').click();
	const wood = panel.locator('[data-refine="material:wood"]');
	await expect(wood).toBeVisible({ timeout: 30_000 });
	await wood.click();
	await expect(list.getByRole('option', { name: /^Wooden keyboard typing/ })).toBeVisible({
		timeout: 30_000,
	});
	await panel.screenshot({ path: join(outDir, 'material.png') });
	if (extra.length) {
		await wood.click();
		await panel.getByTestId('sound-search').fill('keyboard typing slow');
		const real = list.getByRole('option').first();
		await expect(real).toBeVisible({ timeout: 60_000 });
		await real.click();
		await page.keyboard.press('ArrowRight');
		await expect(panel.locator('[data-take]').first()).toBeVisible({ timeout: 30_000 });
		await expect(panel.locator('[data-take] [data-waveform="ready"]').first()).toBeVisible({
			timeout: 60_000,
		});
		await panel.screenshot({ path: join(outDir, 'real-recording.png') });
	}
});
