import type { z } from 'zod';
import type { HandlerContext } from './context.ts';
import { AUDIO_MIX_OWNER, audioHandlers } from './handlers/audio.ts';
import { cameraTrackerHandlers } from './handlers/camtrack.ts';
import { CAPTIONS_OWNER, captionHandlers } from './handlers/captions.ts';
import { clipCoreHandlers } from './handlers/clip-core.ts';
import { clipEditHandlers } from './handlers/clip-edit.ts';
import { CLIPBOARD_OWNER, clipboardHandlers } from './handlers/clipboard.ts';
import { colorMgmtHandlers } from './handlers/color-mgmt.ts';
import { compositionHandlers } from './handlers/composition.ts';
import { editUxHandlers } from './handlers/edit-ux.ts';
import { effectHandlers } from './handlers/effect.ts';
import { ESSENTIAL_OWNER, essentialHandlers } from './handlers/essential.ts';
import { EXPRESSION_OWNER, expressionHandlers } from './handlers/expression.ts';
import { GAPS_OWNER, gapsHandlers } from './handlers/gaps.ts';
import { INTERCHANGE_OWNER, interchangeHandlers } from './handlers/interchange.ts';
import { INTERPRET_OWNER, interpretHandlers } from './handlers/interpret.ts';
import { keyframeHandlers } from './handlers/keyframe.ts';
import { maskHandlers } from './handlers/mask.ts';
import { multicamHandlers } from './handlers/multicam.ts';
import { paramHandlers } from './handlers/param.ts';
import { PRESET_OWNER, presetHandlers } from './handlers/preset.ts';
import { PREVIEWS_OWNER, previewsHandlers } from './handlers/previews.ts';
import { processHandlers } from './handlers/process.ts';
import { projectHandlers } from './handlers/project.ts';
import { ROTO_OWNER, rotoHandlers } from './handlers/roto.ts';
import { rovingHandlers } from './handlers/roving.ts';
import { sequenceHandlers } from './handlers/sequence.ts';
import { keepShapesCentred, SHAPE_BOX_COMMANDS, SHAPE_OWNER, shapeHandlers } from './handlers/shape.ts';
import { SIM_WARP_OWNER, simWarpHandlers } from './handlers/sim-warp.ts';
import { simplifyHandlers } from './handlers/simplify.ts';
import { SOUND_DESIGN_OWNER, soundHandlers } from './handlers/sound.ts';
import { spatialHandlers } from './handlers/spatial.ts';
import { SPEECH_OWNER, speechHandlers } from './handlers/speech.ts';
import { STRUCTURE_OWNER, structureHandlers } from './handlers/structure.ts';
import { TEXT_ANIMATOR_OWNER, textAnimatorHandlers } from './handlers/text-animators.ts';
import { THREE_D_OWNER, threeDHandlers } from './handlers/three-d.ts';
import { timeHandlers } from './handlers/time.ts';
import { trackerHandlers } from './handlers/tracker.ts';
import { transitionHandlers } from './handlers/transition.ts';
import type { Handler, HandlerMap } from './handlers/util.ts';
import { ALL_COMMAND_SCHEMAS, type Command, type CommandType } from './schemas/index.ts';

export type CommandOwner =
	| 'WP-00'
	| 'WP-2B'
	| 'WP-2D'
	| 'WP-TR'
	| 'M2'
	| 'wp-m2-process'
	| 'wp-m2-mg'
	| 'wp-m2-track'
	| 'wp-m2-shapes'
	| 'wp-m3-trackui'
	| 'wp-clipboard'
	| 'wp-m3-presets'
	| 'wp-interchange'
	| 'wp-multicam'
	| 'edit-structure'
	| 'wp-m3-masks'
	| 'audio-mix'
	| 'keyframes-blend'
	| 'wp-captions'
	| 'speech'
	| 'wp-m3-expressions'
	| 'audio-fx'
	| 'wp-time'
	| 'parity-roto'
	| 'edit-ux'
	| 'text-animators'
	| 'three-d'
	| 'sim-warp'
	| 'color-mgmt'
	| 'imports'
	| 'previews'
	| 'gaps'
	| 'sound-design';

export type CatalogEntry = {
	type: CommandType;
	schema: z.ZodType;
	handler: Handler<CommandType>;
	/** Default History label (the transaction label wins; S01:UND-002). */
	label: string;
	owner: CommandOwner;
	milestone: 'M1' | 'M2' | 'M3';
};

const LABELS: Record<CommandType, string> = {
	'project.rename': 'Rename Project',
	'project.updateSettings': 'Project Settings',
	'bin.create': 'New Bin',
	'item.rename': 'Rename',
	'item.setLabel': 'Label',
	'item.move': 'Move Items',
	'item.delete': 'Delete Items',
	'item.setMarks': 'Set Source Marks',
	'item.setPoster': 'Set Poster Frame',
	'media.register': 'Import',
	'media.relink': 'Link Media',
	'media.derive': 'Process Media',
	'media.setSourceRange': 'Set Source Range',
	'media.removeUnused': 'Remove Unused',
	'synthetic.create': 'New Item',
	'synthetic.update': 'Edit Item',
	'transcript.create': 'Add Transcript',
	'transcript.editText': 'Edit Transcript',
	'transcript.setBreak': 'Caption Break',
	'sequence.create': 'New Sequence',
	'sequence.updateSettings': 'Sequence Settings',
	'sequence.duplicate': 'Duplicate Sequence',
	'sequence.delete': 'Delete Sequence',
	'sequence.setInOut': 'Mark In/Out',
	'sequence.setWorkArea': 'Work Area',
	'marker.add': 'Add Marker',
	'marker.update': 'Edit Marker',
	'marker.remove': 'Clear Marker',
	'track.add': 'Add Tracks',
	'track.remove': 'Delete Tracks',
	'track.update': 'Track Settings',
	'clip.place': 'Place Clip',
	'clip.addText': 'New Text',
	'clip.addSolid': 'New Color Matte',
	'clip.addMotionGraphic': 'New Motion Graphic',
	'clip.addComposition': 'New Composition',
	'clip.addShape': 'New Shape',
	'clip.addCaptions': 'Add Captions',
	'clip.addAdjustment': 'New Adjustment Layer',
	'clip.move': 'Move Clip',
	'clip.trim': 'Trim',
	'clip.slip': 'Slip',
	'clip.slide': 'Slide',
	'clip.split': 'Add Edit',
	'clip.lift': 'Clear',
	'clip.extract': 'Ripple Delete',
	'range.lift': 'Lift',
	'range.extract': 'Extract',
	'gap.close': 'Close Gap',
	'clip.duplicate': 'Duplicate',
	'clip.update': 'Edit Clip',
	'clip.setSpeed': 'Speed/Duration',
	'clip.replaceSource': 'Replace With Clip',
	'clip.fitToFrame': 'Scale to Frame Size',
	'clip.link': 'Link',
	'clip.unlink': 'Unlink',
	'clip.group': 'Group',
	'clip.ungroup': 'Ungroup',
	'clip.nest': 'Nest',
	'clip.unnest': 'Unnest',
	'clip.addFrameHold': 'Add Frame Hold',
	'clip.insertFrameHoldSegment': 'Insert Frame Hold Segment',
	'clip.frameHoldOptions': 'Frame Hold Options',
	'sequence.joinThroughEdits': 'Join Through Edits',
	'sequence.makeSubsequence': 'Make Subsequence',
	'param.set': 'Change Value',
	'param.setAnimated': 'Toggle Animation',
	'keyframe.add': 'Add Keyframe',
	'keyframe.update': 'Edit Keyframe',
	'keyframe.remove': 'Delete Keyframes',
	'keyframe.move': 'Move Keyframes',
	'keyframe.setInterpolation': 'Keyframe Interpolation',
	'keyframes.prune': 'Prune Keyframes',
	'keyframe.setSpatialInterpolation': 'Spatial Interpolation',
	'keyframe.setTangents': 'Edit Motion Path',
	'keyframe.setRoving': 'Rove Across Time',
	'effect.add': 'Apply Effect',
	'effect.remove': 'Remove Effect',
	'effect.reorder': 'Reorder Effects',
	'effect.setEnabled': 'Toggle Effect',
	'transition.add': 'Add Transition',
	'transition.update': 'Edit Transition',
	'transition.remove': 'Remove Transition',
	'transition.applyDefault': 'Apply Default Transitions',
	'tracker.add': 'Add Tracker',
	'tracker.update': 'Edit Tracker',
	'tracker.remove': 'Remove Tracker',
	'tracker.setSamples': 'Track',
	'tracker.apply': 'Apply Tracking',
	'tracker.unlink': 'Unlink Tracking',
	'keyframes.simplify': 'Simplify Keyframes',
	'clip.paste': 'Paste',
	'clip.pasteAttributes': 'Paste Attributes',
	'clip.removeAttributes': 'Remove Attributes',
	'effect.paste': 'Paste Effects',
	'keyframe.paste': 'Paste Keyframes',
	'project.pasteItems': 'Paste',
	'effect.applyPreset': 'Apply Preset',
	'shape.addItems': 'Add Shape Items',
	'shape.updateItem': 'Edit Shape Item',
	'shape.removeItems': 'Delete Shape Items',
	'shape.moveItem': 'Move Shape Item',
	'shape.duplicateItem': 'Duplicate Shape Item',
	'shape.groupItems': 'Group Shapes',
	'shape.setContents': 'Replace Shape Contents',
	'shape.convertToVector': 'Convert to Vector Shape',
	'shape.editPath': 'Edit Shape Path',
	'shape.convertToPath': 'Convert to Bezier Path',
	'font.add': 'Add Font',
	'textAnimator.add': 'Add Text Animator',
	'textAnimator.remove': 'Remove Text Animator',
	'textAnimator.update': 'Edit Text Animator',
	'textAnimator.duplicate': 'Duplicate Text Animator',
	'textAnimator.addProperty': 'Add Text Animator Property',
	'textAnimator.removeProperty': 'Remove Text Animator Property',
	'textSelector.add': 'Add Text Selector',
	'textSelector.remove': 'Remove Text Selector',
	'textSelector.update': 'Edit Text Selector',
	'textAnimator.applyPreset': 'Apply Text Animator Preset',
	'textAnimator.convertLegacy': 'Convert Text Animation to Animators',
	'text.setPathOptions': 'Text Path Options',
	'text.setPerCharacter3d': 'Per-character 3D',
	'project.importTimeline': 'Import Timeline',
	'clip.synchronize': 'Synchronize',
	'item.mergeClips': 'Merge Clips',
	'multicam.create': 'Create Multi-Camera Source Sequence',
	'multicam.switchAngle': 'Switch Multi-Camera Angle',
	'multicam.record': 'Record Multi-Camera',
	'multicam.setEnabled': 'Multi-Camera Enable',
	'multicam.flatten': 'Flatten Multi-Camera',
	'multicam.editAngles': 'Edit Cameras',
	'mixer.updateStrip': 'Audio Track Mixer',
	'mixer.addSubmix': 'Add Submix Track',
	'mixer.removeSubmix': 'Delete Submix Track',
	'mixer.addSend': 'Add Send',
	'mixer.updateSend': 'Edit Send',
	'mixer.removeSend': 'Remove Send',
	'mixer.setInsertPosition': 'Move Track Effect',
	'mixer.setLane': 'Audio Track Mixer',
	'mixer.clearLane': 'Delete Automation',
	'mixer.writeAutomation': 'Write Automation',
	'clipMixer.write': 'Write Clip Automation',
	'clipMixer.set': 'Audio Clip Mixer',
	'audio.setGain': 'Audio Gain',
	'audio.autoDuck': 'Auto Duck',
	'mixer.setLoudness': 'Loudness Normalization',
	'liquify.stroke': 'Liquify',
	'liquify.reset': 'Reset Liquify Mesh',
	'meshWarp.setVertex': 'Edit Distortion Mesh',
	'meshWarp.reset': 'Reset Distortion Mesh',
	'puppet.addMesh': 'Add Puppet Mesh',
	'puppet.updateMesh': 'Change Puppet Mesh',
	'puppet.removeMesh': 'Delete Puppet Mesh',
	'puppet.addPin': 'Add Puppet Pin',
	'puppet.removePins': 'Delete Puppet Pins',
	'puppet.renamePin': 'Rename Puppet Pin',
	'puppet.movePins': 'Move Puppet Pins',
	'puppet.setPinKeys': 'Record Puppet Pins',
	'mask.add': 'Create Mask',
	'mask.remove': 'Delete Mask',
	'mask.update': 'Change Mask',
	'mask.reorder': 'Reorder Masks',
	'mask.duplicate': 'Duplicate Mask',
	'mask.editPath': 'Edit Mask Path',
	'mask.setPathKeys': 'Track Mask',
	'caption.addTrack': 'Add Caption Track',
	'caption.setActiveTrack': 'Active Caption Track',
	'caption.add': 'Add Caption',
	'caption.import': 'Import Captions',
	'caption.setText': 'Edit Caption',
	'caption.split': 'Split Caption',
	'caption.merge': 'Merge Captions',
	'caption.delete': 'Delete Captions',
	'caption.setTimes': 'Caption Timing',
	'caption.setStyle': 'Caption Style',
	'caption.applyPreset': 'Apply Caption Style',
	'caption.savePreset': 'Save Caption Style',
	'caption.deletePreset': 'Delete Caption Style',
	'transcript.import': 'Import Transcript',
	'transcript.delete': 'Delete Transcript',
	'transcript.renameSpeaker': 'Rename Speaker',
	'transcript.setSpeaker': 'Set Speaker',
	'transcript.select': 'Mark Text Selection',
	'transcript.extract': 'Extract Text',
	'transcript.lift': 'Lift Text',
	'transcript.insertInto': 'Insert Text Selection',
	'transcript.removeFillers': 'Remove Filler Words',
	'transcript.removePauses': 'Remove Pauses',
	'transcript.createCaptions': 'Create Captions',
	'transcript.attach': 'Generate Transcript',
	'expression.set': 'Set Expression',
	'expression.clear': 'Clear Expression',
	'expression.setEnabled': 'Enable Expression',
	'effect.rename': 'Rename Effect',
	'essentialSound.setType': 'Set Audio Type',
	'essentialSound.clearType': 'Clear Audio Type',
	'essentialSound.set': 'Essential Sound',
	'essentialSound.applyPreset': 'Apply Sound Preset',
	'essentialSound.autoMatch': 'Auto-Match Loudness',
	'clip.remix': 'Remix',
	'clip.remixRevert': 'Revert Remix',
	'timeRemap.enable': 'Time Remapping',
	'timeRemap.addKeyframe': 'Add Speed Keyframe',
	'timeRemap.removeKeyframes': 'Delete Speed Keyframes',
	'timeRemap.setSpeed': 'Change Speed',
	'timeRemap.moveKeyframe': 'Move Speed Keyframe',
	'timeRemap.setTransition': 'Speed Transition',
	'timeRemap.addFreeze': 'Freeze Frame',
	'timeRemap.addReverse': 'Reverse Speed Segment',
	'clip.setTimeInterpolation': 'Time Interpolation',
	'clip.applySceneEdits': 'Scene Edit Detection',
	'roto.add': 'Roto Brush',
	'roto.update': 'Roto Settings',
	'roto.addStrokes': 'Roto Brush Stroke',
	'roto.removeStrokes': 'Remove Roto Strokes',
	'roto.setBox': 'Roto Box',
	'roto.setResult': 'Propagate Roto',
	'roto.freeze': 'Freeze Roto',
	'roto.remove': 'Remove Roto',
	'roto.apply': 'Apply Object Matte',
	'roto.faceTracker': 'Track Face',
	'clip.sourceEdit': 'Overwrite',
	'clip.trimEdits': 'Trim',
	'item.makeSubclip': 'Make Subclip',
	'item.updateSubclip': 'Edit Subclip',
	'media.interpretColor': 'Interpret Footage (Colour)',
	'clip.setColorInterpretation': 'Clip Colour Space',
	'clip.set3d': '3D Layer',
	'clip.addCamera': 'New Camera',
	'clip.addLight': 'New Light',
	'camera.settings': 'Camera Settings',
	'light.settings': 'Light Settings',
	'camera.orbit': 'Orbit Camera',
	'camera.pan': 'Pan Camera',
	'camera.dolly': 'Dolly Camera',
	'sequence.set3dRenderer': '3D Renderer',
	'cameraTracker.add': 'Track Camera',
	'cameraTracker.settings': '3D Camera Tracker Settings',
	'cameraTracker.setResult': 'Solve Camera',
	'cameraTracker.deletePoints': 'Delete Track Points',
	'cameraTracker.setGround': 'Set Ground Plane and Origin',
	'cameraTracker.create': 'Create Camera',
	'cameraTracker.remove': 'Remove 3D Camera Tracker',
	'media.interpret': 'Interpret Footage',
	'sequence.setPreviewSettings': 'Preview Settings',
	'media.attachProxy': 'Attach Proxies',
	'media.detachProxy': 'Detach Proxies',
	'clip.setAudioChannels': 'Audio Channels',
	'item.setAudioChannels': 'Audio Channels',
	'effect.setWarpAnalysis': 'Analyze (Warp Stabilizer)',
	'sequence.autoReframe': 'Auto Reframe Sequence',
	'graphic.update': 'Essential Graphics',
	'graphic.addLayer': 'New Layer',
	'graphic.align': 'Align',
	'graphic.setPins': 'Responsive Design – Position',
	'graphic.importTemplate': 'Add Graphic Template',
	'media.setLibraryInfo': 'Set Sound Library Info',
	'soundCue.add': 'Add Sound Cues',
	'soundCue.update': 'Edit Sound Cue',
	'soundCue.remove': 'Delete Sound Cues',
	'soundCue.resync': 'Resync Sound Cues',
	'soundDesign.place': 'Place Sound',
	'soundDesign.swap': 'Swap Sound',
	'soundDesign.setPalette': 'Sound Palette',
	'soundDesign.setSettings': 'Sound Design Settings',
};

const SOURCES: [HandlerMap, CommandOwner][] = [
	[projectHandlers, 'WP-00'],
	[sequenceHandlers, 'WP-00'],
	[clipCoreHandlers, 'WP-00'],
	[paramHandlers, 'WP-00'],
	[clipEditHandlers, 'WP-2B'],
	[keyframeHandlers, 'WP-2D'],
	[spatialHandlers, 'WP-2D'],
	[rovingHandlers, 'keyframes-blend'],
	[effectHandlers, 'WP-2D'],
	[transitionHandlers, 'WP-TR'],
	[processHandlers, 'wp-m2-process'],
	[compositionHandlers, 'wp-m2-mg'],
	[trackerHandlers, 'wp-m2-track'],
	[simplifyHandlers, 'wp-m3-trackui'],
	[shapeHandlers, SHAPE_OWNER],
	[clipboardHandlers, CLIPBOARD_OWNER],
	[presetHandlers, PRESET_OWNER],
	[textAnimatorHandlers, TEXT_ANIMATOR_OWNER],
	[interchangeHandlers, INTERCHANGE_OWNER],
	[multicamHandlers, 'wp-multicam'],
	[audioHandlers, AUDIO_MIX_OWNER],
	[structureHandlers, STRUCTURE_OWNER],
	[maskHandlers, 'wp-m3-masks'],
	[captionHandlers, CAPTIONS_OWNER],
	[speechHandlers, SPEECH_OWNER],
	[expressionHandlers, EXPRESSION_OWNER],
	[essentialHandlers, ESSENTIAL_OWNER],
	[timeHandlers, 'wp-time'],
	[rotoHandlers, ROTO_OWNER],
	[editUxHandlers, 'edit-ux'],
	[threeDHandlers, THREE_D_OWNER],
	[cameraTrackerHandlers, THREE_D_OWNER],
	[simWarpHandlers, SIM_WARP_OWNER],
	[colorMgmtHandlers, 'color-mgmt'],
	[interpretHandlers, INTERPRET_OWNER],
	[previewsHandlers, PREVIEWS_OWNER],
	[gapsHandlers, GAPS_OWNER],
	[soundHandlers, SOUND_DESIGN_OWNER],
];

function buildCatalog(): Record<CommandType, CatalogEntry> {
	const out = {} as Record<CommandType, CatalogEntry>;
	for (const schema of ALL_COMMAND_SCHEMAS) {
		const type = schema.shape.type.value as CommandType;
		const found = SOURCES.find(([map]) => map[type]);
		if (!found) throw new Error(`No handler registered for ${type}`);
		const [map, owner] = found;
		const handler = map[type] as Handler<CommandType>;
		out[type] = {
			type,
			schema,
			// Changing the layer box must preserve the shape's position relative to its anchor.
			handler: SHAPE_BOX_COMMANDS.has(type) ? keepShapesCentred(handler) : handler,
			label: LABELS[type],
			owner,
			milestone:
				owner.startsWith('wp-m3-') ||
				owner === TEXT_ANIMATOR_OWNER ||
				owner === INTERCHANGE_OWNER ||
				owner === STRUCTURE_OWNER ||
				owner === AUDIO_MIX_OWNER ||
				owner === 'keyframes-blend' ||
				owner === SPEECH_OWNER ||
				owner === ESSENTIAL_OWNER ||
				owner === 'wp-multicam' ||
				owner === 'wp-time' ||
				owner === ROTO_OWNER ||
				owner === 'edit-ux' ||
				owner === 'color-mgmt' ||
				owner === THREE_D_OWNER ||
				owner === INTERPRET_OWNER ||
				owner === PREVIEWS_OWNER ||
				owner === GAPS_OWNER ||
				owner === SOUND_DESIGN_OWNER
					? 'M3'
					: owner === 'M2' ||
							owner.startsWith('wp-m2-') ||
							owner === CLIPBOARD_OWNER ||
							owner === CAPTIONS_OWNER
						? 'M2'
						: 'M1',
		};
	}
	return out;
}

export const COMMAND_CATALOG: Readonly<Record<CommandType, CatalogEntry>> = buildCatalog();
export const COMMAND_TYPES = Object.keys(COMMAND_CATALOG) as CommandType[];

export function isCommandType(t: unknown): t is CommandType {
	return typeof t === 'string' && Object.hasOwn(COMMAND_CATALOG, t);
}

/** Commands an agent may only run with user approval (S01:AGT-011, ARCHITECTURE §11). */
export const APPROVAL_COMMANDS: readonly CommandType[] = [
	'item.delete',
	'sequence.delete',
	'track.remove',
	'media.removeUnused',
];

export type { Command, HandlerContext };
