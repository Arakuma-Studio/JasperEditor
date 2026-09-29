// Motion-graphic template registry interface (ARCHITECTURE §5.4). Implemented by @jasper/mg-templates
// and injected through CommandContext; @jasper/project never imports template code.
import type { ZodType } from 'zod';

export type MgCanvasSize = { width: number; height: number };

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
};

export interface MgTemplateRegistry {
	get(id: string, version: number): MgTemplateInfo | undefined;
	list(): MgTemplateInfo[];
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
