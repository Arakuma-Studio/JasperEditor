// Tool model (S02 §12, TL-590/591; S05:TOOL-001…005): tool ids, groups, keys, and the pointer
// dispatcher's decision table (tool × hit × modifiers → gesture) from the TL §12.14 matrix.
import { isBoundedContent, kindCapabilities } from '@jasper/project';
import type { ActiveTool } from '@jasper/session';
import type { Hit } from './hit.ts';

export type ToolId = ActiveTool;

export type ToolInfo = { id: ToolId; label: string; key: string; icon: string };

export const TOOLS: Record<ToolId, ToolInfo> = {
	selection: { id: 'selection', label: 'Selection Tool', key: 'V', icon: 'tool.selection' },
	trackSelectForward: {
		id: 'trackSelectForward',
		label: 'Track Select Forward Tool',
		key: 'A',
		icon: 'tool.trackSelectForward',
	},
	trackSelectBackward: {
		id: 'trackSelectBackward',
		label: 'Track Select Backward Tool',
		key: 'Shift+A',
		icon: 'tool.trackSelectBackward',
	},
	ripple: { id: 'ripple', label: 'Ripple Edit Tool', key: 'B', icon: 'tool.ripple' },
	rolling: { id: 'rolling', label: 'Rolling Edit Tool', key: 'N', icon: 'tool.rolling' },
	rateStretch: { id: 'rateStretch', label: 'Rate Stretch Tool', key: 'R', icon: 'tool.rateStretch' },
	razor: { id: 'razor', label: 'Razor Tool', key: 'C', icon: 'tool.razor' },
	slip: { id: 'slip', label: 'Slip Tool', key: 'Y', icon: 'tool.slip' },
	slide: { id: 'slide', label: 'Slide Tool', key: 'U', icon: 'tool.slide' },
	pen: { id: 'pen', label: 'Pen Tool', key: 'P', icon: 'tool.pen' },
	hand: { id: 'hand', label: 'Hand Tool', key: 'H', icon: 'tool.hand' },
	zoom: { id: 'zoom', label: 'Zoom Tool', key: 'Z', icon: 'tool.zoom' },
	type: { id: 'type', label: 'Type Tool', key: 'T', icon: 'tool.type' },
	agent: { id: 'agent', label: 'Agent Tool', key: '', icon: 'tool.agent' },
};

/** S05:TOOL-002 groups (flyouts); the first member is the default face. */
export const TOOL_GROUPS: readonly (readonly ToolId[])[] = [
	['selection'],
	['trackSelectForward', 'trackSelectBackward'],
	['ripple', 'rolling', 'rateStretch'],
	['razor'],
	['slip', 'slide'],
	['pen'],
	['hand', 'zoom'],
	['type'],
	['agent'],
];

export type Mods = { shift: boolean; ctrl: boolean; alt: boolean };

export type GestureKind =
	| 'move'
	| 'trim'
	| 'ripple'
	| 'roll'
	| 'stretch'
	| 'slip'
	| 'slide'
	| 'razor'
	| 'marquee'
	| 'trackSelect'
	| 'hand'
	| 'zoom'
	| 'select'
	| 'gap'
	| 'none';

/** TL-591 dispatcher: what a pointer-down does for the active tool on this hit. */
export function resolveGesture(tool: ToolId, hit: Hit, mods: Mods): GestureKind {
	const onClip = hit.kind === 'clip';
	const edge = onClip && hit.zone !== 'body';
	const empty = hit.kind === 'empty' || hit.kind === 'gap' || hit.kind === 'none' || hit.kind === 'new-track';
	switch (tool) {
		case 'selection':
		case 'type':
			if (edge) return mods.ctrl ? 'ripple' : 'trim';
			if (onClip) return 'move';
			if (hit.kind === 'gap') return 'gap';
			return empty ? 'marquee' : 'none';
		case 'trackSelectForward':
		case 'trackSelectBackward':
			return hit.kind === 'none' ? 'none' : 'trackSelect';
		case 'ripple':
			if (edge) return 'ripple';
			if (onClip) return 'select';
			return hit.kind === 'gap' ? 'gap' : 'marquee';
		case 'rolling':
			if (edge) return 'roll';
			return onClip ? 'select' : 'marquee';
		case 'rateStretch': {
			if (!edge) return onClip ? 'select' : 'marquee';
			// TL-617: clips without speed get a regular trim.
			const caps = kindCapabilities(hit.clip.kind);
			return caps?.supportsSpeed && isBoundedContent(hit.clip) ? 'stretch' : 'trim';
		}
		case 'razor':
			return onClip ? 'razor' : 'none';
		case 'slip':
			return onClip ? 'slip' : 'marquee';
		case 'slide':
			return onClip ? 'slide' : 'marquee';
		case 'hand':
			return 'hand';
		case 'zoom':
			return 'zoom';
		case 'pen':
		case 'agent':
			return 'none';
	}
}

/** CSS cursor per tool and hover target (TL-530, S05:IC-010; standard cursors in M1). */
export function cursorFor(tool: ToolId, hit: Hit, mods: Mods): string {
	const g = resolveGesture(tool, hit, mods);
	switch (g) {
		case 'trim':
		case 'ripple':
		case 'stretch':
			return hit.kind === 'clip' && hit.zone === 'in' ? 'w-resize' : 'e-resize';
		case 'roll':
			return 'col-resize';
		case 'slip':
		case 'slide':
			return 'ew-resize';
		case 'razor':
			return 'crosshair';
		case 'hand':
			return 'grab';
		case 'zoom':
			return mods.alt ? 'zoom-out' : 'zoom-in';
		case 'trackSelect':
			return tool === 'trackSelectForward' ? 'e-resize' : 'w-resize';
		case 'none':
			return tool === 'pen' || tool === 'agent' ? 'not-allowed' : 'default';
		default:
			return 'default';
	}
}
