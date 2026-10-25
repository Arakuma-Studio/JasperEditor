// Sound design Phase 0 close-out (spec 12 Phase 0): the Program monitor's audio around transport events, with a
// graph read-ahead (latency compensation, WP0.1). The page's AudioContext output is tapped by an AudioWorklet that
// records every sample with its context frame (`currentFrame`), so times are exact context times.
//
// probe.wav (6 s): clicks of 0.5 at 0.03 s + k·0.25 s up to 2 s; a 1 kHz sine of 0.25 from 2 s to 4 s; silence after.
// It plays on A1 (two Hard Limiters with 20 ms look-ahead: 998 samples each; one is added during a test) and A2;
// the Mix has a Hard Limiter too. Below the ceiling a Hard Limiter is a pure delay, so the Mix is the source summed,
// delayed by the inserts and compensated by the read-ahead.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { arm, disarm, mark, peaks, type Recording, TAP, timeOf } from './sound-tap.ts';
import {
	browserLaunch,
	clipBox,
	clips,
	createProject,
	enableAgentBridge,
	focusTimeline,
	query,
	ROOT,
	serverInfo,
	transact,
} from './support.ts';

test.use({ launchOptions: browserLaunch(['--autoplay-policy=no-user-gesture-required']) });
// Each test measures on its own: a failing one restarts the worker, and the next test sets its project up again.

let page: Page;
const outDir = join(ROOT, 'test-results', 'e2e-sound-p0-transport');
const SR = 48000;

async function seekPaused(p: Page, frame: number): Promise<void> {
	await query(p, 'playhead.set', { frame });
	await p.waitForTimeout(600);
}

/** Space, `ms` of playback, Space; the tap records from just before the first Space. */
async function playFor(p: Page, ms: number, during?: (p: Page) => Promise<void>): Promise<Recording> {
	await focusTimeline(p);
	await arm(p);
	await p.keyboard.press('Space');
	if (during) await during(p);
	await p.waitForTimeout(ms);
	await focusTimeline(p);
	await p.keyboard.press('Space');
	await p.waitForTimeout(200);
	return disarm(p);
}

function ff(args: string[]): void {
	const r = spawnSync(process.env.JASPER_FFMPEG ?? 'ffmpeg', ['-v', 'error', '-y', ...args]);
	expect(r.status, String(r.stderr)).toBe(0);
}

let fps = { num: 30000, den: 1001 };
const frameAt = (s: number) => Math.round((s * fps.num) / fps.den);

test.beforeAll(async ({ browser }) => {
	mkdirSync(outDir, { recursive: true });
	page = await browser.newPage();
	if (process.env.E2E_MIXDBG)
		page.on('console', (m) => m.text().startsWith('[mixdbg]') && console.log(m.text()));
	await page.addInitScript(TAP);
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	await page?.close();
});

let ready = false;

/** probe.wav on A1 (Hard Limiter) and A2, a Hard Limiter on the Mix (once per worker). */
async function setup(): Promise<void> {
	if (ready) return;
	ready = true;
	const name = process.env.E2E_PROBE_EXT === 'mp4' ? 'probe.mp4' : 'probe.wav';
	const wav = join(outDir, name);
	const clicks = 'if(lt(t\\,2)*eq(mod(n-1440\\,12000)\\,0)\\,0.5\\,0)';
	const tone = 'if(gte(t\\,2)*lt(t\\,4)\\,0.25*sin(2*PI*1000*t)\\,0)';
	ff([
		'-f',
		'lavfi',
		'-i',
		`aevalsrc='${clicks}+${tone}':s=48000:d=6`,
		'-ac',
		'2',
		...(name.endsWith('.mp4') ? ['-c:a', 'aac', '-b:a', '256k'] : ['-c:a', 'pcm_s16le']),
		wav,
	]);
	await createProject(page, 'E2E Sound P0 transport');
	await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Control+KeyI');
	await (await chooser).setFiles([wav]);
	await expect(page.getByTestId('project-row').filter({ hasText: name })).toBeVisible({ timeout: 60_000 });
	const items = await query<Record<string, { id: string; name: string }>>(page, 'doc.get', {
		path: ['items'],
	});
	const item = Object.values(items).find((i) => i.name === name)!;
	const r = await transact(page, [
		{ type: 'clip.place', source: { projectItemId: item.id }, at: 0, tracks: { audio: 'A1' } },
		{ type: 'clip.place', source: { projectItemId: item.id }, at: 0, tracks: { audio: 'A2' } },
		{
			type: 'effect.add',
			target: { trackId: 'A1' },
			effectId: 'jasper.audio.hard-limiter',
			params: { lookAhead: 20 },
			ref: '$a1',
		},
		{
			type: 'effect.add',
			target: 'master',
			effectId: 'jasper.audio.hard-limiter',
			params: { lookAhead: 20 },
			ref: '$mix',
		},
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	const s = await query<{ settings: { frameRate: { num: number; den: number } } }>(page, 'sequence.summary');
	fps = s.settings.frameRate;
	// let the media players and the graph settle
	await seekPaused(page, 1);
	await seekPaused(page, 0);
}

/**
 * Samples (context time, Program frame) pairs for `ms` while playing: `min(time − frame / fps)` is the context time at
 * which the picture shows sequence time 0 (a frame is shown from its start until the next one). Only frames after the
 * play position count: while a primed start waits, the picture holds the play position's frame, which says nothing
 * about when it started.
 */
async function pictureAnchor(p: Page, ms: number, fromFrame: number, skipMs: number): Promise<number> {
	return p.evaluate(
		async ([dur, num, den, from, skip]) => {
			const w = window as unknown as {
				__tap: { ctxs: { ctx: BaseAudioContext; starts: number }[] };
				jasper: { query(n: string, a?: unknown): Promise<{ frame: number; playing: boolean }> };
			};
			// anime-allow: test-side wall clock bound of a sampling loop
			const t0 = performance.now();
			const end = t0 + dur;
			// the Program monitor's context: the running one Remotion schedules media buffers on
			const program = () =>
				w.__tap.ctxs
					.filter((c) => c.ctx.state === 'running' && c.starts > 0)
					.sort((a, b) => b.starts - a.starts)[0]?.ctx;
			let ctx = program();
			// anime-allow: test-side wall clock bound of a sampling loop
			while (!ctx && performance.now() < end) {
				await new Promise<number>((r) => requestAnimationFrame(r));
				ctx = program();
			}
			if (!ctx) return Number.NaN;
			let best = Number.POSITIVE_INFINITY;
			// anime-allow: test-side wall clock bound of a sampling loop
			while (performance.now() < end) {
				await new Promise<number>((r) => requestAnimationFrame(r));
				const { frame, playing } = await w.jasper.query('playhead.get');
				// The context time of the sample at the output now (precise, unlike currentTime's steps), read after the
				// frame: the Player set that frame at or before this moment and shows it from then on, so
				// `t − frame / fps` is never earlier than the picture's anchor, and the smallest over many samples
				// approaches it (a main thread that runs late only makes a sample later). Reading the time at the
				// animation frame's start instead, before the Player's own callback set the frame, could undershoot it by
				// that callback's delay (≈ 10–20 ms under load).
				// anime-allow: test-side wall clock of a sample
				const now = performance.now();
				const o = (ctx as AudioContext).getOutputTimestamp();
				const t = (o.contextTime ?? 0) + (now - (o.performanceTime ?? 0)) / 1000;
				if (playing && frame > from && now - t0 >= skip) best = Math.min(best, t - (frame * den) / num);
			}
			return best;
		},
		[ms, fps.num, fps.den, fromFrame, skipMs] as const,
	);
}

/** Hard Limiter latency at 20 ms look-ahead (samples, 48 kHz): every one on the path adds it to the read-ahead. */
const HL20 = 998;
/** A primed start waits beyond the read-ahead (sound-design Phase 6, `START_MARGIN`). */
const MARGIN = 1024;

test('Play: the first samples at the play position are heard (nothing lost to the read-ahead)', async () => {
	test.setTimeout(300_000);
	await setup();
	/** Plays from 0 and returns the recording and the picture's sequence-time-0 context time. */
	const measure = async () => {
		await seekPaused(page, frameAt(1));
		await seekPaused(page, 0);
		let picture = Number.NaN;
		const rec = await playFor(page, 200, async (p) => {
			picture = await pictureAnchor(p, 1050, 0, 150);
		});
		return { rec, picture };
	};
	/**
	 * Checks one primed play with the wait `wait` (s): every click is heard from the one 30 ms after the play position,
	 * exactly `wait` after the resume, and returns picture − audio (s): the picture's sequence time 0 minus the
	 * program's, both as context times at the output (the tap's frames are the context's, the picture's come from its
	 * output timestamp).
	 */
	const check = (m: { rec: Recording; picture: number }, wait: number): number => {
		// the clicks of the first 2 s (a slow page can play into the tone that follows them)
		const ps = peaks(m.rec).filter((p) => p.t - m.rec.armed < wait + 1.95);
		expect(ps.length).toBeGreaterThanOrEqual(3);
		// both tracks summed (0.707): every click, 0.25 s apart
		for (let i = 1; i < ps.length; i++)
			expect(
				Math.abs(ps[i]!.t - ps[i - 1]!.t - 0.25),
				JSON.stringify({ armed: m.rec.armed, ps }),
			).toBeLessThan(0.002);
		for (const p of ps) expect(p.v).toBeGreaterThan(0.6);
		// the click 30 ms after the play position is the first one heard, `wait` after the resume (sample-exact; the
		// tolerance is one render quantum)
		expect(Math.abs(ps[0]!.t - m.rec.armed - (wait + 0.03)), JSON.stringify(ps.slice(0, 3))).toBeLessThan(
			128 / SR,
		);
		return m.picture - (ps[0]!.t - 0.03);
	};
	// Two plays each: a frame report delayed by a stall only makes the picture look later, so the smaller is kept
	// (the stricter one for the lower bound below).
	const primed = async (wait: number) => {
		const m1 = await measure();
		const m2 = await measure();
		const o = [check(m1, wait), check(m2, wait)];
		console.log('primed wait', wait, 'picture − audio', o.join(' '));
		return { offset: Math.min(...o), m: m1 };
	};
	// The setup's read-ahead: Hard Limiters on A1 and the Mix (41.6 ms).
	const w1 = (2 * HL20 + MARGIN) / SR;
	const p1 = await primed(w1);
	console.log('play-start peaks', p1.m.rec.armed, JSON.stringify(peaks(p1.m.rec)));
	test.info().annotations.push({
		type: 'peaks',
		description: JSON.stringify({ armed: p1.m.rec.armed, ps: peaks(p1.m.rec) }),
	});
	// A/V: the picture waits for the program. It must never show sequence time 0 before the program's sequence time 0
	// is at the output. (Remotion starts the picture at its first animation frame after the output passed the resume
	// time; at the end of an unprimed start that lag, 15–90 ms measured here, is the picture's, so a primed start is
	// not compared with one: the wait hides that lag.)
	expect(p1.offset).toBeGreaterThan(-0.01);
	// A wait longer than Remotion's start lag tells a picture that waits apart from one that does not (without the
	// wait it would lead by ≈ wait − lag, 35–110 ms): four more Hard Limiters on the Mix, six in all (125 ms; ten crashed
	// the loaded host's renderer now and then).
	const more = await transact(
		page,
		Array.from({ length: 4 }, (_, i) => ({
			type: 'effect.add',
			target: 'master',
			effectId: 'jasper.audio.hard-limiter',
			params: { lookAhead: 20 },
			ref: `$m${i}`,
		})),
	);
	expect(more.ok, JSON.stringify(more)).toBe(true);
	const extra = more.ok ? Object.values(more.refs ?? {}) : [];
	expect(extra).toHaveLength(4);
	try {
		const w2 = (6 * HL20 + MARGIN) / SR;
		const p2 = await primed(w2);
		console.log('picture − audio', p1.offset, 'with a 125 ms wait', p2.offset);
		test
			.info()
			.annotations.push({ type: 'sync', description: JSON.stringify({ w1: p1.offset, w2: p2.offset }) });
		expect(p2.offset).toBeGreaterThan(-0.01);
		// and not a second wait after it (≥ 0.125 s more)
		expect(p2.offset).toBeLessThan(w2);
	} finally {
		await transact(
			page,
			extra.map((id) => ({ type: 'effect.remove', effectInstanceId: id })),
		);
	}
});

test('Play after a seek while paused: no audio from before the seek', async () => {
	test.setTimeout(240_000);
	await setup();
	// tone at 2–4 s; pause inside it (the graph holds read-ahead worth of tone), seek to the silence at 4.5 s, Play
	await seekPaused(page, frameAt(2.2));
	await playFor(page, 500);
	await seekPaused(page, frameAt(4.5));
	const rec = await playFor(page, 600);
	expect(rec.data.length, 'the tap must record audio quanta to prove silence').toBeGreaterThan(0);
	const max = rec.data.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
	let first = -1;
	for (let i = 0; i < rec.data.length; i++)
		if (Math.abs(rec.data[i]!) > 0.01) {
			first = i;
			break;
		}
	console.log(
		'after paused seek: max',
		max,
		'first loud at',
		first >= 0 ? timeOf(rec, first) - rec.armed : null,
	);
	test.info().annotations.push({ type: 'stale', description: JSON.stringify({ max }) });
	expect(max).toBeLessThan(0.01);
});

/** Runs of |x| < 0.01 longer than 2 ms (a 1 kHz tone of 0.35 crosses 0.01 for 9 µs): [start, end) context times. */
function gaps(r: Recording): { t0: number; t1: number }[] {
	const out: { t0: number; t1: number }[] = [];
	let from = -1;
	for (let i = 0; i <= r.data.length; i++) {
		const quiet = i < r.data.length && Math.abs(r.data[i]!) < 0.01;
		if (quiet && from < 0) from = i;
		if (!quiet && from >= 0) {
			if (i - from > 0.002 * r.rate) out.push({ t0: timeOf(r, from), t1: timeOf(r, i - 1) + 1 / r.rate });
			from = -1;
		}
	}
	return out;
}

test('a latency change during playback: playback restarts primed — the added latency and one primed wait, then on time', async () => {
	// Sound design Phase 6 → preview transport carry-overs: before, the Mix stayed late by the added latency until the
	// stop (one gap of it, 998 samples). Now the Program monitor restarts playback (pause, play: primed with the new
	// read-ahead, the picture holds): the gap of the added latency, then — at the restart — one gap of the new primed
	// wait (the read-ahead + 2 render quanta); after it the program is on time (its alignment against the anchor is
	// measured sample by sample in e2e/sound-p6-transport.spec.ts).
	test.setTimeout(300_000);
	await setup();
	const W = (3 * HL20 + MARGIN) / SR;
	await seekPaused(page, frameAt(2.0));
	let added = '';
	const rec = await playFor(page, 1200, async (p) => {
		await p.waitForTimeout(500);
		await mark(p, 'edit');
		const r = await transact(p, [
			{
				type: 'effect.add',
				target: { trackId: 'A1' },
				effectId: 'jasper.audio.hard-limiter',
				params: { lookAhead: 20 },
				ref: '$added',
			},
		]);
		expect(r.ok, JSON.stringify(r)).toBe(true);
		if (r.ok) added = r.refs!.$added!;
	});
	const edit = rec.marks.edit ?? -1;
	expect((await transact(page, [{ type: 'effect.remove', effectInstanceId: added }])).ok).toBe(true);
	const all = gaps(rec);
	// The constant tone must already be continuous before the edit; do not discard a broken recording.
	expect(
		all.filter((g) => g.t1 > edit - 0.3 && g.t0 < edit),
		JSON.stringify(all),
	).toEqual([]);
	const after = all.filter((g) => g.t0 >= edit && g.t0 < edit + 0.5);
	const restart = after.find((g) => Math.abs(g.t1 - g.t0 - W) < 0.004);
	const others = after.filter((g) => g !== restart).map((g) => g.t1 - g.t0);
	const found = restart ? { added: Math.max(0, ...others), restart: restart.t1 - restart.t0, others } : null;
	console.log('latency change: gaps', JSON.stringify(found));
	test.info().annotations.push({ type: 'gap', description: JSON.stringify(found) });
	expect(found).not.toBeNull();
	// the restart: one primed wait of the new read-ahead
	expect(Math.abs(found!.restart - W)).toBeLessThan(0.004);
	// before it, the live change: one gap of the added latency (998 samples, 20.8 ms) at most
	expect(found!.added).toBeLessThan(0.03);
});

test('Essential Sound Pan saved by an older build: opening the project keeps the pan keyframes; Pan on/off is an offset', async () => {
	test.setTimeout(240_000);
	await setup();
	const projectId = decodeURIComponent(/\/project\/([^/?#]+)/.exec(page.url())![1]!);
	const a1 = (await clips(page, ['A1']))[0]!;
	// pan automation on the A1 clip and the SFX type (the pan stays the clip's own)
	const r = await transact(page, [
		{ type: 'param.setAnimated', target: ['clip', a1.id, 'pan'], animated: true, at: { frames: 0 } },
		{ type: 'param.set', target: ['clip', a1.id, 'pan'], value: -50, at: { frames: 0 } },
		{ type: 'param.set', target: ['clip', a1.id, 'pan'], value: 20, at: { frames: 20 } },
		{ type: 'param.set', target: ['clip', a1.id, 'pan'], value: 50, at: { frames: 60 } },
		{ type: 'essentialSound.setType', clipIds: [a1.id], audioType: 'sfx' },
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	const panKeys = async () => {
		const seq = await query<{ clips: Record<string, { pan: { keyframes: { value: number }[] } }> }>(
			page,
			'doc.get',
			{ path: ['sequences', (await query<{ sequenceId: string }>(page, 'sequence.summary')).sequenceId] },
		);
		return seq.clips[a1.id]!.pan.keyframes.map((k) => k.value);
	};
	expect(await panKeys()).toEqual([-50, 20, 50]);
	// saved, then closed
	await expect
		.poll(async () => {
			const env = (await (await page.request.get(`/api/projects/${projectId}`)).json()) as {
				envelope: {
					document: { sequences: Record<string, { clips: Record<string, { essential?: unknown }> }> };
				};
			};
			return Object.values(env.envelope.document.sequences).some((q) => !!q.clips[a1.id]?.essential);
		})
		.toBe(true);
	await page.goto('/');
	await expect(page.getByTestId('home')).toBeVisible();
	// the file as the older build left it: SFX Pan on at 20, which it wrote into the pan (the key at frame 20), and no
	// `panOffset` marker
	const file = join(serverInfo().appdir, 'projects', projectId, 'project.jasper');
	const env = JSON.parse(readFileSync(file, 'utf8')) as {
		document: {
			sequences: Record<string, { clips: Record<string, { essential: Record<string, unknown> }> }>;
		};
	};
	const seq = Object.values(env.document.sequences).find((q) => q.clips[a1.id])!;
	const ess = seq.clips[a1.id]!.essential;
	delete ess.panOffset;
	ess.pan = { enabled: true, value: 20 };
	writeFileSync(file, JSON.stringify(env));
	await page.goto(`/project/${encodeURIComponent(projectId)}`);
	await expect(page.getByTestId('editor-shell')).toBeVisible();
	await expect.poll(() => page.evaluate(() => !!window.jasper)).toBe(true);
	expect(await panKeys()).toEqual([-50, 20, 50]);
	// Essential Sound shows the Pan section switched off (value kept): nothing moved
	const box = await clipBox(page, a1.id);
	await page.mouse.click(box.x + 20, box.y + box.height / 2);
	await page.getByTestId('workspace-tab-audio').click();
	const es = page.getByTestId('essential-sound');
	await expect(es).toBeVisible();
	const panOn = es.getByTestId('essential-section-pan').getByLabel('Pan on');
	await expect(panOn).not.toBeChecked();
	await page.screenshot({ path: join(outDir, 'essential-sound-legacy-pan.png') });
	// switched on it offsets every key by its value; off gives them back
	await panOn.click();
	await expect.poll(panKeys).toEqual([-30, 40, 70]);
	await panOn.click();
	await expect.poll(panKeys).toEqual([-50, 20, 50]);
});
