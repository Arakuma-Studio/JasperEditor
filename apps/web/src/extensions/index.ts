// M2 UI extension points (ARCHITECTURE §19.10). Each work package registers into these from its own module;
// the host panels (Effect Controls, Properties, Program monitor, Timeline, Project) render what is registered.
import type { Clip, EffectInstance, EffectSpec, ProjectItem, Rational } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import type { ComponentProps, ComponentType } from 'react';
import type { TransformOverlay } from '../panels/program/TransformOverlay.tsx';
import { createRegistry } from './registry.ts';

/** Menu entries contributed to context menus (same shape as the timeline's ContextMenuItem). */
export type MenuItemSpec =
	| { kind: 'item'; label: string; shortcut?: string; disabled?: boolean; checked?: boolean; run(): void }
	| { kind: 'separator' }
	| { kind: 'submenu'; label: string; items: MenuItemSpec[] };

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

/** Props an overlay receives: the same as the transform overlay (view mapping, viewport, transport…). */
export type ProgramOverlayHostProps = Omit<
	ComponentProps<typeof TransformOverlay>,
	'onPan' | 'onContextMenu'
>;
/** An SVG/DOM layer drawn over the Program monitor above the transform overlay (tracker, corner pin handles). */
export type ProgramOverlayDef = {
	id: string;
	/** Rendered only while this returns true (e.g. a tracker is being edited). */
	active(session: EditorSession): boolean;
	component: ComponentType<ProgramOverlayHostProps>;
	order?: number;
};
export const programOverlays = createRegistry<ProgramOverlayDef>();

/**
 * wp-m3-mgtext (S08:MGU-005, additive): a double-click on a layer in the Program monitor (selection tool). The
 * first handler returning true consumes it (e.g. composition clips open their on-canvas text editor).
 */
export type LayerDoubleClickContext = {
	session: EditorSession;
	clip: Clip;
	/** The double-clicked point in sequence pixels. */
	point: [number, number];
	/** Sequence frame shown. */
	frame: number;
};
export type LayerDoubleClickHandler = {
	id: string;
	run(ctx: LayerDoubleClickContext): boolean;
	order?: number;
};
export const layerDoubleClickHandlers = createRegistry<LayerDoubleClickHandler>();

type ClipMenuContext = { session: EditorSession; clip: Clip; selection: readonly string[] };
export type ClipMenuExtension = {
	id: string;
	items(ctx: ClipMenuContext): MenuItemSpec[];
	order?: number;
};
/** Timeline clip context menu additions (appended after a separator). */
export const clipMenuExtensions = createRegistry<ClipMenuExtension>();

/** What a Cue Seam menu extension receives: the right-clicked cue and the selected cues of its sequence. */
export type CueMenuContext = {
	session: EditorSession;
	sequenceId: string;
	cueId: string;
	selection: readonly string[];
	runCommand(commandId: string, args?: unknown): void;
};
export type CueMenuExtension = {
	id: string;
	items(ctx: CueMenuContext): MenuItemSpec[];
	order?: number;
};
/**
 * Cue Seam context menu additions (spec 12 §2.7: Fill With ▸, Fill from Library…, Add Layer…), inserted after the
 * cue's own entries, before Convert to Marker / Delete.
 */
export const cueMenuExtensions = createRegistry<CueMenuExtension>();

type ProjectItemMenuContext = {
	session: EditorSession;
	items: readonly ProjectItem[];
	readOnly: boolean;
	runCommand?(commandId: string, args: unknown): void;
};
export type ProjectItemMenuExtension = {
	id: string;
	items(ctx: ProjectItemMenuContext): MenuItemSpec[];
	order?: number;
};
/** Project panel item context menu additions. */
export const projectItemMenuExtensions = createRegistry<ProjectItemMenuExtension>();

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

/**
 * What a clip decoration receives: the clip and its placement as the timeline draws it. `x`/`w` are unrounded
 * clip-area px of the clip start and width (the clip body element starts at `x`, so body-local px = clip-area
 * px − `x`); `scrollFrame`/`pxPerFrame` map frames to px (`x = (frame − scrollFrame) · pxPerFrame`).
 * Decorations are rendered inside the virtualised, memoised clip view: they must not subscribe to the transport.
 */
export type ClipDecorationProps = {
	clip: Clip;
	x: number;
	w: number;
	height: number;
	viewportWidth: number;
	scrollFrame: number;
	pxPerFrame: number;
	rate: Rational;
	selected: boolean;
	trackLocked: boolean;
};

/**
 * A per-clip timeline decoration (S09:TRU-005 tracker/link glyphs): a `badge` in the clip's name strip (shown
 * when the clip is ≥ 40 px wide, also with names hidden; the strip itself ignores the pointer, so a badge that
 * reacts to clicks sets `pointer-events: auto` on itself) and/or an `overlay` inside the clip body (positioned
 * absolutely by the decoration; keep it out of the trim edge zones when it takes pointer input). `appliesTo`
 * runs on every clip render: keep it O(1).
 */
export type ClipDecorationDef = {
	id: string;
	order?: number;
	appliesTo(clip: Clip): boolean;
	badge?: ComponentType<ClipDecorationProps>;
	overlay?: ComponentType<ClipDecorationProps>;
};
export const clipDecorations = createRegistry<ClipDecorationDef>();

/** The decorations that apply to a clip (a failing `appliesTo` never breaks the timeline). */
export function decorationsFor(defs: readonly ClipDecorationDef[], clip: Clip): ClipDecorationDef[] {
	return defs.filter((d) => {
		try {
			return d.appliesTo(clip);
		} catch {
			return false;
		}
	});
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
