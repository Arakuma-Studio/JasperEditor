// Coordinates are After Effects': world space is sequence space (x right, y down, in pixels) plus z pointing away
// from the viewer (into the screen). A 3D layer's map is
//   world = T(position, positionZ) · Orientation · Rz(rotation) · Ry(rotationY) · Rx(rotationX) · S(sx, sy, scaleZ)
//           · T(−anchor, −anchorZ)
// so a 3D layer with every 3D value at its default (z 0, no X/Y rotation, no orientation) seen through the default
// camera is exactly where its 2D Motion puts it. Angles are degrees, clockwise on screen (as the 2D Rotation).
import { z } from 'zod';
import {
	AnimNumberSchema,
	AnimRGBASchema,
	animatable,
	type DeepStrip,
	nonNegInt,
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
});
export type MaterialOptions = DeepStrip<z.infer<typeof MaterialOptionsSchema>>;

export const BEVEL_STYLES = ['none', 'angular', 'concave', 'convex'] as const;
export const BevelStyleSchema = z.enum(BEVEL_STYLES);
export type BevelStyle = DeepStrip<z.infer<typeof BevelStyleSchema>>;

/** Geometry Options of a text or shape layer in an Advanced 3D sequence (AE's extrusion and bevels). */
export const GeometryOptionsSchema = z.looseObject({
	bevelStyle: BevelStyleSchema,
	/** Pixels. */
	bevelDepth: AnimNumberSchema,
	/** Percent of Bevel Depth used inside holes (counters of letters). */
	holeBevelDepth: AnimNumberSchema,
	/** Pixels; 0 = flat (a card). */
	extrusionDepth: AnimNumberSchema,
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
});
export type LightData = DeepStrip<z.infer<typeof LightDataSchema>>;

export const RENDERERS_3D = ['classic', 'advanced'] as const;
export const Renderer3DSchema = z.enum(RENDERERS_3D);
export type Renderer3D = DeepStrip<z.infer<typeof Renderer3DSchema>>;

/** Sequence 3D settings (AE Composition Settings ▸ 3D Renderer). Absent = Classic 3D, full quality. */
export const Sequence3DSchema = z.looseObject({
	renderer: Renderer3DSchema,
	/** Draft 3D: no lights, shadows or depth of field (faster previews; exports always render in full). */
	draft: z.boolean().optional(),
	/** Advanced 3D: shadow map resolution (pixels per side). Default 2048. */
	shadowMapSize: z.number().int().min(256).max(8192).optional(),
	/** Advanced 3D: supersampling per axis (1…4). Default 2. */
	supersampling: z.number().int().min(1).max(4).optional(),
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
