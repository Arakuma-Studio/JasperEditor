// The single registration point for document commands: type → schema, handler, label, owner.
import type { z } from 'zod';
import type { HandlerContext } from './context.ts';
import { clipCoreHandlers } from './handlers/clip-core.ts';
import { clipEditHandlers } from './handlers/clip-edit.ts';
import { compositionHandlers } from './handlers/composition.ts';
import { effectHandlers } from './handlers/effect.ts';
import { keyframeHandlers } from './handlers/keyframe.ts';
import { m2Handlers } from './handlers/m2.ts';
import { MG_TEMPLATE_OWNER } from './handlers/mg-template.ts';
import { paramHandlers } from './handlers/param.ts';
import { processHandlers } from './handlers/process.ts';
import { projectHandlers } from './handlers/project.ts';
import { sequenceHandlers } from './handlers/sequence.ts';
import { SHAPE_OWNER, shapeHandlers } from './handlers/shape.ts';
import { TEXT_ANIMATION_OWNER } from './handlers/text-animation.ts';
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
	// M2 animation (ARCHITECTURE §20, S11 §10)
	| 'wp-m2-text-anim'
	| 'wp-m2-anime-templates'
	| 'wp-m2-shapes';

export type CatalogEntry = {
	type: CommandType;
	schema: z.ZodType;
	handler: Handler<CommandType>;
	/** Default History label (the transaction label wins; S01:UND-002). */
	label: string;
	owner: CommandOwner;
	milestone: 'M1' | 'M2';
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
	'media.register': 'Import',
	'media.relink': 'Link Media',
	'media.derive': 'Process Media',
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
	'param.set': 'Change Value',
	'param.setAnimated': 'Toggle Animation',
	'keyframe.add': 'Add Keyframe',
	'keyframe.update': 'Edit Keyframe',
	'keyframe.remove': 'Delete Keyframes',
	'keyframe.move': 'Move Keyframes',
	'keyframe.setInterpolation': 'Keyframe Interpolation',
	'keyframes.prune': 'Prune Keyframes',
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
};

const SOURCES: [HandlerMap, CommandOwner][] = [
	[projectHandlers, 'WP-00'],
	[sequenceHandlers, 'WP-00'],
	[clipCoreHandlers, 'WP-00'],
	[paramHandlers, 'WP-00'],
	[clipEditHandlers, 'WP-2B'],
	[keyframeHandlers, 'WP-2D'],
	[effectHandlers, 'WP-2D'],
	[transitionHandlers, 'WP-TR'],
	[processHandlers, 'wp-m2-process'],
	[compositionHandlers, 'wp-m2-mg'],
	[trackerHandlers, 'wp-m2-track'],
	[shapeHandlers, SHAPE_OWNER],
	[m2Handlers, 'M2'],
];

/**
 * Fields of commands owned by another work package than the command itself (M2, ARCHITECTURE §20.1). Until the
 * owner lands, using the field answers E_NOT_IMPLEMENTED naming the owner.
 */
export const COMMAND_FIELD_OWNERS: Readonly<Record<string, CommandOwner>> = {
	'clip.addText.textAnimation': TEXT_ANIMATION_OWNER,
	'clip.update.textAnimation': TEXT_ANIMATION_OWNER,
	'clip.update.shape': SHAPE_OWNER,
	'clip.update.template': MG_TEMPLATE_OWNER,
};

function buildCatalog(): Record<CommandType, CatalogEntry> {
	const out = {} as Record<CommandType, CatalogEntry>;
	for (const schema of ALL_COMMAND_SCHEMAS) {
		const type = schema.shape.type.value as CommandType;
		const found = SOURCES.find(([map]) => map[type]);
		if (!found) throw new Error(`No handler registered for ${type}`);
		const [map, owner] = found;
		out[type] = {
			type,
			schema,
			handler: map[type] as Handler<CommandType>,
			label: LABELS[type],
			owner,
			milestone: owner === 'M2' || owner.startsWith('wp-m2-') ? 'M2' : 'M1',
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

export function requiresApproval(commands: readonly { type: string; force?: unknown }[]): boolean {
	return commands.some((c) => (APPROVAL_COMMANDS as readonly string[]).includes(c.type) || c.force === true);
}

export type { Command, HandlerContext };
