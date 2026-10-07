// three-d: property specs of 3D layers (`threeD.*`), cameras (`camera.*`) and lights (`light.*`) — Effect Controls
// rows, param.set / keyframes / expressions and the agent schemas (After Effects names, units, ranges, defaults).
import type { Clip } from '../schema/sequence.ts';
import {
	BEVEL_STYLES,
	IRIS_SHAPES,
	LAYER_AUTO_ORIENT,
	LIGHT_FALLOFFS,
	LIGHT_TYPES,
	SHADOW_MODES,
} from '../schema/three-d.ts';
import {
	defaultAperture,
	defaultCameraZoom,
	IRIS_SHAPE_LABELS,
	LIGHT_TYPE_LABELS,
} from '../three-d/model.ts';
import type { PropertyContext, PropertySpec } from './properties.ts';

const has3d = (c: Pick<Clip, 'kind'>) => !!(c as { threeD?: unknown }).threeD && c.kind !== 'adjustment';
const hasGeometry = (c: Pick<Clip, 'kind'>) =>
	has3d(c) &&
	(c.kind === 'text' || c.kind === 'shape') &&
	!!(c as { threeD?: { geometry?: unknown } }).threeD?.geometry;
const isCamera = (c: Pick<Clip, 'kind'>) => c.kind === 'camera';
const isLight = (c: Pick<Clip, 'kind'>) => c.kind === 'light';
const lightType = (c: Pick<Clip, 'kind'>) => (c as { light?: { type?: string } }).light?.type;
const isLightOf =
	(...types: string[]) =>
	(c: Pick<Clip, 'kind'>) =>
		isLight(c) && types.includes(lightType(c) ?? '');

type Num = { min?: number; max?: number; softMin?: number; softMax?: number; step?: number };

function num(
	key: string,
	label: string,
	storagePath: string[],
	appliesTo: PropertySpec['appliesTo'],
	o: {
		unit?: PropertySpec['unit'];
		range?: Num;
		control?: 'scrub' | 'slider' | 'angle';
		def: number | ((ctx: PropertyContext) => number);
		group: PropertySpec['group'];
		description?: string;
		precision?: number;
	},
): PropertySpec {
	return {
		key,
		label,
		group: o.group,
		kind: 'number',
		...(o.unit ? { unit: o.unit } : {}),
		range: o.range ?? { step: 0.1 },
		animatable: 'continuous',
		storagePath,
		appliesTo,
		ui: { control: o.control ?? 'scrub', precision: o.precision ?? 1 },
		defaultValue: o.def,
		...(o.description ? { description: o.description } : {}),
	};
}

function vec3(
	key: string,
	label: string,
	storagePath: string[],
	appliesTo: PropertySpec['appliesTo'],
	def: [number, number, number] | ((ctx: PropertyContext) => [number, number, number]),
	group: PropertySpec['group'],
	unit: PropertySpec['unit'],
	description?: string,
): PropertySpec {
	return {
		key,
		label,
		group,
		kind: 'vec3',
		unit,
		range: { step: 0.1 },
		animatable: 'continuous',
		storagePath,
		appliesTo,
		ui: { control: 'vec3', precision: 1 },
		defaultValue: def,
		...(description ? { description } : {}),
	};
}

function sel(
	key: string,
	label: string,
	storagePath: string[],
	appliesTo: PropertySpec['appliesTo'],
	options: readonly string[],
	optionLabels: readonly string[],
	def: string,
	group: PropertySpec['group'],
	description?: string,
): PropertySpec {
	return {
		key,
		label,
		group,
		kind: 'enum',
		options,
		optionLabels,
		animatable: 'no',
		storagePath,
		appliesTo,
		ui: { control: 'select' },
		defaultValue: def,
		...(description ? { description } : {}),
	};
}

function toggle(
	key: string,
	label: string,
	storagePath: string[],
	appliesTo: PropertySpec['appliesTo'],
	def: boolean,
	group: PropertySpec['group'],
	description?: string,
): PropertySpec {
	return {
		key,
		label,
		group,
		kind: 'boolean',
		animatable: 'no',
		storagePath,
		appliesTo,
		ui: { control: 'toggle' },
		defaultValue: def,
		...(description ? { description } : {}),
	};
}

const SHADOW_LABELS = ['Off', 'On', 'Only'];
const PCT = { min: 0, max: 100, step: 0.1 };
const PCT1000 = { min: 0, max: 1000, softMax: 200, step: 0.1 };
const centre = ({ seq }: PropertyContext): [number, number, number] => [
	seq.settings.width / 2,
	seq.settings.height / 2,
	0,
];

// ---------------------------------------------------------------- 3D layers

const L = (k: string) => ['threeD', k];
const M = (k: string) => ['threeD', 'material', k];
const G = (k: string) => ['threeD', 'geometry', k];

export const LAYER_3D_SPECS: readonly PropertySpec[] = [
	num('threeD.positionZ', 'Z Position', L('positionZ'), has3d, {
		unit: 'px',
		def: 0,
		group: 'threeD',
		description: 'Distance along z (away from the viewer) of the anchor point, in pixels.',
	}),
	num('threeD.anchorZ', 'Anchor Point Z', L('anchorZ'), has3d, { unit: 'px', def: 0, group: 'threeD' }),
	num('threeD.scaleZ', 'Z Scale', L('scaleZ'), has3d, {
		unit: '%',
		range: { min: -10000, max: 10000, softMin: 0, softMax: 400, step: 0.1 },
		def: 100,
		group: 'threeD',
	}),
	vec3(
		'threeD.orientation',
		'Orientation',
		L('orientation'),
		has3d,
		[0, 0, 0],
		'threeD',
		'deg',
		'X, Y, Z angles applied in that order; keys turn along the shortest rotation.',
	),
	num('threeD.rotationX', 'X Rotation', L('rotationX'), has3d, {
		unit: 'deg',
		control: 'angle',
		def: 0,
		group: 'threeD',
	}),
	num('threeD.rotationY', 'Y Rotation', L('rotationY'), has3d, {
		unit: 'deg',
		control: 'angle',
		def: 0,
		group: 'threeD',
	}),
	sel(
		'threeD.autoOrient',
		'Auto-Orient',
		L('autoOrient'),
		has3d,
		LAYER_AUTO_ORIENT,
		['Off', 'Orient Along Path', 'Orient Towards Camera'],
		'off',
		'threeD',
	),
	// Material Options
	sel(
		'threeD.material.castsShadows',
		'Casts Shadows',
		M('castsShadows'),
		has3d,
		SHADOW_MODES,
		SHADOW_LABELS,
		'off',
		'material',
	),
	num('threeD.material.lightTransmission', 'Light Transmission', M('lightTransmission'), has3d, {
		unit: '%',
		range: PCT,
		control: 'slider',
		def: 0,
		group: 'material',
	}),
	sel(
		'threeD.material.acceptsShadows',
		'Accepts Shadows',
		M('acceptsShadows'),
		has3d,
		SHADOW_MODES,
		SHADOW_LABELS,
		'on',
		'material',
	),
	toggle('threeD.material.acceptsLights', 'Accepts Lights', M('acceptsLights'), has3d, true, 'material'),
	num('threeD.material.ambient', 'Ambient', M('ambient'), has3d, {
		unit: '%',
		range: PCT1000,
		def: 100,
		group: 'material',
	}),
	num('threeD.material.diffuse', 'Diffuse', M('diffuse'), has3d, {
		unit: '%',
		range: PCT1000,
		def: 50,
		group: 'material',
	}),
	num('threeD.material.specularIntensity', 'Specular Intensity', M('specularIntensity'), has3d, {
		unit: '%',
		range: PCT1000,
		def: 50,
		group: 'material',
	}),
	num('threeD.material.specularShininess', 'Specular Shininess', M('specularShininess'), has3d, {
		unit: '%',
		range: PCT,
		control: 'slider',
		def: 5,
		group: 'material',
	}),
	num('threeD.material.metal', 'Metal', M('metal'), has3d, {
		unit: '%',
		range: PCT,
		control: 'slider',
		def: 100,
		group: 'material',
	}),
	num('threeD.material.reflectionIntensity', 'Reflection Intensity', M('reflectionIntensity'), has3d, {
		unit: '%',
		range: PCT,
		control: 'slider',
		def: 0,
		group: 'material',
		description: 'Advanced 3D: mirror reflection of the environment light.',
	}),
	num('threeD.material.reflectionSharpness', 'Reflection Sharpness', M('reflectionSharpness'), has3d, {
		unit: '%',
		range: PCT,
		control: 'slider',
		def: 100,
		group: 'material',
		description: 'Advanced 3D: 100 % = mirror, lower = rougher (GGX roughness = 1 − sharpness).',
	}),
	// Geometry Options (Advanced 3D extrusion of text and shapes)
	sel(
		'threeD.geometry.bevelStyle',
		'Bevel Style',
		G('bevelStyle'),
		hasGeometry,
		BEVEL_STYLES,
		['None', 'Angular', 'Concave', 'Convex'],
		'none',
		'geometry',
	),
	num('threeD.geometry.bevelDepth', 'Bevel Depth', G('bevelDepth'), hasGeometry, {
		unit: 'px',
		range: { min: 0, max: 1000, softMax: 100, step: 0.1 },
		def: 2,
		group: 'geometry',
	}),
	num('threeD.geometry.holeBevelDepth', 'Hole Bevel Depth', G('holeBevelDepth'), hasGeometry, {
		unit: '%',
		range: PCT,
		control: 'slider',
		def: 100,
		group: 'geometry',
	}),
	num('threeD.geometry.extrusionDepth', 'Extrusion Depth', G('extrusionDepth'), hasGeometry, {
		unit: 'px',
		range: { min: 0, max: 10000, softMax: 1000, step: 0.1 },
		def: 0,
		group: 'geometry',
	}),
];

// ---------------------------------------------------------------- cameras

const C = (k: string) => ['camera', k];
const CT = (k: string) => ['camera', 'transform', k];
const camDof = (c: Pick<Clip, 'kind'>) => isCamera(c);

export const CAMERA_SPECS: readonly PropertySpec[] = [
	sel(
		'camera.type',
		'Type',
		CT('autoOrient'),
		isCamera,
		['off', 'poi'],
		['One-Node Camera', 'Two-Node Camera'],
		'poi',
		'camera',
		'A two-node camera aims at its Point of Interest.',
	),
	vec3(
		'camera.pointOfInterest',
		'Point of Interest',
		CT('pointOfInterest'),
		isCamera,
		centre,
		'camera',
		'px',
	),
	vec3(
		'camera.position',
		'Position',
		CT('position'),
		isCamera,
		({ seq }) => [seq.settings.width / 2, seq.settings.height / 2, -defaultCameraZoom(seq.settings.width)],
		'camera',
		'px',
	),
	vec3('camera.orientation', 'Orientation', CT('orientation'), isCamera, [0, 0, 0], 'camera', 'deg'),
	num('camera.rotationX', 'X Rotation', CT('rotationX'), isCamera, {
		unit: 'deg',
		control: 'angle',
		def: 0,
		group: 'camera',
	}),
	num('camera.rotationY', 'Y Rotation', CT('rotationY'), isCamera, {
		unit: 'deg',
		control: 'angle',
		def: 0,
		group: 'camera',
	}),
	num('camera.rotationZ', 'Z Rotation', CT('rotationZ'), isCamera, {
		unit: 'deg',
		control: 'angle',
		def: 0,
		group: 'camera',
	}),
	num('camera.zoom', 'Zoom', C('zoom'), isCamera, {
		unit: 'px',
		range: { min: 1, max: 100000, softMax: 10000, step: 0.1 },
		def: ({ seq }) => defaultCameraZoom(seq.settings.width),
		group: 'camera',
		description: 'Distance from the eye to the image plane (sets the angle of view).',
	}),
	toggle('camera.depthOfField', 'Depth of Field', C('depthOfField'), camDof, false, 'camera'),
	num('camera.focusDistance', 'Focus Distance', C('focusDistance'), camDof, {
		unit: 'px',
		range: { min: 0, max: 100000, softMax: 10000, step: 0.1 },
		def: ({ seq }) => defaultCameraZoom(seq.settings.width),
		group: 'camera',
	}),
	num('camera.aperture', 'Aperture', C('aperture'), camDof, {
		unit: 'px',
		range: { min: 0, max: 10000, softMax: 200, step: 0.1 },
		def: ({ seq }) => defaultAperture(seq.settings.width),
		group: 'camera',
	}),
	num('camera.blurLevel', 'Blur Level', C('blurLevel'), camDof, {
		unit: '%',
		range: { min: 0, max: 1000, softMax: 200, step: 0.1 },
		def: 100,
		group: 'camera',
	}),
	sel(
		'camera.irisShape',
		'Iris Shape',
		C('irisShape'),
		camDof,
		IRIS_SHAPES,
		IRIS_SHAPES.map((s) => IRIS_SHAPE_LABELS[s]),
		'fast-rectangle',
		'camera',
	),
	num('camera.irisRotation', 'Iris Rotation', C('irisRotation'), camDof, {
		unit: 'deg',
		control: 'angle',
		def: 0,
		group: 'camera',
	}),
	num('camera.irisRoundness', 'Iris Roundness', C('irisRoundness'), camDof, {
		unit: '%',
		range: { min: -100, max: 100, step: 0.1 },
		control: 'slider',
		def: 0,
		group: 'camera',
	}),
	num('camera.irisAspectRatio', 'Iris Aspect Ratio', C('irisAspectRatio'), camDof, {
		range: { min: 0.01, max: 100, softMax: 4, step: 0.01 },
		def: 1,
		group: 'camera',
		precision: 2,
	}),
	num('camera.irisDiffractionFringe', 'Iris Diffraction Fringe', C('irisDiffractionFringe'), camDof, {
		range: { min: 0, max: 1000, softMax: 100, step: 0.1 },
		def: 0,
		group: 'camera',
	}),
	num('camera.highlightGain', 'Highlight Gain', C('highlightGain'), camDof, {
		range: PCT,
		control: 'slider',
		def: 0,
		group: 'camera',
	}),
	num('camera.highlightThreshold', 'Highlight Threshold', C('highlightThreshold'), camDof, {
		range: { min: 0, max: 255, step: 1 },
		control: 'slider',
		def: 255,
		group: 'camera',
		precision: 0,
	}),
	num('camera.highlightSaturation', 'Highlight Saturation', C('highlightSaturation'), camDof, {
		range: PCT,
		control: 'slider',
		def: 0,
		group: 'camera',
	}),
];

// ---------------------------------------------------------------- lights

const LO = (k: string) => ['light', k];
const LT = (k: string) => ['light', 'transform', k];
const placed = isLightOf('parallel', 'spot', 'point');
const aimed = isLightOf('parallel', 'spot');
const falls = isLightOf('spot', 'point');
const shadows = isLightOf('parallel', 'spot', 'point');

export const LIGHT_SPECS: readonly PropertySpec[] = [
	sel(
		'light.type',
		'Light Type',
		LO('type'),
		isLight,
		LIGHT_TYPES,
		LIGHT_TYPES.map((t) => LIGHT_TYPE_LABELS[t]),
		'spot',
		'light',
	),
	sel(
		'light.autoOrient',
		'Auto-Orient',
		LT('autoOrient'),
		aimed,
		['off', 'poi'],
		['Off', 'Towards Point of Interest'],
		'poi',
		'light',
	),
	vec3('light.pointOfInterest', 'Point of Interest', LT('pointOfInterest'), aimed, centre, 'light', 'px'),
	vec3(
		'light.position',
		'Position',
		LT('position'),
		placed,
		({ seq }) => {
			const k = seq.settings.width / 1920;
			return [seq.settings.width / 2 - 260 * k, seq.settings.height / 2 - 260 * k, -440 * k];
		},
		'light',
		'px',
	),
	vec3('light.orientation', 'Orientation', LT('orientation'), aimed, [0, 0, 0], 'light', 'deg'),
	num('light.rotationX', 'X Rotation', LT('rotationX'), aimed, {
		unit: 'deg',
		control: 'angle',
		def: 0,
		group: 'light',
	}),
	num('light.rotationY', 'Y Rotation', LT('rotationY'), aimed, {
		unit: 'deg',
		control: 'angle',
		def: 0,
		group: 'light',
	}),
	num('light.rotationZ', 'Z Rotation', LT('rotationZ'), aimed, {
		unit: 'deg',
		control: 'angle',
		def: 0,
		group: 'light',
	}),
	num('light.intensity', 'Intensity', LO('intensity'), isLight, {
		unit: '%',
		range: { min: -10000, max: 10000, softMin: 0, softMax: 400, step: 0.1 },
		def: 100,
		group: 'light',
	}),
	{
		key: 'light.color',
		label: 'Color',
		group: 'light',
		kind: 'color',
		animatable: 'continuous',
		storagePath: LO('color'),
		appliesTo: isLight,
		ui: { control: 'color' },
		defaultValue: [1, 1, 1, 1],
	},
	num('light.coneAngle', 'Cone Angle', LO('coneAngle'), isLightOf('spot'), {
		unit: 'deg',
		range: { min: 0, max: 180, step: 0.1 },
		control: 'slider',
		def: 90,
		group: 'light',
	}),
	num('light.coneFeather', 'Cone Feather', LO('coneFeather'), isLightOf('spot'), {
		unit: '%',
		range: PCT,
		control: 'slider',
		def: 50,
		group: 'light',
	}),
	sel(
		'light.falloff',
		'Falloff',
		LO('falloff'),
		falls,
		LIGHT_FALLOFFS,
		['None', 'Smooth', 'Inverse Square Clamped'],
		'none',
		'light',
	),
	num('light.radius', 'Radius', LO('radius'), falls, {
		unit: 'px',
		range: { min: 0, max: 100000, softMax: 2000, step: 0.1 },
		def: 500,
		group: 'light',
	}),
	num('light.falloffDistance', 'Falloff Distance', LO('falloffDistance'), falls, {
		unit: 'px',
		range: { min: 0, max: 100000, softMax: 2000, step: 0.1 },
		def: 500,
		group: 'light',
	}),
	toggle('light.castsShadows', 'Casts Shadows', LO('castsShadows'), shadows, false, 'light'),
	num('light.shadowDarkness', 'Shadow Darkness', LO('shadowDarkness'), shadows, {
		unit: '%',
		range: PCT,
		control: 'slider',
		def: 100,
		group: 'light',
	}),
	num('light.shadowDiffusion', 'Shadow Diffusion', LO('shadowDiffusion'), shadows, {
		unit: 'px',
		range: { min: 0, max: 1000, softMax: 100, step: 0.1 },
		def: 0,
		group: 'light',
	}),
	num(
		'light.environmentRotation',
		'Environment Rotation',
		LO('environmentRotation'),
		isLightOf('environment'),
		{
			unit: 'deg',
			control: 'angle',
			def: 0,
			group: 'light',
		},
	),
	toggle(
		'light.environmentBackground',
		'Background',
		LO('environmentBackground'),
		isLightOf('environment'),
		false,
		'light',
		'Draw the environment image behind the 3D layers (Advanced 3D).',
	),
];

export const THREE_D_PROPERTY_SPECS: readonly PropertySpec[] = [
	...LAYER_3D_SPECS,
	...CAMERA_SPECS,
	...LIGHT_SPECS,
];
