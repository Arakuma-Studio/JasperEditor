import type { z } from 'zod';
import type { HandlerContext } from './context.ts';
import { AUDIO_MIX_OWNER, audioHandlers } from './handlers/audio.ts';
import { BATCH_OWNER, batchHandlers } from './handlers/batch.ts';
import { BRIEF_OWNER, briefHandlers } from './handlers/brief.ts';
import { cameraTrackerHandlers } from './handlers/camtrack.ts';
import { CAPTIONS_OWNER, captionHandlers } from './handlers/captions.ts';
import { CLEANUP_OWNER, cleanupHandlers } from './handlers/cleanup.ts';
import { clipCoreHandlers } from './handlers/clip-core.ts';
import { clipEditHandlers } from './handlers/clip-edit.ts';
import { CLIPBOARD_OWNER, clipboardHandlers } from './handlers/clipboard.ts';
import { colorMgmtHandlers } from './handlers/color-mgmt.ts';
import { compositionHandlers } from './handlers/composition.ts';
import { EASE_OWNER, easeHandlers } from './handlers/ease.ts';
import { editUxHandlers } from './handlers/edit-ux.ts';
import { effectHandlers } from './handlers/effect.ts';
import { ESSENTIAL_OWNER, essentialHandlers } from './handlers/essential.ts';
import { EXPRESSION_OWNER, expressionHandlers } from './handlers/expression.ts';
import { GAPS_OWNER, gapsHandlers } from './handlers/gaps.ts';
import { imageSplitHandlers } from './handlers/image-split.ts';
import { INTERCHANGE_OWNER, interchangeHandlers } from './handlers/interchange.ts';
import { INTERPRET_OWNER, interpretHandlers } from './handlers/interpret.ts';
import { keyframeHandlers } from './handlers/keyframe.ts';
import { maskHandlers } from './handlers/mask.ts';
import { mgAnotherHandlers } from './handlers/mg-another.ts';
import { multicamHandlers } from './handlers/multicam.ts';
import { paramHandlers } from './handlers/param.ts';
import { PRESET_OWNER, presetHandlers } from './handlers/preset.ts';
import { PREVIEWS_OWNER, previewsHandlers } from './handlers/previews.ts';
import { processHandlers } from './handlers/process.ts';
import { projectHandlers } from './handlers/project.ts';
import { ROTO_OWNER, rotoHandlers } from './handlers/roto.ts';
import { rovingHandlers } from './handlers/roving.ts';
import { SCENE_OWNER, sceneHandlers } from './handlers/scene.ts';
import { SCRIPT_FIX_OWNER, scriptFixHandlers } from './handlers/script-fix.ts';
import { sequenceHandlers } from './handlers/sequence.ts';
import { keepShapesCentred, SHAPE_BOX_COMMANDS, SHAPE_OWNER, shapeHandlers } from './handlers/shape.ts';
import { shapeTracerHandlers } from './handlers/shape-tracer.ts';
import { shapeTrimHandlers } from './handlers/shape-trim.ts';
import { SIM_WARP_OWNER, simWarpHandlers } from './handlers/sim-warp.ts';
import { simplifyHandlers } from './handlers/simplify.ts';
import { SOUND_DESIGN_OWNER, soundHandlers } from './handlers/sound.ts';
import { soundBedHandlers } from './handlers/sound-beds.ts';
import { soundMixHandlers } from './handlers/sound-mix.ts';
import { spatialHandlers } from './handlers/spatial.ts';
import { SPEECH_OWNER, speechHandlers } from './handlers/speech.ts';
import { STRUCTURE_OWNER, structureHandlers } from './handlers/structure.ts';
import { STYLE_RECIPES_OWNER, styleRecipeHandlers } from './handlers/style-recipes.ts';
import { SUBTITLES_OWNER, subtitleHandlers } from './handlers/subtitles.ts';
import { TEXT_ANIMATOR_OWNER, textAnimatorHandlers } from './handlers/text-animators.ts';
import { TEXT_STYLE_OWNER, textStyleHandlers } from './handlers/text-style.ts';
import { THREE_D_OWNER, threeDHandlers } from './handlers/three-d.ts';
import { timeHandlers } from './handlers/time.ts';
import { TITLE_LOOK_OWNER, titleLookHandlers } from './handlers/title-look.ts';
import { titleTemplateHandlers } from './handlers/title-template.ts';
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
	| 'keyframe-ease'
	| 'sound-design'
	| 'text-styles'
	| 'title-looks'
	| 'subtitles'
	| 'edit-automation'
	| 'transcript-cleanup'
	| 'style-recipes'
	| 'script-correction'
	| 'agent-brief'
	| 'scene-file';

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
	'clip.duplicateMotionGraphic': 'Add Another',
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
	'range.insertTime': 'Insert Time',
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
	'shape.animateTrim': 'Animate Trim Paths',
	'shape.reversePathDirection': 'Reverse Path Direction',
	'shape.addLine': 'New Line',
	'shape.addTrimTracer': 'Add Trim Tracer',
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
	'text.relayout': 'Measure Text',
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
	'audio.smoothJoins': 'Smooth Audio Joins',
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
	'essentialSound.autoTag': 'Auto Tag Audio Types',
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
	'threeD.setSurface': '3D Material',
	'threeD.setGeometry': '3D Geometry',
	'threeD.addBand': 'Add Bevel Band',
	'threeD.removeBand': 'Remove Bevel Band',
	'threeD.reorderBand': 'Reorder Bevel Band',
	'threeD.addBackplate': 'Add Backplate',
	'threeD.removeBackplate': 'Remove Backplate',
	'threeD.reorderBackplate': 'Reorder Backplate',
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
	'keyframe.applyEase': 'Apply Ease',
	'keyframe.pasteEase': 'Paste Ease',
	'keyframe.pasteValues': 'Paste Keyframe Values',
	'keyframe.setVelocity': 'Keyframe Velocity',
	'keyframe.createPathController': 'Create Path Controller',
	'keyframes.cleanupPath': 'Clean Up Motion Path',
	'media.setLibraryInfo': 'Set Sound Library Info',
	'media.upgradeLibraryCopy': 'Update Sound Copy',
	'soundCue.add': 'Add Sound Cues',
	'soundCue.update': 'Edit Sound Cue',
	'soundCue.remove': 'Delete Sound Cues',
	'soundCue.resync': 'Resync Sound Cues',
	'soundDesign.place': 'Place Sound',
	'soundDesign.swap': 'Swap Sound',
	'soundDesign.setRole': 'Sound Role',
	'soundDesign.setPalette': 'Sound Palette',
	'soundDesign.setSettings': 'Sound Design Settings',
	'soundDesign.setPeak': 'Set Peak',
	'soundDesign.applyGains': 'Rebalance SFX Levels',
	'soundDesign.setAutoGain': 'Auto Gain',
	'soundDesign.setCheck': 'Sound Check Result',
	'soundDesign.setVerdict': 'Sound Check Verdict',
	'soundDesign.expectMix': 'Check Mix Unchanged',
	'soundDesign.acknowledgeIssue': 'Acknowledge Sound Check Finding',
	'soundDesign.unacknowledgeIssue': 'Unacknowledge Sound Check Finding',
	'audio.volumeDip': 'Volume Dip',
	'soundDesign.applyStopBefore': 'Stop Before Cue',
	'soundDesign.applyBuild': 'Build Into Cue',
	'soundDesign.ensureBus': 'SFX Room Glue',
	'soundDesign.removeBus': 'Remove SFX Room Glue',
	'soundDesign.applyDelivery': 'Apply Delivery Preset',
	'soundDesign.layBed': 'Lay Ambience Bed',
	// spec 13 SH-003 / AS-032: batch styling and linked text styles.
	'text.setStyle': 'Text Style',
	'effect.setParamMany': 'Effect Parameter',
	'effect.addMany': 'Apply Effect',
	'effect.removeMany': 'Remove Effect',
	'textStyle.create': 'New Text Style',
	'textStyle.update': 'Update Text Style',
	'textStyle.rename': 'Rename Text Style',
	'textStyle.delete': 'Delete Text Style',
	'textStyle.apply': 'Apply Text Style',
	'textStyle.detach': 'Detach From Text Style',
	'textStyle.reset': 'Reset to Text Style',
	// spec 19 TL-018: Title Looks.
	'look.apply': 'Apply Look',
	'look.remove': 'Remove Look',
	'look.detach': 'Detach From Look',
	'look.reset': 'Reset to Look',
	'look.setColorway': 'Change Colourway',
	'look.create': 'New Look',
	'look.update': 'Update Look',
	'look.rename': 'Rename Look',
	'look.delete': 'Delete Look',
	'appearance.addLayer': 'Add Layer',
	'appearance.removeLayer': 'Remove Layer',
	'appearance.reorderLayer': 'Reorder Layers',
	'appearance.setLayerEnabled': 'Show or Hide Layer',
	'appearance.setLayerFixedColor': 'Fix Layer Colour',
	'appearance.setPaint': 'Change Paint',
	'appearance.setLightSource': 'Change Light Source',
	'appearance.setGradient': 'Change Gradient',
	'sequence.setGlobalLight': 'Global Light',
	'clip.addGenerator': 'Add Generator',
	'title.insertTemplate': 'Insert Title Template',
	'clip.splitImage': 'Split Image',
	// spec 13 AS-001…AS-020: automatic subtitles and subtitle templates.
	'captions.generate': 'Create Subtitles',
	'captions.regenerate': 'Regenerate Subtitles',
	'captions.lock': 'Lock Subtitles',
	'captions.alignToCuts': 'Align Subtitles to Cuts',
	'captions.convert': 'Convert Subtitles',
	'captions.updateGroup': 'Subtitle Group Settings',
	'captions.deleteGroup': 'Delete Subtitle Group',
	'subtitleTemplate.save': 'Save as Template',
	'subtitleTemplate.add': 'Add Subtitle Template',
	'subtitleTemplate.delete': 'Delete Subtitle Template',
	'subtitleTemplate.apply': 'Apply Subtitle Template',
	'clip.addAdjustmentBatch': 'New Adjustment Layers',
	'keyframe.addBatch': 'Add Keyframes',
	'cleanup.apply': 'Clean Up Voice',
	'cleanup.configure': 'Clean Up Settings',
	'styleRecipe.add': 'Add Style Recipe',
	'styleRecipe.remove': 'Remove Style Recipe',
	'styleRecipe.setActive': 'Set Active Style Recipe',
	'transcript.replaceWords': 'Fix Transcript Words',
	'scriptFix.configure': 'Fix Transcript Settings',
	// spec 18 AF-BRF: the sequence brief and agent notes.
	'sequence.setBrief': 'Edit Brief',
	'project.addAgentNote': 'Add Agent Note',
	'project.removeAgentNote': 'Remove Agent Note',
	// scene files: the clips `jasper apply` made for a scene's layers.
	'scene.bind': 'Bind Scene Layers',
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
	[mgAnotherHandlers, 'wp-m2-mg'],
	[trackerHandlers, 'wp-m2-track'],
	[simplifyHandlers, 'wp-m3-trackui'],
	[shapeHandlers, SHAPE_OWNER],
	[shapeTrimHandlers, SHAPE_OWNER],
	[shapeTracerHandlers, SHAPE_OWNER],
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
	[easeHandlers, EASE_OWNER],
	[soundHandlers, SOUND_DESIGN_OWNER],
	[soundMixHandlers, SOUND_DESIGN_OWNER],
	[soundBedHandlers, SOUND_DESIGN_OWNER],
	[textStyleHandlers, TEXT_STYLE_OWNER],
	[titleLookHandlers, TITLE_LOOK_OWNER],
	[titleTemplateHandlers, TITLE_LOOK_OWNER],
	[imageSplitHandlers, TITLE_LOOK_OWNER],
	[subtitleHandlers, SUBTITLES_OWNER],
	[batchHandlers, BATCH_OWNER],
	[cleanupHandlers, CLEANUP_OWNER],
	[styleRecipeHandlers, STYLE_RECIPES_OWNER],
	[scriptFixHandlers, SCRIPT_FIX_OWNER],
	[briefHandlers, BRIEF_OWNER],
	[sceneHandlers, SCENE_OWNER],
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
				owner === EASE_OWNER ||
				owner === SOUND_DESIGN_OWNER ||
				owner === TEXT_STYLE_OWNER ||
				owner === TITLE_LOOK_OWNER ||
				owner === SUBTITLES_OWNER ||
				owner === BATCH_OWNER ||
				owner === CLEANUP_OWNER ||
				owner === STYLE_RECIPES_OWNER ||
				owner === SCRIPT_FIX_OWNER ||
				owner === BRIEF_OWNER ||
				owner === SCENE_OWNER
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
	// spec 18 AF-BRF-002: agent notes are removed by the user (Sequence ▸ Brief…); an agent needs approval.
	'project.removeAgentNote',
];

export type { Command, HandlerContext };
