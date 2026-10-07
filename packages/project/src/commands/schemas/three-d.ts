// three-d (docs/wp-notes/three-d.md): commands of 3D layers, cameras, lights and the sequence's 3D renderer. The
// per-property values (Z Position, Orientation, Material Options, Point of Interest, Zoom, Intensity…) are written
// with param.set / keyframe.* through the property registry (`threeD.*`, `camera.*`, `light.*`).
import { z } from 'zod';
import { RGBASchema, Vec3Schema } from '../../schema/common.ts';
import {
	FILM_SIZE_MEASURES,
	IRIS_SHAPES,
	LIGHT_FALLOFFS,
	LIGHT_TYPES,
	RENDERERS_3D,
} from '../../schema/three-d.ts';
import {
	cmd,
	IdListSchema,
	IdRefSchema,
	ParamAtSchema,
	RefDeclSchema,
	TimeInputSchema,
	TrackRefSchema,
} from './common.ts';

const finite = () => z.number().finite();

/** The 3D Layer switch of visual clips (After Effects' cube switch). Off keeps the 3D values. */
export const ClipSet3dCmd = cmd('clip.set3d', {
	clipIds: IdListSchema,
	enabled: z.boolean(),
});

/** Lens of a camera: zoom in pixels, or a focal length (mm), a preset name ("50mm") or an angle of view (°). */
const lensShape = {
	zoom: finite().positive().optional(),
	focalLength: finite().positive().max(10_000).optional(),
	preset: z.string().min(1).optional(),
	angleOfView: finite().gt(0).lt(180).optional(),
	filmSize: finite().positive().max(10_000).optional(),
	measureFilmSize: z.enum(FILM_SIZE_MEASURES).optional(),
};
const dofShape = {
	depthOfField: z.boolean().optional(),
	/** Pixels. */
	focusDistance: finite().min(0).optional(),
	/** The focus distance follows the zoom (Camera Settings ▸ Lock to Zoom). */
	lockToZoom: z.boolean().optional(),
	/** Pixels, or `fStop` (= focal length / aperture in mm at the 1920-px reference). */
	aperture: finite().min(0).optional(),
	fStop: finite().positive().optional(),
	blurLevel: finite().min(0).max(1000).optional(),
	irisShape: z.enum(IRIS_SHAPES).optional(),
};

/**
 * Layer ▸ New ▸ Camera (Premiere: New Item ▸ Camera): a camera clip at `at` on `track` (default: the topmost video
 * track free over the range, else a new track on top), `duration` frames (default: to the end of the sequence, at
 * least 5 s). `position` / `pointOfInterest` place it (default: framing the sequence like the default camera).
 */
export const ClipAddCameraCmd = cmd('clip.addCamera', {
	sequenceId: IdRefSchema.optional(),
	at: TimeInputSchema,
	duration: TimeInputSchema.optional(),
	track: TrackRefSchema.optional(),
	name: z.string().min(1).optional(),
	cameraType: z.enum(['one-node', 'two-node']).optional(),
	position: Vec3Schema.optional(),
	pointOfInterest: Vec3Schema.optional(),
	...lensShape,
	...dofShape,
	ref: RefDeclSchema.optional(),
});

const lightShape = {
	intensity: finite().min(-10_000).max(10_000).optional(),
	color: RGBASchema.optional(),
	coneAngle: finite().min(0).max(180).optional(),
	coneFeather: finite().min(0).max(100).optional(),
	falloff: z.enum(LIGHT_FALLOFFS).optional(),
	radius: finite().min(0).optional(),
	falloffDistance: finite().min(0).optional(),
	castsShadows: z.boolean().optional(),
	shadowDarkness: finite().min(0).max(100).optional(),
	shadowDiffusion: finite().min(0).optional(),
	/** Environment lights: an equirectangular image or video (media id), null = neutral studio. */
	environmentMediaId: IdRefSchema.nullable().optional(),
	environmentBackground: z.boolean().optional(),
};

/** Layer ▸ New ▸ Light: a light clip (placement as `clip.addCamera`). */
export const ClipAddLightCmd = cmd('clip.addLight', {
	sequenceId: IdRefSchema.optional(),
	at: TimeInputSchema,
	duration: TimeInputSchema.optional(),
	track: TrackRefSchema.optional(),
	name: z.string().min(1).optional(),
	lightType: z.enum(LIGHT_TYPES),
	position: Vec3Schema.optional(),
	pointOfInterest: Vec3Schema.optional(),
	...lightShape,
	ref: RefDeclSchema.optional(),
});

/**
 * Camera Settings (Layer ▸ Camera Settings…): type, lens, film size and depth of field. Animated properties get a
 * key at `at` (default: the playhead of the transaction, else the clip's start), as param.set does.
 */
export const CameraSettingsCmd = cmd('camera.settings', {
	clipId: IdRefSchema,
	name: z.string().min(1).optional(),
	cameraType: z.enum(['one-node', 'two-node']).optional(),
	...lensShape,
	...dofShape,
	at: ParamAtSchema.optional(),
});

/** Light Settings (Layer ▸ Light Settings…): type, colour, intensity, cone, falloff and shadows. */
export const LightSettingsCmd = cmd('light.settings', {
	clipId: IdRefSchema,
	name: z.string().min(1).optional(),
	lightType: z.enum(LIGHT_TYPES).optional(),
	...lightShape,
	at: ParamAtSchema.optional(),
});

/**
 * The camera tools on a camera clip (After Effects' Orbit, Pan and Dolly): orbit the eye about the Point of
 * Interest (`yaw` about the vertical, `pitch` about the camera's right axis, degrees), pan in the image plane (`dx`,
 * `dy` frame pixels as seen at the Point of Interest) or dolly along the view (`amount` pixels; `withPoi` moves the
 * Point of Interest too, AE's Track Z). Writes Position / Point of Interest at `at` (keys when animated).
 */
export const CameraOrbitCmd = cmd('camera.orbit', {
	clipId: IdRefSchema,
	yaw: finite(),
	pitch: finite(),
	at: ParamAtSchema.optional(),
});
export const CameraPanCmd = cmd('camera.pan', {
	clipId: IdRefSchema,
	dx: finite(),
	dy: finite(),
	at: ParamAtSchema.optional(),
});
export const CameraDollyCmd = cmd('camera.dolly', {
	clipId: IdRefSchema,
	amount: finite(),
	withPoi: z.boolean().optional(),
	at: ParamAtSchema.optional(),
});

/** Sequence 3D renderer (Composition Settings ▸ 3D Renderer): Classic 3D or Advanced 3D, Draft 3D, quality. */
export const SequenceSet3dRendererCmd = cmd('sequence.set3dRenderer', {
	sequenceId: IdRefSchema.optional(),
	renderer: z.enum(RENDERERS_3D).optional(),
	draft: z.boolean().optional(),
	shadowMapSize: z.number().int().min(256).max(8192).optional(),
	supersampling: z.number().int().min(1).max(4).optional(),
});

export const THREE_D_COMMANDS = [
	ClipSet3dCmd,
	ClipAddCameraCmd,
	ClipAddLightCmd,
	CameraSettingsCmd,
	LightSettingsCmd,
	CameraOrbitCmd,
	CameraPanCmd,
	CameraDollyCmd,
	SequenceSet3dRendererCmd,
] as const;
