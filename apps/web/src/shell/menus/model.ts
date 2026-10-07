// Top-level menubar model (S05 §12.2). Only the structure lives here; every entry is a command id owned
// by the relevant package (timeline.* WP-2B, transport/program WP-2C, inspector WP-2D, project/export
// WP-2E, mg WP-2G). There is no Agent menu: external agents connect over MCP (Help ▸ Connect an AI
// Agent…). Unregistered ids render disabled with a reason (SH-031); the label here is only the fallback
// shown until the owner registers the command (MN-001).
import { TIMELINE_FORMATS } from '../../interchange/formats.ts';
import { ANCHOR_POINTS, ARRANGE_COMMANDS, ARRANGE_LABELS } from '../../panels/program/layer-ops.ts';
import type { ShellMenuItem } from './resolve.ts';

const c = (command: string, label: string, args?: unknown): ShellMenuItem => ({
	type: 'command',
	command,
	label,
	args,
});
const sub = (label: string, items: ShellMenuItem[]): ShellMenuItem => ({ type: 'submenu', label, items });
const sep: ShellMenuItem = { type: 'separator' };

/** Anchor ▸ (S03:XF-038): Center, then the 9-point grid (same entries as the Program monitor layer menu). */
const ANCHOR_MENU: ShellMenuItem[] = ANCHOR_POINTS.map((p) => c('motion.anchor', p.label, { point: p.id }));
/** Arrange ▸ (S03:XF-050). */
const ARRANGE_MENU: ShellMenuItem[] = ARRANGE_COMMANDS.map(([id, op]) => c(id, ARRANGE_LABELS[op]));

export type MenubarMenuModel = {
	id: string;
	label: string;
	items: ShellMenuItem[] /** Editing-only menus (MN-010). */;
	editOnly?: boolean;
};

export const MENUBAR: readonly MenubarMenuModel[] = [
	{
		id: 'file',
		label: 'File',
		items: [
			sub('New', [
				c('app.newProject', 'Project…'),
				c('app.newSequence', 'Sequence…'),
				c('project.newBin', 'Bin'),
				c('graphics.newTextLayer', 'Text Layer'),
				c('mg.insertTemplate', 'fframes Motion Graphic…'),
				// edit-structure: Premiere's New Item synthetics.
				c('project.newAdjustmentLayer', 'Adjustment Layer'),
				c('project.newBarsAndTone', 'Bars and Tone'),
				c('project.newBlackVideo', 'Black Video'),
				c('project.newColorMatte', 'Color Matte…'),
				c('project.newTransparentVideo', 'Transparent Video'),
				c('project.newCountingLeader', 'Universal Counting Leader…'),
				// three-d (After Effects: Layer ▸ New ▸ Camera / Light)
				c('threeD.newCamera', 'Camera…'),
				c('threeD.newLight', 'Light…'),
			]),
			c('app.openProject', 'Open Project…'),
			c('app.closeProject', 'Close Project'),
			sep,
			c('file.save', 'Save'),
			c('app.saveAs', 'Save As…'),
			c('app.saveCopy', 'Save a Copy…'),
			c('file.revert', 'Revert'),
			c('file.projectVersions', 'Project Versions…'),
			c('file.recoverUnsaved', 'Recover Unsaved Changes…'),
			sep,
			c('project.import', 'Import…'),
			// M2 (wp-m2-mg, S08:MGU-001)
			c('mg.importRemotionProject', 'Import Remotion Project…'),
			c('project.importFromMediaBrowser', 'Import from Media Browser'),
			// wp captions
			c('captions.import', 'Import Captions…'),
			// imports workstream: an SVG as an editable vector shape layer
			c('project.importSvgAsShape', 'Import SVG as Shape Layer…'),
			// wp interchange (S04:AS-011)
			c('project.linkMedia', 'Link Media…'),
			sub('Export', [
				c('export.media', 'Media…'),
				c('export.queue', 'Add to Render Queue'),
				c('export.frame', 'Frame…'),
				c('export.quick', 'Quick Export'),
				// imports workstream
				c('export.lottie', 'Lottie…'),
				// wp interchange: timeline documents (Premiere's File ▸ Export entries, plus FCPXML, OTIO and ALE)
				sep,
				...TIMELINE_FORMATS.map((f) => c('file.exportTimeline', f.label, { format: f.id })),
				sep,
				// wp captions: the active caption track as a file
				sub('Captions', [
					c('captions.export', 'SubRip (.srt)', { format: 'srt' }),
					c('captions.export', 'WebVTT (.vtt)', { format: 'vtt' }),
					c('captions.export', 'Scenarist SCC (.scc)', { format: 'scc' }),
					c('captions.export', 'MacCaption MCC (.mcc)', { format: 'mcc' }),
					c('captions.export', 'EBU STL (.stl)', { format: 'stl' }),
					c('captions.export', 'TTML / IMSC1 (.ttml)', { format: 'ttml' }),
					c('captions.export', 'DFXP (.dfxp)', { format: 'dfxp' }),
				]),
			]),
			sep,
			c('project.settings', 'Project Settings…'),
			sub('Engine', [c('engine.connect', 'Connect…'), c('engine.status', 'Engine Status')]),
			sep,
			c('app.goHome', 'Go to Home'),
			c('app.quit', 'Exit'),
		],
	},
	{
		id: 'edit',
		label: 'Edit',
		items: [
			c('history.undo', 'Undo'),
			c('history.redo', 'Redo'),
			sep,
			c('edit.cut', 'Cut'),
			c('edit.copy', 'Copy'),
			c('edit.paste', 'Paste'),
			c('edit.pasteInsert', 'Paste Insert'),
			c('edit.pasteAttributes', 'Paste Attributes…'),
			c('edit.removeAttributes', 'Remove Attributes…'),
			c('edit.clear', 'Clear'),
			c('edit.rippleDelete', 'Ripple Delete'),
			c('edit.duplicate', 'Duplicate'),
			c('edit.removeUnused', 'Remove Unused'),
			c('edit.selectAll', 'Select All'),
			c('edit.deselectAll', 'Deselect All'),
			sep,
			c('edit.find', 'Find…'),
			c('edit.editOriginal', 'Edit Original'),
			sep,
			c('app.keyboardShortcuts', 'Keyboard Shortcuts…'),
			sub('Preferences', [
				c('app.preferences', 'General…'),
				// wp-m3-transdefaults (S10:TUI-031): default transitions and durations.
				c('app.preferences', 'Timeline…', { page: 'timeline' }),
				c('cache.preferences', 'Media Cache…'),
				// wp speech (Premiere: Preferences ▸ Transcription)
				c('speech.preferences', 'Transcription…'),
				sub('Appearance', [
					c('view.theme.darkest', 'Darkest'),
					c('view.theme.dark', 'Dark'),
					sep,
					c('view.contrast.high', 'High Contrast'),
				]),
			]),
		],
	},
	{
		id: 'clip',
		label: 'Clip',
		editOnly: true,
		items: [
			c('timeline.rename', 'Rename…'),
			// edit-ux (Premiere: Clip ▸ Make Subclip… / Edit Subclip…)
			c('project.makeSubclip', 'Make Subclip…'),
			c('project.editSubclip', 'Edit Subclip…'),
			c('timeline.speedDuration', 'Speed/Duration…'),
			c('timeline.audioGain', 'Audio Gain…'),
			c('timeline.audioChannels', 'Audio Channels…'),
			// imports workstream (Premiere: Clip ▸ Modify ▸ Interpret Footage…)
			sub('Modify', [c('media.interpretFootage', 'Interpret Footage…')]),
			// audio-mix
			sub('Audio Options', [
				c('audio.autoDuck', 'Auto Duck…'),
				c('audio.normalizeMedia', 'Normalize Loudness…'),
				c('audio.measureLoudness', 'Measure Loudness'),
				// audio-fx
				sep,
				c('audio.remix', 'Remix…'),
				c('audio.revertRemix', 'Revert Remix'),
				c('audio.autoMatchLoudness', 'Auto-Match Loudness'),
				c('audio.clearAudioType', 'Clear Audio Type'),
			]),
			sep,
			c('timeline.toggleEnable', 'Enable'),
			c('timeline.linkUnlink', 'Link / Unlink'),
			c('timeline.group', 'Group'),
			c('timeline.ungroup', 'Ungroup'),
			c('clip.nest', 'Nest…'),
			c('clip.unnest', 'Unnest'),
			// wp-multicam (Premiere: Clip ▸ Synchronize…, Merge Clips…, Create Multi-Camera Source Sequence…, Multi-Camera ▸)
			c('clip.synchronize', 'Synchronize…'),
			c('clip.mergeClips', 'Merge Clips…'),
			c('clip.createMulticam', 'Create Multi-Camera Source Sequence…'),
			sub('Multi-Camera', [
				c('multicam.enable', 'Enable'),
				c('multicam.flatten', 'Flatten'),
				sep,
				c('multicam.editCameras', 'Edit Cameras…'),
				c('multicam.audioFollowsVideo', 'Multi-Camera Audio Follows Video'),
				c('multicam.selectionTopDown', 'Multi-Camera Selection Top Down'),
			]),
			// edit-structure (Premiere: Clip ▸ Video Options).
			// three-d (After Effects: the 3D Layer switch, Camera / Light Settings)
			c('threeD.toggleLayer', '3D Layer'),
			c('threeD.cameraSettings', 'Camera Settings…'),
			c('threeD.lightSettings', 'Light Settings…'),
			c('threeD.trackCamera', 'Track Camera'),
			sub('Video Options', [
				c('timeline.frameHoldOptions', 'Frame Hold Options…'),
				c('timeline.addFrameHold', 'Add Frame Hold'),
				c('timeline.insertFrameHoldSegment', 'Insert Frame Hold Segment'),
				// Workstream `time` (Premiere: Clip ▸ Video Options ▸ Time Interpolation).
				sub('Time Interpolation', [
					c('timeline.timeInterpolation.frameSampling', 'Frame Sampling'),
					c('timeline.timeInterpolation.frameBlending', 'Frame Blending'),
					c('timeline.timeInterpolation.opticalFlow', 'Optical Flow'),
				]),
			]),
			// Workstream `time`: Time Remapping (the speed band) and Scene Edit Detection.
			sub('Show Clip Keyframes', [sub('Time Remapping', [c('timeline.showSpeedKeyframes', 'Speed')])]),
			c('timeline.toggleSpeedKeyframe', 'Add / Remove Speed Keyframe'),
			c('timeline.removeTimeRemapping', 'Remove Time Remapping'),
			c('timeline.sceneEditDetection', 'Scene Edit Detection…'),
			sep,
			// wp-clipboard-2 (S03:XF-050/051/038): the Program monitor layer menu's transform entries.
			sub('Transform', [
				c('motion.reset', 'Reset Motion'),
				c('motion.resetCrop', 'Reset Crop'),
				sep,
				c('motion.fit', 'Fit to Frame'),
				c('motion.fill', 'Fill Frame'),
				c('motion.native', 'Set to Native (100%)'),
				sep,
				sub('Anchor', ANCHOR_MENU),
			]),
			// wp-m3-trackui (S09:TRK-023)
			c('keyframes.simplify', 'Simplify Keyframes…'),
			c('clip.revealInProject', 'Reveal in Project'),
			c('clip.revealInTimeline', 'Reveal in Timeline'),
			sep,
			sub('Motion Graphic', [c('mg.editParameters', 'Edit Parameters…'), c('mg.rerender', 'Re-render')]),
			c('project.createProxies', 'Create Proxies'),
			c('process.processClip', 'Process Clip…'),
			// wp speech: the selected clips' media
			c('transcript.generateForClips', 'Generate Transcript…'),
			// wp-m3-inpoint (S07:PRC-018): Replace Footage… for the selected Project item / clip's media.
			c('media.replaceFootage', 'Replace Footage…'),
		],
	},
	{
		id: 'sequence',
		label: 'Sequence',
		editOnly: true,
		items: [
			c('sequence.settings', 'Sequence Settings…'),
			// previews (Premiere's Sequence menu): render previews and their files
			c('timeline.renderInToOut', 'Render Effects In to Out'),
			c('timeline.renderAllInToOut', 'Render In to Out'),
			c('timeline.renderSelection', 'Render Selection'),
			c('timeline.renderAudio', 'Render Audio'),
			c('timeline.deleteRenderFiles', 'Delete Render Files'),
			c('timeline.deleteRenderFilesInToOut', 'Delete Render Files In to Out'),
			c('sequence.previewSettings', 'Video Previews…'),
			sep,
			c('timeline.matchFrame', 'Match Frame'),
			c('timeline.reverseMatchFrame', 'Reverse Match Frame'),
			c('timeline.revealNested', 'Reveal Nested Sequence'),
			c('timeline.addEdit', 'Add Edit'),
			c('timeline.addEditAllTracks', 'Add Edit to All Tracks'),
			c('timeline.extendEditToPlayhead', 'Extend Edit'),
			// edit-ux trim mode (Premiere: Sequence ▸ Trim Edit, Select Nearest Edit Point ▸, Toggle Trim Type)
			c('timeline.trimEdit', 'Trim Edit'),
			sub('Select Nearest Edit Point', [
				c('timeline.selectNearestEditRippleIn', 'As Ripple In'),
				c('timeline.selectNearestEditRippleOut', 'As Ripple Out'),
				c('timeline.selectNearestEditRoll', 'As Roll'),
				c('timeline.selectNearestEditTrimIn', 'As Trim In'),
				c('timeline.selectNearestEditTrimOut', 'As Trim Out'),
			]),
			c('timeline.toggleTrimType', 'Toggle Trim Type'),
			c('timeline.playAroundEdit', 'Play Around the Edit'),
			// wp-m3-transdefaults (S05 §12.2 Sequence menu, S10:TUI-030/031)
			c('timeline.applyDefaultVideoTransition', 'Apply Video Transition'),
			c('timeline.applyDefaultAudioTransition', 'Apply Audio Transition'),
			c('timeline.applyDefaultTransitionsToSelection', 'Apply Default Transitions to Selection'),
			c('sequence.transitionDefaults', 'Transition Defaults…'),
			sep,
			c('timeline.lift', 'Lift'),
			c('timeline.extract', 'Extract'),
			sep,
			sub('Go to Gap', [
				c('sequence.goToNextGap', 'Next in Sequence'),
				c('sequence.goToPrevGap', 'Previous in Sequence'),
				c('sequence.goToNextGapInTrack', 'Next in Track'),
				c('sequence.goToPrevGapInTrack', 'Previous in Track'),
			]),
			c('sequence.makeSubsequence', 'Make Subsequence'),
			sep,
			// audio-mix
			c('sequence.loudness', 'Loudness Normalization…'),
			c('audio.voiceoverRecord', 'Record Voice-over'),
			c('audio.voiceoverSettings', 'Voice-Over Record Settings…'),
			// wp captions (FilmCraft / Premiere Sequence ▸ Captions)
			sub('Captions', [
				c('timeline.addCaptionTrack', 'Add New Caption Track'),
				c('timeline.addCaptionAtPlayhead', 'Add Caption at Playhead'),
				c('timeline.nextCaptionSegment', 'Go to Next Caption Segment'),
				c('timeline.prevCaptionSegment', 'Go to Previous Caption Segment'),
				sep,
				c('captions.split', 'Split Caption'),
				c('captions.merge', 'Merge Captions'),
				sep,
				c('captions.showAll', 'Show All Caption Tracks'),
				c('captions.hideAll', 'Hide All Caption Tracks'),
				sep,
				c('transcript.openPanel', 'Transcript'),
				// wp speech
				c('transcript.generate', 'Generate Transcript…'),
				c('transcript.createCaptions', 'Create Captions from Transcript…'),
				c('transcript.removeFillers', 'Remove Filler Words…'),
				c('transcript.removePauses', 'Remove Pauses…'),
			]),
			sep,
			c('timeline.zoomIn', 'Zoom In'),
			c('timeline.zoomOut', 'Zoom Out'),
			c('timeline.zoomToSequence', 'Zoom to Sequence'),
			sep,
			c('timeline.toggleSnap', 'Snap in Timeline'),
			c('timeline.toggleLinkedSelection', 'Linked Selection'),
			c('sequence.showThroughEdits', 'Show Through Edits'),
			c('timeline.toggleNestInsert', 'Insert and Overwrite Sequences as Nests'),
			sep,
			c('timeline.addTracks', 'Add Tracks…'),
			c('timeline.deleteTracks', 'Delete Tracks…'),
			sep,
			// three-d (After Effects: Composition Settings ▸ 3D Renderer, Draft 3D)
			sub('3D Renderer', [
				c('threeD.renderer.classic', 'Classic 3D'),
				c('threeD.renderer.advanced', 'Advanced 3D'),
				sep,
				c('threeD.draft', 'Draft 3D'),
			]),
		],
	},
	{
		id: 'markers',
		label: 'Markers',
		editOnly: true,
		items: [
			c('timeline.markIn', 'Mark In'),
			c('timeline.markOut', 'Mark Out'),
			c('timeline.markClip', 'Mark Clip'),
			c('timeline.markSelection', 'Mark Selection'),
			sep,
			// edit-ux (Premiere: Markers ▸ Mark Split, Source monitor)
			sub('Mark Split', [
				c('source.markSplitVideoIn', 'Video In'),
				c('source.markSplitVideoOut', 'Video Out'),
				c('source.markSplitAudioIn', 'Audio In'),
				c('source.markSplitAudioOut', 'Audio Out'),
				sep,
				c('source.clearSplitMarks', 'Clear Split Marks'),
			]),
			sep,
			c('timeline.goToIn', 'Go to In'),
			c('timeline.goToOut', 'Go to Out'),
			sep,
			c('timeline.clearIn', 'Clear In'),
			c('timeline.clearOut', 'Clear Out'),
			c('timeline.clearInOut', 'Clear In and Out'),
			sep,
			c('timeline.addMarker', 'Add Marker'),
			c('timeline.nextMarker', 'Go to Next Marker'),
			c('timeline.prevMarker', 'Go to Previous Marker'),
			c('timeline.clearMarker', 'Clear Selected Marker'),
			c('timeline.clearAllMarkers', 'Clear All Markers'),
		],
	},
	{
		id: 'graphics',
		label: 'Graphics',
		editOnly: true,
		items: [
			sub('New Layer', [
				c('graphics.newTextLayer', 'Text'),
				c('graphics.newRectangle', 'Rectangle'),
				c('graphics.newEllipse', 'Ellipse'),
				c('threeD.newCamera', 'Camera…'),
				c('threeD.newLight', 'Light…'),
			]),
			c('mg.insertTemplate', 'Insert Motion Template…'),
			// wp-clipboard-2 (S05 Graphics and Titles ▸ Arrange, S03:XF-050)
			sub('Arrange', ARRANGE_MENU),
			// M2 (wp-m2-text-anim, S11:TXA-024)
			sub('Text Animation', [
				c('text.applyAnimation', 'Apply In…', { side: 'in' }),
				c('text.applyAnimation', 'Apply Out…', { side: 'out' }),
				c('text.removeAnimation', 'Remove', { side: 'both' }),
			]),
		],
	},
	{
		id: 'view',
		label: 'View',
		items: [
			c('program.showRulers', 'Show Rulers'),
			c('program.showGuides', 'Show Guides'),
			c('program.lockGuides', 'Lock Guides'),
			c('program.addGuide', 'Add Guide…'),
			c('program.clearGuides', 'Clear Guides'),
			// edit-ux (Premiere View ▸ Guide Templates)
			sub('Guide Templates', [
				c('program.saveGuidesAsTemplate', 'Save Guides as Template…'),
				c('program.manageGuides', 'Manage Guides…'),
			]),
			c('program.snapInMonitor', 'Snap in Program Monitor'),
			sep,
			// three-d (After Effects: View ▸ Switch 3D View)
			sub('Switch 3D View', [
				c('threeD.view.activeCamera', 'Active Camera'),
				c('threeD.view.default', 'Default'),
				sep,
				c('threeD.view.front', 'Front'),
				c('threeD.view.left', 'Left'),
				c('threeD.view.top', 'Top'),
				c('threeD.view.back', 'Back'),
				c('threeD.view.right', 'Right'),
				c('threeD.view.bottom', 'Bottom'),
				sep,
				c('threeD.view.custom1', 'Custom View 1'),
				c('threeD.view.custom2', 'Custom View 2'),
				c('threeD.view.custom3', 'Custom View 3'),
			]),
			c('threeD.view.last', 'Switch to Last 3D View'),
			c('threeD.view.reset', 'Reset 3D View'),
			c('threeD.cameraFromView', 'Create Camera from 3D View'),
			sep,
			c('program.toggleComparisonView', 'Comparison View'),
			c('program.toggleDroppedFrames', 'Show Dropped Frame Indicator'),
			c('monitor.fullScreenVideo', 'Toggle Full Screen Video'),
			sep,
			sub('Theme', [
				c('view.theme.darkest', 'Darkest'),
				c('view.theme.dark', 'Dark'),
				sep,
				c('view.contrast.high', 'High Contrast'),
			]),
			sub('Density', [c('view.density.touch', 'Touch Density')]),
			sub('Layout', [
				c('view.layout.auto', 'Automatic'),
				c('view.layout.desktop', 'Desktop'),
				c('view.layout.compact', 'Compact'),
			]),
			c('view.tooltips', 'Show Tooltips'),
			// audio-mix (Premiere: Toggle Audio During Scrubbing, Shift+S)
			c('transport.toggleAudioScrub', 'Audio Scrubbing'),
			sep,
			c('view.fullscreen', 'Full Screen'),
		],
	},
	{
		id: 'window',
		label: 'Window',
		items: [
			sub('Workspaces', [
				{ type: 'dynamic', provider: 'workspaces' },
				sep,
				c('workspace.reset', 'Reset to Saved Layout'),
				c('workspace.save', 'Save Changes to This Workspace'),
				c('workspace.saveAs', 'Save as New Workspace…'),
				c('workspace.edit', 'Edit Workspaces…'),
				sep,
				c('workspace.import', 'Import Workspace…'),
				c('workspace.export', 'Export Workspace…'),
			]),
			c('palette.findPanel', 'Find Panel…'),
			sep,
			{ type: 'dynamic', provider: 'panels' },
			sep,
			c('panel.maximize', 'Maximize Frame'),
			c('window.resetAllPanels', 'Reset All Panels'),
		],
	},
	{
		id: 'help',
		label: 'Help',
		items: [
			c('app.shortcutReference', 'Keyboard Shortcut Reference'),
			c('palette.open', 'Command Palette'),
			sep,
			c('help.connectAgent', 'Connect an AI Agent…'),
			sep,
			c('app.notices', 'Third-Party Notices'),
			c('app.about', 'About JasperEditor'),
		],
	},
];

/** The Workspaces menu in the header (WS-010): same entries as Window ▸ Workspaces. */
export const WORKSPACES_MENU: ShellMenuItem[] = (() => {
	const first = MENUBAR.find((m) => m.id === 'window')?.items[0];
	return first?.type === 'submenu' ? first.items : [];
})();
