import type { IconId } from '@jasper/ui';
import type { ComponentType } from 'react';
import type { Capability } from '../commands/types.ts';

export const PANEL_KINDS = [
	'project',
	'source',
	'program',
	'timeline',
	'tools',
	'effectControls',
	'effects',
	'properties',
	'motionTemplates',
	'audioMeters',
	'history',
	'info',
	'markers',
	'jobs',
	'lumetri',
	'scopes',
	'audioTrackMixer',
	'audioClipMixer',
	'text',
	'essentialSound',
	'essentialGraphics',
	'mediaBrowser',
	'soundLibrary',
] as const;
export type PanelKind = (typeof PANEL_KINDS)[number];

export interface PanelProps {
	instanceId: string;
	visible: boolean;
	params?: Record<string, unknown>;
}

export type PanelTitleContext = {
	params?: Record<string, unknown>;
	sequenceName?: string | null;
	sourceName?: string | null;
};

/** Panel menu model (S05:PC-010/011): entries reference UI command ids. */
type MenuItem =
	| { type: 'command'; command: string; label?: string }
	| { type: 'submenu'; label: string; items: MenuItem[] }
	| { type: 'separator' };
type MenuModel = MenuItem[];

export interface PanelDefinition {
	kind: PanelKind;
	title(ctx: PanelTitleContext): string;
	icon: IconId;
	instance: 'single' | 'multi';
	/** Program and Timeline stay mounted when hidden (S05:SH-006). */
	keepAlive?: boolean;
	minSize: { w: number; h: number };
	fixedAxis?: 'width' | 'height';
	keymapScope: string;
	menu?: MenuModel;
	touch: 'tab' | 'sheet' | 'hidden';
	requires?: Capability[];
	/**
	 * Where the panel opens when the workspace layout has no place for it — as a tab next to this panel
	 * (Premiere docks the Media Browser with the Project panel); without it the panel floats.
	 */
	dockWith?: PanelKind;
	/** One line for the agent's UI catalog (S05 §17.6). */
	agentDescription: string;
	component: ComponentType<PanelProps>;
}
