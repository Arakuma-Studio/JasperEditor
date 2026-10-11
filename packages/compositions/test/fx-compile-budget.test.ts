// @vitest-environment node
// SwiftShader compile time grows super-linearly with inlined noise and hash calls.
// Include the first draw and readback: ANGLE may compile a pipeline lazily.
// Retest over-budget programs in a fresh browser; host load can inflate wall times.
import { existsSync, writeFileSync } from 'node:fs';
import {
	defaultEffectRegistry,
	defineShaderEffect,
	type EffectParams,
	type EffectSpec,
	fxParam,
	fxSeed,
	GLSL_LIBRARY,
	type ParamSpec,
	planGpuEffect,
	planGpuTransition,
	TRANSITION_SPECS,
	type TransitionSpec,
} from '@jasper/project';
import { type Browser, chromium, type Page } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { budgetMs } from '../../../scripts/perf/budget.ts';
import { TEST_FX } from './fx-examples.ts';
import { TEST_TRANSITIONS } from './transition-examples.ts';

const CHROME = [
	process.env.JASPER_BROWSER_EXECUTABLE,
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
].find((p): p is string => !!p && existsSync(p));

/** Scale the documented budget by host load unless PERF=1 (scripts/perf/budget.ts). */
const BASE_BUDGET = Number(process.env.FX_COMPILE_BUDGET_MS ?? 5000);
const BUDGET = budgetMs(BASE_BUDGET, { parallel: true });
const WORKERS = Math.max(1, Number(process.env.FX_COMPILE_WORKERS ?? 2));
const FILTER = process.env.FX_COMPILE_FILTER ?? '';
/** A program still compiling after this long is reported as a timeout (the page is then discarded). */
const HARD_TIMEOUT = Math.max(BUDGET * 4, 60_000);

/** `vertex`: the generated vertex shader of a draw pass (sim-warp), else the full-screen triangle. */
type Program = { source: string; vertex?: string; users: string[] };

const defaults = (params: readonly ParamSpec[]): EffectParams =>
	Object.fromEntries(params.map((param) => [param.name, param.default] as const));

function collectPrograms(): Program[] {
	const bySource = new Map<string, Program>();
	const add = (source: string, user: string, vertex?: string) => {
		const key = vertex ? `${source}\u0000${vertex}` : source;
		const hit = bySource.get(key);
		if (hit) hit.users.push(user);
		else bySource.set(key, { source, ...(vertex ? { vertex } : {}), users: [user] });
	};
	const effects: EffectSpec[] = [...defaultEffectRegistry.list().filter((s) => s.gpu), ...TEST_FX];
	for (const spec of effects) {
		if (FILTER && !spec.id.includes(FILTER)) continue;
		const params = defaults(spec.params);
		const plan = planGpuEffect(
			spec,
			{ id: 'fx1', params },
			{
				width: 64,
				height: 36,
				pxScale: 1,
				fps: 30,
				frame: 0,
				duration: 30,
				seed: fxSeed('clip', 'fx1', params),
				progress: 0,
			},
			{ width: 64, height: 36 },
		);
		for (const p of plan.passes) add(p.source, `${spec.id}#${p.index}`, p.vertex?.source);
	}
	const transitions: TransitionSpec[] = [...TRANSITION_SPECS.filter((s) => s.gpu), ...TEST_TRANSITIONS];
	for (const spec of transitions) {
		if (FILTER && !spec.id.includes(FILTER)) continue;
		const side = { width: 64, height: 36, compToCanvas: [1, 0, 0, 0, 1, 0, 0, 0, 1], opacity: 1 };
		const staged = planGpuTransition(
			spec,
			{ id: 'trn', params: defaults(spec.params), frame: 5, duration: 10, sides: 'both' },
			{ width: 64, height: 36, fps: 30 },
			{ out: side, in: side },
		);
		for (const p of staged.plan.passes) add(p.source, `${spec.id}#${p.index}`);
	}
	// The noise/hash helpers of the library inside loops (constant and dynamic bounds): what family authors write.
	if (!FILTER || 'library'.includes(FILTER))
		for (const [name, body] of LIBRARY_STRESS) {
			const spec = defineShaderEffect({
				id: `library.${name}`,
				label: name,
				category: 'Utility',
				params: [fxParam.number('n', 'N', 6, { min: 0, max: 12 })],
				gpu: {
					passes: [
						{
							include: GLSL_LIBRARY,
							frag: `void main() {\n  vec2 p = fx_layerPx() * 0.05;\n  float acc = 0.0;\n${body}\n  fragColor = vec4(vec3(acc), 1.0);\n}`,
						},
					],
				},
			});
			const plan = planGpuEffect(
				spec,
				{ id: 'fx1', params: { n: 6 } },
				{ width: 64, height: 36, pxScale: 1, fps: 30, frame: 0, duration: 30, seed: 0.5, progress: 0 },
				{ width: 64, height: 36 },
			);
			add(plan.passes[0]!.source, spec.id);
		}
	return [...bySource.values()];
}

/** Library helpers in loops (8 constant iterations, or a uniform bound), one program each. */
const LIBRARY_STRESS: [string, string][] = [
	['hash2-loop', '  for (int i = 0; i < 16; i++) acc += fx_hash2(ivec2(p) + ivec2(i, -i), u_seed);'],
	['hash3-loop', '  for (int i = 0; i < 16; i++) acc += fx_hash3(ivec3(ivec2(p), i - 8), u_seed);'],
	[
		'random-loop',
		'  for (int i = 0; i < 16; i++) acc += fx_random(p + float(i), u_frame - float(i), u_seed);',
	],
	['valueNoise-loop', '  for (int i = 0; i < 8; i++) acc += fx_valueNoise(p * float(i + 1), u_seed);'],
	[
		'valueNoise3-loop',
		'  for (int i = 0; i < 8; i++) acc += fx_valueNoise3(vec3(p, u_time) * float(i + 1), u_seed);',
	],
	['gradientNoise-loop', '  for (int i = 0; i < 8; i++) acc += fx_gradientNoise(p * float(i + 1), u_seed);'],
	['simplex-loop', '  for (int i = 0; i < 8; i++) acc += fx_simplex(p * float(i + 1), u_seed);'],
	[
		'simplex3-loop',
		'  for (int i = 0; i < 8; i++) acc += fx_simplex3(vec3(p, u_time) * float(i + 1), u_seed);',
	],
	[
		'simplex3-dyn',
		'  for (int i = 0; i < int(u_n); i++) acc += fx_simplex3(vec3(p, u_time) * float(i + 1), u_seed);',
	],
	['fbm', '  acc = fx_fbm(p, 8, 2.0, 0.5, u_seed);'],
	['fbm-loop', '  for (int i = 0; i < 4; i++) acc += fx_fbm(p + float(i), 6, 2.0, 0.5, u_seed);'],
	['fbm3', '  acc = fx_fbm3(vec3(p, u_time), 8, 2.0, 0.5, u_seed);'],
	[
		'fbm3-loop',
		'  for (int i = 0; i < 4; i++) acc += fx_fbm3(vec3(p + float(i), u_time), 6, 2.0, 0.5, u_seed);',
	],
	[
		'turbulence-ridged',
		'  acc = fx_turbulence(vec3(p, u_time), 8, 2.0, 0.5, u_seed) + fx_ridged(vec3(p, u_time), 8, 2.0, 0.5, u_seed);',
	],
	['cellular-loop', '  for (int i = 0; i < 8; i++) acc += fx_cellular(p * float(i + 1), 1.0, u_seed).x;'],
	['cellId-loop', '  for (int i = 0; i < 8; i++) acc += fx_cellId(p * float(i + 1), 1.0, u_seed);'],
	[
		'hash22-33-loop',
		'  for (int i = 0; i < 8; i++) { acc += fx_hash22(ivec2(p) + i, u_seed).x + fx_hash33(ivec3(ivec2(p), i), u_seed).y; }',
	],
];

function compileInPage(prog: { source: string; vertex?: string }): number | string {
	const { source, vertex } = prog;
	const w = window as Window & {
		__gl?: WebGL2RenderingContext;
		__vs?: WebGLShader;
		__fbo?: WebGLFramebuffer;
	};
	if (!w.__gl) {
		const c = document.createElement('canvas');
		c.width = 4;
		c.height = 4;
		const gl = c.getContext('webgl2', { antialias: false, depth: false, stencil: false });
		if (!gl) return 'no WebGL2';
		const vs = gl.createShader(gl.VERTEX_SHADER)!;
		gl.shaderSource(
			vs,
			'#version 300 es\nin vec2 a_pos;\nout vec2 v_uv;\nvoid main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }\n',
		);
		gl.compileShader(vs);
		const buf = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, buf);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
		const tex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
		const fbo = gl.createFramebuffer()!;
		gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
		gl.bindTexture(gl.TEXTURE_2D, null);
		w.__gl = gl;
		w.__vs = vs;
		w.__fbo = fbo;
	}
	const gl = w.__gl;
	const t0 = performance.now();
	const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
	gl.shaderSource(fs, source);
	gl.compileShader(fs);
	let vs = w.__vs!;
	if (vertex) {
		vs = gl.createShader(gl.VERTEX_SHADER)!;
		gl.shaderSource(vs, vertex);
		gl.compileShader(vs);
	}
	const p = gl.createProgram()!;
	gl.attachShader(p, vs);
	gl.attachShader(p, fs);
	gl.bindAttribLocation(p, 0, 'a_pos');
	gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
		const log = `${vertex ? (gl.getShaderInfoLog(vs) ?? '') : ''}${gl.getShaderInfoLog(fs) ?? ''}${gl.getProgramInfoLog(p) ?? ''}`;
		if (vertex) gl.deleteShader(vs);
		gl.deleteShader(fs);
		gl.deleteProgram(p);
		return `compile/link error: ${log}`;
	}
	gl.bindFramebuffer(gl.FRAMEBUFFER, w.__fbo!);
	gl.viewport(0, 0, 4, 4);
	// biome-ignore lint/correctness/useHookAtTopLevel: WebGL call, not a React hook
	gl.useProgram(p);
	gl.drawArrays(gl.TRIANGLES, 0, 3);
	gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
	const ms = performance.now() - t0;
	if (vertex) gl.deleteShader(vs);
	gl.deleteShader(fs);
	gl.deleteProgram(p);
	return ms;
}

type Timing = { ms: number | null; users: string[]; error?: string };

async function launch(): Promise<{ browser: Browser; page: Page }> {
	const browser = await chromium.launch({
		executablePath: CHROME,
		args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
	});
	const page = await browser.newPage();
	await page.setContent('<!doctype html><html><body></body></html>');
	return { browser, page };
}

async function timeAll(programs: Program[]): Promise<Timing[]> {
	const out: Timing[] = new Array(programs.length);
	let next = 0;
	const worker = async () => {
		let b = await launch();
		try {
			while (next < programs.length) {
				const i = next++;
				const prog = programs[i]!;
				let timer: ReturnType<typeof setTimeout> | undefined;
				const r = await Promise.race([
					b.page.evaluate(compileInPage, {
						source: prog.source,
						...(prog.vertex ? { vertex: prog.vertex } : {}),
					}),
					new Promise<'timeout'>((res) => {
						timer = setTimeout(() => res('timeout'), HARD_TIMEOUT);
					}),
				]).catch((e: Error) => `evaluate failed: ${e.message}`);
				clearTimeout(timer);
				if (r === 'timeout') {
					out[i] = { ms: null, users: prog.users, error: `still compiling after ${HARD_TIMEOUT} ms` };
					await b.browser.close().catch(() => {});
					b = await launch();
				} else if (typeof r === 'string') out[i] = { ms: null, users: prog.users, error: r };
				else out[i] = { ms: r, users: prog.users };
			}
		} finally {
			await b.browser.close().catch(() => {});
		}
	};
	await Promise.all(Array.from({ length: WORKERS }, worker));
	return out;
}

describe.runIf(!!CHROME && process.env.FX_GL !== '0')('fx programs compile fast on SwiftShader', () => {
	it(`every effect and transition program compiles within ${BASE_BUDGET} ms (× host load unless PERF=1)`, {
		timeout: 3_600_000,
	}, async () => {
		const programs = collectPrograms();
		expect(programs.length).toBeGreaterThan(FILTER ? 0 : 100);
		const t0 = Date.now();
		const timings = await timeAll(programs);
		// A loaded host inflates wall times: programs over the budget are timed again (fresh browser), best kept.
		const slow = timings.map((t, i) => [t, i] as const).filter(([t]) => t.ms !== null && t.ms > BUDGET);
		if (slow.length) {
			const again = await timeAll(slow.map(([, i]) => programs[i]!));
			slow.forEach(([t, i], k) => {
				const r = again[k]!;
				if (r.ms !== null && r.ms < t.ms!) timings[i] = r;
			});
		}
		const total = Date.now() - t0;
		const ranked = [...timings].sort((a, b) => (b.ms ?? Infinity) - (a.ms ?? Infinity));
		const label = (t: Timing) =>
			`${t.ms === null ? 'TIMEOUT/ERROR' : `${Math.round(t.ms)} ms`}  ${t.users.slice(0, 3).join(', ')}${t.users.length > 3 ? ` (+${t.users.length - 3})` : ''}${t.error ? `  ${t.error.slice(0, 200)}` : ''}`;
		console.log(
			`[fx-compile] ${programs.length} programs in ${Math.round(total / 1000)} s (${WORKERS} workers); slowest:\n${ranked
				.slice(0, 15)
				.map((t) => `  ${label(t)}`)
				.join('\n')}`,
		);
		if (process.env.FX_COMPILE_REPORT)
			writeFileSync(
				process.env.FX_COMPILE_REPORT,
				JSON.stringify(
					ranked.map((t) => ({ ms: t.ms, users: t.users, error: t.error })),
					null,
					1,
				),
			);
		const errors = timings.filter((t) => t.error).map(label);
		expect(errors).toEqual([]);
		const over = timings.filter((t) => t.ms !== null && t.ms > BUDGET).map(label);
		expect(over).toEqual([]);
	});
});
