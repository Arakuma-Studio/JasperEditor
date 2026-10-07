// Distort ▸ Puppet (sim-warp workstream; After Effects' Puppet effect): the layer is drawn through triangle meshes
// deformed as rigidly as possible by pins (Position, Advanced, Bend, Starch and Overlap pins, `EffectInstance.puppet`,
// edited with the Program monitor's Puppet Pin tool and the `puppet.*` commands). The ARAP solve runs per frame in TS
// (puppet/arap.ts); a draw pass maps the source through the deformed triangles, back to front by Overlap depth.
// Areas outside every mesh are not drawn (as in After Effects); without meshes the layer passes through.

import { type ResolvedPuppet, solvePuppet } from '../../../puppet/model.ts';
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { GLSL_DATA } from '../glsl/data.ts';
import type { FxPlanContext } from '../shader.ts';
import { n } from './common.ts';
import { clamp, num } from './core.ts';

const refineOf = (p: Record<string, unknown>) => clamp(Math.round(num(p.refinement, 20) / 10), 0, 10);

function solved(p: Record<string, unknown>, ctx: FxPlanContext) {
	const pup = ctx.structures?.puppet as ResolvedPuppet | undefined;
	if (!pup || pup.meshes.length === 0) return null;
	return solvePuppet(pup, ctx.width, ctx.height, refineOf(p));
}

export const PUPPET = defineShaderEffect({
	id: 'jasper.puppet',
	label: 'Puppet',
	category: 'Distort',
	description:
		'Deforms the layer like a puppet: place pins with the Puppet Pin tool on the Program monitor and move or animate them; Starch stiffens, Overlap layers parts in front.',
	keywords: ['puppet', 'pins', 'mesh', 'deform', 'character', 'arap'],
	params: [n('refinement', 'Mesh Rotation Refinement', 20, 0, 100, 0, 100, 1, { animatable: false })],
	expensive: true,
	gpu: {
		padding: (p, ctx) => {
			const s = solved(p, ctx);
			if (!s) return 0;
			let [x0, y0, x1, y1] = [0, 0, ctx.width, ctx.height];
			for (const m of s)
				for (const q of m.deformed) {
					x0 = Math.min(x0, q[0]);
					y0 = Math.min(y0, q[1]);
					x1 = Math.max(x1, q[0]);
					y1 = Math.max(y1, q[1]);
				}
			const c = (v: number) => Math.min(2048, Math.ceil(Math.max(0, v) + 2));
			return { left: c(-x0), top: c(-y0), right: c(x1 - ctx.width), bottom: c(y1 - ctx.height) };
		},
		uniforms: (p, ctx) => {
			const s = solved(p, ctx);
			const tris: { d: number; i: number; data: number[] }[] = [];
			let k = 0;
			for (const m of s ?? [])
				m.geometry.tris.forEach((t, ti) => {
					const data: number[] = [];
					for (const v of t)
						data.push(m.geometry.verts[v]![0], m.geometry.verts[v]![1], m.deformed[v]![0], m.deformed[v]![1]);
					tris.push({ d: m.depths[ti]!, i: k++, data });
				});
			// Back to front by Overlap depth (stable).
			tris.sort((a, b) => a.d - b.d || a.i - b.i);
			return {
				u_pp: { texels: tris.length ? tris.flatMap((t) => t.data) : [0, 0, 0, 0] },
				u_ppTris: { int: tris.length },
				u_ppOn: !!s,
			};
		},
		passes: [
			{
				output: 'deformed',
				include: [GLSL_DATA],
				draw: {
					vertices: 3,
					instances: { uniform: 'u_ppTris' },
					vert: /* glsl */ `
out vec2 v_rest;
void main() {
  vec4 q = fx_texel(u_pp, gl_InstanceID * 3 + gl_VertexID);
  v_rest = q.xy;
  fx_emit(fx_canvasPxOfLayerPx(q.zw));
}`,
				},
				frag: /* glsl */ `
in vec2 v_rest;
void main() { fragColor = texture(u_source, fx_uvOfLayerPx(v_rest)); }`,
			},
			{
				frag: /* glsl */ `
void main() {
  if (!u_ppOn) { fragColor = texture(u_source, v_uv); return; }
  fragColor = texture(u_deformed, v_uv);
}`,
			},
		],
	},
});

export const PUPPET_EFFECTS: readonly EffectSpec[] = [PUPPET];
