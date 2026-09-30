// M2 UI extension points (ARCHITECTURE §19.10). Each work package registers into these from its own module;
// the host panels (Effect Controls, Properties, Program monitor, Timeline, Project) render what is registered.
import type { Clip, EffectInstance, EffectSpec, ProjectItem } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import type { ComponentType } from 'react';
import { createRegistry } from './registry.ts';

export { createRegistry, type Registry } from './registry.ts';

/** Menu entries contributed to context menus (same shape as the timeline's ContextMenuItem). */
export type MenuItemSpec =
	| { kind: 'item'; label: string; shortcut?: string; disabled?: boolean; checked?: boolean; run(): void }
	| { kind: 'separator' }
	| { kind: 'submenu'; label: string; items: MenuItemSpec[] };

// ---------------------------------------------------------------- Effect Controls: custom effect editors

export type EffectEditorProps = {
	session: EditorSession;
	clip: Clip;
	fx: EffectInstance;
	effect: EffectSpec;
	/** Current sequence frame (the editor evaluates animated params itself with `evaluate`). */
	frame: number;
	sequenceId: string;
	/** Effect Controls vs Properties / Lumetri panel host. */
	host: 'effectControls' | 'properties' | 'panel';
};

/**
 * A custom editor for one effect id (e.g. the Lumetri sections, corner-pin "Track…" button). Effect Controls
 * renders it at the top of the effect's section; params listed in `hideParams` are not shown as generic rows
 * (curves, wheels); the others keep their rows and keyframe lanes.
 */
export type EffectEditorDef = {
	id: string;
	effectId: string;
	component: ComponentType<EffectEditorProps>;
	hideParams?: readonly string[];
	order?: number;
};
export const effectEditors = createRegistry<EffectEditorDef>();
export const effectEditorFor = (effectId: string): EffectEditorDef | undefined =>
	effectEditors.list().find((e) => e.effectId === effectId);

// ---------------------------------------------------------------- Properties: clip sections

export type ClipSectionProps = { session: EditorSession; clips: Clip[]; frame: number; sequenceId: string };
/** A Properties-panel section for clips it applies to (composition props, tracking, processed media…). */
export type ClipSectionDef = {
	id: string;
	title: string;
	appliesTo(clips: readonly Clip[]): boolean;
	component: ComponentType<ClipSectionProps>;
	defaultOpen?: boolean;
	order?: number;
};
export const clipSections = createRegistry<ClipSectionDef>();

// ---------------------------------------------------------------- Program monitor overlays

/** Props an overlay receives: the same as the transform overlay (view mapping, viewport, transport…). */
export type ProgramOverlayHostProps = Record<string, unknown> & { session: EditorSession };
/** An SVG/DOM layer drawn over the Program monitor above the transform overlay (tracker, corner pin handles). */
export type ProgramOverlayDef = {
	id: string;
	/** Rendered only while this returns true (e.g. a tracker is being edited). */
	active(session: EditorSession): boolean;
	component: ComponentType<ProgramOverlayHostProps>;
	order?: number;
};
export const programOverlays = createRegistry<ProgramOverlayDef>();

// ---------------------------------------------------------------- context menus

export type ClipMenuContext = { session: EditorSession; clip: Clip; selection: readonly string[] };
export type ClipMenuExtension = {
	id: string;
	items(ctx: ClipMenuContext): MenuItemSpec[];
	order?: number;
};
/** Timeline clip context menu additions (appended after a separator). */
export const clipMenuExtensions = createRegistry<ClipMenuExtension>();

export type ProjectItemMenuContext = {
	session: EditorSession;
	items: readonly ProjectItem[];
	readOnly: boolean;
};
export type ProjectItemMenuExtension = {
	id: string;
	items(ctx: ProjectItemMenuContext): MenuItemSpec[];
	order?: number;
};
/** Project panel item context menu additions. */
export const projectItemMenuExtensions = createRegistry<ProjectItemMenuExtension>();

/** Collects the menu items of every registered extension, separated from each other. */
export function collectMenuItems<C>(
	exts: readonly { items(ctx: C): MenuItemSpec[] }[],
	ctx: C,
): MenuItemSpec[] {
	const out: MenuItemSpec[] = [];
	for (const e of exts) {
		let items: MenuItemSpec[] = [];
		try {
			items = e.items(ctx);
		} catch {
			items = [];
		}
		if (!items.length) continue;
		out.push({ kind: 'separator' }, ...items);
	}
	return out;
}
