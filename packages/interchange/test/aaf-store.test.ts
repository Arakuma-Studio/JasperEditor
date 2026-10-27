import { describe, expect, it } from 'vitest';
import { importAaf } from '../src/aaf/index.ts';
import { CfbWriter } from '../src/cfb.ts';
import { InterchangeError, Report } from '../src/report.ts';

describe('AAF referenced properties', () => {
	it('reports a present reference table that is not a stream', () => {
		const writer = new CfbWriter(3);
		writer.stream(CfbWriter.ROOT, 'properties', new Uint8Array([0x4c, 0x20, 0, 0]));
		writer.storage(CfbWriter.ROOT, 'referenced properties');
		const bytes = writer.finish();
		expect(() => importAaf(bytes, {}, new Report())).toThrow(InterchangeError);
		expect(() => importAaf(bytes, {}, new Report())).toThrow(
			expect.objectContaining({
				code: 'PARSE',
				message: expect.stringMatching(/referenced properties.*not a stream/),
			}),
		);
	});
});
