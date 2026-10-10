// Clip blend modes on the Remotion path (keyframes-blend, REMOTION_E2E=1): the composition's blend scopes (GL
// compositor over the HTML-in-Canvas backdrop) and CSS modes rendered for real in headless Chrome, every mode at 60 %
// opacity, checked against `blendPixel` exactly like the native export (blend-export.test.ts) — the native ↔ preview
// parity of every mode. The patterns, layer and tolerances are the native test's.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	BLEND_MODES,
	blendModeInfo,
	blendPixel,
	dissolveNoise,
	dissolveSeed,
	type Rgba,
	storePremul8,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import { DocBuilder, ensureFixtures, JSON_H, register, tempAppdir } from './helpers.ts';

const enabled = process.env.REMOTION_E2E === '1';
const W = 1920;
const HH = 1080;
const MODES = BLEND_MODES.filter((m) => m !== 'normal');

function pattern(file: string, r: string, g: string, b: string) {
	const res = spawnSync('ffmpeg', [
		...['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${HH}:d=1`],
		...['-vf', `format=rgb24,geq=r='${r}':g='${g}':b='${b}'`, '-frames:v', '1', file],
	]);
	if (res.status !== 0) throw new Error(res.stderr.toString());
}

describe.runIf(enabled)('blend modes on the Remotion path (REMOTION_E2E=1)', () => {
	let engine: RunningEngine;
	let hostH: Record<string, string>;
	let d: DocBuilder;
	const layerClips: string[] = [];
	let base: Buffer;
	let layer: Buffer;

	const still = async (frame: number): Promise<{ rgb: Buffer; path: string }> => {
		const r = await engine.app.inject({
			method: 'POST',
			url: '/api/stills',
			headers: { ...JSON_H, ...hostH },
			payload: { envelope: d.envelope(), sequenceId: d.seqId, frame },
		});
		const done = await coreServices(engine.app).queue.wait(r.json().id);
		expect(done.error, JSON.stringify(done.error)).toBeUndefined();
		const png = await engine.app.inject({
			method: 'GET',
			url: `/renders/${r.json().id}/output`,
			headers: hostH,
		});
		const f = join(mkdtempSync(join(tmpdir(), 'jasper-blend-rem-')), 'f.png');
		writeFileSync(f, png.rawPayload);
		if (process.env.BLEND_DUMP) console.info(`[blend remotion] still ${frame}: ${f}`);
		const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
			maxBuffer: 64 << 20,
		});
		return { rgb: raw.stdout, path: (done.result as { renderPath: string }).renderPath };
	};

	beforeAll(async () => {
		ensureFixtures();
		engine = await startEngine({
			appdir: tempAppdir(),
			port: Number(process.env.JASPER_E2E_PORT ?? 0),
			// These tests drive the engine itself, not its authentication (server.test.ts, security-hardening.test.ts).
			insecure: true,
			dev: true,
			env: {
				PATH: process.env.PATH,
				...(process.env.JASPER_BROWSER_EXECUTABLE
					? { JASPER_BROWSER_EXECUTABLE: process.env.JASPER_BROWSER_EXECUTABLE }
					: {}),
			},
		});
		hostH = { host: `127.0.0.1:${engine.port}` };
		const dir = mkdtempSync(join(tmpdir(), 'jasper-blend-rem-src-'));
		pattern(join(dir, 'base.png'), 'mod(X*7+Y*3,256)', 'mod(X*5+Y*11,256)', 'mod(X*13+Y*2,256)');
		pattern(join(dir, 'layer.png'), 'mod(X*3+Y*17,256)', 'mod(X*11+Y*5,256)', 'mod(X*2+Y*9,256)');
		d = new DocBuilder();
		const dur = (id: string) => d.doc.sequences[d.seqId]!.clips[id]!.duration;
		const a = d.addMedia(await register(engine.app, join(dir, 'base.png'), hostH));
		const b = d.addMedia(await register(engine.app, join(dir, 'layer.png'), hostH));
		d.tx([{ type: 'clip.place', source: { mediaId: a }, at: 0 }]);
		// Frame 0 + 6i: the layer with mode i (stills are 5 s; each layer is trimmed to 3 frames).
		for (const [i, mode] of MODES.entries()) {
			const r = d.tx([
				{ type: 'clip.place', source: { mediaId: b }, at: 3 + 3 * i, tracks: { video: 'V2' }, ref: '$l' },
			]);
			const id = r.refs.$l!;
			layerClips.push(id);
			d.tx([
				{ type: 'clip.trim', clipId: id, edge: 'out', deltaFrames: 3 - dur(id) },
				{ type: 'clip.update', clipIds: [id], patch: { blendMode: mode } },
				{ type: 'param.set', target: ['clip', id, 'opacity'], value: 60 },
			]);
		}
		// The base pattern alone (frame 0) and a full-opacity Normal layer (after the last mode) as references.
		const end = 3 + 3 * MODES.length;
		const ref = d.tx([
			{ type: 'clip.place', source: { mediaId: b }, at: end, tracks: { video: 'V2' }, ref: '$r' },
		]).refs.$r!;
		d.tx([{ type: 'clip.trim', clipId: ref, edge: 'out', deltaFrames: 3 - dur(ref) }]);
		// A blank nested text with a blend mode over the whole span keeps the stills on the Remotion path (native refuses
		// nested blend modes).
		const t = d.tx([
			{ type: 'clip.addText', at: 0, duration: end + 6, track: 'V3', content: { text: ' ' }, ref: '$t' },
		]).refs.$t!;
		d.tx([
			{ type: 'clip.update', clipIds: [t], patch: { blendMode: 'screen' } },
			{ type: 'clip.nest', clipIds: [t] },
		]);
		const b0 = await still(1);
		expect(b0.path).toBe('remotion');
		base = b0.rgb;
		layer = (await still(end + 1)).rgb;
	}, 600_000);
	afterAll(async () => {
		await engine?.stop();
	});

	const CSS = new Set(MODES.filter((m) => !!blendModeInfo(m)?.css));
	const STEEP = new Set([
		'dissolve',
		'color-burn',
		'color-dodge',
		'vivid-light',
		'hard-mix',
		'divide',
		'darker-color',
		'lighter-color',
		'hue',
		'saturation',
		'color',
		'luminosity',
	]);
	it.each(MODES.map((m, i) => [m, i] as const))(
		'%s at 60 % opacity = blendPixel (as the native export)',
		async (mode, i) => {
			const frame = 4 + 3 * i;
			const out = await still(frame);
			expect(out.path).toBe('remotion');
			const sa = 153 / 255;
			const seed = dissolveSeed(layerClips[i]!, frame - (3 + 3 * i));
			let bad = 0;
			let n = 0;
			let worst = 0;
			for (let p = 0; p < W * HH; p += 37) {
				const k3 = p * 3;
				const dst: Rgba = [base[k3]! / 255, base[k3 + 1]! / 255, base[k3 + 2]! / 255, 1];
				const src: Rgba = [
					(layer[k3]! / 255) * sa,
					(layer[k3 + 1]! / 255) * sa,
					(layer[k3 + 2]! / 255) * sa,
					sa,
				];
				const want = storePremul8(blendPixel(mode, dst, src, dissolveNoise(p % W, Math.floor(p / W), seed)));
				n++;
				let e = 0;
				for (let k = 0; k < 3; k++) e = Math.max(e, Math.abs(want[k]! * 255 - out.rgb[k3 + k]!));
				worst = Math.max(worst, e);
				// CSS modes are drawn by Chrome's compositor: ≤ 3 code values with layer opacity (blend-gl.test.ts).
				if (e > (CSS.has(mode) ? 3.5 : 2.5)) {
					bad++;
					if (process.env.BLEND_DEBUG && bad < 6)
						console.info(
							'BAD',
							mode,
							p % W,
							Math.floor(p / W),
							[...base.subarray(k3, k3 + 3)],
							[...layer.subarray(k3, k3 + 3)],
							want.map((v) => Math.round(v * 255)),
							[...out.rgb.subarray(k3, k3 + 3)],
						);
				}
			}
			console.info(`[blend remotion] ${mode}: ${bad}/${n} off, worst ${worst.toFixed(1)}`);
			expect(bad / n, `${mode}: ${bad} of ${n} pixels off (worst ${worst})`).toBeLessThanOrEqual(
				STEEP.has(mode) ? 0.002 : 0,
			);
		},
		120_000,
	);
});
