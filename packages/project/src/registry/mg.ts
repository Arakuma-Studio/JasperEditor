// Motion-graphic template registry interface (ARCHITECTURE §5.4). Implemented by @jasper/mg-templates
// and injected through CommandContext; @jasper/project never imports template code.
import type { ZodType } from 'zod';
import type { MgRenderer } from '../schema/sequence.ts';

export type MgCanvasSize = { width: number; height: number };

/** Timing of a clip whose template motion is measured: sequence rate and content length (sourceIn + duration). */
export type MgTemplateMotionTiming = { fps: number; totalFrames: number };

export type MgTemplateInfo = {
	id: string;
	version: number;
	name: string;
	category: string;
	/** Validates (and defaults) the params object. */
	paramsSchema: ZodType;
	defaults: Record<string, unknown>;
	introFrames: number;
	outroFrames: number;
	/** Canvas used when a clip says `canvas: 'sequence'` is not wanted. */
	canvasDefault: MgCanvasSize | 'sequence';
	canvases?: MgCanvasSize[];
	/** M2 (S11:ATP-001): `anime` templates are drawn by `@jasper/motion/templates`; absent = fframes. */
	renderer?: MgRenderer;
	/** M2 (S11:ANA-001): one-line gallery description. */
	description?: string;
	/** M2 (S11:ANA-001): default clip length when inserted (S05:MGT-002). */
	defaultDurationSeconds?: number;
	/**
	 * Sound design (spec 12 §2.2, optional): the template's picture speed per CONTENT frame `0 … totalFrames − 1`
	 * at `timing.fps` (`speed[i]`: from frame i − 1 to i, `speed[0]` = 0) in canvas diagonals per second, the units
	 * of the keyframed-clip sampler (`sound/cues/motion.ts`). Null (or absent) when the motion cannot be measured;
	 * the mg cues then fall back to the declared `introFrames` / `outroFrames`. Must be pure and never throw.
	 */
	motionSpeed?(params: Record<string, unknown>, timing: MgTemplateMotionTiming): number[] | null;
};

/** Result of a template version upgrade (S11:ATP-009). */
export type MgTemplateUpgrade = { version: number; params: Record<string, unknown> };

export interface MgTemplateRegistry {
	get(id: string, version: number): MgTemplateInfo | undefined;
	list(): MgTemplateInfo[];
	/**
	 * M2 (S11:ATP-009, optional): migrates params of `id@fromVersion` to the newest version that has an upgrade
	 * path; null when there is none. Implemented by `@jasper/mg-templates` (wp-m2-anime-templates).
	 * `toVersion` (additive, wp-m2-anime-templates): stop at that version (null when the path does not reach it).
	 */
	upgrade?(
		id: string,
		fromVersion: number,
		params: Record<string, unknown>,
		toVersion?: number,
	): MgTemplateUpgrade | null;
}

export const emptyMgRegistry: MgTemplateRegistry = {
	get: () => undefined,
	list: () => [],
};

export function createStaticMgRegistry(infos: MgTemplateInfo[]): MgTemplateRegistry {
	const map = new Map(infos.map((t) => [`${t.id}@${t.version}`, t]));
	return {
		get: (id, version) => map.get(`${id}@${version}`),
		list: () => [...map.values()],
	};
}
