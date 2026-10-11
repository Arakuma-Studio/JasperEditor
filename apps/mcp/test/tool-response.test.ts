import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readToolResponse } from './tool-response.ts';

describe('MCP test response reader', () => {
	it('preserves error details for assertions about rejected input', () => {
		const body = { error: { code: 'E_INVALID_ARGUMENT', message: 'Invalid model' } };
		const response = readToolResponse({
			isError: true,
			content: [{ type: 'text', text: JSON.stringify(body) }],
		});
		expect(response.isError).toBe(true);
		expect(response.body).toEqual(body);
	});

	it.each(['not json', 'null', '[]', '"text"'])('rejects a non-object response: %s', (text) => {
		expect(() => readToolResponse({ content: [{ type: 'text', text }] })).toThrow();
	});

	it('refuses absent text and malformed nested fields instead of asserting their types', () => {
		expect(() => readToolResponse({ content: [] })).toThrow('Expected a JSON text response');
		const schema = z.object({ jobs: z.array(z.object({ jobId: z.string() })) });
		const response = readToolResponse({ content: [{ type: 'text', text: '{"jobs":[{"jobId":3}]}' }] });
		expect(() => response.read(schema)).toThrow();
		const valid = readToolResponse({ content: [{ type: 'text', text: '{"jobs":[{"jobId":"job_1"}]}' }] });
		expect(valid.read(schema).jobs[0]?.jobId).toBe('job_1');
	});
});
