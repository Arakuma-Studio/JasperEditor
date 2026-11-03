// Spec 19 TL-052: a title template is data: what clips to make, in fractions of the frame so it fits any aspect, with no id
// and no reference to anything outside the library. `title.insertTemplate` expands it into ordinary clips in one
// transaction, so everything a template makes can be edited, keyed or deleted like a clip made by hand.
import type { Role } from '../../model.ts';
import type { LookRecipe } from '../../recipe.ts';

/** Fractions of the frame: left, top, width, height. */
export type TemplateRect = readonly [x: number, y: number, w: number, h: number];

export type TemplateAnimation = {
	/** A preset of `TEXT_ANIMATION_SPECS`. */
	preset: string;
	/** Default: the preset's. */
	seconds?: number;
	params?: Record<string, unknown>;
};

/** Timing inside the template: seconds after its start, and before its end. */
export type TemplateTiming = { delay?: number; early?: number };

export type TemplateText = TemplateTiming & {
	kind: 'text';
	/** What `texts` addresses. */
	slot: string;
	label: string;
	labelEs: string;
	/** Sample text: generic, never a real title (TL-001). */
	text: string;
	/** A factory look. */
	look: string;
	rect: TemplateRect;
	/** Text size as a fraction of the shorter side of the frame. */
	size: number;
	align?: 'left' | 'center' | 'right';
	lineHeight?: number;
	in: TemplateAnimation;
	out: TemplateAnimation;
};

/** How a shape arrives and leaves: a wipe from one edge, or a fade. */
export type TemplateMotion = 'wipe-left' | 'wipe-right' | 'fade';

export type TemplateShape = TemplateTiming & {
	kind: 'shape';
	/** Names the clip. */
	name: string;
	rect: TemplateRect;
	/** Corner radius as a fraction of the shorter side of the frame. */
	corner?: number;
	/** Its colour, through a look so a colourway reaches it. */
	role: Role;
	opacity?: number;
	motion: TemplateMotion;
	seconds?: number;
};

export type TemplateGenerator = TemplateTiming & {
	kind: 'generator';
	name: string;
	/** An effect of the `Generate` category, or `generator:<id>`. */
	effectId: string;
	params?: Record<string, unknown>;
	/** Colour params that follow a role, so a colourway reaches the generator (a standalone one has no look). */
	roles?: Record<string, Role>;
};

/** Bottom-first: each clip goes on a track above the one before. */
export type TemplateClip = TemplateText | TemplateShape | TemplateGenerator;

export const TEMPLATE_KINDS = ['lower-third', 'full-screen', 'end-card', 'social-hook'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export type TitleTemplate = {
	/** `template.<slug>`. */
	id: string;
	name: string;
	nameEs: string;
	/** One of `LOOK_CATEGORIES`. */
	category: string;
	kind: TemplateKind;
	tags: readonly string[];
	description: string;
	/** Length in seconds. */
	seconds: number;
	clips: readonly TemplateClip[];
};

/** The look of a template's shape: one role on its face. */
export const shapeLookRecipe = (role: Role): LookRecipe => ({
	layers: [{ type: 'face', params: { paint: { kind: 'role', role } } }],
});
