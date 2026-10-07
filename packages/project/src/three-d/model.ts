// three-d: defaults, factories and lens math of 3D layers, cameras and lights (After Effects' values; the
// camera presets and lens relations follow EffectCraft `render/three_d/camera.rs`, MIT OR Apache-2.0).
import { anim } from '../factories.ts';
import type { RGBA, Vec3 } from '../schema/common.ts';
import type {
	CameraData,
	FILM_SIZE_MEASURES,
	IrisShape,
	Layer3D,
	LightData,
	LightType,
	MaterialOptions,
	RigTransform,
} from '../schema/three-d.ts';

/** AE's camera presets (35 mm film, 36 mm wide): name and focal length (mm). */
export const CAMERA_PRESETS: readonly { name: string; focalLength: number }[] = [
	{ name: '15mm', focalLength: 15 },
	{ name: '20mm', focalLength: 20 },
	{ name: '24mm', focalLength: 24 },
	{ name: '28mm', focalLength: 28 },
	{ name: '35mm', focalLength: 35 },
	{ name: '50mm', focalLength: 50 },
	{ name: '80mm', focalLength: 80 },
	{ name: '135mm', focalLength: 135 },
	{ name: '200mm', focalLength: 200 },
];

/** Film size of the presets (mm, horizontal). */
export const DEFAULT_FILM_SIZE = 36;
/** The default camera's focal length (AE's comp camera, a 50 mm preset). */
export const DEFAULT_FOCAL_LENGTH = 50;
/** Closest distance (camera-space z, pixels) a perspective camera renders. */
export const NEAR_PLANE = 1;

export type FilmMeasure = (typeof FILM_SIZE_MEASURES)[number];

/** The frame dimension a film size is measured along. */
export function filmDimension(measure: FilmMeasure, w: number, h: number): number {
	return measure === 'vertical' ? h : measure === 'diagonal' ? Math.hypot(w, h) : w;
}

/** Zoom (pixels) of a focal length (mm). */
export function zoomForFocalLength(
	focalMm: number,
	frame: { width: number; height: number },
	filmSize = DEFAULT_FILM_SIZE,
	measure: FilmMeasure = 'horizontal',
): number {
	return (filmDimension(measure, frame.width, frame.height) * focalMm) / Math.max(1e-6, filmSize);
}

/** Focal length (mm) of a zoom (pixels). */
export function focalLengthForZoom(
	zoom: number,
	frame: { width: number; height: number },
	filmSize = DEFAULT_FILM_SIZE,
	measure: FilmMeasure = 'horizontal',
): number {
	return (zoom * filmSize) / Math.max(1, filmDimension(measure, frame.width, frame.height));
}

/** Angle of view (degrees) along the film measure of a zoom. */
export function angleOfViewForZoom(
	zoom: number,
	frame: { width: number; height: number },
	measure: FilmMeasure = 'horizontal',
): number {
	return (
		(2 * Math.atan(filmDimension(measure, frame.width, frame.height) / 2 / Math.max(1e-6, zoom)) * 180) /
		Math.PI
	);
}

/** Zoom (pixels) of an angle of view (degrees, 0 < a < 180). */
export function zoomForAngleOfView(
	angle: number,
	frame: { width: number; height: number },
	measure: FilmMeasure = 'horizontal',
): number {
	const a = Math.min(179.9, Math.max(0.01, angle));
	return filmDimension(measure, frame.width, frame.height) / 2 / Math.tan((a * Math.PI) / 360);
}

/** The default comp camera's zoom: the 50 mm preset (2666.67 px at 1920 px wide). */
export function defaultCameraZoom(frameWidth: number): number {
	return (frameWidth * DEFAULT_FOCAL_LENGTH) / DEFAULT_FILM_SIZE;
}

/**
 * Default Aperture (pixels): the presets' 25.3 mm at the 1920-pixel reference width, proportional to the frame
 * width (AE's 50 mm preset is f/1.976). The Camera Settings dialog shows Aperture in millimetres at that reference
 * (`apertureMm`) and F-Stop = focal length / aperture (mm).
 */
export function defaultAperture(frameWidth: number): number {
	return (25.3 * frameWidth) / 1920;
}
export function apertureMm(aperturePx: number, frameWidth: number): number {
	return (aperturePx * 1920) / Math.max(1, frameWidth);
}
export function aperturePxFromMm(mm: number, frameWidth: number): number {
	return (mm * frameWidth) / 1920;
}
export function fStopOf(focalMm: number, aperturePx: number, frameWidth: number): number {
	const a = apertureMm(aperturePx, frameWidth);
	return a > 0 ? focalMm / a : Number.POSITIVE_INFINITY;
}

// ---------------------------------------------------------------- materials

/** After Effects' Material Options defaults. */
export const MATERIAL_DEFAULTS = {
	castsShadows: 'off',
	lightTransmission: 0,
	acceptsShadows: 'on',
	acceptsLights: true,
	ambient: 100,
	diffuse: 50,
	specularIntensity: 50,
	specularShininess: 5,
	metal: 100,
	reflectionIntensity: 0,
	reflectionSharpness: 100,
} as const;

export function defaultMaterial(): MaterialOptions {
	const d = MATERIAL_DEFAULTS;
	return {
		castsShadows: d.castsShadows,
		lightTransmission: anim(d.lightTransmission),
		acceptsShadows: d.acceptsShadows,
		acceptsLights: d.acceptsLights,
		ambient: anim(d.ambient),
		diffuse: anim(d.diffuse),
		specularIntensity: anim(d.specularIntensity),
		specularShininess: anim(d.specularShininess),
		metal: anim(d.metal),
	};
}

/** A fresh 3D Layer block (switch on, every 3D value at its default). */
export function newLayer3D(enabled = true): Layer3D {
	return {
		enabled,
		positionZ: anim(0),
		anchorZ: anim(0),
		scaleZ: anim(100),
		orientation: anim<Vec3>([0, 0, 0]),
		rotationX: anim(0),
		rotationY: anim(0),
		material: defaultMaterial(),
	};
}

/** Default Geometry Options (AE: Bevel Style None, Bevel Depth 2, Hole Bevel Depth 100 %, Extrusion Depth 0). */
export function defaultGeometryOptions(): NonNullable<Layer3D['geometry']> {
	return { bevelStyle: 'none', bevelDepth: anim(2), holeBevelDepth: anim(100), extrusionDepth: anim(0) };
}

// ---------------------------------------------------------------- cameras

function rig(position: Vec3, poi: Vec3, autoOrient: RigTransform['autoOrient']): RigTransform {
	return {
		autoOrient,
		position: anim(position),
		pointOfInterest: anim(poi),
		orientation: anim<Vec3>([0, 0, 0]),
		rotationX: anim(0),
		rotationY: anim(0),
		rotationZ: anim(0),
	};
}

export type NewCameraOptions = {
	type?: 'one-node' | 'two-node';
	/** Zoom in pixels; else from `focalLength` (mm); else the 50 mm preset. */
	zoom?: number;
	focalLength?: number;
	filmSize?: number;
	measureFilmSize?: FilmMeasure;
	depthOfField?: boolean;
	focusDistance?: number;
	aperture?: number;
	blurLevel?: number;
	irisShape?: IrisShape;
};

/**
 * A camera that frames the sequence like the default camera: at the frame centre, `zoom` in front of the z = 0
 * plane (which it shows at 100 %), its Point of Interest at the frame centre.
 */
export function newCameraData(
	frame: { width: number; height: number },
	o: NewCameraOptions = {},
): CameraData {
	const filmSize = o.filmSize ?? DEFAULT_FILM_SIZE;
	const measure = o.measureFilmSize ?? 'horizontal';
	const zoom =
		o.zoom ??
		(o.focalLength !== undefined
			? zoomForFocalLength(o.focalLength, frame, filmSize, measure)
			: defaultCameraZoom(frame.width));
	const c: Vec3 = [frame.width / 2, frame.height / 2, 0];
	return {
		transform: rig([c[0], c[1], -zoom], c, o.type === 'one-node' ? 'off' : 'poi'),
		zoom: anim(zoom),
		filmSize,
		measureFilmSize: measure,
		depthOfField: o.depthOfField ?? false,
		focusDistance: anim(o.focusDistance ?? zoom),
		aperture: anim(o.aperture ?? defaultAperture(frame.width)),
		blurLevel: anim(o.blurLevel ?? 100),
		irisShape: o.irisShape ?? 'fast-rectangle',
		irisRotation: anim(0),
		irisRoundness: anim(0),
		irisAspectRatio: anim(1),
		irisDiffractionFringe: anim(0),
		highlightGain: anim(0),
		highlightThreshold: anim(255),
		highlightSaturation: anim(0),
	};
}

// ---------------------------------------------------------------- lights

/** Light types that have a Point of Interest / direction (AE: parallel and spot). */
export const DIRECTIONAL_LIGHTS: ReadonlySet<LightType> = new Set(['parallel', 'spot']);

export type NewLightOptions = {
	intensity?: number;
	color?: RGBA;
	coneAngle?: number;
	coneFeather?: number;
	falloff?: LightData['falloff'];
	radius?: number;
	falloffDistance?: number;
	castsShadows?: boolean;
	shadowDarkness?: number;
	shadowDiffusion?: number;
};

/**
 * A light at the default place for a new light (EffectCraft's): up-left in front of the frame, (w/2 − 260,
 * h/2 − 260, −440) at 1920 px wide (scaled with the width), aimed at the frame centre (parallel and spot lights);
 * the position of ambient and environment lights does not matter.
 */
export function newLightData(
	type: LightType,
	frame: { width: number; height: number },
	o: NewLightOptions = {},
): LightData {
	const c: Vec3 = [frame.width / 2, frame.height / 2, 0];
	const k = frame.width / 1920;
	const pos: Vec3 = [c[0] - 260 * k, c[1] - 260 * k, -440 * k];
	return {
		type,
		transform: rig(pos, c, DIRECTIONAL_LIGHTS.has(type) ? 'poi' : 'off'),
		intensity: anim(o.intensity ?? 100),
		color: anim<RGBA>(o.color ?? [1, 1, 1, 1]),
		coneAngle: anim(o.coneAngle ?? 90),
		coneFeather: anim(o.coneFeather ?? 50),
		falloff: o.falloff ?? 'none',
		radius: anim(o.radius ?? 500),
		falloffDistance: anim(o.falloffDistance ?? 500),
		castsShadows: o.castsShadows ?? false,
		shadowDarkness: anim(o.shadowDarkness ?? 100),
		shadowDiffusion: anim(o.shadowDiffusion ?? 0),
		...(type === 'environment'
			? { environmentMediaId: null, environmentRotation: anim(0), environmentBackground: false }
			: {}),
	};
}

/** Human labels (menus, Effect Controls). */
export const LIGHT_TYPE_LABELS: Record<LightType, string> = {
	parallel: 'Parallel',
	spot: 'Spot',
	point: 'Point',
	ambient: 'Ambient',
	environment: 'Environment',
};
export const IRIS_SHAPE_LABELS: Record<IrisShape, string> = {
	'fast-rectangle': 'Fast Rectangle',
	triangle: 'Triangle',
	square: 'Square',
	pentagon: 'Pentagon',
	hexagon: 'Hexagon',
	heptagon: 'Heptagon',
	octagon: 'Octagon',
	nonagon: 'Nonagon',
	decagon: 'Decagon',
};
/** Polygon sides of an iris shape (0 = Fast Rectangle, a box filter). */
export function irisSides(shape: IrisShape): number {
	return shape === 'fast-rectangle'
		? 0
		: 3 +
				['triangle', 'square', 'pentagon', 'hexagon', 'heptagon', 'octagon', 'nonagon', 'decagon'].indexOf(
					shape,
				);
}
