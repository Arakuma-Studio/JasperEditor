// three-d (docs/wp-notes/three-d.md): commands of 3D layers, cameras, lights and the sequence's 3D renderer. The
// per-property values (Z Position, Orientation, Material Options, Point of Interest, Zoom, Intensity…) are written
// with param.set / keyframe.* through the property registry (`threeD.*`, `camera.*`, `light.*`).
import { z } from 'zod';
import { RGBASchema, Vec3Schema } from '../../schema/common.ts';
import {
	CAMERA_TRACKER_METHODS,
	CAMERA_TRACKER_SHOT_TYPES,
	CameraSolvePointSchema,
	FILM_SIZE_MEASURES,
	IRIS_SHAPES,
	LIGHT_FALLOFFS,
	LIGHT_TYPES,
	RENDERERS_3D,
	TRACK_POINT_DISPLAY,
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

// ---------------------------------------------------------------- 3D Camera Tracker

const trackerSettingsShape = {
	shot: z.enum(CAMERA_TRACKER_SHOT_TYPES).optional(),
	hfov: finite().min(1).max(170).optional(),
	method: z.enum(CAMERA_TRACKER_METHODS).optional(),
	detailed: z.boolean().optional(),
	lensDistortion: z.boolean().optional(),
	showPoints: z.enum(TRACK_POINT_DISPLAY).optional(),
	pointSize: finite().min(10).max(1000).optional(),
	targetSize: finite().min(10).max(1000).optional(),
};
const mediaSpan = z.tuple([z.number().int().min(0), z.number().int().min(0)]);

/** Applies the 3D Camera Tracker to a video clip (the span defaults to the media frames the clip shows). */
export const CameraTrackerAddCmd = cmd('cameraTracker.add', {
	clipId: IdRefSchema,
	span: mediaSpan.optional(),
	...trackerSettingsShape,
});
/** 3D Camera Tracker settings (Shot Type, Horizontal Angle of View, Solve Method, Detailed Analysis, display). */
export const CameraTrackerSettingsCmd = cmd('cameraTracker.settings', {
	clipId: IdRefSchema,
	span: mediaSpan.optional(),
	...trackerSettingsShape,
});
/** Commits a camera solve (the `camtrack` job's result) to the clip's tracker. */
export const CameraTrackerSetResultCmd = cmd('cameraTracker.setResult', {
	clipId: IdRefSchema,
	solve: z.strictObject({
		span: mediaSpan,
		size: z.tuple([z.number().int().positive(), z.number().int().positive()]),
		shot: z.enum(CAMERA_TRACKER_SHOT_TYPES),
		methodUsed: z.enum(['typical', 'flat', 'tripod']),
		averageError: finite().min(0),
		frames: z.array(finite()),
		points: z.array(CameraSolvePointSchema),
		distortion: z.strictObject({ k1: finite(), k2: finite(), radius: finite() }).nullable(),
		method: z.string().min(1),
	}),
});
/** Deletes track points (they stay out of the next solve). */
export const CameraTrackerDeletePointsCmd = cmd('cameraTracker.deletePoints', {
	clipId: IdRefSchema,
	pointIds: z.array(z.number().int().min(0)).min(1),
});
/** Set Ground Plane and Origin from three or more track points (`pointIds` empty = clear). */
export const CameraTrackerSetGroundCmd = cmd('cameraTracker.setGround', {
	clipId: IdRefSchema,
	pointIds: z.array(z.number().int().min(0)),
	/** Media frame whose solved camera orients the plane (default: the first frame the points share). */
	frame: z.number().int().min(0).optional(),
});
/**
 * Create Camera / Create Text and Camera / Create Solid and Camera: a one-node camera following the solve over the
 * clip (a key per frame), and optionally a 3D layer on the target of the selected track points.
 */
export const CameraTrackerCreateCmd = cmd('cameraTracker.create', {
	clipId: IdRefSchema,
	layer: z.enum(['none', 'text', 'solid']).optional(),
	/** Track points of the target (needed for a layer). */
	pointIds: z.array(z.number().int().min(0)).optional(),
	/** Media frame the target is seen at (default: the frame under the playhead the caller passes, else the first). */
	frame: z.number().int().min(0).optional(),
	text: z.string().max(10_000).optional(),
	color: RGBASchema.optional(),
	name: z.string().optional(),
	/** Reuse the tracker's camera (its keys are rewritten) instead of making a new one. */
	replaceCamera: z.boolean().optional(),
	cameraRef: RefDeclSchema.optional(),
	layerRef: RefDeclSchema.optional(),
});
export const CameraTrackerRemoveCmd = cmd('cameraTracker.remove', { clipId: IdRefSchema });

export const THREE_D_COMMANDS = [
	CameraTrackerAddCmd,
	CameraTrackerSettingsCmd,
	CameraTrackerSetResultCmd,
	CameraTrackerDeletePointsCmd,
	CameraTrackerSetGroundCmd,
	CameraTrackerCreateCmd,
	CameraTrackerRemoveCmd,
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
