// `defineShaderEffect`: the one way family files declare GPU effects, so every entry gets the
// same defaults — version 1, video, `preview: 'webgl'`, Remotion export (native only with an explicit ffmpeg
// mapping), the Effects-panel bin — and new framework fields reach all of them. Bins mirror how Premiere shows
// third-party packs: Video Effects ▸ <bin> ▸ <effect> (R-PUI §12).
import type { EffectCategory, EffectSpec, ParamSpec } from '../effects.ts';
import type { GpuEffect } from './shader.ts';

/** Effects-panel bins of the Sapphire-style families (Premiere lists each as a folder under Video Effects). */
export const SAPPHIRE_BINS = {
	adjust: 'Sapphire Adjust',
	blurSharpen: 'Sapphire Blur+Sharpen',
	composite: 'Sapphire Composite',
	distort: 'Sapphire Distort',
	glows: 'Sapphire Glows',
	lighting: 'Sapphire Lighting',
	render: 'Sapphire Render',
	stylize: 'Sapphire Stylize',
	time: 'Sapphire Time',
} as const;

export type ShaderEffectInit = {
	/** `jasper.<kebab>` (Premiere-standard families) or `jasper.s.<kebab>` (Sapphire-style families). */
	id: string;
	label: string;
	category: EffectCategory;
	/** Effects-panel folder under Video Effects (default: the category). */
	bin?: string;
	params: ParamSpec[];
	gpu: GpuEffect;
	description?: string;
	keywords?: readonly string[];
	version?: number;
	/**
	 * ffmpeg mapping for the native export path. Leave it unset (null): today's native builder renders only crop,
	 * flips and the extensions' effects (colour LUTs), so clips with any other effect — GPU effects included — export
	 * through Remotion, where the shader runs. A mapping must match the shader within the FX-040 tolerance (golden
	 * test) and use filters of the shipped LGPL FFmpeg (D-13); it is reserved for a later registry-driven builder.
	 */
	native?: EffectSpec['native'];
	/** Optional CSS/SVG approximation used where GPU effects cannot run in the preview (no WebGL2). */
	preview?: EffectSpec['preview'];
	expensive?: boolean;
	migrate?: EffectSpec['migrate'];
};

export function defineShaderEffect(init: ShaderEffectInit): EffectSpec {
	const native = init.native ?? null;
	return {
		id: init.id,
		version: init.version ?? 1,
		label: init.label,
		category: init.category,
		...(init.bin ? { bin: init.bin } : {}),
		appliesTo: 'video',
		params: init.params,
		preview: init.preview ?? {},
		native,
		gpu: init.gpu,
		capabilities: { preview: 'webgl', export: native ? ['remotion', 'native'] : ['remotion'] },
		...(init.expensive ? { expensive: true } : {}),
		...(init.description ? { description: init.description } : {}),
		...(init.keywords ? { keywords: init.keywords } : {}),
		...(init.migrate ? { migrate: init.migrate } : {}),
	};
}
