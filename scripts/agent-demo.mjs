#!/usr/bin/env node
// Agent API demo (WP-2H, ARCHITECTURE §11, S01 Appendix B): posts one transaction to a running engine —
// a text clip declared with a temp ref, an opacity fade-in on it (param.setAnimated + two param.set),
// and an agent-note marker. With the project open in the editor it applies live (one "Agent: …" History
// entry); with no editor open the engine applies it headlessly and saves a new revision.
//
//   node scripts/agent-demo.mjs <projectId> [--engine http://127.0.0.1:47900] [--token <t>] [--agent <name>]
//   node scripts/agent-demo.mjs --list            # list projects
//
// Env: JASPER_ENGINE_URL, JASPER_LOCAL_TOKEN. Every engine has a token (docs/security-review.md §8): without
// --token or the variable, the script reads it from the runtime file the engine's /health names (the file is
// readable by the engine's user only).
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const flag = (name) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));

const engine = (flag('engine') ?? process.env.JASPER_ENGINE_URL ?? 'http://127.0.0.1:47900').replace(
	/\/$/,
	'',
);
async function discoverToken() {
	try {
		const health = await (await fetch(`${engine}/health`)).json();
		return JSON.parse(readFileSync(health.runtimeFile, 'utf8')).token ?? undefined;
	} catch {
		return undefined;
	}
}
const token = flag('token') ?? process.env.JASPER_LOCAL_TOKEN ?? (await discoverToken());
const agent = flag('agent') ?? 'agent-demo';
const headers = {
	'content-type': 'application/json',
	'x-jasper-agent': encodeURIComponent(agent),
	...(token ? { authorization: `Bearer ${token}` } : {}),
};

async function call(method, path, body) {
	const res = await fetch(`${engine}${path}`, {
		method,
		headers,
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = text;
	}
	if (!res.ok) {
		throw new Error(`${method} ${path} → ${res.status} ${json?.code ?? ''} ${json?.message ?? text}`);
	}
	return json;
}

function usage(code = 1) {
	console.log(
		'usage: node scripts/agent-demo.mjs <projectId> [--engine URL] [--token T] [--agent NAME] | --list',
	);
	process.exit(code);
}

async function main() {
	if (argv.includes('--help') || argv.includes('-h')) usage(0);
	if (argv.includes('--list')) {
		const { projects } = await call('GET', '/api/projects');
		for (const p of projects) console.log(`${p.projectId}  rev ${p.revision}  ${p.modifiedAt}  ${p.name}`);
		return;
	}
	const projectId = positional[0];
	if (!projectId) usage();

	const { result: rev, via } = await call('POST', '/api/agent/query', { projectId, query: 'doc.revision' });
	console.log(`project ${projectId}: revision ${rev.revision} (answered by ${via})`);

	const stamp = new Date().toLocaleTimeString();
	const transaction = {
		protocol: 'jasper.tx/1',
		label: `Demo title ${stamp}`,
		origin: { agent, runId: `demo_${Date.now().toString(36)}` },
		expectedRevision: rev.revision,
		commands: [
			{
				type: 'clip.addText',
				ref: '$title',
				at: '00:00:01:00',
				duration: { seconds: 4 },
				track: 'V2',
				content: { text: `Agent demo ${stamp}` },
				box: { width: 1400, height: 160, autoSize: 'height' },
			},
			{ type: 'param.setAnimated', target: ['clip', '$title', 'opacity'], animated: true, at: { frames: 0 } },
			{ type: 'param.set', target: ['clip', '$title', 'opacity'], value: 0, at: { frames: 0 } },
			{ type: 'param.set', target: ['clip', '$title', 'opacity'], value: 100, at: { frames: 15 } },
			{
				type: 'marker.add',
				frame: '00:00:01:00',
				name: `Agent demo ${stamp}`,
				markerType: 'agent-note',
				comment: 'Added by scripts/agent-demo.mjs: a title that fades in over 15 frames.',
			},
		],
	};
	const { result, appliedBy } = await call('POST', '/api/agent/tx', { projectId, transaction });
	if (!result.ok) {
		console.error(`rejected (${appliedBy}):`);
		for (const e of result.errors) console.error(`  [${e.commandIndex}] ${e.code}: ${e.message}`);
		process.exit(2);
	}
	console.log(`applied by ${appliedBy}: revision ${result.revision}`);
	console.log(`  title clip ${result.refs.$title}`);
	console.log(
		`  created ${result.created.length}, changed ${result.changed.length}, warnings ${result.warnings.length}`,
	);
	if (appliedBy === 'session')
		console.log('  → look for "Agent: …" in the History panel and the new marker.');
	else console.log('  → saved headlessly; open the project to see the title and the marker.');
}

main().catch((e) => {
	console.error(`agent-demo: ${e.message}`);
	if (e.cause?.code === 'ECONNREFUSED')
		console.error(`is the engine running at ${engine}? (pnpm dev:engine)`);
	process.exit(1);
});
