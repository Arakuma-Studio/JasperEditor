// @vitest-environment node
// Dev aid (MB_BENCH=1): SwiftShader cost of motion-blur tap-loop variants, 64 taps per pixel.
import { appendFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FX_MB_KEYS, mbUniforms } from '@jasper/project';
import { chromium } from '@playwright/test';
import { describe, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = ['/usr/bin/google-chrome'].find((p) => existsSync(p));

const keys = Array.from({ length: FX_MB_KEYS + 2 }, (_, k) => [k * 2, Math.sin(k) * 3, 0.01 * k, 1]).flat();
const plan = (flags: number) =>
	mbUniforms({
		taps: 64,
		keys: FX_MB_KEYS,
		stride: 1,
		extentPx: 64,
		jitter: true,
		packed: keys,
		warp: flags & 2 ? Array.from({ length: 32 }, (_, m) => (m / 31) ** 1.5) : null,
		times: [],
	});
const TAP = 'vec4 tapAt(vec2 off) { return texture(u_source, v_uv + off / u_canvasSize); }\n';
const VARIANTS: [string, string, Record<string, unknown>][] = [
	[
		'A old: const bound, float[] uniform index',
		`${TAP}void main() { vec4 acc = vec4(0.0); int n = u_n;
  for (int i = 0; i < 64; i++) { if (i >= n) break; int b = i * 4; acc += tapAt(vec2(u_shk[b], u_shk[b + 1])); }
  fragColor = acc / float(n); }`,
		{ u_shk: { floats: Array.from({ length: 256 }, (_, i) => i * 0.1) }, u_n: { int: 64 }, ...plan(1) },
	],
	[
		'B dyn bound, float[] uniform index',
		`${TAP}void main() { vec4 acc = vec4(0.0); int n = u_n;
  for (int i = 0; i < fx_mbDyn(96); i++) { if (i >= n) break; int b = i * 4; acc += tapAt(vec2(u_shk[b], u_shk[b + 1])); }
  fragColor = acc / float(n); }`,
		{ u_shk: { floats: Array.from({ length: 256 }, (_, i) => i * 0.1) }, u_n: { int: 64 }, ...plan(1) },
	],
	[
		'C CR pose, per-pixel jitter',
		`${TAP}void main() { vec4 acc = vec4(0.0); int n = fx_mbTaps(); float j = fx_mbPlanJitter(); float ws = 0.0;
  for (int i = 0; i < fx_mbDyn(96); i++) { if (i >= n) break; vec2 t = fx_mbTap(i, n, j); vec4 q = fx_mbPose(0, t.x); acc += tapAt(q.xy) * t.y; ws += t.y; }
  fragColor = acc / ws; }`,
		plan(1),
	],
	[
		'D CR pose + warp',
		`${TAP}void main() { vec4 acc = vec4(0.0); int n = fx_mbTaps(); float j = fx_mbPlanJitter(); float ws = 0.0;
  for (int i = 0; i < fx_mbDyn(96); i++) { if (i >= n) break; vec2 t = fx_mbTap(i, n, j); vec4 q = fx_mbPose(0, t.x); acc += tapAt(q.xy) * t.y; ws += t.y; }
  fragColor = acc / ws; }`,
		plan(3),
	],
	[
		'E CR pose, uniform time (j = 0.5)',
		`${TAP}void main() { vec4 acc = vec4(0.0); int n = fx_mbTaps(); float ws = 0.0;
  for (int i = 0; i < fx_mbDyn(96); i++) { if (i >= n) break; vec2 t = fx_mbTap(i, n, 0.5); vec4 q = fx_mbPose(0, t.x); acc += tapAt(q.xy) * t.y; ws += t.y; }
  fragColor = acc / ws; }`,
		plan(1),
	],
	[
		'F boundary poses (uniform index) + mix by jitter',
		`${TAP}void main() { vec4 acc = vec4(0.0); int n = fx_mbTaps(); float j = fx_mbPlanJitter(); float ws = 0.0;
  vec4 q0 = fx_mbPose(0, fx_mbTap(0, n, 0.0).x);
  for (int i = 0; i < fx_mbDyn(96); i++) { if (i >= n) break; vec2 t1 = fx_mbTap(i + 1, n, 0.0); vec4 q1 = fx_mbPose(0, t1.x); acc += tapAt(mix(q0, q1, j).xy); q0 = q1; }
  fragColor = acc / float(n); }`,
		plan(3),
	],
	[
		'G direct per-tap table (uniform index) + mix by jitter',
		`${TAP}void main() { vec4 acc = vec4(0.0); int n = fx_mbTaps(); float j = fx_mbPlanJitter();
  vec4 q0 = u_tab[0];
  for (int i = 0; i < fx_mbDyn(96); i++) { if (i >= n) break; vec4 q1 = u_tab[i + 1]; acc += tapAt(mix(q0, q1, j).xy); q0 = q1; }
  fragColor = acc / float(n); }`,
		{ ...plan(1), u_tab: { vec4s: Array.from({ length: 65 * 4 }, (_, i) => i * 0.03) } },
	],
	[
		'H linear keys (32), per-pixel time',
		`${TAP}void main() { vec4 acc = vec4(0.0); int n = fx_mbTaps(); float j = fx_mbPlanJitter();
  for (int i = 0; i < fx_mbDyn(96); i++) { if (i >= n) break; float u = fx_mbTapAt(i, n, j) * 31.0; int k = min(int(u), 30);
    vec4 q = mix(u_tab[k], u_tab[k + 1], u - float(k)); acc += tapAt(q.xy); }
  fragColor = acc / float(n); }`,
		{ ...plan(1), u_tab: { vec4s: Array.from({ length: 34 * 4 }, (_, i) => i * 0.03) } },
	],
	[
		'H2 linear keys (32) + warp + weights',
		`${TAP}void main() { vec4 acc = vec4(0.0); int n = fx_mbTaps(); float j = fx_mbPlanJitter(); float ws = 0.0;
  for (int i = 0; i < fx_mbDyn(96); i++) { if (i >= n) break; vec2 t = fx_mbTap(i, n, j); float u = t.x * 31.0; int k = min(int(u), 30);
    vec4 q = mix(u_tab[k], u_tab[k + 1], u - float(k)); acc += tapAt(q.xy) * t.y; ws += t.y; }
  fragColor = acc / ws; }`,
		{ ...plan(3), u_tab: { vec4s: Array.from({ length: 34 * 4 }, (_, i) => i * 0.03) } },
	],
];

describe.runIf(!!CHROME && process.env.MB_BENCH === '1')('motion-blur tap-loop bench', { timeout: 900_000 }, () => {
	it('variants', async () => {
		const req = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'));
		const esbuild = req('esbuild') as {
			build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
		};
		const out = await esbuild.build({
			entryPoints: [join(here, 'fx-motion-blur', 'entry.ts')],
			bundle: true,
			write: false,
			format: 'iife',
			platform: 'browser',
			target: 'es2022',
			define: { 'process.env.NODE_ENV': '"production"' },
			logLevel: 'silent',
		});
		const browser = await chromium.launch({
			executablePath: CHROME,
			args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
		});
		const page = await browser.newPage();
		await page.setContent('<!doctype html><html><body></body></html>');
		await page.addScriptTag({ content: out.outputFiles[0]!.text });
		for (const [name, frag, uniforms] of VARIANTS) {
			const ms = await page.evaluate(
				(a) => (window as unknown as { __mb: { bench(a: unknown): number } }).__mb.bench(a),
				{ frag, uniforms, width: 960, height: 540, repeat: 3 },
			);
			appendFileSync('/tmp/mb-bench.txt', `${name}: ${ms.toFixed(0)} ms\n`);
		}
		await browser.close();
	});
});
