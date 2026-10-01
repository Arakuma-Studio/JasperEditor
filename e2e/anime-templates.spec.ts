// Anime templates E2E (S11 §11 test 3, wp-m2-anime-templates): drag `title-reveal` from the gallery (badge R, hover
// preview), edit its text and colour in Properties, keyframe a colour param (Effect Controls/Properties
// stopwatch), stretch the clip (intro and outro frame-exact), apply a Gaussian blur and a corner pin (visible in the
// Program), export, and compare an exported frame with `renderStill`. fframes templates keep their twin + badge.
//
// Export path: with the layer-bake extension ready (`features.layerBake.state === 'ready'`, wp-m2-layer-bake) the
// plan must be native/hybrid; without it (this package alone) Auto plans the Remotion path because the anime
// template has a native blocker. The test records which one it checked as an annotation — it never skips.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { makeEnvelope, type ProjectDocument } from '../packages/project/src/index.ts';
import {
	appliedLabels,
	clipBox,
	clips,
	createProject,
	enableAgentBridge,
	focusTimeline,
	pointerDrag,
	query,
	ROOT,
	timelineArea,
	waitForJob,
	watchPage,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const EXPORT_DIR = join(ROOT, 'test-results', 'e2e-anime-templates');
mkdirSync(EXPORT_DIR, { recursive: true });

let page: Page;
let watcher: { errors: string[] };
let clipId = '';
let seqId = '';
/** Program markup of the template at a few frames before the stretch (frame → innerHTML). */
const before = new Map<number, string>();

type MgClipDoc = {
	start: number;
	duration: number;
	template: { id: string; version: number; renderer?: string };
	params: Record<string, unknown>;
	paramKeyframes?: Record<string, { time: number; value: unknown }[]>;
	effects?: { id: string; effectId: string }[];
};

const clipDoc = async (): Promise<MgClipDoc> =>
	query<MgClipDoc>(page, 'doc.get', { path: ['sequences', seqId, 'clips', clipId] });

const program = () => page.getByTestId('program-player-wrapper');
const templateIn = () => program().locator('[data-anime-template="title-reveal@1"]');

/** Moves the playhead and returns the template markup the Program shows at that frame. */
async function markupAt(frame: number): Promise<string> {
	await query(page, 'playhead.set', { frame });
	await expect.poll(async () => (await query<{ frame: number }>(page, 'playhead.get')).frame).toBe(frame);
	// The Player re-renders on the next animation frame; wait until two reads agree.
	let last = '';
	await expect
		.poll(async () => {
			const html = await templateIn()
				.innerHTML()
				.catch(() => '');
			const stable = html !== '' && html === last;
			last = html;
			return stable;
		})
		.toBe(true);
	return last;
}

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	watcher = watchPage(page);
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	await page?.close();
});

test('the gallery lists anime templates (badge R, hover preview) and title-reveal drags onto the timeline', async () => {
	await createProject(page, 'E2E Anime Templates');
	seqId = (await query<{ sequenceId: string }>(page, 'sequence.summary')).sequenceId;
	await page.getByTestId('tab-motionTemplates').click();
	const card = page.locator('[data-template="title-reveal@1"]');
	await expect(card).toBeVisible();
	await expect(card.locator('[data-engine-badge="R"]')).toHaveText('R');
	await expect(card.locator('[data-engine-label]')).toHaveText('anime · Remotion');
	// Poster = a Remotion <Thumbnail> of the template; hovering plays the shared Player.
	await expect(
		card.locator('[data-preview-thumb="poster"] [data-anime-template="title-reveal@1"]'),
	).toBeAttached();
	await card.locator('[data-mg-preview]').hover();
	await expect(card.locator('[data-preview-thumb="playing"]')).toBeAttached({ timeout: 5_000 });
	// fframes cards keep the SVG twin poster and gain the hover preview too.
	const lt = page.locator('[data-template="lower-third@1"]');
	await expect(lt.locator('[data-preview-thumb="poster"] svg')).toBeAttached();
	await lt.locator('[data-mg-preview]').hover();
	await expect(lt.locator('[data-preview-thumb="playing"]')).toBeAttached({ timeout: 5_000 });
	// Engine filter `anime`.
	await page.getByTestId('motion-templates-engine').selectOption('anime');
	await expect(page.locator('[data-template]')).toHaveCount(4);
	await page.getByTestId('motion-templates-engine').selectOption('all');

	const area = (await timelineArea(page).boundingBox())!;
	await card.dragTo(timelineArea(page), { targetPosition: { x: 40, y: area.height - 220 } });
	await expect
		.poll(async () => (await clips(page)).filter((c) => c.kind === 'motion-graphic').length)
		.toBe(1);
	clipId = (await clips(page)).find((c) => c.kind === 'motion-graphic')!.id;
	const doc = await clipDoc();
	expect(doc.template).toEqual({ id: 'title-reveal', version: 1, renderer: 'anime' });
	expect(doc.duration).toBe(Math.round((5 * 30000) / 1001)); // 5 s at 29.97
	await query(page, 'playhead.set', { frame: doc.start + 60 });
	await expect(templateIn()).toBeVisible({ timeout: 60_000 });
	await expect(program().locator(`[data-clip-id="${clipId}"] [data-mg-renderer="anime"]`)).toBeAttached();
	// The timeline shows the R badge for anime templates.
	await expect(
		page
			.locator(`[data-testid="timeline-track-area"] [data-clip-id="${clipId}"] [data-engine-badge]`)
			.first(),
	).toHaveAttribute('data-engine-badge', 'R');
});

test('edit the title text and colour in Properties', async () => {
	const cb = await clipBox(page, clipId);
	await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2);
	await expect(page.getByTestId('mg-template-section')).toBeVisible();
	await expect(page.getByTestId('mg-template-engine')).toContainText('anime · Remotion');
	await expect(page.getByTestId('mg-template-rerender')).toHaveCount(0); // fframes-only action hidden
	const title = page.getByTestId('prop-params.title');
	await title.fill('Anime Works');
	await title.press('Enter');
	await page.getByTestId('prop-params.titleColor').fill('#ff3300');
	await expect.poll(async () => (await clipDoc()).params.title).toBe('Anime Works');
	await expect.poll(async () => (await clipDoc()).params.titleColor).toEqual([1, 0.2, 0, 1]);
	const doc = await clipDoc();
	await query(page, 'playhead.set', { frame: doc.start + 70 });
	await expect(program().locator('[data-part="title"]')).toHaveText('Anime Works');
	await expect(program().locator('[data-part="title"]')).toHaveCSS('color', 'rgb(255, 51, 0)');
});

test('keyframe a colour param with the stopwatch: the Program colour changes over time', async () => {
	const doc = await clipDoc();
	const f0 = doc.start + 40;
	const f1 = doc.start + 100;
	await query(page, 'playhead.set', { frame: f0 });
	const labels = (await appliedLabels(page)).length;
	// Effect Controls ▸ Template · Title Reveal: the stopwatch of a colour param (S05:ECP-008).
	await page.getByTestId('tab-effectControls').click();
	const ec = page.getByTestId('effect-controls-panel');
	await ec.getByTestId('stopwatch-params.accentColor').click();
	await expect.poll(async () => (await clipDoc()).paramKeyframes?.accentColor?.length ?? 0).toBe(1);
	await query(page, 'playhead.set', { frame: f1 });
	await ec.getByTestId('prop-params.accentColor').fill('#00ff00');
	await expect.poll(async () => (await clipDoc()).paramKeyframes?.accentColor?.length ?? 0).toBe(2);
	expect((await appliedLabels(page)).length).toBe(labels + 2);
	const stroke = async (frame: number) => {
		await query(page, 'playhead.set', { frame });
		const line = program().locator('[data-part="underline"] line');
		await expect(line).toBeAttached();
		let v = '';
		await expect
			.poll(async () => {
				const s = (await line.getAttribute('stroke')) ?? '';
				const stable = s === v;
				v = s;
				return stable && s !== '';
			})
			.toBe(true);
		return v;
	};
	const a = await stroke(f0);
	const b = await stroke(f1);
	const mid = await stroke(Math.round((f0 + f1) / 2));
	expect(a).toBe('rgba(56, 135, 255, 1)'); // the template default accent, keyed at f0
	expect(b).toBe('rgba(0, 255, 0, 1)');
	expect(new Set([a, b, mid]).size).toBe(3); // evaluated between the keys
});

test('stretching the clip keeps the intro and the outro frame-exact', async () => {
	const doc = await clipDoc();
	const intro = [doc.start + 2, doc.start + 12, doc.start + 30];
	const fromEnd = [1, 6, 14];
	for (const f of intro) before.set(f, await markupAt(f));
	for (const k of fromEnd) before.set(-k, await markupAt(doc.start + doc.duration - k));
	await focusTimeline(page);
	await page.keyboard.press('KeyV');
	const b = await clipBox(page, clipId);
	const pxPerFrame = b.width / doc.duration;
	await pointerDrag(
		page,
		{ x: b.x + b.width - 2, y: b.y + b.height / 2 },
		{ x: b.x + b.width - 2 + 60 * pxPerFrame, y: b.y + b.height / 2 },
	);
	await expect.poll(async () => (await clipDoc()).duration).toBeGreaterThan(doc.duration + 30);
	const after = await clipDoc();
	expect(after.start).toBe(doc.start);
	for (const f of intro) expect(await markupAt(f), `intro frame ${f}`).toBe(before.get(f));
	for (const k of fromEnd)
		expect(await markupAt(after.start + after.duration - k), `${k} frames before the end`).toBe(
			before.get(-k),
		);
	// The hold in the middle of the longer clip equals the end of the intro (the keyframed accent colour —
	// keys in content time — is the only thing that may differ between the two hold frames).
	const noAccent = (html: string) => html.replace(/ stroke="[^"]*"/, '');
	expect(noAccent(await markupAt(after.start + Math.floor(after.duration / 2)))).toBe(
		noAccent(await markupAt(doc.start + Math.floor(doc.duration / 2))),
	);
});

test('a Gaussian blur and a corner pin apply to the anime template in the Program', async () => {
	const doc = await clipDoc();
	await query(page, 'playhead.set', { frame: doc.start + 60 });
	await page.getByTestId('tab-effects').click();
	for (const [search, id] of [
		['Gaussian', 'jasper.gaussian-blur'],
		['Corner Pin', 'jasper.corner-pin'],
	] as const) {
		await page.getByTestId('effects-search').fill(search);
		const fx = page.locator(`[data-effect-id="${id}"]`);
		await expect(fx).toBeVisible();
		const cb = await clipBox(page, clipId);
		const n = (await appliedLabels(page)).length;
		await fx.dragTo(page.locator(`[data-testid="timeline-track-area"] [data-clip-id="${clipId}"]`).first(), {
			targetPosition: { x: Math.min(20, cb.width / 2), y: cb.height / 2 },
		});
		await expect.poll(async () => (await appliedLabels(page)).length).toBe(n + 1);
	}
	const effects = (await clipDoc()).effects ?? [];
	expect(effects.map((e) => e.effectId)).toEqual(['jasper.gaussian-blur', 'jasper.corner-pin']);
	// Pull the upper-left corner in so the pin is visibly projective (agent API edit = one history entry).
	const pin = effects.find((e) => e.effectId === 'jasper.corner-pin')!;
	const r = await page.evaluate(
		([fxId]) =>
			(
				window as unknown as {
					jasper: { transact(tx: unknown): Promise<{ ok: boolean }> };
				}
			).jasper.transact({
				label: 'Corner pin',
				commands: [{ type: 'param.set', target: ['effect', fxId, 'topLeft'], value: [0.12, 0.08] }],
			}),
		[pin.id] as const,
	);
	expect(r.ok).toBe(true);
	const layer = program().locator(`[data-clip-id="${clipId}"]`).first();
	await expect(layer.locator('[data-effect="jasper.gaussian-blur"]')).toBeAttached();
	await expect
		.poll(async () => layer.evaluate((el) => (el as HTMLElement).style.transform))
		.toMatch(/^matrix3d\(/);
	await expect(layer.locator('[data-anime-template="title-reveal@1"]')).toBeAttached();
});

test('fframes templates are unaffected: twin SVG and F badge through LayerBox', async () => {
	await page.getByTestId('tab-motionTemplates').click();
	const lt = page.locator('[data-template="lower-third@1"]');
	const area = (await timelineArea(page).boundingBox())!;
	await lt.dragTo(timelineArea(page), { targetPosition: { x: 40, y: area.height - 160 } });
	await expect
		.poll(async () => (await clips(page)).filter((c) => c.kind === 'motion-graphic').length)
		.toBe(2);
	const fframes = (await clips(page)).find((c) => c.kind === 'motion-graphic' && c.id !== clipId)!;
	await query(page, 'playhead.set', { frame: fframes.start + 40 });
	const layer = program().locator(`[data-clip-id="${fframes.id}"]`).first();
	await expect(layer.locator('[data-mg-renderer="fframes"] svg')).toBeAttached();
	await expect(layer.locator('[data-mg-badge]')).toBeAttached();
	// Remove it again so the export below only has the anime template over black.
	await page.keyboard.press('Control+KeyZ');
	await expect
		.poll(async () => (await clips(page)).filter((c) => c.kind === 'motion-graphic').length)
		.toBe(1);
});

/** RGB frames decoded with ffmpeg (rgb24, sequence size). */
function rgbFrame(file: string, args: string[]): Buffer {
	return execFileSync(
		process.env.JASPER_FFMPEG ?? 'ffmpeg',
		['-v', 'error', '-i', file, ...args, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
		{ maxBuffer: 64 << 20 },
	);
}

async function exportProRes(
	request: APIRequestContext,
	expectPath: RegExp,
): Promise<{ file: string; renderPath: string }> {
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyM');
	await expect(page.getByTestId('export-mode')).toBeVisible();
	await page.getByTestId('export-engine').selectOption('auto');
	await page.getByTestId('export-codec').selectOption('prores');
	await page.getByTestId('export-filename').fill('anime-templates.mov');
	await expect(page.getByTestId('plan-path')).toContainText(expectPath, { timeout: 60_000 });
	const known = new Set(
		((await (await request.get('/api/jobs')).json()).jobs as { id: string }[]).map((j) => j.id),
	);
	await page.getByTestId('export-start').click();
	let jobId = '';
	await expect
		.poll(async () => {
			const jobs = (await (await request.get('/api/jobs')).json()).jobs as { id: string; kind: string }[];
			jobId = jobs.find((j) => j.kind === 'export' && !known.has(j.id))?.id ?? '';
			return jobId;
		})
		.not.toBe('');
	const job = await waitForJob(request, jobId, 600_000);
	expect(job.state, JSON.stringify(job.error ?? null)).toBe('succeeded');
	const res = await request.get(`/renders/${jobId}/output`);
	expect(res.ok()).toBe(true);
	const file = join(EXPORT_DIR, 'anime-templates.mov');
	const { writeFileSync } = await import('node:fs');
	writeFileSync(file, await res.body());
	return { file, renderPath: String(job.result?.renderPath ?? '') };
}

test('export (native with layer-bake, else Remotion) matches renderStill', async ({ request }) => {
	test.setTimeout(900_000);
	const caps = await (await request.get('/api/capabilities')).json();
	const bake = caps.features?.layerBake?.state === 'ready';
	test.info().annotations.push({
		type: 'export-path',
		description: bake
			? 'layer-bake ready: the anime template is baked, the plan must be native/hybrid'
			: 'layer-bake not available (this package alone): Auto plans the Remotion path for the anime template',
	});
	const out = await exportProRes(request, bake ? /native|hybrid/i : /remotion/i);
	expect(out.renderPath).toMatch(bake ? /native|hybrid/ : /remotion/);

	// renderStill of the same frame (engine POST /api/stills over the live document).
	const doc = await query<ProjectDocument>(page, 'doc.get');
	const clip = doc.sequences[seqId]!.clips[clipId] as unknown as MgClipDoc;
	const frame = clip.start + 24; // inside the intro: chars, subtitle and underline mid-animation
	const envelope = makeEnvelope(doc, { revision: 1, savedAt: new Date().toISOString(), platform: 'e2e' });
	const still = await request.post('/api/stills', { data: { envelope, sequenceId: seqId, frame } });
	expect(still.status()).toBe(202);
	const stillJob = await waitForJob(request, (await still.json()).id, 300_000);
	expect(stillJob.state, JSON.stringify(stillJob.error ?? null)).toBe('succeeded');
	const png = join(EXPORT_DIR, `still-${frame}.png`);
	const { writeFileSync } = await import('node:fs');
	writeFileSync(png, await (await request.get(String(stillJob.result?.url))).body());

	const a = rgbFrame(out.file, ['-vf', `select=eq(n\\,${frame})`, '-frames:v', '1']);
	const b = rgbFrame(png, []);
	expect(a.length).toBe(b.length);
	let within = 0;
	let max = 0;
	for (let i = 0; i < a.length; i += 3) {
		const d = Math.max(
			Math.abs(a[i]! - b[i]!),
			Math.abs(a[i + 1]! - b[i + 1]!),
			Math.abs(a[i + 2]! - b[i + 2]!),
		);
		if (d <= 3) within++;
		max = Math.max(max, d);
	}
	const ratio = within / (a.length / 3);
	console.info(
		`[anime-templates] export ${out.renderPath} vs renderStill frame ${frame}: ${(ratio * 100).toFixed(2)} % within 3/255, max ${max}`,
	);
	test.info().annotations.push({
		type: 'still-parity',
		description: `${(ratio * 100).toFixed(2)} % within 3/255 (max ${max})`,
	});
	expect(ratio).toBeGreaterThanOrEqual(0.99);
	// The frame is not trivially black: the title is drawn.
	let lit = 0;
	for (let i = 0; i < b.length; i += 3) if (b[i]! + b[i + 1]! + b[i + 2]! > 60) lit++;
	expect(lit).toBeGreaterThan(1000);
});

test('no uncaught page errors', () => {
	expect(watcher.errors.filter((e) => e.startsWith('pageerror'))).toEqual([]);
});
