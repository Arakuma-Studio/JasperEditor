import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeExecPath } from '../src/tools/node-runtime.ts';
import { tempAppdir } from './temp.ts';

function fakeNode(dir: string, name = 'node'): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, name);
	writeFileSync(file, '#!/bin/sh\n');
	chmodSync(file, 0o755);
	return file;
}

describe('Node runtime of the engine workers (RUN-1)', () => {
	it('is this process in a checkout or a headless engine', () => {
		expect(nodeExecPath({})).toBe(process.execPath);
		expect(nodeExecPath({ JASPER_RESOURCES_DIR: tempAppdir('jasper-res-') })).toBe(process.execPath);
		expect(nodeExecPath({ JASPER_NODE: '/no/such/node' })).toBe(process.execPath);
	});

	it('is the runtime shipped in <resources>/node when there is one; JASPER_NODE wins', () => {
		const resources = tempAppdir('jasper-res-');
		const shipped = fakeNode(join(resources, 'node'), process.platform === 'win32' ? 'node.exe' : 'node');
		expect(nodeExecPath({ JASPER_RESOURCES_DIR: resources })).toBe(shipped);
		const explicit = fakeNode(tempAppdir('jasper-node-'), 'my-node');
		expect(nodeExecPath({ JASPER_RESOURCES_DIR: resources, JASPER_NODE: explicit })).toBe(explicit);
	});
});
