// Self-description for agents (S01:AGT-002): JSON Schemas of every command and the transaction
// envelope, the effect registry, motion-graphic templates, presets and error codes (z.toJSONSchema).
import { z } from 'zod';
import { TransactionSchema } from '../commands/apply.ts';
import { COMMAND_CATALOG, type CommandOwner } from '../commands/catalog.ts';
import { isNotImplementedHandler } from '../commands/handlers/util.ts';
import type { CommandType } from '../commands/schemas/index.ts';
import { ERROR_CODES, type Registries, TX_PROTOCOL, WARNING_CODES } from '../commands/types.ts';
import { PROPERTY_SPECS } from '../registry/properties.ts';
import { KNOWN_CLIP_KINDS } from '../schema/sequence.ts';
import { LATEST_TEXT_ANIMATION_SPECS, TEXT_ANIMATION_SPECS } from '../text-animations.ts';
import { TRANSITION_SPECS } from '../transitions.ts';

export type JsonSchema = Record<string, unknown>;

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
	effects: {
		id: string;
		version: number;
		label: string;
		category: string;
		appliesTo: string;
		params: unknown[];
		capabilities: unknown;
		/** fx framework: Effects-panel bin, one-line description, GPU shader effect (Remotion path unless native). */
		bin?: string;
		description?: string;
		gpu?: boolean;
	}[];
	/**
	 * Wave-2 transition framework: every transition type (`transition.add {effectId, params}`): Effects-panel bin,
	 * params (ParamSpecs; `param.set` target ["transition", id, name]), GPU shader stage (Remotion path) or built-in.
	 */
	transitions: {
		id: string;
		version: number;
		label: string;
		appliesTo: 'video' | 'audio';
		bin: string;
		subBin?: string;
		description: string;
		keywords?: readonly string[];
		params: unknown[];
		capabilities: unknown;
		gpu?: boolean;
	}[];
	mgTemplates: {
		id: string;
		version: number;
		name: string;
		category: string;
		paramsSchema: JsonSchema;
		defaults: unknown;
		introFrames: number;
		outroFrames: number;
		/** M2 (S11:ANA-001): `fframes` or `anime`. */
		renderer: 'fframes' | 'anime';
		description?: string;
		defaultDurationSeconds?: number;
	}[];
	/** M2 (S11:ANA-001): text animator presets (in/out animators of text clips). */
	textAnimations: {
		id: string;
		version: number;
		label: string;
		category: string;
		phases: readonly ('in' | 'out')[];
		paramsSchema: JsonSchema;
		defaults: unknown;
		/** At 30 fps; scaled to the sequence rate on apply. */
		defaultDurationFrames: number;
		description: string;
		/** The newest version of its preset (what new animations use); older versions only render saved documents. */
		latest: boolean;
	}[];
	presets: { id: string; name: string; settings: unknown }[];
	properties: {
		key: string;
		label: string;
		kind: string;
		unit?: string;
		range?: unknown;
		animatable: string;
		/** vec2 points (spatial-motion-path, S03:KF-021): the spatial interpolation of new keys. */
		spatial?: string;
		/** M2 (S11:ANA-001): clip kinds the property applies to. */
		kinds: string[];
	}[];
	errorCodes: readonly string[];
	warningCodes: readonly string[];
};

export function toJsonSchema(schema: z.ZodType): JsonSchema {
	return z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }) as JsonSchema;
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
			implemented: !isNotImplementedHandler(entry.handler),
			schema: toJsonSchema(entry.schema),
		};
	}
	return {
		protocol: TX_PROTOCOL,
		transaction: toJsonSchema(TransactionSchema),
		commands,
		effects: registries.effects.list().map((e) => ({
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
	};
}
