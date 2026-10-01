// Top-level menubar model (S05 §12.2). Only the structure lives here; every entry is a command id owned
// by the relevant package (timeline.* WP-2B, transport/program WP-2C, inspector WP-2D, project/export
// WP-2E, mg WP-2G). There is no Agent menu: external agents connect over MCP (Help ▸ Connect an AI
// Agent…). Unregistered ids render disabled with a reason (SH-031); the label here is only the fallback
// shown until the owner registers the command (MN-001).
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
				c('project.newColorMatte', 'Color Matte…'),
			]),
			c('app.openProject', 'Open Project…'),
			c('app.closeProject', 'Close Project'),
			sep,
			c('file.save', 'Save'),
			c('app.saveAs', 'Save As…'),
			c('app.saveCopy', 'Save a Copy…'),
			c('file.revert', 'Revert'),
			sep,
			c('project.import', 'Import…'),
			// M2 (wp-m2-mg, S08:MGU-001)
			c('mg.importRemotionProject', 'Import Remotion Project…'),
			c('project.importFromMediaBrowser', 'Import from Media Browser'),
			sub('Export', [
				c('export.media', 'Media…'),
				c('export.queue', 'Add to Render Queue'),
				c('export.frame', 'Frame…'),
				c('export.quick', 'Quick Export'),
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
			c('edit.selectAll', 'Select All'),
			c('edit.deselectAll', 'Deselect All'),
			sep,
			c('edit.find', 'Find…'),
			c('edit.editOriginal', 'Edit Original'),
			sep,
			c('app.keyboardShortcuts', 'Keyboard Shortcuts…'),
			sub('Preferences', [
				c('app.preferences', 'General…'),
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
			c('timeline.speedDuration', 'Speed/Duration…'),
			c('timeline.audioGain', 'Audio Gain…'),
			c('timeline.audioChannels', 'Audio Channels…'),
			sep,
			c('timeline.toggleEnable', 'Enable'),
			c('timeline.linkUnlink', 'Link / Unlink'),
			c('timeline.group', 'Group'),
			c('timeline.ungroup', 'Ungroup'),
			c('clip.nest', 'Nest…'),
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
			c('clip.revealInProject', 'Reveal in Project'),
			c('clip.revealInTimeline', 'Reveal in Timeline'),
			sep,
			sub('Motion Graphic', [c('mg.editParameters', 'Edit Parameters…'), c('mg.rerender', 'Re-render')]),
			c('project.createProxies', 'Create Proxies'),
			c('process.processClip', 'Process Clip…'),
		],
	},
	{
		id: 'sequence',
		label: 'Sequence',
		editOnly: true,
		items: [
			c('sequence.settings', 'Sequence Settings…'),
			c('timeline.renderInToOut', 'Render Effects In to Out'),
			sep,
			c('timeline.matchFrame', 'Match Frame'),
			c('timeline.reverseMatchFrame', 'Reverse Match Frame'),
			c('timeline.addEdit', 'Add Edit'),
			c('timeline.addEditAllTracks', 'Add Edit to All Tracks'),
			c('timeline.extendEditToPlayhead', 'Extend Edit'),
			sep,
			c('timeline.lift', 'Lift'),
			c('timeline.extract', 'Extract'),
			sep,
			c('timeline.zoomIn', 'Zoom In'),
			c('timeline.zoomOut', 'Zoom Out'),
			c('timeline.zoomToSequence', 'Zoom to Sequence'),
			sep,
			c('timeline.toggleSnap', 'Snap in Timeline'),
			c('timeline.toggleLinkedSelection', 'Linked Selection'),
			sep,
			c('timeline.addTracks', 'Add Tracks…'),
			c('timeline.deleteTracks', 'Delete Tracks…'),
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
			c('program.snapInMonitor', 'Snap in Program Monitor'),
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
