import { defaultEffectRegistry, planGpuEffect } from '@jasper/project';

const VS = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  v_uv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const api = {
	compile(id: string, extraSource?: string) {
		const spec = defaultEffectRegistry.get(id)!;
		const params = Object.fromEntries(spec.params.map((p) => [p.name, p.default]));
		const plan = planGpuEffect(
			spec,
			{ id: 'x', params },
			{ width: 64, height: 36, pxScale: 1, fps: 30, frame: 0, duration: 30, seed: 0.5, progress: 0 },
			{ width: 64, height: 36 },
		);
		const gl = document.createElement('canvas').getContext('webgl2')!;
		const out: { pass: number; ms: number; ok: boolean; log?: string }[] = [];
		const sources = extraSource ? [extraSource] : plan.passes.map((p) => p.source);
		sources.forEach((src, i) => {
			const t = performance.now();
			const vs = gl.createShader(gl.VERTEX_SHADER)!;
			gl.shaderSource(vs, VS);
			gl.compileShader(vs);
			const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
			gl.shaderSource(fs, src);
			gl.compileShader(fs);
			const prog = gl.createProgram()!;
			gl.attachShader(prog, vs);
			gl.attachShader(prog, fs);
			gl.linkProgram(prog);
			const ok = !!gl.getProgramParameter(prog, gl.LINK_STATUS);
			// Force the driver to really build the program (SwiftShader JITs at the first draw with fragments).
			gl.canvas.width = 4;
			gl.canvas.height = 4;
			gl.viewport(0, 0, 4, 4);
			gl.useProgram(prog);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
			gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
			gl.finish();
			out.push({
				pass: i,
				ms: Math.round(performance.now() - t),
				ok,
				...(ok ? {} : { log: gl.getShaderInfoLog(fs) ?? '' }),
			});
		});
		return out;
	},
	source(id: string, pass: number) {
		const spec = defaultEffectRegistry.get(id)!;
		const params = Object.fromEntries(spec.params.map((p) => [p.name, p.default]));
		return planGpuEffect(
			spec,
			{ id: 'x', params },
			{ width: 64, height: 36, pxScale: 1, fps: 30, frame: 0, duration: 30, seed: 0.5, progress: 0 },
			{ width: 64, height: 36 },
		).passes[pass]!.source;
	},
};

declare global {
	interface Window {
		__c: typeof api;
	}
}

window.__c = api;
