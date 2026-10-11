import { describe, expect, it } from 'vitest';
import { importAaf } from '../src/aaf/index.ts';
import { readStore } from '../src/aaf/store.ts';
import { CfbError, CfbWriter } from '../src/cfb.ts';
import { Report } from '../src/report.ts';

function emptyStore(): CfbWriter {
	const writer = new CfbWriter(3);
	writer.stream(CfbWriter.ROOT, 'properties', new Uint8Array([0x4c, 0x20, 0, 0]));
	return writer;
}

describe('AAF referenced properties', () => {
	it('allows an absent optional reference table', () => {
		expect(readStore(emptyStore().finish()).props).toEqual([]);
	});

	it('reports a present reference table that is not a stream', () => {
		const writer = emptyStore();
		writer.storage(CfbWriter.ROOT, 'referenced properties');
		const bytes = writer.finish();
		expect(() => readStore(bytes)).toThrow(CfbError);
		expect(() => importAaf(bytes, {}, new Report())).toThrow(/referenced properties.*not a stream/);
	});
});
