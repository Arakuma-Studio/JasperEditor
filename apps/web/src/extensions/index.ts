// M2 UI extension points (ARCHITECTURE §19.10). Each work package registers into these from its own module;
// the host panels (Effect Controls, Properties, Program monitor, Timeline, Project) render what is registered.
import type { Clip, EffectInstance, EffectSpec, ProjectItem } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import type { ComponentType } from 'react';
import { createRegistry } from './registry.ts';

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

type ClipMenuContext = { session: EditorSession; clip: Clip; selection: readonly string[] };
export type ClipMenuExtension = {
	id: string;
	items(ctx: ClipMenuContext): MenuItemSpec[];
	order?: number;
};
/** Timeline clip context menu additions (appended after a separator). */
export const clipMenuExtensions = createRegistry<ClipMenuExtension>();

type ProjectItemMenuContext = {
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

// ---------------------------------------------------------------- Timeline: engine badge state (wp-m2-mg)

/** What a clip's engine badge shows instead of the plain kind badge (e.g. `✓` = Remotion master cached). */
export type ClipBadgeState = { text: string; title: string; tone?: 'ok' | 'busy' | 'warn' };
/**
 * Timeline engine badge providers (M2, additive): the first provider returning a state for a clip wins.
 * `subscribe` lets the timeline re-render a clip when the provider's state changes (async caches).
 */
export type ClipBadgeProvider = {
	id: string;
	badge(clip: Clip): ClipBadgeState | null;
	subscribe?(cb: () => void): () => void;
	version?(): number;
	order?: number;
};
export const clipBadgeProviders = createRegistry<ClipBadgeProvider>();

/** The badge state of a clip from the registered providers (null = default badge). */
export function clipBadgeFor(clip: Clip): ClipBadgeState | null {
	for (const p of clipBadgeProviders.list()) {
		try {
			const b = p.badge(clip);
			if (b) return b;
		} catch {
			// a failing provider never breaks the timeline
		}
	}
	return null;
}

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
