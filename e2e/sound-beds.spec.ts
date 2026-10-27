// Ambience beds and room tone in the built app (spec 12 §4 P6-E12; wp-note "Phase 6 → WP-E8"): three stills on V1
// (three scenes, 20 s) and a dialogue recording (a −52 dBFS pink floor under syllables) cut into two clips with a 1 s
// hole between them. Sequence ▸ Sound Design ▸ Run Sound Check → SILENCE in the hole with the fix "Fill it with room
// tone" (not safe: it asks first) → one History entry, the re-check has no SILENCE there; Sequence ▸ Sound Design ▸ Lay
// Ambience Bed… with the project's street recording → three measured scenes → Lay Beds → one History entry "Lay
// Ambience Bed", the pieces and crossfades on an "Ambience" track; a native export through the Export dialog, MEASURED:
// level at every joint, the hole at the floor. Screenshots go to test-results/e2e-sound-beds.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { encodeWav } from '../packages/audio-dsp/src/index.ts';
import {
	appliedLabels,
	createProject,
	enableAgentBridge,
	exportViaUi,
	query,
	ROOT,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const outDir = join(ROOT, 'test-results', 'e2e-sound-beds');
const SR = 48_000;
const FFMPEG = process.env.JASPER_FFMPEG ?? 'ffmpeg';
const CHECK_MS = 900_000;
let page: Page;
let dir = '';

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

function decode(file: string): Float32Array {
	const r = spawnSync(
		FFMPEG,
		['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'],
		{
			maxBuffer: 1 << 30,
		},
	);
	if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
	const b = r.stdout as Buffer;
	return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}
const rmsDb = (x: Float32Array, a: number, b: number) => {
	let e = 0;
	for (let i = Math.max(0, a); i < Math.min(x.length, b); i++) e += x[i]! ** 2;
	return 10 * Math.log10(e / Math.max(1, b - a) + 1e-20);
};

async function menu(p: Page, item: string) {
	const menubar = p.getByTestId('title-bar').getByRole('menubar');
	await menubar.getByRole('menuitem', { name: 'Sequence', exact: true }).click();
	await p.getByRole('menuitem', { name: 'Sound Design' }).hover();
	await p.getByRole('menuitem', { name: item, exact: true }).click();
}
const panel = () => page.locator('[data-panel-kind="soundCheck"][data-instance-id]');
async function waitVerdict(previous?: string) {
	await expect(panel().getByTestId('sound-check-verdict')).toBeVisible({ timeout: CHECK_MS });
	await expect(panel().getByTestId('sound-check-progress')).toBeHidden({ timeout: CHECK_MS });
	if (previous)
		await expect
			.poll(async () => (await panel().getByTestId('sound-check-live').textContent()) ?? '', {
				timeout: CHECK_MS,
			})
			.not.toBe(previous);
}

type Clip = {
	id: string;
	kind: string;
	start: number;
	duration: number;
	trackId: string;
	bed?: { purpose: string };
};
type Seq = {
	clips: Record<string, Clip>;
	transitions: Record<
		string,
		{ duration: number; outgoingClipId: string | null; incomingClipId: string | null }
	>;
	audioTracks: { id: string; name: string }[];
	settings: { frameRate: { num: number; den: number } };
};
async function sequence(p: Page): Promise<Seq> {
	return Object.values(await query<Record<string, Seq>>(p, 'doc.get', { path: ['sequences'] }))[0]!;
}

test.beforeAll(async ({ browser }) => {
	mkdirSync(outDir, { recursive: true });
	dir = mkdtempSync(join(tmpdir(), 'jasper-e2e-beds-'));
	for (const c of ['red', 'green', 'blue']) {
		const r = spawnSync(FFMPEG, [
			'-v',
			'error',
			'-y',
			'-f',
			'lavfi',
			'-i',
			`color=c=${c}:s=640x360`,
			'-frames:v',
			'1',
			join(dir, `${c}.png`),
		]);
		expect(r.status, String(r.stderr)).toBe(0);
	}
	const street = [pink(6, 1, -30), pink(6, 2, -30)];
	writeFileSync(join(dir, 'street.wav'), encodeWav(street, SR, 's16'));
	const d = pink(10, 21, -52);
	for (let i = 0; i < d.length; i++) {
		const t = i / SR;
		if (!((t >= 0.5 && t < 3.5) || (t >= 5.5 && t < 8.5))) continue;
		d[i]! += 0.15 * (0.5 - 0.5 * Math.cos(2 * Math.PI * 4 * t)) * Math.sin(2 * Math.PI * 1500 * t);
	}
	writeFileSync(join(dir, 'dialogue.wav'), encodeWav([d, d.slice()], SR, 's16'));
	page = await browser.newPage({ viewport: { width: 1800, height: 1050 } });
	await enableAgentBridge(page);
});
test.afterAll(async () => {
	await page?.close();
});

test('room tone fills the dialogue hole from Sound Check; an ambience bed per scene; measured in the export', async ({
	request,
}) => {
	test.setTimeout(3_600_000);
	await createProject(page, 'E2E Beds');
	await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Control+KeyI');
	const names = ['red.png', 'green.png', 'blue.png', 'street.wav', 'dialogue.wav'];
	await (await chooser).setFiles(names.map((n) => join(dir, n)));
	for (const n of names)
		await expect(page.getByTestId('project-row').filter({ hasText: n })).toBeVisible({ timeout: 120_000 });
	const items = await query<Record<string, { id: string; name: string }>>(page, 'doc.get', {
		path: ['items'],
	});
	const item = (n: string) => Object.values(items).find((i) => i.name === n)!.id;
	const setup = await transact(page, [
		...['red.png', 'green.png', 'blue.png'].map((n, i) => ({
			type: 'clip.place',
			source: { projectItemId: item(n) },
			at: i * 200,
			tracks: { video: 'V1' },
			ref: `$v${i}`,
		})),
		{
			type: 'clip.place',
			source: { projectItemId: item('dialogue.wav') },
			sourceRange: { in: { seconds: 0 }, out: { seconds: 4 } },
			at: 0,
			tracks: { audio: 'A1' },
			ref: '$a',
		},
		{
			type: 'clip.place',
			source: { projectItemId: item('dialogue.wav') },
			sourceRange: { in: { seconds: 5 }, out: { seconds: 9 } },
			at: 150,
			tracks: { audio: 'A1' },
			ref: '$b',
		},
		{ type: 'essentialSound.setType', clipIds: ['$a', '$b'], audioType: 'dialogue' },
	] as never);
	expect(setup.ok, JSON.stringify(setup)).toBe(true);
	// the stills are 200 frames each: three scenes
	let seq = await sequence(page);
	const stills = Object.values(seq.clips)
		.filter((c) => c.kind === 'still')
		.sort((a, b) => a.start - b.start);
	const trim = await transact(
		page,
		stills.map((c) => ({
			type: 'clip.trim',
			clipId: c.id,
			edge: 'out',
			deltaFrames: 200 - c.duration,
		})) as never,
	);
	expect(trim.ok, JSON.stringify(trim)).toBe(true);
	seq = await sequence(page);
	const fps = seq.settings.frameRate.num / seq.settings.frameRate.den;
	const holeStart = Object.values(seq.clips).find((c) => c.kind === 'audio' && c.start === 0)!;
	const hole = { start: holeStart.start + holeStart.duration, end: 150 };

	// 1. Sound Check: SILENCE in the hole, its fix fills it with room tone
	await page.keyboard.press('Alt+Shift+Digit9');
	await menu(page, 'Run Sound Check');
	await expect(panel()).toBeVisible({ timeout: 60_000 });
	await waitVerdict();
	const silence = panel().locator('[data-code="SILENCE"]').first();
	await expect(silence).toBeVisible();
	await expect(silence.getByTestId('sound-check-message')).toContainText(/Silence under −60 dBFS/);
	await expect(silence).toContainText(/Fill it with room tone/);
	await silence.scrollIntoViewIfNeeded();
	await panel().screenshot({ path: join(outDir, '1-silence-fix.png') });
	const before = await appliedLabels(page);
	await silence.getByTestId('sound-check-fix').click();
	const confirm = page.getByRole('dialog').filter({ hasText: /Fill it with room tone/ });
	await expect(confirm).toBeVisible();
	await confirm.screenshot({ path: join(outDir, '2-fix-confirm.png') });
	await confirm.getByRole('button', { name: 'Apply Fix' }).click();
	await expect
		.poll(async () => (await appliedLabels(page)).length, { timeout: 120_000 })
		.toBe(before.length + 1);
	expect((await appliedLabels(page)).at(-1)).toMatch(/Fill it with room tone/);
	seq = await sequence(page);
	const tone = Object.values(seq.clips).filter((c) => c.bed?.purpose === 'roomtone');
	expect(tone.length).toBeGreaterThanOrEqual(1);
	expect(seq.audioTracks.find((t) => t.id === tone[0]!.trackId)!.name).toBe('Room Tone');
	const live = (await panel().getByTestId('sound-check-live').textContent()) ?? '';
	await panel().getByTestId('sound-check-run').click();
	await waitVerdict(live);
	const left = await panel()
		.locator('[data-code="SILENCE"]')
		.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-frame'))));
	expect(left.filter((f) => f >= hole.start - 5 && f <= hole.end)).toEqual([]);
	await panel().screenshot({ path: join(outDir, '3-after-room-tone.png') });

	// 2. Lay Ambience Bed… with the project's street recording
	await menu(page, 'Lay Ambience Bed…');
	const dialog = page.getByTestId('ambience-bed-dialog');
	await expect(dialog).toBeVisible();
	await dialog.getByRole('combobox', { name: 'Bed', exact: true }).click();
	await page.getByRole('option', { name: 'street.wav (project)' }).click();
	await expect(dialog.getByTestId('ambience-bed-scene')).toHaveCount(3, { timeout: 120_000 });
	await expect(dialog.getByTestId('ambience-bed-scene').first()).toContainText(/Loop \d/);
	await dialog.screenshot({ path: join(outDir, '4-dialog.png') });
	const before2 = await appliedLabels(page);
	await dialog.getByRole('button', { name: 'Lay Beds' }).click();
	await expect
		.poll(async () => (await appliedLabels(page)).length, { timeout: 300_000 })
		.toBe(before2.length + 1);
	expect((await appliedLabels(page)).at(-1)).toBe('Lay Ambience Bed');
	seq = await sequence(page);
	const bed = Object.values(seq.clips)
		.filter((c) => c.bed?.purpose === 'ambience')
		.sort((a, b) => a.start - b.start);
	expect(bed.length).toBeGreaterThanOrEqual(6);
	expect(seq.audioTracks.find((t) => t.id === bed[0]!.trackId)!.name).toBe('Ambience');
	const joints = Object.values(seq.transitions).filter(
		(t) => t.outgoingClipId && t.incomingClipId && bed.some((c) => c.id === t.incomingClipId),
	);
	expect(joints.length).toBe(bed.length - 1);
	// the whole sequence in the timeline (Zoom to Sequence)
	await page.getByTestId('timeline-track-area').click({ position: { x: 5, y: 5 } });
	await page.keyboard.press('Backslash');
	await page.getByTestId('timeline-track-area').screenshot({ path: join(outDir, '5-timeline.png') });
	// ducked under the dialogue: Volume keyframes on the pieces the dialogue plays over
	const ducked = await query<Record<string, { volumeDb?: { keyframes?: unknown[] } }>>(page, 'doc.get', {
		path: [
			'sequences',
			Object.keys(await query<Record<string, unknown>>(page, 'doc.get', { path: ['sequences'] }))[0]!,
			'clips',
		],
	});
	expect(bed.some((c) => (ducked[c.id]?.volumeDb?.keyframes ?? []).length > 0)).toBe(true);

	// 3. the export, measured (the result toasts stay up: they keep clear of Export mode's footer)
	const { file } = await exportViaUi(page, request, {
		engine: 'native',
		fileName: 'beds.mp4',
		expectPath: /native/i,
		outDir,
		jobTimeoutMs: 900_000,
	});
	spawnSync(FFMPEG, [
		'-v',
		'error',
		'-y',
		'-i',
		file,
		'-filter_complex',
		'[0:a]showwavespic=s=1600x300',
		'-frames:v',
		'1',
		join(outDir, '6-export-wave.png'),
	]);
	const x = decode(file);
	const at = (f: number) => Math.round((f / fps) * SR);
	const ambOnly = (a: number, b: number) => rmsDb(x, at(a), at(b));
	// at every joint of the bed after the dialogue (frames 300–580: ambience only) the level matches its body
	const late = joints
		.map((t) => bed.find((c) => c.id === t.incomingClipId)!.start)
		.filter((f) => f > 300 && f < 580);
	const body = ambOnly(300, 580);
	const dev = late.map((f) => ambOnly(f - 3, f + 3) - body);
	console.info(
		`[e2e beds] body ${body.toFixed(2)} dBFS; joints ${late.join(', ')}: ${dev.map((d) => d.toFixed(2)).join(', ')} dB; the hole ${ambOnly(hole.start + 2, hole.end - 2).toFixed(2)} dBFS`,
	);
	expect(Math.max(...dev.map(Math.abs))).toBeLessThan(1.5);
	expect(ambOnly(hole.start + 2, hole.end - 2)).toBeGreaterThan(-60);
});
