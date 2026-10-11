import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export const JsonObjectSchema = z.record(z.string(), z.json());

export function readToolResponse(result: CallToolResult) {
	const text = result.content.find((content) => content.type === 'text')?.text;
	if (text === undefined) throw new Error('Expected a JSON text response from the MCP tool');
	const body = JsonObjectSchema.parse(JSON.parse(text));
	return {
		isError: result.isError === true,
		body,
		read<S extends z.ZodType>(schema: S): z.output<S> {
			return schema.parse(body);
		},
	};
}
