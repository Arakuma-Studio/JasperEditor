// Sound design Phase 0 close-out (spec 12 Phase 0): the Program monitor's audio around transport events, with a
// graph read-ahead (latency compensation, WP0.1). The page's AudioContext output is tapped by an AudioWorklet that
// records every sample with its context frame (`currentFrame`), so times are exact context times.
//
// probe.wav (6 s): clicks of 0.5 at 0.03 s + k·0.25 s up to 2 s; a 1 kHz sine of 0.25 from 2 s to 4 s; silence after.
// It plays on A1 (two Hard Limiters with 20 ms look-ahead: 998 samples each; one is added during a test) and A2;
// the Mix has a Hard Limiter too. Below the ceiling a Hard Limiter is a pure delay, so the Mix is the source summed,
// delayed by the inserts and compensated by the read-ahead.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { createProject, enableAgentBridge, focusTimeline, query, ROOT, transact } from './support.ts';

test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });
// Each test measures on its own: a failing one restarts the worker, and the next test sets its project up again.

let page: Page;
const outDir = join(ROOT, 'test-results', 'e2e-sound-p0-transport');
const SR = 48000;

/**
 * Taps every AudioContext destination through one bus per context: an AudioWorklet records channel 0 of whatever
 * reaches the speakers with its context frame. `stop()` calls of scheduled sources are logged with the context time
 * (Remotion stops a clip's queued buffers when it reschedules, e.g. at a seek).
 */
const TAP = () => {
	type Block = { f: number; d: Float32Array };
	type Tap = {
		on: boolean;
		ctxs: { ctx: BaseAudioContext; node: AudioWorkletNode | null; blocks: Block[] }[];
		stops: { t: number }[];
	};
	const w = window as unknown as { __tap: Tap };
	w.__tap = { on: false, ctxs: [], stops: [] };
	const code = `class T extends AudioWorkletProcessor {
		constructor() { super(); this.on = false; this.buf = [];
			this.port.onmessage = (e) => { this.on = e.data.on; if (!this.on) { this.port.postMessage(this.buf); this.buf = []; } }; }
		process(inputs) { const x = inputs[0] && inputs[0][0];
			if (this.on && x) { this.buf.push({ f: currentFrame, d: new Float32Array(x) });
				if (this.buf.length >= 256) { this.port.postMessage(this.buf); this.buf = []; } }
			return true; } }
	registerProcessor('jasper-e2e-tap', T);`;
	const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
	const buses = new WeakMap<BaseAudioContext, GainNode>();
	const connect = AudioNode.prototype.connect as (this: AudioNode, ...a: unknown[]) => unknown;
	const busOf = (dest: AudioDestinationNode): GainNode => {
		const ctx = dest.context;
		let bus = buses.get(ctx);
		if (bus) return bus;
		bus = ctx.createGain();
		buses.set(ctx, bus);
		connect.call(bus, dest);
		const entry = { ctx, node: null as AudioWorkletNode | null, blocks: [] as Block[] };
		ctx.addEventListener('statechange', () => {
			if (w.__tap.on) w.__tap.stops.push({ t: -ctx.currentTime });
		});
		w.__tap.ctxs.push(entry);
		void ctx.audioWorklet.addModule(url).then(() => {
			const node = new AudioWorkletNode(ctx, 'jasper-e2e-tap', { channelCount: 2, channelCountMode: 'explicit' });
			node.port.onmessage = (e: MessageEvent<Block[]>) => entry.blocks.push(...e.data);
			const mute = ctx.createGain();
			mute.gain.value = 0;
			connect.call(bus!, node);
			connect.call(node, mute);
			connect.call(mute, dest);
			entry.node = node;
		});
		return bus;
	};
	AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
		const dest = args[0];
		if (dest instanceof AudioDestinationNode) return connect.apply(this, [busOf(dest), ...args.slice(1)]);
		return connect.apply(this, args);
	} as typeof AudioNode.prototype.connect;
	const stop = AudioScheduledSourceNode.prototype.stop;
	AudioScheduledSourceNode.prototype.stop = function (this: AudioScheduledSourceNode, when?: number) {
		if (w.__tap.on) w.__tap.stops.push({ t: this.context.currentTime });
		return stop.call(this, when);
	};
};

type Recording = {
	rate: number;
	/** Context time (s) when the tap was armed (the frozen time of a suspended context = where playback resumes). */
	armed: number;
	/** First context frame and the samples of channel 0 from there (gaps, e.g. while suspended, are not filled). */
	frames: number[];
	data: number[];
	stops: number[];
	marks: Record<string, number>;
};

async function arm(p: Page): Promise<void> {
	await p.evaluate(() => {
		const t = (window as unknown as { __tap: { on: boolean; ctxs: { node: AudioWorkletNode | null; blocks: unknown[] }[]; stops: unknown[] } }).__tap;
		for (const c of t.ctxs) {
			c.blocks.length = 0;
			c.node?.port.postMessage({ on: true });
		}
		t.stops.length = 0;
		t.on = true;
	});
}

/** Marks the current context time of the program context under `name`. */
async function mark(p: Page, name: string): Promise<void> {
	await p.evaluate((n) => {
		const t = (window as unknown as { __tap: { ctxs: { ctx: BaseAudioContext; blocks: unknown[] }[]; marks?: Record<string, number> } }).__tap;
		t.marks ??= {};
		const ctx = t.ctxs.find((c) => c.ctx.state === 'running')?.ctx ?? t.ctxs[0]?.ctx;
		t.marks[n] = ctx?.currentTime ?? -1;
	}, name);
}

async function disarm(p: Page): Promise<Recording> {
	await p.evaluate(() => {
		const t = (window as unknown as { __tap: { on: boolean; ctxs: { node: AudioWorkletNode | null }[] } }).__tap;
		t.on = false;
		for (const c of t.ctxs) c.node?.port.postMessage({ on: false });
	});
	await p.waitForTimeout(300);
	return p.evaluate(() => {
		const t = (
			window as unknown as {
				__tap: {
					ctxs: { ctx: BaseAudioContext; blocks: { f: number; d: Float32Array }[] }[];
					stops: { t: number }[];
					marks?: Record<string, number>;
					armedAt?: number;
				};
			}
		).__tap;
		const peakOf = (bs: { d: Float32Array }[]) =>
			bs.reduce((m, b) => b.d.reduce((x, v) => Math.max(x, Math.abs(v)), m), 0);
		const bestIndex = t.ctxs.reduce((a, b, i) => (peakOf(b.blocks) > peakOf(t.ctxs[a]!.blocks) ? i : a), 0);
		const best = t.ctxs[bestIndex]!;
		const armedAll = (t as unknown as { armedAll?: number[] }).armedAll ?? [];
		const frames: number[] = [];
		const data: number[] = [];
		for (const b of best.blocks) {
			frames.push(b.f);
			for (const v of b.d) data.push(v);
		}
		const marks = t.marks ?? {};
		t.marks = {};
		return {
			rate: best.ctx.sampleRate,
			armed: armedAll[bestIndex] ?? -1,
			frames,
			data,
			stops: t.stops.map((s) => s.t),
			marks,
		};
	});
}

/** Context time (s) of sample `i` of a recording (blocks are 128 frames). */
function timeOf(r: Recording, i: number): number {
	const b = Math.floor(i / 128);
	return (r.frames[b]! + (i - b * 128)) / r.rate;
}

/** Local maxima of |x| above `min`, merged within 5 ms, as context times. */
function peaks(r: Recording, min = 0.05): { t: number; v: number }[] {
	const out: { t: number; v: number; i: number }[] = [];
	for (let i = 0; i < r.data.length; i++) {
		const v = Math.abs(r.data[i]!);
		if (v < min) continue;
		const last = out[out.length - 1];
		if (last && i - last.i < r.rate * 0.005) {
			if (v > last.v) Object.assign(last, { i, v, t: timeOf(r, i) });
		} else out.push({ i, v, t: timeOf(r, i) });
	}
	return out.map(({ t, v }) => ({ t, v }));
}

async function seekPaused(p: Page, frame: number): Promise<void> {
	await query(p, 'playhead.set', { frame });
	await p.waitForTimeout(600);
}

/** Space, `ms` of playback, Space; the tap records from just before the first Space. */
async function playFor(p: Page, ms: number, during?: (p: Page) => Promise<void>): Promise<Recording> {
	await focusTimeline(p);
	await arm(p);
	await p.evaluate(() => {
		const t = (window as unknown as { __tap: { ctxs: { ctx: BaseAudioContext }[]; armedAt?: number } }).__tap;
		// the program context is suspended while paused: its frozen time is where the next Play starts
		// the program context (the Player's) is the one Remotion created suspended; the tap picks the loudest one later
		(t as unknown as { armedAll: number[] }).armedAll = t.ctxs.map((c) => c.ctx.currentTime);
	});
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
	await page.addInitScript(TAP);
	await enableAgentBridge(page);
});

test.afterAll(async () => {
	await page?.close();
});

let ready = false;
/** Effect instance ids of the A1 and Mix Hard Limiters. */
let limiters: string[] = [];

/** probe.wav on A1 (Hard Limiter) and A2, a Hard Limiter on the Mix (once per worker). */
async function setup(): Promise<void> {
	if (ready) return;
	ready = true;
	const name = process.env.E2E_PROBE_EXT === 'mp4' ? 'probe.mp4' : 'probe.wav';
	const wav = join(outDir, name);
	const clicks = 'if(lt(t\\,2)*eq(mod(n-1440\\,12000)\\,0)\\,0.5\\,0)';
	const tone = 'if(gte(t\\,2)*lt(t\\,4)\\,0.25*sin(2*PI*1000*t)\\,0)';
	ff(['-f', 'lavfi', '-i', `aevalsrc='${clicks}+${tone}':s=48000:d=6`, '-ac', '2', ...(name.endsWith('.mp4') ? ['-c:a', 'aac', '-b:a', '256k'] : ['-c:a', 'pcm_s16le']), wav]);
	await createProject(page, 'E2E Sound P0 transport');
	await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Control+KeyI');
	await (await chooser).setFiles([wav]);
	await expect(page.getByTestId('project-row').filter({ hasText: name })).toBeVisible({ timeout: 60_000 });
	const items = await query<Record<string, { id: string; name: string }>>(page, 'doc.get', { path: ['items'] });
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
	if (r.ok) limiters = [r.refs!.$a1!, r.refs!.$mix!];
	const s = await query<{ settings: { frameRate: { num: number; den: number } } }>(page, 'sequence.summary');
	fps = s.settings.frameRate;
	// let the media players and the graph settle
	await seekPaused(page, 1);
	await seekPaused(page, 0);
}

/**
 * Samples (context time, Program frame) pairs for `ms` while playing: `min(time − frame / fps)` is the context time at
 * which the picture shows sequence time 0 (a frame is shown from its start until the next one).
 */
async function pictureAnchor(p: Page, ms: number): Promise<number> {
	return p.evaluate(
		async ([dur, num, den]) => {
			const w = window as unknown as {
				__tap: { ctxs: { ctx: BaseAudioContext }[] };
				jasper: { query(n: string, a?: unknown): Promise<{ frame: number; playing: boolean }> };
			};
			const ctx = w.__tap.ctxs.find((c) => c.ctx.state === 'running')?.ctx;
			if (!ctx) return Number.NaN;
			let best = Number.POSITIVE_INFINITY;
			// anime-allow: test-side wall clock bound of a sampling loop
			const end = performance.now() + dur;
			// anime-allow: test-side wall clock bound of a sampling loop
			while (performance.now() < end) {
				const now = await new Promise<number>((r) => requestAnimationFrame(r));
				// the context time of the sample at the output at this frame (precise, unlike currentTime's steps)
				const o = (ctx as AudioContext).getOutputTimestamp();
				const t = (o.contextTime ?? 0) + (now - (o.performanceTime ?? 0)) / 1000;
				const { frame, playing } = await w.jasper.query('playhead.get');
				if (playing) best = Math.min(best, t - (frame * den) / num);
			}
			return best;
		},
		[ms, fps.num, fps.den] as const,
	);
}

test('Play: the first samples at the play position are heard (nothing lost to the read-ahead)', async () => {
	test.setTimeout(240_000);
	await setup();
	/** Plays from 0 and returns the clicks heard and the picture's sequence-time-0 context time. */
	const measure = async () => {
		await seekPaused(page, frameAt(1));
		await seekPaused(page, 0);
		let picture = Number.NaN;
		const rec = await playFor(page, 200, async (p) => {
			await p.waitForTimeout(150);
			picture = await pictureAnchor(p, 900);
		});
		return { rec, picture };
	};
	// baseline without latency (both limiters off): how far the picture's frame report trails the audio here
	const setEnabled = (enabled: boolean) =>
		transact(
			page,
			limiters.map((id) => ({ type: 'effect.setEnabled', effectInstanceId: id, enabled })),
		);
	/** picture − audio (s): the picture's sequence time 0 minus the program output's (from the click at 0.28 s). */
	const offsetOf = (m: { rec: Recording; picture: number }) => {
		const c = peaks(m.rec).find((p) => p.v > 0.5 && p.t - m.rec.armed > 0.15);
		return c ? m.picture - (c.t - 0.28) : Number.NaN;
	};
	// Two plays each: a frame report delayed by a stall only makes the picture look later, so the smaller is right.
	expect((await setEnabled(false)).ok).toBe(true);
	const baseOffset = Math.min(offsetOf(await measure()), offsetOf(await measure()));
	expect((await setEnabled(true)).ok).toBe(true);
	const first = await measure();
	const { rec } = first;
	const offset = Math.min(offsetOf(first), offsetOf(await measure()));
	const ps = peaks(rec);
	console.log('play-start peaks', rec.armed, rec.frames[0]! / rec.rate, JSON.stringify(ps));
	test.info().annotations.push({ type: 'peaks', description: JSON.stringify({ armed: rec.armed, ps }) });
	expect(ps.length).toBeGreaterThanOrEqual(3);
	// both tracks summed (0.707): every click, 0.25 s apart
	for (let i = 1; i < ps.length; i++) expect(Math.abs(ps[i]!.t - ps[i - 1]!.t - 0.25)).toBeLessThan(0.002);
	for (const p of ps) expect(p.v).toBeGreaterThan(0.6);
	// the click 30 ms after the play position is the first one heard: well before the next one (0.28 s)
	expect(ps[0]!.t - rec.armed, JSON.stringify(ps.slice(0, 3))).toBeLessThan(0.2);
	// A/V: the clicks give the context time of sequence time 0 in the program output, the frame reports the picture's.
	// With the read-ahead primed the picture waits for the program: picture − audio stays what it is without latency
	// (an unprimed start would show the picture the read-ahead, 41.6 ms, earlier relative to the audio).
	console.log('picture − audio', offset, 'without latency', baseOffset);
	test.info().annotations.push({ type: 'sync', description: JSON.stringify({ offset, baseOffset }) });
	expect(Math.abs(offset - baseOffset)).toBeLessThan(0.02);
});

test('Play after a seek while paused: no audio from before the seek', async () => {
	test.setTimeout(240_000);
	await setup();
	// tone at 2–4 s; pause inside it (the graph holds read-ahead worth of tone), seek to the silence at 4.5 s, Play
	await seekPaused(page, frameAt(2.2));
	await playFor(page, 500);
	await seekPaused(page, frameAt(4.5));
	const rec = await playFor(page, 600);
	const max = rec.data.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
	let first = -1;
	for (let i = 0; i < rec.data.length; i++)
		if (Math.abs(rec.data[i]!) > 0.01) {
			first = i;
			break;
		}
	console.log('after paused seek: max', max, 'first loud at', first >= 0 ? timeOf(rec, first) - rec.armed : null);
	test.info().annotations.push({ type: 'stale', description: JSON.stringify({ max }) });
	expect(max).toBeLessThan(0.01);
});

test('seek during playback: the audio from before the seek stops at the seek', async () => {
	test.setTimeout(240_000);
	await setup();
	await seekPaused(page, frameAt(2.2));
	const rec = await playFor(page, 700, async (p) => {
		await p.waitForTimeout(600);
		// type 4.5 s into the timecode readout while playing (it seeks without pausing)
		await p.getByTestId('timeline-timecode').click();
		const input = p.getByTestId('timeline-timecode-input');
		await input.fill('00:00:04:15');
		await mark(p, 'enter');
		await input.press('Enter');
		await p.waitForTimeout(100);
		console.log('after the typed seek', JSON.stringify(await query(p, 'playhead.get')));
	});
	const enter = rec.marks.enter ?? -1;
	const stop = rec.stops.find((t) => t >= enter - 0.001) ?? -1;
	let last = -1;
	for (let i = 0; i < rec.data.length; i++) if (Math.abs(rec.data[i]!) > 0.01) last = i;
	const lastT = last >= 0 ? timeOf(rec, last) : -1;
	console.log('seek while playing: enter', enter, 'stop', stop, 'last tone', lastT, 'tail', lastT - stop);
	console.log('stops', JSON.stringify(rec.stops), 'armed', rec.armed);
	test.info().annotations.push({ type: 'tail', description: JSON.stringify({ enter, stop, lastT }) });
	expect(stop).toBeGreaterThan(0);
	expect(lastT - stop).toBeLessThan(0.008);
});

test('a latency change during playback: no dropout beyond the added latency', async () => {
	test.setTimeout(240_000);
	await setup();
	await seekPaused(page, frameAt(2.0));
	const rec = await playFor(page, 1200, async (p) => {
		await p.waitForTimeout(500);
		await mark(p, 'edit');
		const r = await transact(p, [
			{
				type: 'effect.add',
				target: { trackId: 'A1' },
				effectId: 'jasper.audio.hard-limiter',
				params: { lookAhead: 20 },
			},
		]);
		expect(r.ok, JSON.stringify(r)).toBe(true);
	});
	const edit = rec.marks.edit ?? -1;
	// the longest run of |x| < 0.01 while the tone plays (the tone crosses 0.01 every 0.5 ms)
	let worst = 0;
	let at = -1;
	let run = 0;
	for (let i = 0; i < rec.data.length; i++) {
		const t = timeOf(rec, i);
		if (t < edit - 0.2 || t > edit + 0.7) {
			run = 0;
			continue;
		}
		if (Math.abs(rec.data[i]!) < 0.01) run++;
		else {
			if (run > worst) {
				worst = run;
				at = t;
			}
			run = 0;
		}
	}
	console.log('latency change: longest gap', worst, 'samples', worst / SR, 's at', at - edit);
	{
		const gaps: string[] = [];
		let r0 = 0;
		for (let i = 0; i < rec.data.length; i++) {
			if (Math.abs(rec.data[i]!) < 0.01) r0++;
			else {
				if (r0 > 96) gaps.push(`${r0}@${(timeOf(rec, i) - edit).toFixed(4)}`);
				r0 = 0;
			}
		}
		const amp = (from: number, to: number) => {
			let m = 0;
			for (let i = 0; i < rec.data.length; i++) {
				const t = timeOf(rec, i) - edit;
				if (t >= from && t < to) m = Math.max(m, Math.abs(rec.data[i]!));
			}
			return m;
		};
		console.log('gaps', gaps.join(' '), 'amp before', amp(-0.3, -0.05), 'after', amp(0.3, 0.6));
		console.log('stops/states rel. edit', JSON.stringify(rec.stops.map((x) => (x < 0 ? `S${(-x - edit).toFixed(4)}` : (x - edit).toFixed(4)))));
	}
	test.info().annotations.push({ type: 'gap', description: JSON.stringify({ worst, at: at - edit }) });
	// undo the second limiter for the next tests
	await query(page, 'playhead.get');
	expect(worst / SR).toBeLessThan(0.05);
});
