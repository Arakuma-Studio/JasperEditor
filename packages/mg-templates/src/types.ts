// Motion-graphic template definitions: the TS twins of the Rust `jasper-mg` templates
// (ARCHITECTURE §10.2, D-12). Each definition mirrors one Rust module in
// native/mg/crates/jasper-mg-templates/src (same id, version, param names, defaults and ranges).
import type { ZodType } from 'zod';

export type MgCanvas = { width: number; height: number };

/** Timing and markup options for `renderSvg` (all optional). */
export type MgSvgOptions = {
	/**
	 * Clip duration in frames. Outros are anchored to the end of the clip, so pass the clip duration
	 * whenever it is known. Default: the template's `defaultDurationSeconds` at `fps`.
	 */
	durationFrames?: number;
	/** Frames of the template timeline skipped at the head (clip sourceIn). Default 0. */
	sourceInFrames?: number;
	/**
	 * Prefix for element ids (clip paths). SVG ids are document-global when the markup is inlined, so
	 * give every layer its own prefix. Default `mg` (what the native renderer uses).
	 */
	idPrefix?: string;
};

export type MgTemplateDefinition<P extends Record<string, unknown> = Record<string, unknown>> = {
	id: string;
	version: number;
	name: string;
	category: string;
	/** One-line description for the Motion Templates gallery. */
	description?: string;
	/** Must mirror the Rust serde struct of the template (strict object, every field defaulted). */
	paramsSchema: ZodType<P>;
	defaults: P;
	/** Frames kept intact when the clip duration changes ("Responsive Design – Time", S01:KND-009). */
	introFrames: number;
	outroFrames: number;
	/** Default clip length when the template is inserted (S05:MGT-002). */
	defaultDurationSeconds: number;
	/** Canvases the Rust template supports natively (others are scaled). */
	canvases: MgCanvas[];
	/**
	 * SVG markup for one frame (straight alpha, transparent background). `frame` is the clip-local frame
	 * (0-based) at `fps`; the result is a complete `<svg>` element sized to `canvas`.
	 */
	renderSvg(params: P, frame: number, fps: number, canvas: MgCanvas, options?: MgSvgOptions): string;
};

export type AnyMgTemplate = MgTemplateDefinition<any>;
