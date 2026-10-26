#!/usr/bin/env node
// Subtitle preview benchmark (spec 13 AS-050/AS-075, docs/wp-notes/auto-subtitles.md): the built editor in headless
// Chrome (like `pnpm perf` "editor": same flags, cookies of a running stack) plays a sequence with a video and N word
// subtitles, and reads the Program monitor's PlaybackDriver stats (frames shown per second, dropped), the UI frame
// rate and long tasks — with no subtitles and with each variant, so the ratio to video-only playback is measured.
//
//   BASE_URL=http://127.0.0.1:5199 E2E_TOKEN=… E2E_EDITOR_KEY=… node scripts/perf/subtitles-preview.mjs \
//        --media <video> [--width 1920 --height 1080] [--clips 1080] [--variants none,static,pixelpop]
//        [--seconds 8] [--profile] [--out DIR]
//
// `--profile` records a V8 CPU profile of each variant's playback (CDP Profiler) and prints the 25 functions with the
// most self time. Results: <out>/preview-<label>.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d) => {
	const i = argv.indexOf(`--${n}`);
	if (i < 0) return d;
	const v = argv[i + 1];
	return v === undefined || v.startsWith('--') ? true : v;
};
const W = Number(flag('width', 1920));
const H = Number(flag('height', 1080));
const CLIPS = Number(flag('clips', 1080));
const SECONDS = Number(flag('seconds', 8));
const VARIANTS = String(flag('variants', 'none,static,pixelpop')).split(',');
const PROFILE = !!flag('profile', false);
const MEDIA = flag('media', null);
const OUT = flag('out', join(root, 'test-results', 'subtitles'));
const LABEL = flag('label', `${W}x${H}-${CLIPS}`);
if (!MEDIA) throw new Error('--media <video file> is required');
mkdirSync(OUT, { recursive: true });
const base = process.env.BASE_URL;
const secrets = { token: process.env.E2E_TOKEN, editorKey: process.env.E2E_EDITOR_KEY };
const FPS = 60000 / 1001;

let seed = 1;
const rnd = () => {
	seed ^= seed << 13;
	seed ^= seed >>> 17;
	seed ^= seed << 5;
	return ((seed >>> 0) % 1_000_000) / 1_000_000;
};
const WORDS = 'hoy vamos a hacer un juego en solo siete dias mira este nivel que locura el jefe final tiene mil vidas'.split(
	' ',
);
const items = [];
for (let i = 0, f = 0; i < CLIPS; i++) {
	const d = Math.max(12, Math.round((0.3 + rnd() * 0.5) * FPS));
	const n = 1 + Math.floor(rnd() * 3);
	items.push({ start: f, duration: d, text: Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ').toUpperCase() });
	f += d;
}
const hex = (h, a = 1) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255).concat(a);
function commands(variant, fontId) {
	const out = [];
	for (const [i, it] of items.entries()) {
		const ref = `$t${i}`;
		out.push({
			type: 'clip.addText',
			at: it.start,
			duration: it.duration,
			track: 'V2',
			ref,
			content: {
				text: it.text,
				style: {
					fontId,
					weight: 800,
					sizePx: 98,
					fill: [1, 1, 1, 1],
					strokes: [{ color: hex('#AE00FF'), widthPx: 11.5, position: 'outside' }],
					shadow: { color: hex('#221D58', 0.8), angleDeg: 0, distancePx: 0, blurPx: 24 },
				},
			},
			transform: { position: [W / 2, Math.round(0.83 * H)] },
		});
		if (variant === 'pixelpop') {
			const tf = `$tf${i}`;
			const key = (target, sec, value) => ({ type: 'keyframe.add', target, at: { frames: Math.round(sec * FPS) }, value });
			out.push(
				{
					type: 'effect.add',
					target: { clipId: ref },
					effectId: 'jasper.transform',
					params: { useCompShutterAngle: false, shutterAngle: 360 },
					ref: tf,
				},
				key(['effect', tf, 'scaleHeight'], 0, 75),
				key(['effect', tf, 'scaleHeight'], 0.1, 108),
				key(['effect', tf, 'scaleHeight'], 0.167, 100),
				key(['effect', tf, 'opacity'], 0, 0),
				key(['effect', tf, 'opacity'], 0.05, 100),
				{
					type: 'effect.add',
					target: { clipId: ref },
					effectId: 'jasper.s.shake',
					params: { amplitude: 0.6, frequency: 1, wrapX: 'no', wrapY: 'no', xRandAmp: 0.889, yRandAmp: 0.444, tiltRandAmp: 1 },
				},
			);
		}
	}
	return out;
}

const report = { label: LABEL, base, clips: CLIPS, size: `${W}x${H}`, loadBefore: loadavg(), scenarios: [] };
const save = () => writeFileSync(join(OUT, `preview-${LABEL}.json`), JSON.stringify(report, null, 2));
const browser = await chromium.launch({
	headless: true,
	args: ['--enable-features=CanvasDrawElement', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
await page.context().addCookies(
	[
		['jasper_session', secrets.token],
		['jasper_editor', secrets.editorKey],
	].map(([name, value]) => ({ name, value, url: base, httpOnly: true, sameSite: 'Strict' })),
);
await page.addInitScript(() => localStorage.setItem('jasper:agent-bridge', '1'));
await page.goto(`${base}/`);
await page.getByTestId('home-new').click();
await page.getByTestId('new-project-name').fill(`subtitle-preview-${LABEL}`);
await page.getByTestId('new-project-create').click();
await page.getByTestId('timeline-track-area').waitFor({ timeout: 120_000 });
await page.waitForFunction(() => !!window.jasper, null, { timeout: 60_000 });
await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
const chooser = page.waitForEvent('filechooser');
await page.keyboard.press('Control+KeyI');
await (await chooser).setFiles([MEDIA]);
const mediaName = MEDIA.split('/').pop();
await page.getByTestId('project-row').filter({ hasText: mediaName }).waitFor({ timeout: 180_000 });
await page.waitForFunction(() => !!window.__jasperMonitor, null, { timeout: 240_000 });
const tx = (commands, label = 'subtitle preview') =>
	page.evaluate((a) => window.jasper.transact({ protocol: 'jasper.tx/1', label: a.label, commands: a.c }), {
		c: commands,
		label,
	});
const seqId = await page.evaluate(() => window.__jasperMonitor.session.getState().activeSequenceId);
await tx([
	{ type: 'sequence.updateSettings', sequenceId: seqId, settings: { width: W, height: H, frameRate: { num: 60000, den: 1001 } } },
]);
const font = await tx([{ type: 'font.add', family: 'JetBrains Mono', ref: '$font' }]);
const fontId = font?.refs?.$font ?? font?.result?.refs?.$font;
const cdp = PROFILE ? await page.context().newCDPSession(page) : null;

async function measure(name) {
	await page.waitForTimeout(3000);
	if (cdp) {
		await cdp.send('Profiler.enable');
		await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
		await cdp.send('Profiler.start');
	}
	const r = await page.evaluate(
		async ({ secs, from }) => {
			const { session, driver } = window.__jasperMonitor;
			const t = session.transport;
			t.pause();
			t.seek(from);
			await new Promise((res) => setTimeout(res, 1500));
			t.play(1);
			const f0 = driver.stats.framesShown;
			const d0 = driver.stats.framesDropped;
			const p0 = performance.now();
			let raf = 0;
			const tick = () => {
				raf++;
				if (performance.now() - p0 < secs * 1000) requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
			let longTasks = 0;
			let longMs = 0;
			const po = new PerformanceObserver((l) => {
				for (const e of l.getEntries()) {
					longTasks++;
					longMs += e.duration;
				}
			});
			try {
				po.observe({ type: 'longtask', buffered: false });
			} catch {}
			await new Promise((res) => setTimeout(res, secs * 1000));
			const dt = (performance.now() - p0) / 1000;
			t.pause();
			po.disconnect();
			return {
				fps: Math.round(((driver.stats.framesShown - f0) / dt) * 10) / 10,
				dropped: driver.stats.framesDropped - d0,
				uiFps: Math.round((raf / dt) * 10) / 10,
				longTasks,
				longTaskMs: Math.round(longMs),
				heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null,
			};
		},
		{ secs: SECONDS, from: Math.round(5 * FPS) },
	);
	const out = { scenario: name, ...r };
	if (cdp) {
		const { profile } = await cdp.send('Profiler.stop');
		const self = new Map();
		const dt = profile.timeDeltas ?? [];
		const byId = new Map(profile.nodes.map((n) => [n.id, n]));
		for (const [i, id] of (profile.samples ?? []).entries()) {
			const n = byId.get(id);
			const cf = n.callFrame;
			const k = `${cf.functionName || '(anonymous)'} ${cf.url.split('/').pop()}:${cf.lineNumber + 1}`;
			self.set(k, (self.get(k) ?? 0) + (dt[i] ?? 0));
		}
		const total = [...self.values()].reduce((a, b) => a + b, 0);
		out.profileTop = [...self]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 25)
			.map(([k, v]) => `${((100 * v) / total).toFixed(1)}% ${k}`);
	}
	console.log(JSON.stringify(out, null, 1));
	report.scenarios.push(out);
	save();
}

for (const v of VARIANTS) {
	const ids = await page.evaluate(() => {
		const s = window.__jasperMonitor.session;
		return Object.keys(s.getCommitted().sequences[s.getState().activeSequenceId].clips);
	});
	if (ids.length) await tx([{ type: 'clip.lift', clipIds: ids }]);
	await tx([{ type: 'clip.place', source: { mediaByName: mediaName }, at: 0, tracks: { video: 'V1' } }]);
	if (v !== 'none') {
		const cmds = commands(v, fontId);
		let cur = [];
		for (const c of cmds) {
			if (c.type === 'clip.addText' && cur.length >= 4000) {
				await tx(cur);
				cur = [];
			}
			cur.push(c);
		}
		if (cur.length) await tx(cur);
	}
	await measure(`${v}${v === 'none' ? '' : ` (${CLIPS} subtitles)`}`);
}
await page.screenshot({ path: join(OUT, `preview-${LABEL}.png`) });
await browser.close();
save();
