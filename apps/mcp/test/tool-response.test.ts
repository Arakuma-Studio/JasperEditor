import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readToolResponse } from './tool-response.ts';

const response = (text: string, isError = false): CallToolResult => ({
	content: [{ type: 'text', text }],
	isError,
});

describe('readToolResponse', () => {
	it('retains arbitrary nested JSON object values', () => {
		fc.assert(
			fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (body) => {
				const text = JSON.stringify(body);
				expect(readToolResponse(response(text)).body).toEqual(JSON.parse(text));
			}),
		);
	});

	it('retains error status and reads the body with a caller schema', () => {
		const parsed = readToolResponse(response('{"error":{"code":"E_TEST"}}', true));
		expect(parsed.isError).toBe(true);
		expect(parsed.read(z.object({ error: z.object({ code: z.string() }) }))).toEqual({
			error: { code: 'E_TEST' },
		});
		expect(() => parsed.read(z.object({ count: z.number() }))).toThrow(z.ZodError);
	});

	it.each(['null', '[]', 'true', '1', '"value"', '{"nested":[1e999]}'])(
		'rejects a non-object or nonfinite JSON body: %s',
		(text) => expect(() => readToolResponse(response(text))).toThrow(z.ZodError),
	);

	it('rejects missing or malformed JSON text', () => {
		expect(() => readToolResponse({ content: [] })).toThrow('Expected a JSON text response');
		expect(() => readToolResponse(response('{'))).toThrow(SyntaxError);
	});
});
