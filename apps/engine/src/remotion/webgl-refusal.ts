// Why a render document cannot render with the render browser's WebGL status (spec 19 TL-123, TL-124): shared by the
// export planner (a plan blocker before anything runs) and the Remotion service (a job refusal before it opens a
// browser). Pure; no I/O.
import type { GlNeed } from '@jasper/project';

/** What the WebGL probe of the render browser found (`RemotionWebglStatus` of service.ts, narrowed). */
export type WebglStatus = {
	state: 'ok' | 'unavailable' | 'unknown';
	/** Whether the WebGL renderer is a GPU (false: SwiftShader, llvmpipe…); absent = not probed. */
	hardware?: boolean;
	/** Whether the browser has `EXT_color_buffer_float` (float render targets); absent = not probed. */
	floatTargets?: boolean;
	/** `MAX_RENDERBUFFER_SIZE` of the browser's WebGL2 (3D supersampling); absent = not probed. */
	maxRenderbufferSize?: number;
	message?: string;
};

/**
 * The refusal for a document with `needs` (`snapshotGlNeeds`) under the probed status `s`, or null: WebGL2 missing
 * (`WEBGL_UNAVAILABLE`), or an effect that `requiresFloat` without float render targets (its own code, e.g.
 * `FX_NEEDS_FLOAT`). `unknown` (not probed, Remotion not ready) refuses nothing: the render decides.
 */
export function webglRefusal(
	needs: readonly GlNeed[],
	s: WebglStatus,
): { code: string; message: string; needs: GlNeed[] } | null {
	if (needs.length === 0) return null;
	const names = [...new Set(needs.map((n) => n.label))].slice(0, 5).join(', ');
	if (s.state === 'unavailable')
		return {
			code: 'WEBGL_UNAVAILABLE',
			message: `${names}: colour grading, GPU effects, GPU transitions, blend modes and 3D layers need WebGL2 in the render browser, which is unavailable here${s.message ? ` (${s.message})` : ''}`,
			needs: [...needs],
		};
	if (s.state === 'ok' && s.floatTargets === false) {
		const floats = needs.filter((n) => n.float);
		const first = floats[0]?.float;
		if (first) return { code: first.code, message: first.message, needs: floats };
	}
	return null;
}
