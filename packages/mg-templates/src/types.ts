// Motion-graphic template definitions: the TS twins of the Rust `jasper-mg` templates
// (ARCHITECTURE §10.2, D-12). WP-2G fills the catalog.
import type { ZodType } from 'zod';

export type MgCanvas = { width: number; height: number };

export type MgTemplateDefinition<P extends Record<string, unknown> = Record<string, unknown>> = {
	id: string;
	version: number;
	name: string;
	category: string;
	/** Must mirror the Rust serde struct of the template. */
	paramsSchema: ZodType<P>;
	defaults: P;
	/** Frames kept intact when the clip duration changes ("Responsive Design – Time", S01:KND-009). */
	introFrames: number;
	outroFrames: number;
	/** Canvases the Rust template supports natively (others are scaled). */
	canvases: MgCanvas[];
	/**
	 * SVG markup for one frame (straight alpha, transparent background). `frame` is the clip-local frame
	 * (0-based) at `fps`; the result must be a complete `<svg>` element sized to `canvas`.
	 */
	renderSvg(params: P, frame: number, fps: number, canvas: MgCanvas): string;
};

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous catalogs need a widened params type
export type AnyMgTemplate = MgTemplateDefinition<any>;
