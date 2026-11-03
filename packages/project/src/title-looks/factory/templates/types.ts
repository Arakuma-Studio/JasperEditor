// Spec 19 TL-052: a title template is data: what clips to make, in fractions of the frame so it fits any aspect, with no id
// and no reference to anything outside the library. `title.insertTemplate` expands it into ordinary clips in one
// transaction, so everything a template makes can be edited, keyed or deleted like a clip made by hand.
import type {
	BevelPosition,
	BevelProfile,
	EnvironmentPreset,
	PlateShape,
	ToneMapping,
} from '../../../schema/three-d.ts';
import type { LookFont, Role } from '../../model.ts';
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
	/** A factory look, or, under a `solid`, a face of its own in a font (`TemplateSolidFace`). */
	look: string | TemplateSolidFace;
	rect: TemplateRect;
	/** Text size as a fraction of the shorter side of the frame. */
	size: number;
	align?: 'left' | 'center' | 'right';
	lineHeight?: number;
	in: TemplateAnimation;
	out: TemplateAnimation;
	/** A real 3D solid of the text (spec 19 §9): the template needs `scene3d`. */
	solid?: TemplateSolid;
};

/**
 * The look of a solid's text: one face in a font, nothing around it. The solid is traced from the layer's picture, so a
 * rim, plate or hard shadow of a 2D look would become part of the solid; its surfaces paint it, not the look's colours.
 */
export type TemplateSolidFace = { font: LookFont };

/**
 * A text's 3D solid (TL-070 to TL-074). Lengths are fractions of the text size, so a template is the same solid at any
 * frame size. Materials are `SURFACE_PRESETS` ids.
 */
export type TemplateSolid = {
	/** The whole solid's material. */
	material: string;
	/** Materials of single surfaces over it. */
	surfaces?: Partial<Record<'face' | 'side' | 'back', string>>;
	depth: number;
	bevelPosition?: BevelPosition;
	/** Bevel bands, outermost first (TL-070). */
	bands?: readonly { width: number; depth: number; profile?: BevelProfile; material?: string }[];
	/** Backplates, nearest first (TL-073). */
	plates?: readonly {
		shape: PlateShape;
		grow: number;
		depth: number;
		gap?: number;
		corner?: number;
		material?: string;
	}[];
	/** Inflate instead of extrude (TL-072): `height` as a fraction of the text size. */
	inflate?: { height: number; smoothness?: number };
	/** Turn of the solid in degrees, so its depth shows. */
	rotation?: { x?: number; y?: number };
};

/**
 * What a 3D template asks of its sequence (TL-075 to TL-077): Advanced 3D with this tone mapping, exposure and glints, and
 * an environment light over the template's span. Glint radius and length are fractions of the frame's shorter side.
 */
export type TemplateScene3D = {
	toneMapping: ToneMapping;
	/** Stops. */
	exposure?: number;
	environment: EnvironmentPreset;
	glint?: {
		threshold: number;
		intensity: number;
		radius: number;
		rays: 0 | 2 | 4 | 6 | 8;
		length: number;
		angle?: number;
	};
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
	/** The sequence's 3D scene: a template with a `solid` has one. */
	scene3d?: TemplateScene3D;
};

/** The look of a template's shape: one role on its face. */
export const shapeLookRecipe = (role: Role): LookRecipe => ({
	layers: [{ type: 'face', params: { paint: { kind: 'role', role } } }],
});
