import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { camtrackCommand } from '../src/camtrack/entry.ts';
import { procCommand } from '../src/processing/proc-entry.ts';
import { rotoCommand } from '../src/roto/entry.ts';
import { speechCommand } from '../src/speech/entry.ts';
import { bundledNode, insideElectron, nodeExecPath } from '../src/tools/node-runtime.ts';
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
		const shipped = fakeNode(join(resources, 'node'));
		expect(bundledNode(resources, 'linux')).toBe(shipped);
		expect(bundledNode(resources, 'win32')).toBeNull();
		fakeNode(join(resources, 'node'), 'node.exe');
		expect(bundledNode(resources, 'win32')).toBe(join(resources, 'node', 'node.exe'));
		expect(nodeExecPath({ JASPER_RESOURCES_DIR: resources })).toBe(
			join(resources, 'node', process.platform === 'win32' ? 'node.exe' : 'node'),
		);
		const explicit = fakeNode(tempAppdir('jasper-node-'), 'my-node');
		expect(nodeExecPath({ JASPER_RESOURCES_DIR: resources, JASPER_NODE: explicit })).toBe(explicit);
		expect(bundledNode(null)).toBeNull();
		expect(bundledNode(undefined)).toBeNull();
	});

	it('every worker bundle is started with it', () => {
		const resources = tempAppdir('jasper-res-');
		const shipped = fakeNode(join(resources, 'node'), process.platform === 'win32' ? 'node.exe' : 'node');
		const bundles = tempAppdir('jasper-bundles-');
		const bundle = (name: string) => {
			const f = join(bundles, name);
			writeFileSync(f, '');
			return f;
		};
		const env = { JASPER_RESOURCES_DIR: resources };
		for (const [command, variable, file] of [
			[speechCommand, 'JASPER_SPEECH', 'jasper-speech.mjs'],
			[rotoCommand, 'JASPER_ROTO', 'jasper-roto.mjs'],
			[camtrackCommand, 'JASPER_CAMTRACK', 'jasper-camtrack.mjs'],
			[procCommand, 'JASPER_PROC', 'jasper-proc.mjs'],
		] as const) {
			const b = bundle(file);
			expect([file, command({ ...env, [variable]: b })]).toEqual([file, { command: shipped, args: [b] }]);
			expect(command({ [variable]: b }).command).toBe(process.execPath);
		}
	});

	it('uses the requested runtime for source workers and explicit TypeScript entries', () => {
		const runtime = fakeNode(tempAppdir('jasper-node-'));
		const explicitSource = join(tempAppdir('jasper-worker-'), 'custom-worker.ts');
		writeFileSync(explicitSource, '');
		for (const [command, variable] of [
			[speechCommand, 'JASPER_SPEECH'],
			[rotoCommand, 'JASPER_ROTO'],
			[camtrackCommand, 'JASPER_CAMTRACK'],
			[procCommand, 'JASPER_PROC'],
		] as const) {
			const source = command({ JASPER_NODE: runtime });
			expect(source.command).toBe(runtime);
			expect(source.args[0]).toBe('--import');
			expect(source.args[1]).toMatch(/^file:/);
			const explicit = command({ JASPER_NODE: runtime, [variable]: explicitSource });
			expect(explicit.command).toBe(runtime);
			expect(explicit.args[2]).toBe(explicitSource);
			expect(() => command({ [variable]: `${explicitSource}.missing.mjs` })).toThrow('does not exist');
		}
	});

	it('knows when it runs inside Electron (where the binary runs a script only as "run as Node")', () => {
		expect(insideElectron({ node: '20.0.0' })).toBe(false);
		expect(insideElectron({ node: '24.0.0', electron: '44.5.0' })).toBe(true);
		expect(insideElectron()).toBe(false);
	});
});
