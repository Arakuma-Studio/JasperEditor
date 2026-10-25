// M2 UI extension points (ARCHITECTURE §19.10). Each work package registers into these from its own module;
// the host panels (Effect Controls, Properties, Program monitor, Timeline, Project) render what is registered.
import type { Clip, EffectInstance, EffectSpec, ProjectItem, Rational, ResolvedLayer } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import type { ComponentProps, ComponentType } from 'react';
import type { TransformOverlay } from '../panels/program/TransformOverlay.tsx';
import { createRegistry } from './registry.ts';

/** Menu entries contributed to context menus (same shape as the timeline's ContextMenuItem). */
export type MenuItemSpec =
	| {
			kind: 'item';
			label: string;
			shortcut?: string;
			disabled?: boolean;
			checked?: boolean;
			run(): void;
			/** The pointer or the keyboard rests on the item (e.g. audition the sound it would place). */
			onHighlight?(): void;
			/** It left the item. */
			onUnhighlight?(): void;
	  }
	| { kind: 'separator' }
	| {
			kind: 'submenu';
			label: string;
			items: MenuItemSpec[];
			/** Items computed when the submenu opens (`items` shows meanwhile, e.g. "Searching…"). */
			load?(): Promise<MenuItemSpec[]>;
	  };

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

/**
 * Props of a custom control for a motion-graphic template param (C3): rendered in place of the default editor of
 * every Properties / Effect Controls row whose template names it (`ui.params.<name>.control`). `onChange` writes
 * through the normal undoable param commands (a keyframe at the playhead when the param is animated);
 * `coalesce: true` merges repeated edits (a drag, typing) into one undo step.
 */
export type TemplateParamControlProps = {
	clipId: string;
	paramName: string;
	/** The param's value at the playhead (the first selected clip's when several are selected). */
	value: unknown;
	/** The clip's static params (siblings such as `variant`). */
	params: Readonly<Record<string, unknown>>;
	/** Writes this param on every selected clip; false when the edit was refused (nothing changed). */
	onChange(next: unknown, opts?: { coalesce?: boolean }): boolean;
	/** True while the project is read-only. */
	disabled: boolean;
	/** Every selected clip the row edits (`clipId` first). */
	clipIds: readonly string[];
	/** The selected clips hold different values for this param (`value` is then the first clip's). */
	mixed: boolean;
	/**
	 * WP7a (additive to C3): writes several params of every selected clip as ONE undoable step (Randomize identity,
	 * Randomize stats). A function patch is called per clip with that clip's static params, so each clip can get its
	 * own values. False when the edit was refused.
	 */
	onChangeParams(patch: TemplateParamPatchInput, opts?: TemplateParamWriteOptions): boolean;
};

/** Params to write, by name. */
export type TemplateParamPatch = Readonly<Record<string, unknown>>;
/** A patch for all clips, or one per clip (null/undefined = leave that clip alone). */
export type TemplateParamPatchInput =
	| TemplateParamPatch
	| ((
			params: Readonly<Record<string, unknown>>,
			clipId: string,
			index: number,
	  ) => TemplateParamPatch | null | undefined);
export type TemplateParamWriteOptions = {
	/** History label (default: the row's label). */
	label?: string;
	/** Merge repeated writes of the same key within the session window into one History entry. */
	coalesceKey?: string;
};

/**
 * A button (or small widget) a custom control adds to the header of every template param group containing a param it
 * renders (e.g. the social-comment "Randomize stats" wand). Rendered once per group even when several of the group's
 * params use controls naming the same action id.
 */
export type TemplateGroupActionProps = {
	/** The selected clips (`clipIds[0]` is the one whose `params` are given). */
	clipIds: readonly string[];
	params: Readonly<Record<string, unknown>>;
	/** The group's params shown for the selection. */
	paramNames: readonly string[];
	onChangeParams(patch: TemplateParamPatchInput, opts?: TemplateParamWriteOptions): boolean;
	disabled: boolean;
};
export type TemplateGroupAction = { id: string; component: ComponentType<TemplateGroupActionProps> };

export type TemplateParamControlDef = {
	/** The control name templates use in `ui.params.<name>.control`. */
	id: string;
	component: ComponentType<TemplateParamControlProps>;
	/**
	 * Sibling params this control edits too (e.g. a time control on `timeValue` that also edits `timeUnit`): their own
	 * rows are hidden while a row with this control is shown for the same template.
	 */
	alsoEdits?: readonly string[];
	/** `block`: the control is drawn under the row's label across the full panel width (text editors, pickers). */
	layout?: 'inline' | 'block';
	/** Group header actions (see `TemplateGroupAction`). */
	groupActions?: readonly TemplateGroupAction[];
	order?: number;
};
export const templateParamControls = createRegistry<TemplateParamControlDef>();

export type TemplateParamControlOptions = Pick<
	TemplateParamControlDef,
	'alsoEdits' | 'layout' | 'groupActions'
>;

/** Registers a custom template-param control under `name` (C3); returns the unregister function. */
export function registerTemplateParamControl(
	name: string,
	component: ComponentType<TemplateParamControlProps>,
	options: TemplateParamControlOptions = {},
): () => void {
	if (!name.trim()) throw new Error('A template param control needs a name');
	return templateParamControls.register({ id: name, component, ...options });
}

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
	/** The topmost unlocked layer under the pointer; null only for handlers registered with `anyPoint`. */
	clip: Clip | null;
	/** The double-clicked point in sequence pixels. */
	point: [number, number];
	/** Sequence frame shown. */
	frame: number;
	/** WP7b canvas-edit (additive): the layers the monitor resolved at `frame`, bottom to top. */
	scene?: readonly ResolvedLayer[];
	/** Monitor zoom (screen px per sequence px). */
	viewScale?: number;
	/** The Program overlay surface that received the double-click (scopes DOM lookups to this monitor). */
	surface?: Element | null;
};
export type LayerDoubleClickHandler = {
	id: string;
	run(ctx: LayerDoubleClickContext): boolean;
	order?: number;
	/** Also called where no unlocked layer is under the pointer (`clip` null), e.g. to explain a locked track. */
	anyPoint?: boolean;
};
export const layerDoubleClickHandlers = createRegistry<LayerDoubleClickHandler>();

type ClipMenuContext = {
	session: EditorSession;
	clip: Clip;
	selection: readonly string[];
	/** Runs a UI command with the timeline's context (toasts, engine), when the host provides it. */
	runCommand?(commandId: string, args?: unknown): void;
};
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
