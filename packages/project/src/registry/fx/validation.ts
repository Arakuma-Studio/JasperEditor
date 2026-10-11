export const FORBIDDEN_GLSL_SYNTAX: readonly (readonly [RegExp, string])[] = [
	[/#version/, 'must not contain #version (the framework adds it)'],
	[/\bprecision\s+(highp|mediump|lowp)\b/, 'must not declare precision (the prelude does)'],
	[/\bgl_FragColor\b/, 'uses gl_FragColor (GLSL ES 1.00); write fragColor'],
	[/\btexture2D\s*\(/, 'uses texture2D (GLSL ES 1.00); use texture()'],
	[/\bvarying\b/, 'uses varying (GLSL ES 1.00)'],
	[/\bout\s+vec4\s+fragColor\b/, 'declares fragColor (the prelude does)'],
];

/** A thrown value may also throw when its message is read or converted to text. */
export function hookErrorMessage(error: unknown): string {
	try {
		return String(error instanceof Error ? error.message : error);
	} catch {
		return 'Unknown shader hook error';
	}
}
