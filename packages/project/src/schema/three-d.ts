// Coordinates are After Effects': world space is sequence space (x right, y down, in pixels) plus z pointing away
// from the viewer (into the screen). A 3D layer's map is
//   world = T(position, positionZ) · Orientation · Rz(rotation) · Ry(rotationY) · Rx(rotationX) · S(sx, sy, scaleZ)
//           · T(−anchor, −anchorZ)
// so a 3D layer with every 3D value at its default (z 0, no X/Y rotation, no orientation) seen through the default
// camera is exactly where its 2D Motion puts it. Angles are degrees, clockwise on screen (as the 2D Rotation).
import { z } from 'zod';
import {
	type Animatable,
	AnimNumberSchema,
	AnimRGBASchema,
	animatable,
	type DeepStrip,
	nonNegInt,
	type RGBA,
	Vec3Schema,
} from './common.ts';

/** Animatable `[x, y, z]` (positions in pixels, orientations in degrees). */
export const AnimVec3Schema = animatable(Vec3Schema);

/** Casts Shadows / Accepts Shadows: Off, On, Only (AE's Material Options popups). */
export const SHADOW_MODES = ['off', 'on', 'only'] as const;
export const ShadowModeSchema = z.enum(SHADOW_MODES);
export type ShadowMode = DeepStrip<z.infer<typeof ShadowModeSchema>>;

/**
 * Material Options of a 3D layer (After Effects names, ranges and defaults; percentages are 0…100 except Light
 * Transmission, Ambient, Diffuse and Specular Intensity, which AE lets go to 1000 % for over-bright surfaces).
 * The Advanced 3D fields (`reflection*`, `roughness`) are optional with read-time defaults (`materialOf`).
 */
export const MaterialOptionsSchema = z.looseObject({
	castsShadows: ShadowModeSchema,
	/** Light passing through the layer, tinted by its colour (shadows become coloured), percent. */
	lightTransmission: AnimNumberSchema,
	acceptsShadows: ShadowModeSchema,
	acceptsLights: z.boolean(),
	ambient: AnimNumberSchema,
	diffuse: AnimNumberSchema,
	specularIntensity: AnimNumberSchema,
	/** 0 % = wide highlight (exponent 1), 100 % = tight (exponent 256). */
	specularShininess: AnimNumberSchema,
	/** Highlight colour: 0 % = the light's, 100 % = the layer's. */
	metal: AnimNumberSchema,
	/** Mirror reflection of the environment, percent (Advanced 3D). Default 0. */
	reflectionIntensity: AnimNumberSchema.optional(),
	/** Reflection sharpness, percent (100 = mirror; lower = rougher). Default 100. */
	reflectionSharpness: AnimNumberSchema.optional(),
	/**
	 * Physically based surface of the whole layer (spec 19 TL-071, TL-074, Advanced 3D). Absent = After Effects' model
	 * above. Read leniently: checked by INV-012 (`threeDProblem`), repaired by `repairThreeD`.
	 */
	pbr: z.custom<SurfaceMaterial>(() => true).optional(),
});
export type MaterialOptions = DeepStrip<z.infer<typeof MaterialOptionsSchema>>;

/** Procedural normal maps of a surface (TL-074). */
export const SURFACE_RELIEFS = ['none', 'crumple', 'hammered', 'liquid'] as const;
export type SurfaceRelief = (typeof SURFACE_RELIEFS)[number];
/** Where a surface's base colour comes from: the layer's picture, or `baseColor`. */
export const SURFACE_BASES = ['picture', 'color'] as const;
export type SurfaceBase = (typeof SURFACE_BASES)[number];

/** A tint ramp across a surface (Pachislop's metal banding): stops in the signal, hold-only like appearance gradients. */
export type SurfaceRamp = {
	/** Degrees, 90 = top to bottom on the layer. */
	angle: number;
	stops: { at: number; color: RGBA }[];
};

/**
 * A physically based surface (TL-071, TL-074). Percentages are 0…100 unless noted; `flakeScale`, `reliefScale` and
 * `thickness` are layer pixels. Numbers and colours are animatable: a change never rebuilds geometry.
 */
export type SurfaceMaterial = {
	base: SurfaceBase;
	baseColor: Animatable<RGBA>;
	ramp?: SurfaceRamp;
	metalness: Animatable<number>;
	roughness: Animatable<number>;
	/** Image-based reflections × this (100 = physical, up to 400). */
	reflectivity: Animatable<number>;
	/** Direct highlights × this (100 = physical, up to 400). */
	specularBoost: Animatable<number>;
	clearcoat: Animatable<number>;
	clearcoatRoughness: Animatable<number>;
	flakes: Animatable<number>;
	flakeScale: Animatable<number>;
	relief: SurfaceRelief;
	reliefAmount: Animatable<number>;
	reliefScale: Animatable<number>;
	reliefSeed: number;
	iridescence: Animatable<number>;
	/** Thin film thickness, nanometres. */
	iridescenceThickness: Animatable<number>;
	transmission: Animatable<number>;
	/** Index of refraction, 1…2.5. */
	ior: Animatable<number>;
	thickness: Animatable<number>;
	dispersion: Animatable<number>;
	/** Light kept per `thickness` of glass, as a colour (Beer-Lambert). */
	attenuationColor: Animatable<RGBA>;
	emissive: Animatable<RGBA>;
	/** Percent of white; 100 = 1.0 scene-linear. */
	emissiveIntensity: Animatable<number>;
};

export const BEVEL_STYLES = ['none', 'angular', 'concave', 'convex'] as const;
export const BevelStyleSchema = z.enum(BEVEL_STYLES);
export type BevelStyle = DeepStrip<z.infer<typeof BevelStyleSchema>>;

/** Cross-section of a bevel band (TL-070; Pachislop `bevel.ts`). */
export const BEVEL_PROFILES = ['flat', 'chamfer', 'round', 'cove', 'step', 'inset', 'tube'] as const;
export type BevelProfile = (typeof BEVEL_PROFILES)[number];
/** Where the band stack sits against the traced outline: cut inside it, half each way, or grown outside it. */
export const BEVEL_POSITIONS = ['inside', 'center', 'outside'] as const;
export type BevelPosition = (typeof BEVEL_POSITIONS)[number];
export const GEOMETRY_MODES = ['extrude', 'inflate'] as const;
export type GeometryMode = (typeof GEOMETRY_MODES)[number];
export const PLATE_SHAPES = ['contour', 'hull', 'box'] as const;
export type PlateShape = (typeof PLATE_SHAPES)[number];

/** At most this many bevel bands per solid (TL-070). */
export const MAX_BEVEL_BANDS = 6;
/** At most this many backplates per layer (TL-073). */
export const MAX_BACKPLATES = 3;
/** Facets of a curved bevel profile. */
export const MAX_BEVEL_SEGMENTS = 24;

/** One ring of the bevel, from the face edge outwards (TL-070). `width` and `depth` are layer pixels. */
export type BevelBand = {
	id: string;
	width: Animatable<number>;
	depth: Animatable<number>;
	profile: BevelProfile;
	/** −100…100: exponent bend of the profile; above 0 fuller, below 0 pinched. */
	curve: Animatable<number>;
	segments: number;
	/** Absent = the layer's base surface. */
	material?: SurfaceMaterial;
};

/** A point of an inflate height curve: x = distance from the edge / largest inset, y = height, both 0…1. */
export type InflateCurvePoint = { x: number; y: number; corner?: boolean };

/** Inflate mode (TL-072): the front is a height field over the outline's distance field. */
export type InflateOptions = {
	/** Layer pixels. */
	height: Animatable<number>;
	/** Sorted by x, 2…16 points. */
	curve: InflateCurvePoint[];
	/** 0…100: 0 shades the mesh's facets, above that exact slopes with rounder ridges. */
	smoothness: Animatable<number>;
	/** 1…4: density of the height grid. */
	detail: number;
};

/** A solid stacked behind the title (TL-073). Lengths are layer pixels; plate k grows by the sum of grows 0…k. */
export type Backplate = {
	id: string;
	enabled: boolean;
	shape: PlateShape;
	grow: Animatable<number>;
	depth: Animatable<number>;
	/** Gap behind the previous solid. */
	gap: Animatable<number>;
	/** Corner radius of a box plate. */
	corner: Animatable<number>;
	/** Contour plates: fill the counters of letters. */
	fillCounters: boolean;
	bevelWidth: Animatable<number>;
	bevelDepth: Animatable<number>;
	bevelProfile: BevelProfile;
	face?: SurfaceMaterial;
	side?: SurfaceMaterial;
};

/** Geometry Options of a text or shape layer in an Advanced 3D sequence (AE's extrusion and bevels). */
export const GeometryOptionsSchema = z.looseObject({
	bevelStyle: BevelStyleSchema,
	/** Pixels. */
	bevelDepth: AnimNumberSchema,
	/** Percent of Bevel Depth used inside holes (counters of letters). */
	holeBevelDepth: AnimNumberSchema,
	/** Pixels; 0 = flat (a card). */
	extrusionDepth: AnimNumberSchema,
	// spec 19 §9. Read leniently: checked by INV-012 (`threeDProblem`), repaired by `repairThreeD`.
	/** Absent = `extrude`. */
	mode: z.enum(GEOMETRY_MODES).optional(),
	/** With bands: where they sit against the outline. Absent = `inside` (the silhouette stays the picture). */
	bevelPosition: z.enum(BEVEL_POSITIONS).optional(),
	/** Bevel bands, face edge outwards (TL-070). Non-empty, they replace Bevel Style and Bevel Depth. */
	bands: z.custom<BevelBand[]>(() => true).optional(),
	inflate: z.custom<InflateOptions>(() => true).optional(),
	backplates: z.custom<Backplate[]>(() => true).optional(),
	/** Materials per surface (TL-071). An absent surface shows the layer's base surface (`material.pbr`). */
	surfaces: z
		.custom<{ face?: SurfaceMaterial; side?: SurfaceMaterial; back?: SurfaceMaterial }>(() => true)
		.optional(),
});
export type GeometryOptions = DeepStrip<z.infer<typeof GeometryOptionsSchema>>;

/** Auto-Orient of a 3D layer: off, along its motion path, towards the active camera. */
export const LAYER_AUTO_ORIENT = ['off', 'path', 'camera'] as const;
export const LayerAutoOrientSchema = z.enum(LAYER_AUTO_ORIENT);
export type LayerAutoOrient = DeepStrip<z.infer<typeof LayerAutoOrientSchema>>;

/**
 * The 3D Layer switch and the 3D-only transform values of a visual clip. X/Y position, X/Y anchor, the X/Y scale and
 * the Z rotation stay in the clip's Motion (`transform`); this adds the third dimension. `enabled: false` keeps the
 * values (AE keeps them when the switch is turned off and on again).
 */
export const Layer3DSchema = z.looseObject({
	enabled: z.boolean(),
	positionZ: AnimNumberSchema,
	anchorZ: AnimNumberSchema,
	/** Percent. */
	scaleZ: AnimNumberSchema,
	/** Degrees `[x, y, z]`, applied X then Y then Z; interpolates along the shortest rotation. */
	orientation: AnimVec3Schema,
	rotationX: AnimNumberSchema,
	rotationY: AnimNumberSchema,
	autoOrient: LayerAutoOrientSchema.optional(),
	material: MaterialOptionsSchema,
	/** Advanced 3D extrusion (text and shape layers). Absent = flat. */
	geometry: GeometryOptionsSchema.optional(),
});
export type Layer3D = DeepStrip<z.infer<typeof Layer3DSchema>>;

/**
 * Transform of a camera or light ("rig"). `autoOrient: 'poi'` = a two-node camera / a light aimed at its Point of
 * Interest (the Orientation and X/Y/Z Rotation then turn it further); `off` = one-node.
 */
export const RIG_AUTO_ORIENT = ['off', 'poi'] as const;
export const RigTransformSchema = z.looseObject({
	autoOrient: z.enum(RIG_AUTO_ORIENT),
	position: AnimVec3Schema,
	pointOfInterest: AnimVec3Schema,
	orientation: AnimVec3Schema,
	rotationX: AnimNumberSchema,
	rotationY: AnimNumberSchema,
	rotationZ: AnimNumberSchema,
});
export type RigTransform = DeepStrip<z.infer<typeof RigTransformSchema>>;

/** Iris Shape popup (AE Camera Options; "Fast Rectangle" is a box filter). */
export const IRIS_SHAPES = [
	'fast-rectangle',
	'triangle',
	'square',
	'pentagon',
	'hexagon',
	'heptagon',
	'octagon',
	'nonagon',
	'decagon',
] as const;
export const IrisShapeSchema = z.enum(IRIS_SHAPES);
export type IrisShape = DeepStrip<z.infer<typeof IrisShapeSchema>>;

export const FILM_SIZE_MEASURES = ['horizontal', 'vertical', 'diagonal'] as const;

/** A camera's lens and depth of field (AE Camera Settings / Camera Options). Distances in pixels. */
export const CameraDataSchema = z.looseObject({
	transform: RigTransformSchema,
	/** Distance from the eye to the image plane (pixels): sets the angle of view with the frame size. */
	zoom: AnimNumberSchema,
	/** Film size (mm) along `measureFilmSize`; with zoom it gives the focal length (AE default 36 mm). */
	filmSize: z.number().positive().max(10_000),
	measureFilmSize: z.enum(FILM_SIZE_MEASURES),
	depthOfField: z.boolean(),
	focusDistance: AnimNumberSchema,
	/** Aperture diameter (pixels). */
	aperture: AnimNumberSchema,
	/** Percent. */
	blurLevel: AnimNumberSchema,
	irisShape: IrisShapeSchema,
	irisRotation: AnimNumberSchema,
	irisRoundness: AnimNumberSchema,
	irisAspectRatio: AnimNumberSchema,
	irisDiffractionFringe: AnimNumberSchema,
	highlightGain: AnimNumberSchema,
	highlightThreshold: AnimNumberSchema,
	highlightSaturation: AnimNumberSchema,
});
export type CameraData = DeepStrip<z.infer<typeof CameraDataSchema>>;

/** The reflection environments of spec 19 TL-038, by the names looks store. */
export const ENVIRONMENT_PRESETS = ['studio', 'sky', 'city', 'sunset', 'chromeBands', 'neon'] as const;
export type EnvironmentPreset = (typeof ENVIRONMENT_PRESETS)[number];

export const LIGHT_TYPES = ['parallel', 'spot', 'point', 'ambient', 'environment'] as const;
export const LightTypeSchema = z.enum(LIGHT_TYPES);
export type LightType = DeepStrip<z.infer<typeof LightTypeSchema>>;
export const LIGHT_FALLOFFS = ['none', 'smooth', 'inverse-square'] as const;
export const LightFalloffSchema = z.enum(LIGHT_FALLOFFS);
export type LightFalloff = DeepStrip<z.infer<typeof LightFalloffSchema>>;

/** A light (AE Light Settings / Light Options). */
export const LightDataSchema = z.looseObject({
	type: LightTypeSchema,
	transform: RigTransformSchema,
	/** Percent (negative = a light that removes light, as AE allows). */
	intensity: AnimNumberSchema,
	color: AnimRGBASchema,
	/** Spot: full cone angle (degrees) and feather (percent). */
	coneAngle: AnimNumberSchema,
	coneFeather: AnimNumberSchema,
	falloff: LightFalloffSchema,
	/** Pixels. */
	radius: AnimNumberSchema,
	falloffDistance: AnimNumberSchema,
	castsShadows: z.boolean(),
	shadowDarkness: AnimNumberSchema,
	/** Pixels. */
	shadowDiffusion: AnimNumberSchema,
	/**
	 * Environment lights (Advanced 3D, image-based lighting): the media (an equirectangular panorama: still or video)
	 * that lights and is reflected by the scene. Null = a neutral grey studio environment.
	 */
	environmentMediaId: z.string().nullable().optional(),
	/** Environment rotation about the vertical axis (degrees). */
	environmentRotation: AnimNumberSchema.optional(),
	/** Draw the environment as the background of the 3D run (AE "Environment Light ▸ Background"). */
	environmentBackground: z.boolean().optional(),
	/**
	 * A procedural environment (TL-075), shared by name with the reflection presets of looks (TL-038). Used when
	 * `environmentMediaId` is null; absent = the neutral studio.
	 */
	environmentPreset: z.enum(ENVIRONMENT_PRESETS).optional(),
});
export type LightData = DeepStrip<z.infer<typeof LightDataSchema>>;

export const RENDERERS_3D = ['classic', 'advanced'] as const;
export const Renderer3DSchema = z.enum(RENDERERS_3D);
export type Renderer3D = DeepStrip<z.infer<typeof Renderer3DSchema>>;

/** Tone mapping of Advanced 3D before the 8-bit output (TL-076). `hue` keeps hue and saturation. */
export const TONE_MAPPINGS = ['none', 'aces', 'agx', 'neutral', 'hue'] as const;
export const ToneMappingSchema = z.enum(TONE_MAPPINGS);
export type ToneMapping = DeepStrip<z.infer<typeof ToneMappingSchema>>;

/** Rays of a glint: 0 = bloom only. */
export const GLINT_RAYS = [0, 2, 4, 6, 8] as const;

/** Glints of the sequence's Advanced 3D (TL-077): bloom and star rays from highlights above the threshold. */
export const Glint3DSchema = z.looseObject({
	enabled: z.boolean(),
	/** Scene-linear luminance above which a pixel glints (1 = brighter than white). */
	threshold: AnimNumberSchema,
	/** Percent. */
	intensity: AnimNumberSchema,
	/** Bloom radius, sequence pixels. */
	radius: AnimNumberSchema,
	rays: z.number().int().min(0).max(8),
	/** Ray length, sequence pixels. */
	length: AnimNumberSchema,
	/** Degrees. */
	angle: AnimNumberSchema,
	tint: AnimRGBASchema,
});
export type Glint3D = DeepStrip<z.infer<typeof Glint3DSchema>>;

/** Sequence 3D settings (AE Composition Settings ▸ 3D Renderer). Absent = Classic 3D, full quality. */
export const Sequence3DSchema = z.looseObject({
	renderer: Renderer3DSchema,
	/** Draft 3D: no lights, shadows or depth of field (faster previews; exports always render in full). */
	draft: z.boolean().optional(),
	/** Advanced 3D: shadow map resolution (pixels per side). Default 2048. */
	shadowMapSize: z.number().int().min(256).max(8192).optional(),
	/** Advanced 3D: supersampling per axis (1…4). Absent = 1, the 4× multisampling alone. */
	supersampling: z.number().int().min(1).max(4).optional(),
	/** Tone mapping (TL-076). Absent = `none`. */
	toneMapping: ToneMappingSchema.optional(),
	/** Stops of exposure before tone mapping. Keys in sequence time; absent = 0. */
	exposure: AnimNumberSchema.optional(),
	glint: Glint3DSchema.optional(),
});
export type Sequence3D = DeepStrip<z.infer<typeof Sequence3DSchema>>;

export const CAMERA_TRACKER_SHOT_TYPES = ['fixed', 'variable', 'specify'] as const;
export const CAMERA_TRACKER_METHODS = ['auto', 'typical', 'flat', 'tripod'] as const;
export const TRACK_POINT_DISPLAY = ['3d', 'off'] as const;

/** 3D Camera Tracker settings (After Effects' effect controls; absent fields = `cameraTrackerSettingsOf`). */
export const CameraTrackerSettingsSchema = z.looseObject({
	shot: z.enum(CAMERA_TRACKER_SHOT_TYPES).optional(),
	/** Horizontal Angle of View (degrees) for Specify Angle of View. */
	hfov: z.number().min(1).max(170).optional(),
	method: z.enum(CAMERA_TRACKER_METHODS).optional(),
	detailed: z.boolean().optional(),
	/** Solve radial lens distortion (EffectCraft; After Effects has no equivalent switch). */
	lensDistortion: z.boolean().optional(),
	/** Show Track Points: 3D Solved, or off. */
	showPoints: z.enum(TRACK_POINT_DISPLAY).optional(),
	/** Track Point Size / Target Size (%). */
	pointSize: z.number().min(10).max(1000).optional(),
	targetSize: z.number().min(10).max(1000).optional(),
});
export type CameraTrackerSettings = DeepStrip<z.infer<typeof CameraTrackerSettingsSchema>>;

/** A solved 3D track point (canonical solve space), its reprojection error (px) and media frames tracked. */
export const CameraSolvePointSchema = z.looseObject({
	id: nonNegInt(),
	pos: Vec3Schema,
	error: z.number().min(0),
	first: nonNegInt(),
	last: nonNegInt(),
});
export type CameraSolvePoint = DeepStrip<z.infer<typeof CameraSolvePointSchema>>;

/**
 * A camera solve (the engine's `CamTrackResult`): `frames` holds 8 numbers per media frame of the span (world → camera
 * rotation as an axis-angle vector, camera centre, focal length in media px, 1 / 0 = solved / interpolated) in the
 * canonical solve space (first solved camera at the origin looking along +z, x right, y down; median point depth 1).
 */
export const CameraSolveSchema = z.looseObject({
	span: z.tuple([nonNegInt(), nonNegInt()]),
	size: z.tuple([z.number().int().positive(), z.number().int().positive()]),
	shot: z.enum(CAMERA_TRACKER_SHOT_TYPES),
	methodUsed: z.enum(['typical', 'flat', 'tripod']),
	averageError: z.number().min(0),
	frames: z.array(z.number()),
	points: z.array(CameraSolvePointSchema),
	distortion: z.looseObject({ k1: z.number(), k2: z.number(), radius: z.number() }).nullable(),
	/** Settings the solve was computed with (stale when they differ). */
	inputs: z.string(),
	method: z.string(),
});
export type CameraSolve = DeepStrip<z.infer<typeof CameraSolveSchema>>;

/**
 * The ground plane and origin set from track points ("Set Ground Plane and Origin"): a plane through `origin` with
 * unit `normal` (pointing away from the camera side) and an in-plane `xAxis`, in canonical solve space.
 */
export const CameraTrackerGroundSchema = z.looseObject({
	origin: Vec3Schema,
	normal: Vec3Schema,
	xAxis: Vec3Schema,
});
export type CameraTrackerGround = DeepStrip<z.infer<typeof CameraTrackerGroundSchema>>;

/**
 * After Effects' 3D Camera Tracker on a video clip: the analysed span of its media (inclusive media frames at `rate`),
 * the settings, the deleted track points, the solve and the ground plane. The created camera is an ordinary camera
 * clip (`createdCameraId` remembers it).
 */
export const ClipCameraTrackerSchema = z.looseObject({
	id: z.string(),
	mediaId: z.string(),
	rate: z.looseObject({ num: z.number().int().positive(), den: z.number().int().positive() }),
	span: z.tuple([nonNegInt(), nonNegInt()]),
	settings: CameraTrackerSettingsSchema,
	/** Track ids of deleted points (left out of the next solve). */
	deleted: z.array(nonNegInt()),
	solve: CameraSolveSchema.nullable(),
	ground: CameraTrackerGroundSchema.optional(),
	createdCameraId: z.string().optional(),
});
export type ClipCameraTracker = DeepStrip<z.infer<typeof ClipCameraTrackerSchema>>;
