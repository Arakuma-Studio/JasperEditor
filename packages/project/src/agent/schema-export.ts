// Self-description for agents (S01:AGT-002): JSON Schemas of every command and the transaction
// envelope, the effect registry, motion-graphic templates, presets and error codes (z.toJSONSchema).

import { z } from 'zod';
import { TransactionSchema } from '../commands/apply.ts';
import { COMMAND_CATALOG, type CommandOwner } from '../commands/catalog.ts';
import type { CommandType } from '../commands/schemas/index.ts';
import { ERROR_CODES, type Registries, TX_PROTOCOL, WARNING_CODES } from '../commands/types.ts';
import type { SequencePreset } from '../presets.ts';
import type { EffectSpec } from '../registry/effects.ts';
import type { MgTemplateInfo } from '../registry/mg.ts';
import { PROPERTY_SPECS, type PropertySpec } from '../registry/properties.ts';
import { KNOWN_CLIP_KINDS } from '../schema/sequence.ts';
import {
	LATEST_TEXT_ANIMATION_SPECS,
	TEXT_ANIMATION_SPECS,
	type TextAnimationSpec,
} from '../text-animations.ts';
import { TRANSITION_SPECS, type TransitionSpec } from '../transitions.ts';
import { SHAPE_PRESETS } from '../vector/presets.ts';
import { shapeItemFieldCatalog } from '../vector/properties.ts';

export type JsonSchema = ReturnType<typeof z.toJSONSchema>;

export type AgentSchema = {
	protocol: typeof TX_PROTOCOL;
	transaction: JsonSchema;
	commands: Record<
		CommandType,
		{
			label: string;
			owner: CommandOwner;
			milestone: 'M1' | 'M2' | 'M3';
			implemented: boolean;
			schema: JsonSchema;
		}
	>;
	effects: (Pick<
		EffectSpec,
		'id' | 'version' | 'label' | 'category' | 'appliesTo' | 'params' | 'capabilities' | 'bin' | 'description'
	> & { gpu?: boolean })[];
	transitions: (Pick<
		TransitionSpec,
		| 'id'
		| 'version'
		| 'label'
		| 'appliesTo'
		| 'bin'
		| 'subBin'
		| 'description'
		| 'keywords'
		| 'params'
		| 'capabilities'
		| 'expensive'
	> & { gpu?: boolean })[];
	mgTemplates: (Omit<MgTemplateInfo, 'paramsSchema' | 'renderer' | 'canvasDefault' | 'canvases'> & {
		paramsSchema: JsonSchema;
		renderer: NonNullable<MgTemplateInfo['renderer']>;
	})[];
	textAnimations: (Omit<TextAnimationSpec, 'paramsSchema'> & {
		paramsSchema: JsonSchema;
		/** The newest version of its preset; older versions still render saved documents. */
		latest: boolean;
	})[];
	presets: Pick<SequencePreset, 'id' | 'name' | 'settings'>[];
	properties: (Pick<PropertySpec, 'key' | 'label' | 'kind' | 'unit' | 'range' | 'animatable' | 'spatial'> & {
		kinds: string[];
	})[];
	errorCodes: readonly string[];
	warningCodes: readonly string[];
	/**
	 * wp shapes: vector shape items — the fields of each item type (property key `shape.items.<itemId>.<field>` for
	 * param.set / keyframes / expressions) and the shape presets (`clip.addShape {type: 'vector', preset}`).
	 */
	shapeItems?: {
		keyPattern: string;
		types: ReturnType<typeof shapeItemFieldCatalog>;
		presets: { id: string; label: string; category: string; description: string }[];
	};
};

export function toJsonSchema(schema: z.ZodType): JsonSchema {
	return z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' });
}

export function exportAgentSchema(registries: Registries): AgentSchema {
	const commands = {} as AgentSchema['commands'];
	for (const [type, entry] of Object.entries(COMMAND_CATALOG) as [
		CommandType,
		(typeof COMMAND_CATALOG)[CommandType],
	][]) {
		commands[type] = {
			label: entry.label,
			owner: entry.owner,
			milestone: entry.milestone,
			implemented: true,
			schema: toJsonSchema(entry.schema),
		};
	}
	return {
		protocol: TX_PROTOCOL,
		transaction: toJsonSchema(TransactionSchema),
		commands,
		// color-mgmt: internal (render-only) effects are not offered.
		effects: registries.effects
			.list()
			.filter((e) => !e.internal)
			.map((e) => ({
				id: e.id,
				version: e.version,
				label: e.label,
				category: e.category,
				appliesTo: e.appliesTo,
				params: e.params,
				capabilities: e.capabilities,
				...(e.bin ? { bin: e.bin } : {}),
				...(e.description ? { description: e.description } : {}),
				...(e.gpu ? { gpu: true } : {}),
			})),
		transitions: TRANSITION_SPECS.map((t) => ({
			id: t.id,
			version: t.version,
			label: t.label,
			appliesTo: t.appliesTo,
			bin: t.bin,
			...(t.subBin ? { subBin: t.subBin } : {}),
			description: t.description,
			...(t.keywords ? { keywords: t.keywords } : {}),
			params: [...t.params],
			capabilities: t.capabilities,
			...(t.gpu ? { gpu: true } : {}),
			...(t.expensive ? { expensive: true } : {}),
		})),
		mgTemplates: registries.mgTemplates.list().map((t) => ({
			id: t.id,
			version: t.version,
			name: t.name,
			category: t.category,
			paramsSchema: toJsonSchema(t.paramsSchema),
			defaults: t.defaults,
			introFrames: t.introFrames,
			outroFrames: t.outroFrames,
			renderer: t.renderer ?? 'fframes',
			...(t.description ? { description: t.description } : {}),
			...(t.defaultDurationSeconds !== undefined ? { defaultDurationSeconds: t.defaultDurationSeconds } : {}),
		})),
		textAnimations: TEXT_ANIMATION_SPECS.map((t) => ({
			id: t.id,
			version: t.version,
			label: t.label,
			category: t.category,
			phases: t.phases,
			paramsSchema: toJsonSchema(t.paramsSchema),
			defaults: t.defaults,
			defaultDurationFrames: t.defaultDurationFrames,
			description: t.description,
			// Superseded versions stay valid in documents; new animations use the latest (S11:TXA-002).
			latest: LATEST_TEXT_ANIMATION_SPECS.includes(t),
		})),
		presets: registries.presets.list().map((p) => ({ id: p.id, name: p.name, settings: p.settings })),
		properties: PROPERTY_SPECS.map((p) => ({
			key: p.key,
			label: p.label,
			kind: p.kind,
			unit: p.unit,
			range: p.range,
			animatable: p.animatable,
			...(p.spatial ? { spatial: p.spatial } : {}),
			kinds: KNOWN_CLIP_KINDS.filter((kind) => p.appliesTo({ kind })),
		})),
		errorCodes: ERROR_CODES,
		warningCodes: WARNING_CODES,
		shapeItems: {
			keyPattern: 'shape.items.<itemId>.<field>',
			types: shapeItemFieldCatalog(),
			presets: SHAPE_PRESETS.map((p) => ({
				id: p.id,
				label: p.label,
				category: p.category,
				description: p.description,
			})),
		},
	};
}
