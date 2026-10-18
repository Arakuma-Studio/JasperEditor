// Spec 12 P6-R6 and the final verification walkthrough (wp-note "Final verification B") in the built app, as a user:
// a project with footage (two cuts and a push), a typewriter title, a keyframed logo, a "sfx: boom" marker, music with a
// drop and two dialogue clips with a 1 s hole → Sound Library: search, audition (Space), insert peak-aligned at the
// playhead (Enter) → Sequence ▸ Sound Design ▸ Suggest Cues… → Auto Sound Pass… with a personality and the mix options
// (room glue, stop before heroes, build, web delivery) → Propose → review: accept some, reject one, an alternate, a note
// → Apply (ONE History entry) → one Ctrl+Z → Reopen review → Apply again → Run Sound Check → Fix all safe → acknowledge a
// warning with a reason → Lay Ambience Bed… (the project's street recording) and Fill Room Tone → Essential Sound ▸ Music
// to picture: Land the drop on the hero cue, Clip ▸ Audio Options ▸ End on Bar → Delivery Target… (web) → Export with
// a Markdown credits file → MEASURED with ffmpeg: integrated loudness, true peak, and every peak-aligned sound's peak
// against its cue frame (cross-correlation in the exported audio). Every step leaves a screenshot in
// test-results/e2e-sound-design (looked at for the wp-note); the numbers go to walkthrough.json.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { JobListResponseSchema } from '../packages/api/src/jobs.ts';
import { encodeWav } from '../packages/audio-dsp/src/index.ts';
import { dropMusic } from '../packages/audio-fx/test/music.ts';
import {
	appliedLabels,
	clipBox,
	clipElement,
	createProject,
	enableAgentBridge,
	FIXTURES,
	focusTimeline,
	query,
	ROOT,
	transact,
	waitForJob,
} from './support.ts';

test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });
test.describe.configure({ mode: 'serial' });

const outDir = join(ROOT, 'test-results', 'e2e-sound-design');
const SR = 48_000;
const FLICKS = 705_600_000;
const FFMPEG = process.env.JASPER_FFMPEG ?? 'ffmpeg';
const LONG = 1_500_000;
let page: Page;
let dir = '';
let shot = 0;
const report: Record<string, unknown> = {};

async function snap(name: string) {
	shot++;
	await page.screenshot({
		path: join(outDir, `${String(shot).padStart(2, '0')}-${name}.png`),
		timeout: 60_000,
	});
}

function prng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 2 ** 31 - 1;
	};
}
function pink(seconds: number, seed: number, dbfs: number): Float32Array {
	const r = prng(seed);
	const x = new Float32Array(Math.round(seconds * SR));
	let b0 = 0;
	let b1 = 0;
	let b2 = 0;
	let e = 0;
	for (let i = 0; i < x.length; i++) {
		const w = r();
		b0 = 0.99765 * b0 + w * 0.099046;
		b1 = 0.963 * b1 + w * 0.2965164;
		b2 = 0.57 * b2 + w * 1.0526913;
		x[i] = b0 + b1 + b2 + w * 0.1848;
		e += x[i]! * x[i]!;
	}
	const g = 10 ** (dbfs / 20) / Math.sqrt(e / x.length);
	for (let i = 0; i < x.length; i++) x[i]! *= g;
	return x;
}

/** The first channel as 48 kHz float samples (ffmpeg); `rate` ≠ 1 plays it varispeed like a clip speed. */
function decodeMono(file: string, rate = 1): Float32Array {
	const af = rate === 1 ? 'pan=mono|c0=c0' : `pan=mono|c0=c0,asetrate=48000*${rate},aresample=48000`;
	const raw = execFileSync(
		FFMPEG,
		['-v', 'error', '-i', file, '-map', '0:a:0', '-af', af, '-ar', '48000', '-f', 'f32le', '-'],
		{
			maxBuffer: 1 << 30,
		},
	);
	return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
}

/** The lag of `ref[w0, w1)` in `mix` around `guess` (± `span` samples) with the largest normalised correlation. */
function locate(mix: Float32Array, ref: Float32Array, w0: number, w1: number, guess: number, span: number) {
	let best = { lag: Number.NaN, r: -2 };
	let rr = 0;
	for (let i = w0; i < w1; i++) rr += ref[i]! * ref[i]!;
	for (let lag = guess - span; lag <= guess + span; lag++) {
		let xy = 0;
		let xx = 0;
		for (let i = w0; i < w1; i++) {
			const x = mix[lag + i] ?? 0;
			xy += x * ref[i]!;
			xx += x * x;
		}
		const r = xx > 0 && rr > 0 ? xy / Math.sqrt(xx * rr) : -1;
		if (r > best.r) best = { lag, r };
	}
	return best;
}

function ebur128(file: string): { integrated: number; truePeak: number; lra: number } {
	const r = spawnSync(
		FFMPEG,
		[
			'-nostats',
			'-hide_banner',
			'-i',
			file,
			'-vn',
			'-filter_complex',
			'ebur128=peak=true',
			'-f',
			'null',
			'-',
		],
		{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
	);
	const summary = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
	const i = /I:\s+(-?[\d.]+) LUFS/.exec(summary);
	const l = /LRA:\s+(-?[\d.]+) LU/.exec(summary);
	const p = /True peak:\s+Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(summary);
	if (!i || !p) throw new Error(`ebur128 output not understood: ${summary.slice(0, 500)}`);
	return { integrated: Number(i[1]), truePeak: Number(p[1]), lra: l ? Number(l[1]) : Number.NaN };
}

async function menu(item: string, top = 'Sequence', sub: string | null = 'Sound Design') {
	const menubar = page.getByTestId('title-bar').getByRole('menubar');
	await menubar.getByRole('menuitem', { name: top, exact: true }).click();
	if (sub) await page.getByRole('menuitem', { name: sub }).hover();
	await page.getByRole('menuitem', { name: item, exact: true }).click();
}

async function libraryReady(request: APIRequestContext) {
	await expect
		.poll(
			async () => {
				const r = await request.get('/api/sounds/status');
				if (!r.ok()) return 0;
				const s = (await r.json()) as { sounds: number; indexing: unknown; needsIndex: boolean };
				return s.indexing || s.needsIndex ? 0 : s.sounds;
			},
			{ timeout: 360_000, intervals: [1000] },
		)
		.toBeGreaterThan(20);
}

type Clip = {
	id: string;
	kind: string;
	trackId: string;
	start: number;
	duration: number;
	sourceIn: number;
	mediaId: string;
	speed: { rate: number };
	gainDb?: number;
	essential?: { type?: string };
	remix?: { anchors?: { sourceSeconds: number; frame: number }[] };
	bed?: { purpose: string };
	sfx?: {
		cueId: string | null;
		soundId: string | null;
		role: string;
		placement: { align: string; peakFlicks: number; errorFlicks: number };
	};
};
type Cue = {
	id: string;
	frame: number;
	kind: string;
	weight: string;
	placedClipIds?: string[];
	source: string;
};
type Seq = {
	clips: Record<string, Clip>;
	audioTracks: { id: string; name: string | null }[];
	submixTracks?: { id: string; name: string }[];
	settings: { frameRate: { num: number; den: number } };
	soundDesign?: {
		cues?: Record<string, Cue>;
		settings?: { delivery?: string; style?: Record<string, unknown> };
		mix?: { room?: { busId: string }; cues?: Record<string, { stopBefore?: unknown; build?: unknown }> };
		acknowledged?: Record<string, { code: string; reason: string; by: string }>;
	};
};
async function sequence(): Promise<Seq> {
	return Object.values(await query<Record<string, Seq>>(page, 'doc.get', { path: ['sequences'] }))[0]!;
}
type MediaRow = {
	id: string;
	originalName?: string;
	locators: { type: string; key?: string }[];
	library?: {
		soundId: string;
		title?: string;
		license?: string;
		types?: string[];
		descriptors?: { peakSec: number };
	};
};
async function media(): Promise<Record<string, MediaRow>> {
	return query(page, 'doc.get', { path: ['media'] });
}

const library = () => page.locator('[data-panel-kind="soundLibrary"][data-instance-id]');
const reviewPanel = () => page.locator('[data-panel-kind="review"][data-instance-id]');
const checkPanel = () => page.locator('[data-panel-kind="soundCheck"][data-instance-id]');
async function waitVerdict(previous?: string) {
	await expect(checkPanel().getByTestId('sound-check-verdict')).toBeVisible({ timeout: LONG });
	await expect(checkPanel().getByTestId('sound-check-progress')).toBeHidden({ timeout: LONG });
	if (previous !== undefined)
		await expect
			.poll(async () => (await checkPanel().getByTestId('sound-check-live').textContent()) ?? '', {
				timeout: LONG,
			})
			.not.toBe(previous);
}
async function findings(): Promise<{ id: string; code: string; frame: string; text: string }[]> {
	return checkPanel()
		.getByTestId('sound-check-findings')
		.locator('[role="option"][data-issue-id]')
		.evaluateAll((els) =>
			els.map((e) => ({
				id: e.getAttribute('data-issue-id') ?? '',
				code: e.getAttribute('data-code') ?? '',
				frame: e.getAttribute('data-frame') ?? '',
				text: (e.textContent ?? '').replace(/\s+/g, ' ').slice(0, 240),
			})),
		);
}

test.beforeAll(async ({ browser }) => {
	mkdirSync(outDir, { recursive: true });
	dir = mkdtempSync(join(tmpdir(), 'jasper-e2e-sound-design-'));
	// music: 16 bars of 120 BPM C major, the drop at bar 9 (16 s)
	const m = dropMusic(SR, 120, 16, 9);
	writeFileSync(join(dir, 'music.wav'), encodeWav(m.audio, SR, 's16'));
	// dialogue: a −52 dBFS pink floor under 1.5 kHz syllables (4 Hz) from 0.5–3.5 s and 5.5–8.5 s
	const d = pink(10, 21, -52);
	for (let i = 0; i < d.length; i++) {
		const t = i / SR;
		if (!((t >= 0.5 && t < 3.5) || (t >= 5.5 && t < 8.5))) continue;
		d[i]! += 0.15 * (0.5 - 0.5 * Math.cos(2 * Math.PI * 4 * t)) * Math.sin(2 * Math.PI * 1500 * t);
	}
	writeFileSync(join(dir, 'dialogue.wav'), encodeWav([d, d.slice()], SR, 's16'));
	// a street bed: 6 s of stereo pink noise at −30 dBFS
	writeFileSync(join(dir, 'street.wav'), encodeWav([pink(6, 1, -30), pink(6, 2, -30)], SR, 's16'));
	page = await browser.newPage({ viewport: { width: 1800, height: 1350 } });
	await enableAgentBridge(page);
});
test.afterAll(async () => {
	writeFileSync(join(outDir, 'walkthrough.json'), JSON.stringify(report, null, 2));
	await page?.close();
});

test('user walkthrough: library → Suggest Cues → Auto Sound Pass → review → Sound Check → beds → music fit → delivery → export, measured', async ({
	request,
}) => {
	test.setTimeout(7_200_000);
	const projectId = await createProject(page, 'E2E Sound Design Walkthrough');
	// File ▸ Import: the footage and the three recordings
	await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Control+KeyI');
	const files = [
		join(FIXTURES, 'clip-a.mp4'),
		join(FIXTURES, 'clip-b.mp4'),
		...['music.wav', 'dialogue.wav', 'street.wav'].map((n) => join(dir, n)),
	];
	await (await chooser).setFiles(files);
	for (const n of ['clip-a.mp4', 'clip-b.mp4', 'music.wav', 'dialogue.wav', 'street.wav'])
		await expect(page.getByTestId('project-row').filter({ hasText: n })).toBeVisible({ timeout: 120_000 });
	const items = await query<Record<string, { id: string; name: string }>>(page, 'doc.get', {
		path: ['items'],
	});
	const item = (n: string) => Object.values(items).find((i) => i.name === n)!.id;
	// the edit (the user's cut, built here in one transaction): cuts at 240 and 390 (a push), a typewriter title, a
	// keyframed logo that moves and lands, a "sfx: boom" marker at 20 s, music on A1, dialogue with a hole on A2
	const edit = await transact(page, [
		{
			type: 'clip.place',
			source: { projectItemId: item('clip-a.mp4') },
			sourceRange: { in: { seconds: 0 }, out: { seconds: 8 } },
			at: 0,
			tracks: { video: 'V1' },
			audio: false,
			matchSequence: 'keep',
		},
		{
			type: 'clip.place',
			source: { projectItemId: item('clip-b.mp4') },
			sourceRange: { in: { seconds: 0 }, out: { seconds: 5 } },
			at: 240,
			tracks: { video: 'V1' },
			audio: false,
			matchSequence: 'keep',
		},
		{
			type: 'clip.place',
			source: { projectItemId: item('clip-a.mp4') },
			sourceRange: { in: { seconds: 1 }, out: { seconds: 10 } },
			at: 390,
			tracks: { video: 'V1' },
			audio: false,
			matchSequence: 'keep',
			ref: '$c',
		},
		{
			type: 'transition.add',
			clipId: '$c',
			edge: 'in',
			effectId: 'jasper.push',
			duration: 20,
			alignment: 'center',
			params: { direction: 'westToEast' },
		},
		{
			type: 'clip.addText',
			at: 30,
			duration: 120,
			track: 'V2',
			content: { text: 'SOUND DESIGN' },
			textAnimation: { in: { preset: 'typewriter', durationFrames: 45 } },
		},
		{ type: 'clip.addText', at: 480, duration: 120, track: 'V3', content: { text: 'LOGO' }, ref: '$l' },
		{
			type: 'keyframe.add',
			target: ['clip', '$l', 'transform', 'position'],
			at: { frames: 10 },
			value: [200, 540],
		},
		{
			type: 'keyframe.add',
			target: ['clip', '$l', 'transform', 'position'],
			at: { frames: 22 },
			value: [1010, 540],
		},
		{
			type: 'keyframe.add',
			target: ['clip', '$l', 'transform', 'position'],
			at: { frames: 27 },
			value: [960, 540],
		},
		{ type: 'marker.add', frame: 600, name: 'sfx: boom' },
		{
			type: 'clip.place',
			source: { projectItemId: item('music.wav') },
			sourceRange: { in: { seconds: 0 }, out: { seconds: 22 } },
			at: 0,
			tracks: { audio: 'A1' },
			ref: '$m',
		},
		{ type: 'essentialSound.setType', clipIds: ['$m'], audioType: 'music' },
		{
			type: 'clip.place',
			source: { projectItemId: item('dialogue.wav') },
			sourceRange: { in: { seconds: 0.5 }, out: { seconds: 3.5 } },
			at: 180,
			tracks: { audio: 'A2' },
			ref: '$d1',
		},
		{
			type: 'clip.place',
			source: { projectItemId: item('dialogue.wav') },
			sourceRange: { in: { seconds: 5.5 }, out: { seconds: 8.5 } },
			at: 300,
			tracks: { audio: 'A2' },
			ref: '$d2',
		},
		{ type: 'essentialSound.setType', clipIds: ['$d1', '$d2'], audioType: 'dialogue' },
	] as never);
	expect(edit.ok, JSON.stringify(edit)).toBe(true);
	const musicClipId = (edit as unknown as { refs: Record<string, string> }).refs.$m!;
	await libraryReady(request);
	await page.keyboard.press('Alt+Shift+Digit9');
	await expect(reviewPanel()).toBeVisible({ timeout: 60_000 });
	await focusTimeline(page);
	await page.keyboard.press('Backslash');
	await snap('edit');

	// 1. Sound Library: search, audition (Space: no History entry), insert peak-aligned at the playhead (Enter)
	await page.locator('.dv-tab', { hasText: 'Sound Library' }).first().click();
	await expect(library()).toBeVisible({ timeout: 60_000 });
	const list = library().getByRole('listbox', { name: 'Sounds' });
	await expect(list.getByRole('option').first()).toBeVisible({ timeout: 360_000 });
	await library().getByTestId('sound-search').fill('pop');
	await expect(list.getByRole('option').first()).toHaveAttribute('aria-label', /pop/i, { timeout: 30_000 });
	const first = list.getByRole('option').first();
	const label = (await first.getAttribute('aria-label')) ?? '';
	await query(page, 'playhead.set', { frame: 150 });
	const h0 = await appliedLabels(page);
	await first.click();
	await page.keyboard.press('Space');
	await expect(library().getByTestId('sound-live')).toHaveText(/^Playing /, { timeout: 30_000 });
	await snap('library-audition');
	await page.keyboard.press('Space');
	await expect(library().getByTestId('sound-live')).toHaveText('Audition stopped');
	expect(await appliedLabels(page)).toEqual(h0);
	await first.click();
	await page.keyboard.press('Enter');
	await expect.poll(async () => (await appliedLabels(page)).length, { timeout: 60_000 }).toBe(h0.length + 1);
	expect((await appliedLabels(page)).at(-1)).toMatch(/^Add Sound /);
	let seq = await sequence();
	const F = (FLICKS * seq.settings.frameRate.den) / seq.settings.frameRate.num;
	const fps = seq.settings.frameRate.num / seq.settings.frameRate.den;
	const inserted = Object.values(seq.clips).find((c) => c.sfx && !c.sfx.cueId)!;
	expect(inserted, JSON.stringify(seq.clips)).toBeTruthy();
	const insertedPoint =
		inserted.start * F + (inserted.sfx!.placement.peakFlicks - inserted.sourceIn) / inserted.speed.rate;
	report.libraryInsert = {
		label,
		clip: inserted.id,
		alignedPointErrorFlicks: insertedPoint - 150 * F,
		errorFlicks: inserted.sfx!.placement.errorFlicks,
	};
	expect(Math.abs(insertedPoint - 150 * F)).toBeLessThanOrEqual(2);
	await snap('library-inserted');

	// 2. Suggest Cues…: counts per source, one undo step
	await menu('Suggest Cues…');
	const suggest = page.getByTestId('suggest-cues-dialog');
	await expect(suggest).toBeVisible();
	const sources = await suggest
		.locator('[data-cue-source-count]')
		.evaluateAll((els) =>
			Object.fromEntries(els.map((e) => [e.getAttribute('data-cue-source-count'), e.textContent])),
		);
	report.suggestSources = sources;
	await suggest.screenshot({ path: join(outDir, `${String(++shot).padStart(2, '0')}-suggest-cues.png`) });
	const suggestButton = suggest.getByRole('button', { name: /^Suggest \d+ Cues?$/ });
	const nCues = Number(/(\d+)/.exec((await suggestButton.textContent()) ?? '')![1]);
	expect(nCues).toBeGreaterThan(2);
	await suggestButton.click();
	await expect(suggest).toBeHidden();
	expect((await appliedLabels(page)).at(-1)).toBe(`Suggest Cues (${nCues})`);
	seq = await sequence();
	const cues0 = Object.values(seq.soundDesign?.cues ?? {});
	report.cues = cues0.map((c) => ({ frame: c.frame, kind: c.kind, weight: c.weight, source: c.source }));
	expect(
		cues0.some((c) => c.frame === 600 && c.weight === 'hero'),
		JSON.stringify(report.cues),
	).toBe(true);
	await expect(page.getByTestId('cue-seam')).toBeVisible();
	await snap('cues');

	// 3. Auto Sound Pass… with a personality and the mix options → Propose
	await menu('Auto Sound Pass…');
	const pass = page.getByTestId('auto-sound-pass-dialog');
	await expect(pass).toBeVisible();
	const style = pass.getByTestId('auto-pass-style');
	await style.getByRole('combobox', { name: 'Personality' }).click();
	await page.getByRole('option', { name: 'Energetic' }).click();
	const mixOpts = pass.getByTestId('auto-pass-mix');
	await mixOpts.getByRole('checkbox', { name: /Room glue/ }).click();
	await mixOpts.getByRole('checkbox', { name: /Stop before heroes/ }).click();
	await mixOpts.getByRole('checkbox', { name: /Build into heroes/ }).click();
	await mixOpts.getByRole('combobox', { name: 'Delivery' }).click();
	await page.getByRole('option', { name: 'Web / streaming · −14 LUFS · −1 dBTP' }).click();
	await pass.screenshot({
		path: join(outDir, `${String(++shot).padStart(2, '0')}-auto-pass-dialog.png`),
		timeout: 60_000,
	});
	const h1 = await appliedLabels(page);
	await pass.getByRole('button', { name: 'Propose' }).click();
	await expect(page.getByTestId('review-bar')).toBeVisible({ timeout: LONG });
	const notes = pass.getByTestId('auto-pass-notes');
	if (await notes.isVisible()) {
		report.planNotes = await pass.getByTestId('auto-pass-notes-list').getByRole('listitem').allTextContents();
		await pass.screenshot({
			path: join(outDir, `${String(++shot).padStart(2, '0')}-auto-pass-notes.png`),
			timeout: 60_000,
		});
		await pass.locator('[data-dialog-primary]').click();
	}
	await expect(pass).toBeHidden();
	expect(await appliedLabels(page)).toEqual(h1);

	// 4. Review: accept all, reject one support sound, an alternate on another, a note → Apply (one entry)
	const { proposals } = (await (await request.get(`/api/projects/${projectId}/proposals`)).json()) as {
		proposals: { id: string; createdAt: string }[];
	};
	const proposalId = [...proposals].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!.id;
	type Item = {
		id: string;
		state: string;
		meta?: Record<string, unknown>;
		alternatives?: unknown[];
		requires?: string[];
	};
	const storedItems = async () =>
		(
			(await (
				await request.get(`/api/projects/${projectId}/proposals/${proposalId}?revalidate=1`)
			).json()) as {
				proposal: { items: Item[] };
			}
		).proposal.items;
	const items0 = await storedItems();
	const places = items0.filter((i) => i.meta?.soundId && !i.meta?.setup);
	report.proposal = {
		id: proposalId,
		items: items0.length,
		placements: places.map((i) => ({
			frame: i.meta!.frame,
			kind: i.meta!.kind,
			role: i.meta!.role,
			title: i.meta!.title,
			alternatives: i.alternatives?.length ?? 0,
		})),
		mix: items0
			.filter((i) => i.meta?.kind === 'stopBefore' || i.meta?.kind === 'build' || i.meta?.kind === 'room')
			.map((i) => i.meta!.kind),
	};
	expect(places.length).toBeGreaterThanOrEqual(3);
	// Jasper Synth is a fallback (spec 12 §0): never rotated in among real recordings of the same type
	report.synthPlacements = places
		.filter((i) => String(i.meta?.title ?? '').startsWith('Jasper Synth'))
		.map((i) => i.meta!.title);
	const required = new Set(items0.flatMap((i) => i.requires ?? []));
	const toReject =
		places.find((i) => i.meta!.role === 'support' && !required.has(i.id)) ??
		places.find((i) => !required.has(i.id))!;
	const withAlt = places.find((i) => i.id !== toReject.id && (i.alternatives?.length ?? 0) > 0);
	const toNote =
		places.find((i) => i.id !== toReject.id && i.id !== withAlt?.id) ??
		places.find((i) => i.id !== toReject.id)!;
	const row = (id: string) => page.locator(`[data-review-row="${id}"]`);
	await snap('review-ghosts');
	await page.getByTestId('review-bar-accept-all').click();
	await row(toReject.id).click();
	await page.keyboard.press('Backspace');
	await expect(row(toReject.id)).toHaveAttribute('data-review-state', 'rejected');
	if (withAlt) {
		await row(withAlt.id).click();
		await page.getByTestId('review-details').getByRole('button', { name: 'Next alternate' }).click();
		await expect(page.getByTestId('review-details').locator('[data-review-alt-label]')).toContainText(
			'Alternate 2/',
		);
	}
	await row(toNote.id).click();
	await page.getByTestId('review-details').locator('[data-review-detail="note"]').click();
	await page.getByLabel('Note for the agent').fill('Keep this one, a touch quieter');
	await page.getByTestId('review-details').locator('[data-review-detail="save-note"]').click();
	await expect(row(toNote.id)).toHaveAttribute('aria-label', /note: Keep this one, a touch quieter/);
	await snap('review-decided');
	const accepted = (await storedItems()).filter((i) => i.state === 'accepted').length;
	await row(toNote.id).click();
	await page.keyboard.press('Control+Enter');
	await expect.poll(async () => (await appliedLabels(page)).length, { timeout: 120_000 }).toBe(h1.length + 1);
	expect((await appliedLabels(page)).at(-1)).toMatch(/^Accept Sound design: /);
	const applied = page.getByTestId('toast').filter({ hasText: /^Applied \d+ of \d+ sounds from you/ });
	await expect(applied).toBeVisible();
	report.applyToast = await applied.textContent();
	await snap('review-applied');
	// one Ctrl+Z takes the whole pass back into review, decisions intact; Apply again
	await page.getByTestId('review-bar-exit').click();
	await focusTimeline(page);
	await applied.hover();
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await appliedLabels(page)).length).toBe(h1.length);
	await applied.getByRole('button', { name: 'Reopen review' }).click();
	await expect(page.getByTestId('review-bar')).toBeVisible();
	await expect(row(toReject.id)).toHaveAttribute('data-review-state', 'rejected');
	await expect(row(toNote.id)).toHaveAttribute('data-review-state', 'accepted');
	expect((await storedItems()).find((i) => i.id === toNote.id)?.state).toBe('pending');
	await snap('review-reopened');
	await row(toNote.id).click();
	await page.keyboard.press('Control+Enter');
	await expect.poll(async () => (await appliedLabels(page)).length, { timeout: 120_000 }).toBe(h1.length + 1);
	const after = await storedItems();
	report.reviewOutcome = {
		accepted,
		stateCounts: after.reduce<Record<string, number>>(
			(a, i) => ({ ...a, [i.state]: (a[i.state] ?? 0) + 1 }),
			{},
		),
		rejected: toReject.id,
		alternate: withAlt?.id ?? null,
		noted: toNote.id,
	};
	expect(after.find((i) => i.id === toReject.id)!.state).toBe('rejected');
	await page.getByTestId('review-bar-exit').click();
	seq = await sequence();
	expect(seq.soundDesign?.mix?.room, JSON.stringify(seq.soundDesign?.mix ?? null)).toBeTruthy();
	expect(seq.soundDesign?.settings?.delivery).toBe('web');
	await focusTimeline(page);
	await page.keyboard.press('Backslash');
	await snap('pass-applied');

	// 5. Sound Check: run, Fix all safe, acknowledge a warning / info with a reason
	await menu('Run Sound Check');
	await expect(checkPanel()).toBeVisible({ timeout: 60_000 });
	await waitVerdict();
	const firstCheck = {
		verdict: await checkPanel().getByTestId('sound-check-verdict').getAttribute('data-verdict'),
		findings: await findings(),
	};
	report.check1 = firstCheck;
	await checkPanel().screenshot({
		path: join(outDir, `${String(++shot).padStart(2, '0')}-check-1.png`),
		timeout: 60_000,
	});
	const fixAll = checkPanel().getByTestId('sound-check-fix-all');
	if (await fixAll.isEnabled()) {
		const n = (await appliedLabels(page)).length;
		await fixAll.click();
		// the fixes (one entry), then the check again ("Sound Check Result")
		await expect
			.poll(async () => (await appliedLabels(page)).slice(n), { timeout: LONG, intervals: [2000] })
			.toContain('Sound Check Result');
		await waitVerdict();
		report.fixAllSafe = { entries: (await appliedLabels(page)).slice(n), after: await findings() };
		await checkPanel().screenshot({
			path: join(outDir, `${String(++shot).padStart(2, '0')}-check-fix-all.png`),
			timeout: 60_000,
		});
	} else report.fixAllSafe = 'no safe fix offered';
	const nonError = checkPanel()
		.getByTestId('sound-check-findings')
		.locator('[role="option"][data-issue-id]')
		.filter({ has: page.locator('span.w-12', { hasText: /^(Warning|Info)$/ }) })
		.first();
	await expect(nonError, JSON.stringify(await findings())).toBeVisible();
	const ackId = (await nonError.getAttribute('data-issue-id'))!;
	const nAck = (await appliedLabels(page)).length;
	await nonError.getByTestId('sound-check-message').click();
	await nonError.getByTestId('sound-check-acknowledge').click();
	const reason = checkPanel().getByTestId('sound-check-ack-reason');
	await expect(reason).toBeFocused();
	await reason.fill('Deliberate: the walkthrough keeps it');
	await reason.press('Enter');
	await expect.poll(async () => (await appliedLabels(page)).length, { timeout: 60_000 }).toBe(nAck + 1);
	expect((await appliedLabels(page)).at(-1)).toBe('Acknowledge Sound Check Finding');
	await expect(checkPanel().getByTestId('sound-check-acknowledged-toggle')).toContainText('Acknowledged (1)');
	seq = await sequence();
	report.acknowledged = { id: ackId, stored: seq.soundDesign?.acknowledged };
	await checkPanel().screenshot({
		path: join(outDir, `${String(++shot).padStart(2, '0')}-check-acknowledged.png`),
		timeout: 60_000,
	});

	// 6. Lay Ambience Bed… (the street recording) and Fill Room Tone
	await menu('Lay Ambience Bed…');
	const bedDialog = page.getByTestId('ambience-bed-dialog');
	await expect(bedDialog).toBeVisible();
	await bedDialog.getByRole('combobox', { name: 'Bed', exact: true }).click();
	await page.getByRole('option', { name: 'street.wav (project)' }).click();
	await expect(bedDialog.getByTestId('ambience-bed-scene').first()).toContainText(/Loop \d/, {
		timeout: 180_000,
	});
	report.bedScenes = await bedDialog.getByTestId('ambience-bed-scene').allTextContents();
	await bedDialog.screenshot({
		path: join(outDir, `${String(++shot).padStart(2, '0')}-ambience-dialog.png`),
		timeout: 60_000,
	});
	const nBed = (await appliedLabels(page)).length;
	await bedDialog.getByRole('button', { name: 'Lay Beds' }).click();
	await expect.poll(async () => (await appliedLabels(page)).length, { timeout: 300_000 }).toBe(nBed + 1);
	expect((await appliedLabels(page)).at(-1)).toBe('Lay Ambience Bed');
	const nTone = (await appliedLabels(page)).length;
	await menu('Fill Room Tone');
	await expect.poll(async () => (await appliedLabels(page)).length, { timeout: 300_000 }).toBe(nTone + 1);
	report.roomToneEntry = (await appliedLabels(page)).at(-1);
	seq = await sequence();
	const bedPieces = Object.values(seq.clips).filter((c) => c.bed?.purpose === 'ambience');
	const tone = Object.values(seq.clips).filter((c) => c.bed?.purpose === 'roomtone');
	report.beds = {
		ambiencePieces: bedPieces.length,
		roomTonePieces: tone.length,
		roomTone: tone.map((c) => [c.start, c.start + c.duration]),
	};
	expect(bedPieces.length).toBeGreaterThanOrEqual(2);
	expect(tone.length).toBeGreaterThanOrEqual(1);
	expect(tone.some((c) => c.start <= 272 && c.start + c.duration >= 298)).toBe(true);
	await focusTimeline(page);
	await page.keyboard.press('Backslash');
	await snap('beds');
	await focusTimeline(page);
	await page.keyboard.press('Backslash');

	// 7. Music to picture: land the drop on the hero cue (Essential Sound), End on Bar (Clip ▸ Audio Options)
	await clipElement(page, musicClipId).scrollIntoViewIfNeeded();
	const mbox = await clipBox(page, musicClipId);
	await page.mouse.click(mbox.x + 40, mbox.y + mbox.height / 2);
	await page.getByTestId('workspace-tab-audio').click();
	const es = page.getByTestId('essential-sound');
	await expect(es).toBeVisible();
	const fit = es.getByTestId('essential-music-fit');
	await fit.scrollIntoViewIfNeeded();
	await fit.getByTestId('essential-music-analyse').click();
	await expect(fit.getByTestId('essential-music-info')).toHaveText(/120 BPM · 4 beats per bar · C major/, {
		timeout: 180_000,
	});
	report.musicInfo = await fit.getByTestId('essential-music-info').textContent();
	report.musicDrops = await fit.getByTestId('essential-music-drops').textContent();
	await fit.getByRole('combobox', { name: 'Land the drop on' }).click();
	await page.getByRole('option', { name: /^Hero cue \(/ }).click();
	const nDrop = (await appliedLabels(page)).length;
	await fit.getByTestId('essential-land-drop').click();
	await expect.poll(async () => (await appliedLabels(page)).length, { timeout: 180_000 }).toBe(nDrop + 1);
	expect((await appliedLabels(page)).at(-1)).toBe('Land the Drop');
	await expect(fit.getByTestId('essential-music-landed')).toHaveText(/^The drop lands at /);
	report.landed = await fit.getByTestId('essential-music-landed').textContent();
	await snap('music-landed');
	seq = await sequence();
	const pieces = Object.values(seq.clips)
		.filter((c) => c.remix)
		.sort((a, b) => a.start - b.start);
	expect(pieces.length).toBeGreaterThan(1);
	const anchors = pieces[0]!.remix!.anchors ?? [];
	report.dropAnchor = anchors;
	const heroFrame = anchors[0]?.frame ?? 600;
	await clipElement(page, pieces.at(-1)!.id).scrollIntoViewIfNeeded();
	const fb = await clipBox(page, pieces.at(-1)!.id);
	await page.mouse.click(fb.x + 20, fb.y + fb.height / 2);
	await menu('End on Bar', 'Clip', 'Audio Options');
	await expect.poll(async () => (await appliedLabels(page)).at(-1), { timeout: 180_000 }).toBe('End on Bar');
	seq = await sequence();
	const lastPiece = Object.values(seq.clips)
		.filter((c) => c.remix)
		.sort((a, b) => a.start - b.start)
		.at(-1)!;
	report.musicEnd = { endFrame: lastPiece.start + lastPiece.duration };
	await snap('music-end-on-bar');

	// 8. Delivery Target… (web): one entry, the measured summary
	await page.keyboard.press('Alt+Shift+Digit9');
	await menu('Delivery Target…');
	const delivery = page.getByTestId('delivery-dialog');
	await expect(delivery).toBeVisible();
	const nDel = (await appliedLabels(page)).length;
	await delivery.getByRole('button', { name: 'Apply' }).click();
	await expect(delivery.getByTestId('delivery-summary')).toContainText('Export:', { timeout: LONG });
	report.delivery = await delivery.getByTestId('delivery-summary').textContent();
	await delivery.screenshot({
		path: join(outDir, `${String(++shot).padStart(2, '0')}-delivery.png`),
		timeout: 60_000,
	});
	expect((await appliedLabels(page)).length).toBe(nDel + 1);
	await delivery.getByRole('button', { name: 'Close' }).last().click();
	await expect(delivery).toBeHidden();

	// a last Sound Check of the finished mix (the acknowledged finding stays acknowledged unless its target changed)
	// (Sequence ▸ Sound Design ▸ Run Sound Check shows the panel; a finished run stores "Sound Check Result")
	const nCheck = (await appliedLabels(page)).length;
	const jobsBefore = new Set(
		JobListResponseSchema.parse(await (await request.get('/api/jobs')).json()).jobs.map((j) => j.id),
	);
	await menu('Run Sound Check');
	await expect(checkPanel()).toBeVisible({ timeout: 60_000 });
	let checkJob = '';
	await expect
		.poll(
			async () => {
				const { jobs } = JobListResponseSchema.parse(await (await request.get('/api/jobs')).json());
				checkJob = jobs.find((j) => j.kind === 'sound-check' && !jobsBefore.has(j.id))?.id ?? '';
				return checkJob;
			},
			{ timeout: 120_000 },
		)
		.not.toBe('');
	const finalJob = await waitForJob(request, checkJob, LONG);
	expect(finalJob.state, JSON.stringify(finalJob.error ?? null)).toBe('succeeded');
	await waitVerdict();
	report.finalCheckHistory = (await appliedLabels(page)).slice(nCheck);
	report.checkFinal = {
		verdict: await checkPanel().getByTestId('sound-check-verdict').getAttribute('data-verdict'),
		findings: await findings(),
		acknowledged: await checkPanel()
			.getByTestId('sound-check-acknowledged-toggle')
			.textContent({ timeout: 3000 })
			.catch(() => null),
	};
	await checkPanel().screenshot({
		path: join(outDir, `${String(++shot).padStart(2, '0')}-check-final.png`),
		timeout: 60_000,
	});

	// 9. Export with a Markdown credits file
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyM');
	await expect(page.getByTestId('export-mode')).toBeVisible();
	await page.getByTestId('export-engine').selectOption('native');
	await page.getByTestId('export-filename').fill('sound-design-walkthrough.mp4');
	await page.getByTestId('export-credits').selectOption('md');
	await expect(page.getByTestId('plan-path')).toContainText(/native/i, { timeout: 60_000 });
	await page.getByTestId('export-sound').scrollIntoViewIfNeeded();
	await snap('export-mode');
	const before = new Set(
		JobListResponseSchema.parse(await (await request.get('/api/jobs')).json()).jobs.map((j) => j.id),
	);
	await expect(page.getByTestId('export-start')).toBeEnabled({ timeout: 60_000 });
	await page.getByTestId('export-start').click();
	await expect(page.getByTestId('export-mode')).toBeHidden();
	let jobId = '';
	await expect
		.poll(async () => {
			const { jobs } = JobListResponseSchema.parse(await (await request.get('/api/jobs')).json());
			jobId = jobs.find((j) => j.kind === 'export' && !before.has(j.id))?.id ?? '';
			return jobId;
		})
		.not.toBe('');
	const job = await waitForJob(request, jobId, LONG);
	expect(job.state, JSON.stringify(job.error ?? null)).toBe('succeeded');
	const result = job.result as {
		url?: string;
		credits?: { format: string; count: number; name: string; url: string };
		warnings?: { code: string; message: string }[];
	};
	report.exportWarnings = result.warnings ?? [];
	expect(result.credits?.format).toBe('md');
	const creditsText = await (await request.get(result.credits!.url)).text();
	writeFileSync(join(outDir, 'walkthrough.credits.md'), creditsText);
	report.credits = { count: result.credits!.count, firstLine: creditsText.split('\n')[0] };
	expect(creditsText.split('\n')[0]).toBe('## Sound credits');
	const jobRow = page.getByTestId('jobs-panel').locator(`[data-testid="job-row"][data-job-id="${jobId}"]`);
	await expect(jobRow).toHaveAttribute('data-status', /succeeded|done|finished/i, { timeout: 60_000 });
	const download = page.waitForEvent('download');
	await jobRow.getByTestId('job-download').click();
	const file = join(outDir, 'sound-design-walkthrough.mp4');
	await (await download).saveAs(file);
	await snap('exported');

	// MEASURED: loudness and true peak (web: −14 LUFS ± 1, ≤ −1 dBTP), and every peak-aligned sound on its cue frame
	const loud = ebur128(file);
	report.loudness = loud;
	seq = await sequence();
	const mediaDoc = await media();
	const mix = decodeMono(file);
	const peaks: Record<string, unknown>[] = [];
	for (const cue of Object.values(seq.soundDesign?.cues ?? {})) {
		const ids = (cue.placedClipIds ?? []).filter((id) => seq.clips[id]);
		if (ids.length !== 1) continue;
		const c = seq.clips[ids[0]!]!;
		if (c.sfx?.placement.align !== 'peak') continue;
		const key = mediaDoc[c.mediaId]?.locators.find((l) => l.type === 'engine-store')?.key;
		if (!key) continue;
		const res = await request.get(`/media/${encodeURIComponent(key)}`);
		if (!res.ok()) continue;
		const local = join(outDir, `${c.id}.media`);
		writeFileSync(local, await res.body());
		const ref = decodeMono(local, c.speed.rate);
		const refPoint = Math.round(((c.sfx.placement.peakFlicks / FLICKS) * SR) / c.speed.rate);
		const W = 2400;
		const w0 = Math.max(0, refPoint - W);
		const w1 = Math.min(ref.length, refPoint + W);
		const clipStart = Math.round(((c.start * F - c.sourceIn / c.speed.rate) / FLICKS) * SR);
		const found = locate(mix, ref, w0, w1, clipStart, 960);
		const cueSample = Math.round(((cue.frame * F) / FLICKS) * SR);
		const peakAt = found.lag + refPoint;
		const docPoint = Math.round(
			((c.start * F + (c.sfx.placement.peakFlicks - c.sourceIn) / c.speed.rate) / FLICKS) * SR,
		);
		peaks.push({
			cue: cue.frame,
			kind: cue.kind,
			role: c.sfx.role,
			title: mediaDoc[c.mediaId]?.library?.title,
			r: Math.round(found.r * 1000) / 1000,
			peakVsCueSamples: peakAt - cueSample,
			peakVsDocumentSamples: peakAt - docPoint,
		});
	}
	report.peaks = peaks;
	report.heroFrame = heroFrame;
	writeFileSync(join(outDir, 'walkthrough.json'), JSON.stringify(report, null, 2));
	for (const t of [heroFrame / fps, 150 / fps, 5, 13]) {
		spawnSync(FFMPEG, [
			'-v',
			'error',
			'-y',
			'-ss',
			String(t),
			'-i',
			file,
			'-frames:v',
			'1',
			join(outDir, `export-frame-${t.toFixed(2)}s.png`),
		]);
	}
	spawnSync(FFMPEG, [
		'-v',
		'error',
		'-y',
		'-i',
		file,
		'-filter_complex',
		'[0:a]showwavespic=s=1800x300',
		'-frames:v',
		'1',
		join(outDir, 'export-wave.png'),
	]);
	console.log('walkthrough', JSON.stringify({ loudness: loud, peaks }));
	expect(Math.abs(loud.integrated + 14), JSON.stringify(loud)).toBeLessThanOrEqual(1);
	expect(loud.truePeak, JSON.stringify(loud)).toBeLessThanOrEqual(-1);
	const clear = peaks.filter((p) => (p.r as number) >= 0.9);
	expect(clear.length, JSON.stringify(peaks)).toBeGreaterThan(0);
	for (const p of clear) {
		expect(Math.abs(p.peakVsDocumentSamples as number), JSON.stringify(p)).toBeLessThanOrEqual(2);
		// on the cue frame: within one frame after it (the placement keeps the sub-frame rest), 1 ms of slack before
		expect(p.peakVsCueSamples as number, JSON.stringify(p)).toBeGreaterThanOrEqual(-48);
		expect(p.peakVsCueSamples as number, JSON.stringify(p)).toBeLessThan(SR / fps + 48);
	}
});
