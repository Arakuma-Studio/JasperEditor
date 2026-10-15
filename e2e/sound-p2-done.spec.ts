// Spec 12 Phase 2 "Done when", end to end in the built app on the Phase 2 fixture (cuts, a push transition, a keyframed
// logo, a typewriter title, a lower third and an `sfx:` marker; the same commands as the MCP test's fixture):
// Sequence ▸ Sound Design ▸ Suggest Cues… finds each event with a reason, and the engine route (what MCP
// find_sound_cues calls) derives the same cues from the same document → Fill Unfilled Cues (one History entry) →
// Next Variation ×2 (one entry; one undo restores the sequence exactly; redo) → Add Layer… → undo / redo of the whole
// fill → export (the planner's path: the lower third rules out native when the fframes renderer is not built), where
// the aligned point of every peak- or start-aligned fill is located in the decoded mix (normalised cross-correlation
// with the registered media, varispeed like its clip) and must sit on its cue frame.
// Screenshots go to test-results/e2e-sound-p2-done; the measured offsets are printed and attached.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { FIXTURE_COMMANDS } from '../apps/mcp/test/sound-cues-fixture.ts';
import {
	appliedLabels,
	clipBox,
	createProject,
	enableAgentBridge,
	exportViaUi,
	focusTimeline,
	query,
	ROOT,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const outDir = join(ROOT, 'test-results', 'e2e-sound-p2-done');
const FLICKS = 705_600_000;
const SR = 48_000;
let page: Page;

type Sfx = {
	cueId: string | null;
	soundId: string | null;
	layer: number;
	role: string;
	alternatives?: string[];
	placement: { align: string; peakFlicks: number; errorFlicks: number };
};
type Clip = {
	id: string;
	kind: string;
	trackId: string;
	start: number;
	duration: number;
	sourceIn: number;
	mediaId: string;
	linkId?: string | null;
	speed: { rate: number };
	sfx?: Sfx;
};
type Cue = {
	id: string;
	frame: number;
	kind: string;
	weight: string;
	source: string;
	reason?: string;
	anchor?: unknown;
	placedClipIds?: string[];
};
type Seq = {
	id: string;
	clips: Record<string, Clip>;
	settings: { frameRate: { num: number; den: number } };
	soundDesign?: { cues?: Record<string, Cue> };
};
type Suggestion = {
	key: string;
	frame: number;
	kind: string;
	weight: string;
	types: string[];
	anchor: unknown;
	reason: string;
	storedCueId: string | null;
};

async function sequence(p: Page): Promise<Seq> {
	const seqs = await query<Record<string, Seq>>(p, 'doc.get', { path: ['sequences'] });
	return Object.values(seqs)[0]!;
}
async function cues(p: Page): Promise<Cue[]> {
	return Object.values((await sequence(p)).soundDesign?.cues ?? {}).sort(
		(a, b) => a.frame - b.frame || a.id.localeCompare(b.id),
	);
}
const sfxClips = (s: Seq) => Object.values(s.clips).filter((c) => c.sfx);
/** Sequence frame (fractional) where a clip's aligned point plays. */
function pointFrame(s: Seq, c: Clip): number {
	const F = (FLICKS * s.settings.frameRate.den) / s.settings.frameRate.num;
	return c.start + (c.sfx!.placement.peakFlicks - c.sourceIn) / c.speed.rate / F;
}
/** Canonical JSON (sorted keys) so anchors compare by value. */
function canon(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
	if (v && typeof v === 'object')
		return `{${Object.keys(v as object)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
			.join(',')}}`;
	return JSON.stringify(v);
}

/** The first channel as 48 kHz float samples (ffmpeg); `rate` ≠ 1 plays it varispeed like a clip speed. */
function decodeMono(file: string, rate = 1): Float32Array {
	const af = rate === 1 ? 'pan=mono|c0=c0' : `pan=mono|c0=c0,asetrate=48000*${rate},aresample=48000`;
	const raw = execFileSync(
		process.env.JASPER_FFMPEG ?? 'ffmpeg',
		['-v', 'error', '-i', file, '-map', '0:a:0', '-af', af, '-ar', '48000', '-f', 'f32le', '-'],
		{ maxBuffer: 256 * 1024 * 1024 },
	);
	return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
}

/** The lag (± `span` around `guess`) where `ref[w0, w1)` correlates best with `mix` (normalised). */
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

test.beforeAll(async ({ browser }) => {
	mkdirSync(outDir, { recursive: true });
	page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
	await enableAgentBridge(page);
});
test.afterAll(async () => {
	await page?.close();
});

test('Phase 2 done-when: suggest (= engine route), fill, vary, layer, undo/redo, export peaks on the cues', async ({
	request,
}) => {
	test.setTimeout(1_500_000);
	const projectId = await createProject(page, 'E2E Sound P2 Done');
	const r = await transact(page, FIXTURE_COMMANDS as never);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	await page.keyboard.press('Alt+Shift+Digit9');
	const panel = page.locator('[data-panel-kind="soundLibrary"][data-instance-id]');
	await expect(panel).toBeVisible({ timeout: 60_000 });
	const list = panel.getByRole('listbox', { name: 'Sounds' });
	await expect(list.getByRole('option').first()).toBeVisible({ timeout: 360_000 });

	// 1. Suggest Cues… (defaults: every source, the sequence's density, respect dialogue)
	const menubar = page.getByTestId('title-bar').getByRole('menubar');
	const soundDesignMenu = async (item: string) => {
		await menubar.getByRole('menuitem', { name: 'Sequence', exact: true }).click();
		await page.getByRole('menuitem', { name: 'Sound Design' }).hover();
		await page.getByRole('menuitem', { name: item }).click();
	};
	await soundDesignMenu('Suggest Cues…');
	const dialog = page.getByTestId('suggest-cues-dialog');
	await expect(dialog).toBeVisible();
	await dialog.screenshot({ path: join(outDir, 'dialog.png') });
	const button = dialog.getByRole('button', { name: /^Suggest \d+ Cues$/ });
	const n = Number(/(\d+)/.exec((await button.textContent()) ?? '')![1]);
	await button.click();
	await expect(dialog).toBeHidden();
	expect((await appliedLabels(page)).at(-1)).toBe(`Suggest Cues (${n})`);
	const stored = await cues(page);
	expect(stored).toHaveLength(n);
	for (const c of stored) expect(c.reason, JSON.stringify(c)).toBeTruthy();
	const has = (pred: (c: Cue) => boolean, what: string) =>
		expect(stored.some(pred), `${what}: ${JSON.stringify(stored.map((c) => [c.frame, c.kind]))}`).toBe(true);
	has((c) => c.frame === 90 && c.kind === 'cut', 'cut at 90');
	has((c) => c.frame === 180 && (c.kind === 'transition' || c.kind === 'move'), 'push at 180');
	has((c) => c.kind === 'move' && c.frame > 40 && c.frame < 57, 'logo move');
	has((c) => c.kind === 'land' && c.frame >= 50 && c.frame <= 57, 'logo land');
	has((c) => c.frame >= 200 && c.frame < 245 && c.kind === 'appear', 'typewriter keys');
	has((c) => c.frame >= 330 && c.kind === 'land', 'lower-third land');
	has((c) => c.frame === 250 && c.weight === 'hero', 'marker boom');

	// 2. The engine route (what MCP find_sound_cues calls) derives the same cues from the live document; each matches
	//    a stored cue
	const res = await request.post('/api/sound-design/cues', { data: { projectId } });
	expect(res.ok(), await res.text()).toBe(true);
	const route = (await res.json()) as { cues: Suggestion[] };
	const sig = (c: { frame: number; kind: string; weight: string; anchor?: unknown }) =>
		`${c.frame}|${c.kind}|${c.weight}|${canon(c.anchor ?? null)}`;
	expect(route.cues.map(sig).sort()).toEqual(stored.map(sig).sort());
	expect(route.cues.every((c) => c.storedCueId !== null)).toBe(true);
	writeFileSync(
		join(outDir, 'cues.json'),
		JSON.stringify(
			route.cues.map((c) => ({
				frame: c.frame,
				kind: c.kind,
				weight: c.weight,
				types: c.types,
				reason: c.reason,
			})),
			null,
			1,
		),
	);

	// 3. Fill Unfilled Cues: one History entry, every unmuted cue filled
	const n0 = (await appliedLabels(page)).length;
	const beforeFill = await sequence(page);
	await soundDesignMenu('Fill Unfilled Cues');
	await expect
		.poll(async () => (await appliedLabels(page)).at(-1), { timeout: 180_000 })
		.toMatch(/^Fill Unfilled Cues \(\d+\)$/);
	expect(await appliedLabels(page)).toHaveLength(n0 + 1);
	let seq = await sequence(page);
	const after = Object.values(seq.soundDesign!.cues!);
	const unfilled = after.filter((c) => !(c.placedClipIds ?? []).length);
	expect(unfilled, JSON.stringify(unfilled)).toHaveLength(0);
	for (const c of sfxClips(seq)) {
		const cue = seq.soundDesign!.cues![c.sfx!.cueId!]!;
		expect(cue, c.id).toBeTruthy();
		if (c.sfx!.placement.align !== 'end') {
			const at = pointFrame(seq, c);
			// the aligned point plays in [cue, cue + 1 frame) (≤ 1e-6 frame of float slack; a trimmed head at frame 0
			// would be exact too)
			expect(at, `${cue.kind} at ${cue.frame}`).toBeGreaterThanOrEqual(cue.frame - 1e-6);
			expect(at, `${cue.kind} at ${cue.frame}`).toBeLessThan(cue.frame + 1);
		}
	}
	const filledAll = seq;
	await focusTimeline(page);
	await page.keyboard.press('Backslash');
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(outDir, 'filled-all.png') });

	// 4. Next Variation ×2 on the cut's clip: ONE entry; one undo restores the sequence exactly; redo the last swap
	const cut = after.find((c) => c.frame === 90 && c.kind === 'cut')!;
	const cutClipId = cut.placedClipIds![0]!;
	const clickClip = async (id: string, button: 'left' | 'right' = 'left') => {
		let b = await clipBox(page, id).catch(() => null);
		for (let i = 0; (!b || b.width < 40) && i < 10; i++) {
			const c = (await sequence(page)).clips[id]!;
			await query(page, 'playhead.set', { frame: c.start });
			await focusTimeline(page);
			await page.keyboard.press('Equal');
			await page.waitForTimeout(200);
			b = await clipBox(page, id).catch(() => null);
		}
		if (!b) throw new Error(`clip ${id} is not visible`);
		await page.mouse.click(b.x + Math.min(20, b.width / 3), b.y + b.height - 6, { button });
	};
	const n1 = (await appliedLabels(page)).length;
	for (let i = 1; i <= 2; i++) {
		await focusTimeline(page);
		await clickClip(cutClipId);
		await page.keyboard.press('Control+Alt+Period');
		await expect
			.poll(async () => (await appliedLabels(page)).at(-1), { timeout: 60_000 })
			.toBe(i === 1 ? 'Swap Sound' : `Swap Sound ×${i}`);
		await page.keyboard.press('Escape');
	}
	expect(await appliedLabels(page)).toHaveLength(n1 + 1);
	seq = await sequence(page);
	const swapped = seq;
	expect(seq.clips[cutClipId]!.sfx!.soundId).not.toBe(filledAll.clips[cutClipId]!.sfx!.soundId);
	expect(pointFrame(seq, seq.clips[cutClipId]!)).toBeGreaterThanOrEqual(90 - 1e-6);
	expect(pointFrame(seq, seq.clips[cutClipId]!)).toBeLessThan(91);
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => canon(await sequence(page))).toBe(canon(filledAll));
	await page.keyboard.press('Control+Shift+KeyZ');
	await expect.poll(async () => canon(await sequence(page))).toBe(canon(swapped));

	// 5. Add Layer… on the cut's clip: a linked layer on another track, aligned to the same point
	await clickClip(cutClipId, 'right');
	const menu = page.getByTestId('timeline-context-menu');
	await expect(menu).toBeVisible();
	await menu.getByRole('menuitem', { name: 'Add Layer…' }).click();
	await expect(panel.getByTestId('sound-fill-chip')).toContainText('Add layer:');
	await list.getByRole('option').nth(1).click();
	await page.keyboard.press('Enter');
	await expect
		.poll(async () => (await appliedLabels(page)).at(-1), { timeout: 60_000 })
		.toMatch(/^Add Layer /);
	seq = await sequence(page);
	const layer = sfxClips(seq).find((c) => c.sfx!.cueId === cut.id && c.id !== cutClipId)!;
	expect(layer, JSON.stringify(sfxClips(seq).map((c) => c.sfx))).toBeTruthy();
	expect(layer.trackId).not.toBe(seq.clips[cutClipId]!.trackId);
	expect(layer.linkId).toBeTruthy();
	expect(layer.linkId).toBe(seq.clips[cutClipId]!.linkId);
	if (layer.sfx!.placement.align !== 'end') {
		expect(pointFrame(seq, layer)).toBeGreaterThanOrEqual(90 - 1e-6);
		expect(pointFrame(seq, layer)).toBeLessThan(91);
	}
	const final = seq;

	// 6. Undo back to before the fill (layer, swaps, fill), then redo all three: the same sequence each way
	await focusTimeline(page);
	for (let i = 0; i < 3; i++) await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => canon(await sequence(page))).toBe(canon(beforeFill));
	for (let i = 0; i < 3; i++) await page.keyboard.press('Control+Shift+KeyZ');
	await expect.poll(async () => canon(await sequence(page))).toBe(canon(final));
	await page.keyboard.press('Backslash');
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(outDir, 'final-timeline.png') });

	// 7. Export (auto: the planner picks the path that renders the motion graphic): every peak- / start-aligned fill
	//    sits on its cue frame in the decoded mix
	seq = await sequence(page);
	const { file, job } = await exportViaUi(page, request, {
		engine: 'auto',
		fileName: 'sound-p2-done.mp4',
		expectPath: /\w/,
		outDir,
		jobTimeoutMs: 900_000,
	});
	const mix = decodeMono(file);
	const F = (FLICKS * seq.settings.frameRate.den) / seq.settings.frameRate.num;
	type MediaRow = {
		locators: { type: string; key?: string }[];
		container?: string;
		library?: { title?: string; leadSilenceSec?: number };
	};
	const mediaDoc = await query<Record<string, MediaRow>>(page, 'doc.get', { path: ['media'] });
	const report: Record<string, unknown>[] = [];
	const refs = new Map<string, Float32Array>();
	for (const c of sfxClips(seq)) {
		if (c.sfx!.placement.align === 'end') continue;
		const cue = seq.soundDesign!.cues![c.sfx!.cueId!]!;
		const m = mediaDoc[c.mediaId]!;
		const key = m.locators.find((l) => l.type === 'engine-store')?.key;
		expect(key, JSON.stringify(m.locators)).toBeTruthy();
		const refKey = `${c.mediaId}@${c.speed.rate}`;
		let ref = refs.get(refKey);
		if (!ref) {
			const resp = await request.get(`/media/${encodeURIComponent(key!)}`);
			expect(resp.ok()).toBe(true);
			const local = join(outDir, `${c.mediaId}.media`);
			writeFileSync(local, await resp.body());
			ref = decodeMono(local, c.speed.rate);
			refs.set(refKey, ref);
		}
		const refPoint = Math.round(((c.sfx!.placement.peakFlicks / FLICKS) * SR) / c.speed.rate);
		const W = 2400; // 50 ms around the aligned point
		const w0 = Math.max(0, Math.min(ref.length - W, refPoint - W / 2));
		const w1 = Math.min(ref.length, w0 + W);
		const expected = pointFrame(seq, c) * (F / FLICKS) * SR;
		const cueSample = (cue.frame * F * SR) / FLICKS;
		const found = locate(mix, ref, w0, w1, Math.round(expected - refPoint), 2400);
		const at = found.lag + refPoint;
		const point = pointFrame(seq, c);
		// another SFX clip sounding within a frame of this one's aligned point lowers the correlation
		const overlapped = sfxClips(seq).some(
			(o) => o.id !== c.id && o.start < point + 1 && o.start + o.duration > point - 1,
		);
		report.push({
			cue: cue.frame,
			title: m.library?.title,
			container: m.container,
			lead: m.library?.leadSilenceSec ?? 0,
			sourceIn: c.sourceIn,
			overlapped,
			kind: cue.kind,
			align: c.sfx!.placement.align,
			layer: c.sfx!.layer,
			rate: c.speed.rate,
			errorSamples: Math.round((at - expected) * 100) / 100,
			fromCueSamples: Math.round((at - cueSample) * 100) / 100,
			r: Math.round(found.r * 10_000) / 10_000,
		});
	}
	console.log('export path', JSON.stringify(job.result).slice(0, 400));
	console.log('export points', JSON.stringify(report));
	test.info().annotations.push({ type: 'export points', description: JSON.stringify(report) });
	writeFileSync(join(outDir, 'export-points.json'), JSON.stringify(report, null, 1));
	expect(report.length).toBeGreaterThanOrEqual(5);
	for (const row of report) {
		// a sound alone is found (chance correlation over 2 400 samples is ≈ 0.02; AAC smears short ticks to 0.55–0.7,
		// measured); overlapping sounds lower it further, but the lag must still be exact (AAC, varispeed: ≤ 2 samples)
		if (!row.overlapped) expect(row.r as number, JSON.stringify(row)).toBeGreaterThan(0.3);
		expect(Math.abs(row.errorSamples as number), JSON.stringify(row)).toBeLessThanOrEqual(2);
		expect(row.fromCueSamples as number, JSON.stringify(row)).toBeGreaterThanOrEqual(-2);
		expect(row.fromCueSamples as number, JSON.stringify(row)).toBeLessThan((F / FLICKS) * SR);
	}
});
