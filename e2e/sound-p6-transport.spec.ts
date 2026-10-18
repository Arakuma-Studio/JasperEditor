// Sound design Phase 6 → preview transport carry-overs (spec 12; wp-note "Phase 6 → preview transport carry-overs"):
// the Program monitor's audio around a big edit while playing, a latency added while playing, a long read-ahead on Play,
// a seek while playing, and many paused seeks + Play in a row. The page's AudioContext output is tapped by an
// AudioWorklet (`e2e/sound-tap.ts`) with exact context frames; the graph's transport events (`__jasperTransportLog`:
// Remotion's anchor as the graph keeps it, primed starts, refused re-anchors) say where each click must be.
//
// probe8.wav (8 s): clicks of 0.5 at 0.03 s + k·0.25 s, a second click 10 ms after the one at every whole second
// + 0.03 s (a marker that names the click), and a third 20 ms after the one at 4.03 s (the seek target's). It plays on A1 (a Hard Limiter, 20 ms look-ahead: 998 samples) and A2; the
// Mix has a Hard Limiter too. Below the ceiling a Hard Limiter is a pure delay: the Mix is the two tracks summed
// (0.707 per click after the −3 dB pan law), delayed by the inserts and compensated by the read-ahead (41.6 ms).
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { arm, disarm, mark, peaks, type Recording, TAP } from './sound-tap.ts';
import { createProject, enableAgentBridge, focusTimeline, query, ROOT, transact } from './support.ts';

test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });

let page: Page;
const outDir = join(ROOT, 'test-results', 'e2e-sound-p6-transport');
const SR = 48000;
/** Hard Limiter latency at 20 ms look-ahead (samples, 48 kHz). */
const HL20 = 998;
/** A primed start waits beyond the read-ahead (`START_MARGIN`; 0 to measure a build before it). */
const MARGIN = Number(process.env.E2E_P6_MARGIN ?? 1024);
/** Plays per test (the wp-note's counts come from several runs of the spec). */
const PLAYS = Number(process.env.E2E_P6_PLAYS ?? 6);
const DEBUG = !!process.env.E2E_P6_DEBUG;
/** Whether the build has the graph's transport log (the measurements that need Remotion's anchor). */
let logged = false;

type LogEntry = { t: number; kind: string; anchor: number; value?: number };

let fps = { num: 30000, den: 1001 };
const frameAt = (s: number) => Math.round((s * fps.num) / fps.den);

function ff(args: string[]): void {
	const r = spawnSync(process.env.JASPER_FFMPEG ?? 'ffmpeg', ['-v', 'error', '-y', ...args]);
	expect(r.status, String(r.stderr)).toBe(0);
}

test.beforeAll(async ({ browser }) => {
	mkdirSync(outDir, { recursive: true });
	page = await browser.newPage();
	await page.addInitScript(TAP);
	await page.addInitScript(() => {
		(window as unknown as { __jasperTransportLog: unknown[] }).__jasperTransportLog = [];
	});
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	await page?.close();
});

let ready = false;
async function setup(): Promise<void> {
	if (ready) return;
	ready = true;
	const wav = join(outDir, 'probe8.wav');
	const clicks =
		'if(lt(t\\,8)*(eq(mod(n-1440\\,12000)\\,0)+eq(mod(n-1920\\,48000)\\,0)+eq(n\\,194400))\\,0.5\\,0)';
	ff(['-f', 'lavfi', '-i', `aevalsrc='${clicks}':s=48000:d=9`, '-ac', '2', '-c:a', 'pcm_s16le', wav]);
	await createProject(page, 'E2E Sound P6 transport');
	await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Control+KeyI');
	await (await chooser).setFiles([wav]);
	await expect(page.getByTestId('project-row').filter({ hasText: 'probe8.wav' })).toBeVisible({
		timeout: 60_000,
	});
	const items = await query<Record<string, { id: string; name: string }>>(page, 'doc.get', {
		path: ['items'],
	});
	const item = Object.values(items).find((i) => i.name === 'probe8.wav')!;
	const r = await transact(page, [
		{ type: 'clip.place', source: { projectItemId: item.id }, at: 0, tracks: { audio: 'A1' } },
		{ type: 'clip.place', source: { projectItemId: item.id }, at: 0, tracks: { audio: 'A2' } },
		{
			type: 'effect.add',
			target: { trackId: 'A1' },
			effectId: 'jasper.audio.hard-limiter',
			params: { lookAhead: 20 },
		},
		{
			type: 'effect.add',
			target: 'master',
			effectId: 'jasper.audio.hard-limiter',
			params: { lookAhead: 20 },
		},
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	const s = await query<{ settings: { frameRate: { num: number; den: number } } }>(page, 'sequence.summary');
	fps = s.settings.frameRate;
	await seekPaused(page, 1);
	await seekPaused(page, 0);
	logged = await page.evaluate(() => {
		const log = (window as unknown as { __jasperTransportLog: unknown[] }).__jasperTransportLog;
		return log.length > 0;
	});
	console.log(
		'transport log in this build:',
		logged,
		'load',
		loadavg()
			.map((x) => x.toFixed(1))
			.join(' '),
	);
}

async function seekPaused(p: Page, frame: number): Promise<void> {
	await query(p, 'playhead.set', { frame });
	await p.waitForTimeout(600);
}

async function takeLog(p: Page): Promise<LogEntry[]> {
	return p.evaluate(() => {
		const w = window as unknown as { __jasperTransportLog: LogEntry[] };
		const out = w.__jasperTransportLog.slice();
		w.__jasperTransportLog.length = 0;
		return out;
	});
}

/**
 * Samples (context time at the output, Program frame) every animation frame until `stopSampler`, for `pictureLag`.
 */
async function startSampler(p: Page): Promise<void> {
	await p.evaluate(() => {
		const w = window as unknown as {
			__p6frames: [number, number, number][];
			__p6on: boolean;
			__tap: { ctxs: { ctx: BaseAudioContext; starts: number }[] };
			jasper: { query(n: string): Promise<{ frame: number; playing: boolean }> };
		};
		w.__p6frames = [];
		w.__p6on = true;
		const tick = async () => {
			if (!w.__p6on) return;
			try {
				const ctx = w.__tap.ctxs
					.filter((c) => c.ctx.state === 'running' && c.starts > 0)
					.sort((a, b) => b.starts - a.starts)[0]?.ctx as AudioContext | undefined;
				if (ctx) {
					const { frame, playing } = await w.jasper.query('playhead.get');
					// anime-allow: test-side wall clock of a sample
					const now = performance.now();
					const o = ctx.getOutputTimestamp();
					if (playing && o.performanceTime)
						w.__p6frames.push([(o.contextTime ?? 0) + (now - o.performanceTime) / 1000, frame, now]);
				}
			} catch {
				// the bridge between projects: no sample
			}
			requestAnimationFrame(() => void tick());
		};
		requestAnimationFrame(() => void tick());
	});
}

/** Space, `ms` of playback (with `during` from the start), Space; the tap records from just before the first Space. */
async function playFor(
	p: Page,
	ms: number,
	during?: (p: Page) => Promise<void>,
	opts: { armed?: boolean } = {},
): Promise<Recording> {
	await focusTimeline(p);
	if (!opts.armed) await arm(p);
	await startSampler(p);
	await p.evaluate(() => {
		// anime-allow: test-side wall clock of the Play press
		(window as unknown as { __p6space: number }).__p6space = performance.now();
	});
	await p.keyboard.press('Space');
	const t0 = Date.now();
	if (during) await during(p);
	const left = ms - (Date.now() - t0);
	if (left > 0) await p.waitForTimeout(left);
	await focusTimeline(p);
	await mark(p, 'pause');
	await p.keyboard.press('Space');
	await p.waitForTimeout(200);
	await p.evaluate(() => {
		(window as unknown as { __p6on: boolean }).__p6on = false;
	});
	return disarm(p);
}

/**
 * The clicks of a recording up to the pause, in context seconds, with which content click each one is: main clicks
 * (every 0.25 s) and markers (10 ms after the whole-second ones). `index` counts main clicks from the first one heard.
 */
function clicks(rec: Recording, min = 0.3): { t: number; v: number; marker: boolean }[] {
	const until = rec.marks.pause ?? Number.POSITIVE_INFINITY;
	const ps = peaks(rec, min).filter((x) => x.t <= until);
	return ps.map((x, i) => {
		const prev = ps[i - 1];
		return { ...x, marker: !!prev && Math.abs(x.t - prev.t - 0.01) < 0.0005 };
	});
}

/**
 * How far (s) the audio clock slipped against the wall clock over a play (`__p6frames`: medians of the first and last
 * five samples of wall − audio time; NaN with fewer than ten).
 */
async function clockSlip(p: Page, after = Number.NEGATIVE_INFINITY): Promise<number> {
	const f = await p.evaluate(
		() => (window as unknown as { __p6frames?: [number, number, number][] }).__p6frames ?? [],
	);
	// (not during a primed wait: the graph then reports the output timestamp shifted, for Remotion's start)
	const d = f.filter(([t]) => t > after).map(([t, , w]) => w / 1000 - t);
	if (d.length < 10) return Number.NaN;
	const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
	return med(d.slice(-5)) - med(d.slice(0, 5));
}

/** The primed start the program resumed with after context time `after`: the last one before the next `running`. */
function primedStart(log: LogEntry[], after: number): LogEntry | undefined {
	const run = log.findIndex((e) => e.kind === 'running' && e.t >= after);
	const before = run < 0 ? log : log.slice(0, run);
	return before.filter((e) => e.kind === 'primed' && e.t >= after).at(-1);
}

/** Wall time (ms) from the Play press to the first picture frame after the one it started on. */
async function playLatency(p: Page): Promise<number> {
	return p.evaluate(() => {
		const w = window as unknown as { __p6frames?: [number, number, number][]; __p6space?: number };
		const f = w.__p6frames ?? [];
		const first = f[0]?.[1];
		const moved = f.find((x) => x[1] !== first);
		return moved && w.__p6space !== undefined ? moved[2] - w.__p6space : Number.NaN;
	});
}

/** Content times of the probe's clicks (main clicks, whole-second markers, the third click at 4.05 s). */
const PROBE_EVENTS = [
	...Array.from({ length: 32 }, (_, k) => 0.03 + 0.25 * k),
	...Array.from({ length: 8 }, (_, m) => m + 0.04),
	4.05,
].sort((a, b) => a - b);

/** Gaps between consecutive main clicks that are not 0.25 s (± 2 samples), with where they are. */
function brokenSpacing(cs: { t: number; marker: boolean }[], from: number): string[] {
	const main = cs.filter((c) => !c.marker);
	const out: string[] = [];
	for (let i = 1; i < main.length; i++) {
		const d = (main[i]!.t - main[i - 1]!.t) * SR;
		if (Math.abs(d - 12_000) > 2)
			out.push(`${d.toFixed(0)} samples at ${(main[i - 1]!.t - from).toFixed(3)} s`);
	}
	return out;
}

/** Buffers Remotion started after their time (a starved main thread), inside [from, to]. */
function lateStarts(rec: Recording, from: number, to: number): string[] {
	return rec.late
		.filter((l) => l.t >= from && l.t <= to)
		.map((l) => `buffer started ${(l.by * 1000).toFixed(1)} ms late at ${(l.t - from).toFixed(3)} s`);
}

/**
 * Where each heard click is against Remotion's anchor as the graph keeps it (`anchor` entries; a primed start's
 * includes its wait): content click `k` (0.03 s + 0.25 s · k, sequence time = composition time here) must leave the
 * Mix at `anchor + time`. Returns the worst |offset| (s) of the main clicks heard after context time `after`.
 */
function anchorOffsets(
	rec: Recording,
	log: LogEntry[],
	after: number,
): { worst: number; n: number; rows: string[] } {
	const anchors = log.filter((e) => e.kind === 'anchor' || e.kind === 'primed' || e.kind === 'confirmed');
	let worst = 0;
	let n = 0;
	const rows: string[] = [];
	for (const c of clicks(rec)) {
		if (c.marker || c.t < after) continue;
		const a = [...anchors].reverse().find((e) => e.t <= c.t);
		if (!a) continue;
		const k = Math.round((c.t - a.anchor - 0.03) / 0.25);
		const off = c.t - a.anchor - (0.03 + 0.25 * k);
		worst = Math.max(worst, Math.abs(off));
		n++;
		if (rows.length < 12) rows.push(`${(0.03 + 0.25 * k).toFixed(2)}s:${(off * SR).toFixed(1)}`);
	}
	return { worst, n, rows };
}

test('a big edit while playing (an agent adds tracks) keeps the audio going on its samples', async () => {
	test.setTimeout(900_000);
	await setup();
	let measured = 0;
	let refused = 0;
	let replays = 0;
	const failures: string[] = [];
	const audioTracks = async () =>
		(await query<{ tracks?: { kind: string }[] }>(page, 'sequence.summary')).tracks?.filter(
			(t) => t.kind === 'audio',
		).length;
	const tracksBefore = await audioTracks();
	for (let a = 0; a < PLAYS * 3 && measured < PLAYS; a++) {
		await seekPaused(page, frameAt(1));
		await seekPaused(page, 0);
		await takeLog(page);
		const rec = await playFor(page, 3400, async (p) => {
			for (const [i, wait] of [700, 800, 800].entries()) {
				await p.waitForTimeout(wait);
				await mark(p, `edit${i}`);
				const r = await transact(
					p,
					Array.from({ length: 4 }, () => ({ type: 'track.add', kind: 'audio' })),
				);
				expect(r.ok, JSON.stringify(r)).toBe(true);
			}
		});
		const log = await takeLog(page);
		// back to two tracks (the next play measures the same graph): undo the three edits
		await focusTimeline(page);
		for (let u = 0; u < 3; u++) await page.keyboard.press('Control+KeyZ');
		await expect.poll(audioTracks).toBe(tracksBefore);
		const from = rec.armed;
		const to = (rec.marks.pause ?? 1e9) - 0.001;
		const cs = clicks(rec);
		const broken = brokenSpacing(cs, from);
		const late = lateStarts(rec, from, to);
		const n = log.filter((e) => e.kind === 'refused').length;
		refused += n;
		if (broken.length > 0 && late.length > 0) {
			replays++;
			console.log('host starved the page (buffers started late), again:', late.join('; '));
			continue;
		}
		measured++;
		const note = { play: measured, clicks: cs.length, refused: n, broken };
		console.log('big edit play', JSON.stringify(note));
		if (DEBUG && broken.length > 0)
			console.log(
				'debug',
				JSON.stringify({
					log: log.map((e) => ({
						...e,
						t: +(e.t - from).toFixed(4),
						anchor: +(e.anchor - from).toFixed(4),
						value: e.value === undefined ? undefined : +(e.value - from).toFixed(4),
					})),
					clicks: cs.map((c) => +(c.t - from).toFixed(4)),
					marks: Object.fromEntries(Object.entries(rec.marks).map(([k, v]) => [k, +(v - from).toFixed(4)])),
					stops: rec.stops.map((x) => [+(x.t - from).toFixed(4), x.player]),
					starts: rec.starts.length,
				}),
			);
		if (cs.filter((c) => !c.marker).length < 10) failures.push(`play ${measured}: ${cs.length} clicks`);
		if (broken.length > 0) failures.push(`play ${measured}: ${broken.join(', ')}`);
	}
	console.log(
		'big edit: measured',
		measured,
		'refused re-anchors',
		refused,
		'replayed',
		replays,
		'load',
		loadavg()[0],
	);
	test.info().annotations.push({
		type: 'big-edit',
		description: JSON.stringify({ measured, refused, replays, failures }),
	});
	expect(measured).toBe(PLAYS);
	expect(failures).toEqual([]);
});

test('a latency added while playing: after the restart the Mix is on time again', async () => {
	test.setTimeout(600_000);
	await setup();
	const results: string[] = [];
	for (let i = 0; i < Math.max(2, Math.ceil(PLAYS / 2)); i++) {
		await takeLog(page);
		await seekPaused(page, frameAt(1));
		await seekPaused(page, 0);
		let added: string[] = [];
		const rec = await playFor(page, 2600, async (p) => {
			await p.waitForTimeout(800);
			await mark(p, 'edit');
			// six more Hard Limiters on the Mix: + 6 × 998 samples (125 ms) of read-ahead
			const r = await transact(
				p,
				Array.from({ length: 6 }, (_, k) => ({
					type: 'effect.add',
					target: 'master',
					effectId: 'jasper.audio.hard-limiter',
					params: { lookAhead: 20 },
					ref: `$l${k}`,
				})),
			);
			expect(r.ok, JSON.stringify(r)).toBe(true);
			added = r.ok ? Object.values(r.refs ?? {}) : [];
		});
		const log = await takeLog(page);
		if (DEBUG)
			console.log(
				'debug latency',
				JSON.stringify({
					log: log.map((e) => ({
						...e,
						t: +(e.t - rec.armed).toFixed(4),
						anchor: +(e.anchor - rec.armed).toFixed(4),
					})),
					clicks: clicks(rec).map((c) => +(c.t - rec.armed).toFixed(4)),
					edit: +((rec.marks.edit ?? 0) - rec.armed).toFixed(4),
					frames: (
						await page.evaluate(
							() => (window as unknown as { __p6frames?: [number, number][] }).__p6frames ?? [],
						)
					)
						.filter((_, k) => k % 3 === 0)
						.map(([t, f]) => [
							+(t - rec.armed).toFixed(4),
							f,
							+(t - rec.armed - (f * fps.den) / fps.num).toFixed(4),
						]),
				}),
			);
		expect(
			(
				await transact(
					page,
					added.map((id) => ({ type: 'effect.remove', effectInstanceId: id })),
				)
			).ok,
		).toBe(true);
		const edit = rec.marks.edit ?? 0;
		const cs = clicks(rec);
		expect(cs.length, JSON.stringify(cs)).toBeGreaterThan(6);
		if (logged) {
			// every click before the edit and after the restart on its sample against the anchor in force
			const before = anchorOffsets(rec, log, rec.armed);
			const restart = log.find((e) => e.kind === 'restart' && e.t >= edit - 0.05);
			const primed = primedStart(log, edit - 0.05);
			expect(restart, JSON.stringify(log)).toBeTruthy();
			const after = anchorOffsets(rec, log, (primed?.t ?? edit) + 0.01);
			results.push(
				`play ${i + 1}: offsets ${JSON.stringify(after.rows)} worst ${(after.worst * SR).toFixed(1)}`,
			);
			console.log(
				'latency restart',
				JSON.stringify({ before: before.rows, after: after.rows, worst: after.worst }),
			);
			expect(after.n, JSON.stringify(log)).toBeGreaterThan(2);
			// on the sample (one render quantum: the tap's block start; the clicks are sample-exact)
			expect(after.worst * SR, JSON.stringify({ after, log })).toBeLessThan(2);
		}
		// and against the picture: the program is not behind it (before the fix it stayed late by the added 125 ms)
		const picture = await pictureLag(rec, edit, 0.6);
		results.push(`play ${i + 1}: picture − audio after the edit ${picture.toFixed(4)} s`);
		console.log('latency restart picture − audio', picture);
		// (a sample of the picture's anchor reads a few ms early now and then: Chrome's output timestamps jitter)
		expect(picture).toBeGreaterThan(-0.02);
	}
	test.info().annotations.push({ type: 'latency-restart', description: JSON.stringify(results) });
});

/**
 * Picture − audio (s) after `after` + `skip`: the picture's anchor (the smallest `contextTime − frame / fps` the
 * Program monitor showed while playing, sampled into `__p6frames`) minus the program's (a whole-second click, named by
 * its marker, minus its content time). Positive: the picture shows a time after the program played it.
 */
async function pictureLag(rec: Recording, after: number, skip = 0.6): Promise<number> {
	const samples = await page.evaluate(
		() => (window as unknown as { __p6frames?: [number, number][] }).__p6frames ?? [],
	);
	let picture = Number.POSITIVE_INFINITY;
	for (const [t, frame] of samples)
		if (t > after + skip) picture = Math.min(picture, t - (frame * fps.den) / fps.num);
	const cs = clicks(rec);
	const named = cs.findIndex((c, i) => !c.marker && c.t > after + skip && cs[i + 1]?.marker);
	if (named < 0 || !Number.isFinite(picture)) {
		console.log(
			'pictureLag: no measure',
			JSON.stringify({ samples: samples.length, named, picture, after, last: samples.slice(-3) }),
		);
		return Number.NaN;
	}
	const c = cs[named]!;
	// content time of the named click: a whole second + 0.03 s, the one the picture puts nearest
	const m = Math.round(c.t - picture - 0.03);
	return picture - (c.t - (m + 0.03));
}

test('Play with a long read-ahead (0.62 s): the first click is heard, the picture waits for it and shows buffering', async () => {
	test.setTimeout(600_000);
	await setup();
	// 28 more Hard Limiters on the Mix: 30 on the path, 30 × 998 samples = 0.624 s of read-ahead
	const more = await transact(
		page,
		Array.from({ length: 28 }, (_, k) => ({
			type: 'effect.add',
			target: 'master',
			effectId: 'jasper.audio.hard-limiter',
			params: { lookAhead: 20 },
			ref: `$w${k}`,
		})),
	);
	expect(more.ok, JSON.stringify(more)).toBe(true);
	const extra = more.ok ? Object.values(more.refs ?? {}) : [];
	try {
		const wait = (30 * HL20 + MARGIN) / SR;
		const plays = Math.max(2, Math.ceil(PLAYS / 2));
		let measured = 0;
		for (let i = 0; i < plays * 3 && measured < plays; i++) {
			await takeLog(page);
			await seekPaused(page, frameAt(1));
			await seekPaused(page, 0);
			let sawBuffering = false;
			const rec = await playFor(page, 2200, async (p) => {
				sawBuffering = await p
					.getByTestId('program-buffering')
					.waitFor({ state: 'visible', timeout: 500 })
					.then(
						() => true,
						() => false,
					);
			});
			const cs = clicks(rec);
			// 30 limiters load the audio thread: a play whose audio clock slipped against the wall clock (an underrun)
			// measures the host, not the graph, and is played again (as the Phase 0 specs do)
			const slip = await clockSlip(page, rec.armed + wait + 0.1);
			if (!(Math.abs(slip) < 0.01)) {
				console.log('long read-ahead: the audio clock slipped', (slip * 1000).toFixed(1), 'ms, again');
				continue;
			}
			measured++;
			if (DEBUG) {
				const log = await takeLog(page);
				console.log(
					'debug long',
					JSON.stringify(
						log.map((e) => ({
							...e,
							t: +(e.t - rec.armed).toFixed(4),
							anchor: +(e.anchor - rec.armed).toFixed(4),
						})),
					),
				);
			}
			console.log(
				'long read-ahead play',
				i + 1,
				JSON.stringify(cs.slice(0, 4).map((c) => c.t - rec.armed)),
				sawBuffering,
			);
			expect(cs.length, JSON.stringify(cs)).toBeGreaterThan(2);
			// the click 30 ms after the play position is the first one heard (nothing lost), `wait` after the resume
			// (one render quantum)
			const off = cs[0]!.t - rec.armed - (wait + 0.03);
			console.log('long read-ahead first click', (off * SR).toFixed(1), 'samples from the expected one');
			expect(cs[0]!.marker).toBe(false);
			expect(Math.abs(off), JSON.stringify(cs.slice(0, 3))).toBeLessThan(128 / SR);
			expect(sawBuffering).toBe(true);
			const picture = await pictureLag(rec, rec.armed, wait + 0.2);
			console.log('long read-ahead picture − audio', picture);
			// the picture waits for the program: measured −0.023 … +0.037 s over 30 plays (the picture anchor is sampled
			// from Chrome's output timestamps once per animation frame; before the stall watchdog knew about the wait it
			// kicked the Player 0.6 s in and the picture led by 8–54 ms every play)
			expect(picture).toBeGreaterThan(-0.03);
			// one wait, not two
			expect(picture).toBeLessThan(wait);
		}
		expect(measured).toBe(plays);
	} finally {
		await transact(
			page,
			extra.map((id) => ({ type: 'effect.remove', effectInstanceId: id })),
		);
	}
});

test('seek while playing: the audio after the seek starts on its first sample', async () => {
	test.setTimeout(600_000);
	await setup();
	for (let i = 0; i < Math.max(2, Math.ceil(PLAYS / 2)); i++) {
		await seekPaused(page, frameAt(1.5));
		await takeLog(page);
		const rec = await playFor(page, 2000, async (p) => {
			await p.waitForTimeout(700);
			// type 4 s into the timecode readout while playing (it seeks without pausing the transport)
			await p.getByTestId('timeline-timecode').click();
			const input = p.getByTestId('timeline-timecode-input');
			await input.fill(`00:00:04:00`);
			await mark(p, 'enter');
			await input.press('Enter');
		});
		const log = await takeLog(page);
		const enter = rec.marks.enter ?? 0;
		const cs = clicks(rec);
		// Groups of a main click and its markers. After the Enter: the old position's single clicks until the pause,
		// then the new position's audio — its first group must be the triple of 4.03 s (26 ms after the target frame 120
		// = 4.004 s): none of its first samples lost, nothing earlier than the target.
		const groups: { t: number; size: number }[] = [];
		for (const c of cs) {
			if (c.marker && groups.length > 0) groups[groups.length - 1]!.size++;
			else groups.push({ t: c.t, size: 1 });
		}
		const after = groups.filter((g) => g.t > enter);
		const firstNamed = after.findIndex((g) => g.size > 1);
		const fresh = firstNamed >= 0 ? after[firstNamed]! : null;
		console.log(
			'seek while playing',
			i + 1,
			JSON.stringify(after.slice(0, 8).map((g) => [+(g.t - enter).toFixed(4), g.size])),
		);
		if (DEBUG)
			console.log(
				'debug',
				JSON.stringify({
					log: log.map((e) => ({
						...e,
						t: +(e.t - enter).toFixed(4),
						anchor: +(e.anchor - enter).toFixed(4),
					})),
					stops: rec.stops.map((x) => [+(x.t - enter).toFixed(4), x.player]),
				}),
			);
		expect(fresh?.size, JSON.stringify(after)).toBe(3);
		// and nothing of the new position before it (the single clicks before it are the old position's, before the hold)
		const before = after.slice(0, firstNamed);
		if (before.length > 0)
			expect(fresh!.t - before[before.length - 1]!.t, JSON.stringify(after)).toBeGreaterThan(0.25);
		if (logged) {
			const primed = primedStart(log, enter - 0.05);
			expect(primed, JSON.stringify(log)).toBeTruthy();
			// the 4.03 s click on its sample against the primed anchor (content time = sequence time here)
			const off = fresh!.t - primed!.anchor - 4.03;
			console.log('seek while playing: first click against the anchor', (off * SR).toFixed(2), 'samples');
			expect(Math.abs(off * SR), JSON.stringify(log)).toBeLessThan(2);
		}
	}
});

test('many paused seeks + Play: every play starts on its first sample, nothing from before the seek', async () => {
	test.setTimeout(1_800_000);
	await setup();
	const n = Number(process.env.E2E_P6_STRESS ?? PLAYS * 4);
	const anomalies: string[] = [];
	const latencies: number[] = [];
	let measured = 0;
	let replays = 0;
	const W = (2 * HL20 + MARGIN) / SR;
	// a fixed pseudo-random walk of positions inside the clicks (0.3 … 7.0 s), after a play somewhere else
	let x = 12345;
	const rnd = () => {
		x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
		return x / 2 ** 32;
	};
	for (let i = 0; i < n * 2 && measured < n; i++) {
		const pre = frameAt(0.5 + rnd() * 6);
		const frame = frameAt(0.3 + rnd() * 6.5);
		await seekPaused(page, pre);
		await playFor(page, 150 + Math.round(rnd() * 300));
		// a real seek: away from where the play before paused (a pause and Play goes on from there, unprimed)
		const at = (await query<{ frame: number }>(page, 'playhead.get')).frame;
		const target = frame === at ? frame + 3 : frame;
		await takeLog(page);
		if (DEBUG)
			await page.evaluate(() => {
				(window as unknown as { __tap: { all?: unknown[] } }).__tap.all = [];
			});
		await seekPaused(page, target);
		const rec = await playFor(page, 700);
		const pos = (target * fps.den) / fps.num;
		// the next click (main or marker) at or after the play position
		const next = PROBE_EVENTS.find((e) => e >= pos - 1e-9) ?? Number.NaN;
		const expected = rec.armed + W + (next - pos);
		// the program fades in over START_FADE (30 ms) from its start: a click that soon after the play position is
		// heard that much softer (0.707 at full level)
		const level = Math.SQRT1_2 * Math.min(1, Math.max(0, (next - pos) / 0.03));
		const cs = clicks(rec, 0.02);
		const late = lateStarts(rec, rec.armed, expected + 0.3);
		const first = cs[0];
		const early = cs.filter((c) => c.t < expected - 2 / SR);
		const off = first ? (first.t - expected) * SR : Number.NaN;
		// (a click between two samples — a sub-sample start — splits over them: at least half of it on one)
		const soft = !!first && level > 0.05 && (first.v < 0.5 * level - 0.02 || first.v > level + 0.02);
		latencies.push(await playLatency(page));
		if ((early.length > 0 || !(Math.abs(off) < 2) || soft) && late.length > 0) {
			replays++;
			continue;
		}
		measured++;
		if (level < 0.05) {
			// the next click is in the first 2 ms of the fade: inaudible by design; the one after it must be on time
			const after = PROBE_EVENTS.find((e) => e > next + 1e-9)!;
			const second = cs.find((c) => c.t > expected + 0.001);
			if (second && Math.abs((second.t - expected - (after - next)) * SR) < 2 && early.length === 0) continue;
		}
		if (early.length > 0 || !(Math.abs(off) < 2) || soft) {
			if (DEBUG) {
				const log = await takeLog(page);
				console.log(
					'debug anomaly',
					JSON.stringify({
						log: log.map((e) => ({
							...e,
							t: +(e.t - rec.armed).toFixed(4),
							anchor: +(e.anchor - rec.armed).toFixed(4),
						})),
						clicks: cs.slice(0, 6).map((c) => [+(c.t - rec.armed).toFixed(5), +c.v.toFixed(3), c.marker]),
						expected: +(expected - rec.armed).toFixed(5),
						stops: rec.stops.map((x) => [+(x.t - rec.armed).toFixed(4), x.player]),
						starts: rec.starts.slice(0, 8).map((x) => [+(x.t - rec.armed).toFixed(4), x.player]),
						connects: rec.connects
							.slice(0, 12)
							.map((x) => [+(x.t - rec.armed).toFixed(4), x.suspended, x.player]),
						all: await page.evaluate(() =>
							((window as unknown as { __tap: { all?: unknown[][] } }).__tap.all ?? [])
								.filter((x) => x[0] === 'start')
								.slice(0, 16),
						),
						armed: rec.armed,
						firstFrame: rec.frames[0]! / SR - rec.armed,
					}),
				);
			}
			anomalies.push(
				JSON.stringify({
					play: measured,
					pre,
					paused: at,
					frame: target,
					offSamples: off,
					level: [first?.v, level],
					early: early.map((c) => [((c.t - rec.armed) * 1000).toFixed(2), c.v.toFixed(3)]),
					stops: rec.stops.length,
				}),
			);
		}
	}
	console.log(
		'paused seek + Play stress:',
		measured,
		'plays,',
		anomalies.length,
		'anomalies,',
		replays,
		'replayed',
	);
	for (const a of anomalies) console.log('anomaly', a);
	test.info().annotations.push({
		type: 'stress',
		description: JSON.stringify({ measured, replays, anomalies, load: loadavg() }),
	});
	expect(measured).toBe(n);
	expect(anomalies).toEqual([]);
});

test('pause and Play again: the audio goes on with every click on its sample', async () => {
	test.setTimeout(600_000);
	await setup();
	const failures: string[] = [];
	for (let i = 0; i < Math.max(2, Math.ceil(PLAYS / 2)); i++) {
		await seekPaused(page, frameAt(1));
		await seekPaused(page, frameAt(0.5));
		await playFor(page, 900);
		await page.waitForTimeout(400);
		await takeLog(page);
		// Remotion's queued buffers last up to 2 s: 3.4 s of play covers buffers scheduled before and after the pause
		const rec = await playFor(page, 3400);
		const log = await takeLog(page);
		const lat = await playLatency(page);
		const cs = clicks(rec, 0.02).filter((c) => !c.marker);
		const broken = brokenSpacing(cs, rec.armed);
		console.log(
			'pause and play',
			i + 1,
			JSON.stringify({
				clicks: cs.length,
				broken,
				first: cs[0] ? cs[0].t - rec.armed : null,
				playLatencyMs: lat,
			}),
		);
		if (DEBUG && broken.length > 0)
			console.log(
				'debug resume',
				JSON.stringify(
					log.map((e) => ({
						...e,
						t: +(e.t - rec.armed).toFixed(4),
						anchor: +(e.anchor - rec.armed).toFixed(4),
					})),
				),
			);
		if (cs.length < 12) failures.push(`play ${i + 1}: ${cs.length} clicks`);
		if (broken.length > 0) failures.push(`play ${i + 1}: ${broken.join(', ')}`);
	}
	expect(failures).toEqual([]);
});
