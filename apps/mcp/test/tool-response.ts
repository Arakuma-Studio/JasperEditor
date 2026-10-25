import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const JsonSchema = z.json();

export function readToolResponse(result: CallToolResult) {
	const text = result.content.find((content) => content.type === 'text')?.text;
	if (text === undefined) throw new Error('Expected a JSON text response from the MCP tool');
	const body = JsonSchema.parse(JSON.parse(text));
	if (body === null || typeof body !== 'object' || Array.isArray(body))
		throw new Error('Expected a JSON object response from the MCP tool');
	return {
		isError: result.isError === true,
		body,
		read<S extends z.ZodType>(schema: S): z.output<S> {
			return schema.parse(body);
		},
	};
}
