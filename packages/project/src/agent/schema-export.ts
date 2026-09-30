// Self-description for agents (S01:AGT-002): JSON Schemas of every command and the transaction
// envelope, the effect registry, motion-graphic templates, presets and error codes (z.toJSONSchema).
import { z } from 'zod';
import { TransactionSchema } from '../commands/apply.ts';
import { COMMAND_CATALOG, type CommandOwner } from '../commands/catalog.ts';
import { isNotImplementedHandler } from '../commands/handlers/util.ts';
import type { CommandType } from '../commands/schemas/index.ts';
import { ERROR_CODES, type Registries, TX_PROTOCOL, WARNING_CODES } from '../commands/types.ts';
import { PROPERTY_SPECS } from '../registry/properties.ts';

export type JsonSchema = Record<string, unknown>;

export type AgentSchema = {
	protocol: typeof TX_PROTOCOL;
	transaction: JsonSchema;
	commands: Record<
		CommandType,
		{ label: string; owner: CommandOwner; milestone: 'M1' | 'M2'; implemented: boolean; schema: JsonSchema }
	>;
	effects: {
		id: string;
		version: number;
		label: string;
		category: string;
		appliesTo: string;
		params: unknown[];
		capabilities: unknown;
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
	}[];
	presets: { id: string; name: string; settings: unknown }[];
	properties: {
		key: string;
		label: string;
		kind: string;
		unit?: string;
		range?: unknown;
		animatable: string;
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
		})),
		presets: registries.presets.list().map((p) => ({ id: p.id, name: p.name, settings: p.settings })),
		properties: PROPERTY_SPECS.map((p) => ({
			key: p.key,
			label: p.label,
			kind: p.kind,
			unit: p.unit,
			range: p.range,
			animatable: p.animatable,
		})),
		errorCodes: ERROR_CODES,
		warningCodes: WARNING_CODES,
	};
}
