import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// Give recursive JSON values a finite type boundary before composing the record.
const JsonValueSchema: z.ZodType<z.JSONType> = z.lazy(() =>
	z.union([
		z.string(),
		z.number(),
		z.boolean(),
		z.null(),
		z.array(JsonValueSchema),
		z.record(z.string(), JsonValueSchema),
	]),
);
const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

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
