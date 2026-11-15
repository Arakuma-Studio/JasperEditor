// `jasper`: the one-shot command line for JasperEditor (docs/wp-notes/mcp-cli.md §5). Every command is one
// shell call over the same tools jasper-mcp serves (run in process through an in-memory MCP client), so the
// CLI and MCP behave identically: the engine is discovered (or started with --start-engine) the same way, and
// edits go to the open editor window live when the project is open there (one `Agent: …` History entry).
//
// Exit status: 0 ok, 1 the command failed, 2 usage error. --json prints one JSON document per result line.
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';
import { AgentQueryNameSchema } from '@jasper/api';
import { isCommandType } from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parseFriendlyTime } from './arguments.ts';
import { type EngineConnection, EngineLink, startupTimeoutMs } from './link.ts';
import { applyScene, exportSceneFile, previewScene, type SceneCliContext } from './scene-cli.ts';
import { createJasperMcpServer } from './server.ts';
import { MCP_SERVER_VERSION } from './version.ts';

const CLI_HELP = `jasper ${MCP_SERVER_VERSION} — JasperEditor from the command line

Usage: jasper [options] <command> [arguments]

Commands:
  status                              engine, discovery and render capabilities
  projects                            list projects
  describe [name…] [--full]           command catalogue; a command type's JSON Schema and example (clip.place),
                                      or an MCP tool's description and arguments (add_transition; --full: every
                                      nested field and its reference text). A name that is both prints both
  exec <type> [k=v…] | exec <type> '<json>' | exec '<command json>'
                                      apply one document command (one undo step)
  run <file.jsonl | ->                one transaction per line: a command {"type": …} or
                                      {"label"?, "commands": [...]}; prints one result line each
  get <path>                          a parameter (clip/<id>/opacity, effect/<id>/radius,
                                      transition/<id>/<param>, track/A1/volumeDb) with value and
                                      evaluated; any other path reads the document (sequences/<id>/settings)
  set <path> <value>                  param.set on a parameter path (value: JSON or a bare string)
  props <clipId>                      every property of a clip: value, evaluated, keyframes, target
  inspect [sequenceId]                the timeline table (--json: the sequence summary)
  import <file…>                      import media files (absolute or relative paths)
  render-frame --at <time> --out <file.png> [--width N]
                                      render the Program output at a time to a PNG
  export --out <file> [--preset ID] [--range from..to] [--engine auto|native|remotion] [--overwrite]
                                      export and wait (progress on stderr; Ctrl+C cancels and deletes the file);
                                      an existing file is kept (" (2)" is appended) unless --overwrite
  query <name> [k=v…]                 an agent query (doc.get, sequence.at, clip.properties…)
  ui <action> [k=v…] [--out f.png]    live UI of the open editor window: state, elements, screenshot,
                                      click, drag, scroll, key, type, set, locate, hit, commands, command
  tools                               list every MCP tool
  call <tool> [k=v… | '<json>'] [--out f.png]
                                      call any MCP tool; --out writes the images it returns
                                      (several: f-0.png, f-1.png… in result order)
  apply <scene.yaml|.json> [--dry-run]
                                      make a sequence match a scene file: only what differs, one undo step
                                      (applying it again changes nothing)
  preview <scene> --times 0.3,1,2.5,6 --out sheet.png [--watch] [--width N] [--columns N] [--timeout s]
                                      apply, then render those times as one labelled contact sheet;
                                      --watch does it again on every save
  export-scene [--sequence <name|id>] [--out scene.yaml|.json] [--format yaml|json]
                                      a sequence as a scene file (stdout without --out)

Options:
  --project <id|name>    project to work on (env JASPER_PROJECT; default: the project open in the editor
                         window, else the only project; call start_export never guesses it)
  --sequence <id>        sequence (default: the project's first / the editor's active one)
  --at <time>            time for get / props / render-frame: frames, 2.5s, 250ms, 00:03, 1:02:03 or HH:MM:SS:FF
  --label <text>         History label for exec (default: the command type)
  --dry-run              validate exec / run / set without applying
  --keep-going           run: continue after a failed line
  --json                 machine output: one JSON document per line on stdout
  --engine-url <url> --token <t> --appdir <dir> --start-engine --engine-entry <file> --engine-port <n>
  --agent-name <name>    name in the editor History (default "jasper-cli")
  --request-timeout <s>  deadline for one engine request (default 180)
  --timeout <s>          how long a waiting tool waits (export: default 3600; call: the tool's timeoutSeconds
                         when not given, capped at its maximum); waits poll the engine, so they outlast
                         --request-timeout. Set it under any limit around the jasper process, so a long job
                         answers with how to finish it instead of being killed
  --startup-timeout <s>  wait for an engine that is still starting, found or --start-engine'd
                         (env JASPER_ENGINE_STARTUP_TIMEOUT; default 120; progress on stderr)
  --help, --version

k=v values are JSON when they parse (3, true, [1,2], {"a":1}), else strings; dotted keys nest (at.seconds=2).
Times in k=v accept 30 (frames), {"seconds":2.5} or "00:00:01:15"; --at also takes 2.5s.
Exit status: 0 ok, 1 the command failed, 2 usage error.`;

class UsageError extends Error {
	override readonly name = 'UsageError';
}

const VALUE_FLAGS = new Set([
	'project',
	'sequence',
	'at',
	'label',
	'out',
	'preset',
	'range',
	'engine',
	'width',
	'engine-url',
	'token',
	'appdir',
	'engine-entry',
	'engine-port',
	'agent-name',
	'request-timeout',
	'startup-timeout',
	'timeout',
	'crf',
	'times',
	'format',
	'columns',
]);
const BOOL_FLAGS = new Set([
	'json',
	'dry-run',
	'keep-going',
	'start-engine',
	'help',
	'version',
	'h',
	'watch',
	'overwrite',
	'full',
]);

type ParsedArgs = { flags: Record<string, string | true>; positional: string[] };

function parseArgv(argv: readonly string[]): ParsedArgs {
	const flags: Record<string, string | true> = {};
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === '--') {
			positional.push(...argv.slice(i + 1));
			break;
		}
		if (a.startsWith('--') || a === '-h') {
			const eq = a.indexOf('=');
			const name = a === '-h' ? 'help' : a.slice(2, eq > 0 ? eq : undefined);
			if (BOOL_FLAGS.has(name)) {
				if (eq > 0) throw new UsageError(`--${name} takes no value`);
				flags[name] = true;
			} else if (VALUE_FLAGS.has(name)) {
				const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
				if (v === undefined) throw new UsageError(`--${name} needs a value`);
				flags[name] = v;
			} else throw new UsageError(`Unknown option ${a} (jasper --help lists them)`);
		} else positional.push(a);
	}
	return { flags, positional };
}

/** A JSON value when it parses, else the string itself. */
function looseValue(s: string): unknown {
	try {
		return JSON.parse(s);
	} catch {
		return s;
	}
}

/** `k=v` pairs → an object (dotted keys nest); a single JSON object argument is taken as is. */
function kvArgs(items: readonly string[]): Record<string, unknown> {
	if (items.length === 1 && items[0]!.trim().startsWith('{')) {
		const v = looseValue(items[0]!);
		if (!v || typeof v !== 'object' || Array.isArray(v))
			throw new UsageError(`Not a JSON object: ${items[0]}`);
		return v as Record<string, unknown>;
	}
	const out: Record<string, unknown> = {};
	for (const it of items) {
		const eq = it.indexOf('=');
		if (eq <= 0) throw new UsageError(`Expected key=value, got "${it}"`);
		const keys = it.slice(0, eq).split('.');
		let o = out;
		for (const k of keys.slice(0, -1)) {
			const next = o[k];
			if (next === undefined) o[k] = {};
			else if (!next || typeof next !== 'object' || Array.isArray(next))
				throw new UsageError(`"${keys.join('.')}" nests under a key that already has a value`);
			o = o[k] as Record<string, unknown>;
		}
		o[keys.at(-1)!] = looseValue(it.slice(eq + 1));
	}
	return out;
}

/** `--at`: 30 (frames), 2.5s / 250ms / 00:03 / 1:02:03 (friendly times, arguments.ts), HH:MM:SS:FF, or JSON. */
function timeValue(s: string): unknown {
	const sec = parseFriendlyTime(s.trim());
	if (sec !== null) return { seconds: sec };
	if (/^-?\d+$/.test(s.trim())) return Number(s);
	if (/^\d{1,3}[:;]\d{1,2}[:;]\d{1,2}[:;.]\d{1,3}$/.test(s.trim())) return s.trim();
	const v = looseValue(s);
	if (v && typeof v === 'object') return v;
	throw new UsageError(`Not a time: "${s}" (use frames, 2.5s, 250ms, 00:03, 1:02:03 or HH:MM:SS:FF)`);
}

type Out = { stdout(s: string): void; stderr(s: string): void };

export class CommandFailed extends Error {
	constructor(readonly body: unknown) {
		super(typeof body === 'string' ? body : JSON.stringify(body));
		this.name = 'CommandFailed';
	}
}

function textOf(r: CallToolResult): string {
	return (r.content.find((c) => c.type === 'text') as { text?: string } | undefined)?.text ?? '';
}
function jsonOf(r: CallToolResult): unknown {
	const t = textOf(r);
	try {
		return JSON.parse(t);
	} catch {
		return t;
	}
}
function imageOf(r: CallToolResult): Buffer | null {
	const img = r.content.find((c) => c.type === 'image') as { data?: string } | undefined;
	return img?.data ? Buffer.from(img.data, 'base64') : null;
}

/**
 * `call … --out <file>`: writes every image of a tool result. One image goes to `<file>`; several (e.g. one preview
 * per item of `add_motion_graphic {dryRun, preview}`) go to `<stem>-<i><ext>`, `i` = the image's index in the
 * result (what `preview.image` names), so none is dropped. Returns the paths written.
 */
export function writeToolImages(r: CallToolResult, out: string): string[] {
	const images = r.content
		.filter((c) => c.type === 'image')
		.map((c) => (c as { data?: string }).data)
		.filter((d): d is string => typeof d === 'string' && d.length > 0);
	if (images.length === 1) {
		writeFileSync(out, Buffer.from(images[0]!, 'base64'));
		return [out];
	}
	const ext = extname(out);
	const stem = ext ? out.slice(0, -ext.length) : out;
	return images.map((d, i) => {
		const path = `${stem}-${i}${ext}`;
		writeFileSync(path, Buffer.from(d, 'base64'));
		return path;
	});
}

export type CliSession = {
	call(name: string, args?: Record<string, unknown>, opts?: { progress?: boolean }): Promise<CallToolResult>;
	link: EngineConnection;
	close(): Promise<void>;
};

export async function openSession(
	link: EngineConnection,
	agentName: string,
	err: Out['stderr'],
	signal?: AbortSignal,
): Promise<CliSession> {
	// The CLI reaches every tool by name: all toolsets are advertised (spec 18 AF-CTX-002).
	const { server } = createJasperMcpServer({ link, agentName, toolsets: 'all' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'jasper-cli', version: MCP_SERVER_VERSION });
	await Promise.all([server.connect(a), client.connect(b)]);
	return {
		link,
		call: async (name, args = {}, opts = {}) => {
			let last = '';
			return (await client.callTool({ name, arguments: args }, undefined, {
				timeout: 6 * 3600_000,
				signal,
				...(opts.progress
					? {
							onprogress: (p) => {
								const pct = p.total ? `${Math.round((p.progress / p.total) * 100)}%` : `${p.progress}`;
								const line = `${pct}${p.message ? ` ${p.message}` : ''}`;
								if (line !== last) err(`[jasper] ${line}\n`);
								last = line;
							},
						}
					: {}),
			})) as CallToolResult;
		},
		close: async () => {
			await client.close().catch(() => {});
			await server.close().catch(() => {});
		},
	};
}

type Ctx = {
	s: CliSession;
	flags: ParsedArgs['flags'];
	out: Out;
	json: boolean;
	cwd: string;
	signal?: AbortSignal;
	projectId(): Promise<string>;
	/** Whether --project / JASPER_PROJECT names the project (else `projectId()` guesses it). */
	namedProject: boolean;
};

/**
 * Tools `call` never runs on a guessed project (the editor window's, or the only one): `call start_export '{}'`, meant
 * as a look at its arguments, exported the open project for 15 minutes. They take projectId, --project or
 * JASPER_PROJECT; without one the server refuses the call naming projectId.
 */
const NAMED_PROJECT_TOOLS = new Set(['start_export']);

/** The scene commands' view of a CLI invocation (scene-cli.ts). */
const sceneCtx = (c: Ctx): SceneCliContext => ({
	call: c.s.call,
	link: c.s.link,
	flags: c.flags,
	out: c.out,
	json: c.json,
	cwd: c.cwd,
	...(c.signal ? { signal: c.signal } : {}),
	projectId: c.projectId,
	usage: (m) => new UsageError(m),
	fail: (body) => new CommandFailed(body),
});

/** Calls a tool; a tool error becomes CommandFailed with its `{error}` body. */
async function tool(c: Ctx, name: string, args: Record<string, unknown> = {}, progress = false) {
	const r = await c.s.call(name, args, { progress });
	if (r.isError) throw new CommandFailed(jsonOf(r));
	return r;
}

function emit(c: Ctx, value: unknown, human?: string) {
	if (c.json) c.out.stdout(`${JSON.stringify(value)}\n`);
	else c.out.stdout(`${human ?? (typeof value === 'string' ? value : JSON.stringify(value, null, 2))}\n`);
}

const PARAM_HEADS = new Set(['clip', 'effect', 'transition', 'track']);

function splitPath(p: string): string[] {
	return p.split('/').filter(Boolean);
}

/** clip/<id>/transform.position → ["clip", id, "transform", "position"]. */
function paramTarget(path: string): string[] | null {
	const parts = splitPath(path);
	if (parts.length < 3 || !PARAM_HEADS.has(parts[0]!)) return null;
	const [head, id, ...rest] = parts;
	return [head!, id!, ...rest.flatMap((r) => r.split('.'))];
}

function needArgs(pos: readonly string[], n: number, usage: string) {
	if (pos.length < n) throw new UsageError(`Usage: jasper ${usage}`);
}

const COMMANDS: Record<string, (c: Ctx, args: string[]) => Promise<void>> = {
	async status(c) {
		const r = await tool(c, 'engine_status');
		emit(c, jsonOf(r));
	},
	async projects(c) {
		const r = jsonOf(await tool(c, 'list_projects')) as { projects?: { projectId: string; name: string }[] };
		if (c.json) return emit(c, r);
		for (const p of r.projects ?? []) c.out.stdout(`${p.projectId}\t${p.name}\n`);
	},
	async tools(c) {
		const list = (await listTools(c)).map((t) => ({ name: t.name, title: t.title }));
		if (c.json) return emit(c, list);
		for (const t of list) c.out.stdout(`${t.name}\t${t.title ?? ''}\n`);
	},
	async describe(c, args) {
		if (!args.length) return emit(c, jsonOf(await tool(c, 'describe_commands', {})));
		// A name is a document command (clip.place) or an MCP tool of any toolset (add_transition); one that is both
		// prints both. Tools print what describe_tool returns, one document each; the commands one describe_commands.
		const toolNames = new Set((await listTools(c)).map((t) => t.name));
		const unknown = args.filter((a) => !toolNames.has(a) && !isCommandType(a));
		if (unknown.length)
			throw new CommandFailed({
				error: {
					code: 'E_NOT_FOUND',
					message: `No command type or MCP tool named ${unknown.map((n) => `"${n}"`).join(', ')}`,
					hint: '`jasper describe` lists the command types; `jasper tools` lists every MCP tool.',
				},
			});
		const tools = args.filter((a) => toolNames.has(a));
		const types = args.filter((a) => isCommandType(a));
		for (const name of tools.filter((n) => isCommandType(n)))
			c.out.stderr(
				`jasper: "${name}" is both an MCP tool and a command type; both are shown, the tool first\n`,
			);
		for (const name of tools)
			emit(c, jsonOf(await tool(c, 'describe_tool', { name, ...(c.flags.full ? { full: true } : {}) })));
		if (types.length) emit(c, jsonOf(await tool(c, 'describe_commands', { types })));
	},
	async exec(c, args) {
		needArgs(args, 1, "exec <type> [k=v…] | exec '<command json>'");
		let command: Record<string, unknown>;
		if (args[0]!.trim().startsWith('{')) {
			if (args.length > 1) throw new UsageError('exec with a command JSON takes no other arguments');
			command = kvArgs([args[0]!]);
		} else command = { type: args[0], ...kvArgs(args.slice(1)) };
		const r = await tool(c, 'apply_commands', {
			projectId: await c.projectId(),
			label: typeof c.flags.label === 'string' ? c.flags.label : String(command.type),
			commands: [command],
			...(c.flags['dry-run'] ? { dryRun: true } : {}),
			...(typeof c.flags.sequence === 'string' ? { sequenceId: c.flags.sequence } : {}),
		});
		emit(c, jsonOf(r));
	},
	async run(c, args) {
		needArgs(args, 1, 'run <file.jsonl | ->');
		const text = args[0] === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(c.cwd, args[0]!), 'utf8');
		const projectId = await c.projectId();
		let failed = 0;
		const lines = text.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!.trim();
			if (!line || line.startsWith('#') || line.startsWith('//')) continue;
			let v: unknown;
			try {
				v = JSON.parse(line);
			} catch (e) {
				throw new UsageError(`line ${i + 1}: not JSON (${(e as Error).message})`);
			}
			if (!v || typeof v !== 'object' || Array.isArray(v))
				throw new UsageError(`line ${i + 1}: expected a command object or {"commands": [...]}`);
			const o = v as Record<string, unknown>;
			const commands = Array.isArray(o.commands) ? o.commands : [o];
			const label = typeof o.label === 'string' ? o.label : `${args[0]}:${i + 1}`;
			const r = await c.s.call('apply_commands', {
				projectId,
				label,
				commands,
				...(c.flags['dry-run'] || o.dryRun === true ? { dryRun: true } : {}),
				...(typeof o.sequenceId === 'string' ? { sequenceId: o.sequenceId } : {}),
				...(typeof o.expectedRevision === 'number' ? { expectedRevision: o.expectedRevision } : {}),
			});
			const body = jsonOf(r);
			const ok = !r.isError;
			if (c.json)
				c.out.stdout(
					`${JSON.stringify({ line: i + 1, ok, ...(ok ? { result: body } : (body as object)) })}\n`,
				);
			else
				c.out.stdout(
					ok
						? `line ${i + 1}: ok (revision ${(body as { revision?: number }).revision ?? '?'})\n`
						: `line ${i + 1}: FAILED ${JSON.stringify((body as { error?: unknown }).error ?? body)}\n`,
				);
			if (!ok) {
				failed++;
				if (!c.flags['keep-going']) break;
			}
		}
		if (failed)
			throw new CommandFailed({ error: { code: 'E_RUN_FAILED', message: `${failed} line(s) failed` } });
	},
	async get(c, args) {
		needArgs(args, 1, 'get <path>');
		const target = paramTarget(args[0]!);
		const projectId = await c.projectId();
		if (target) {
			const r = await tool(c, 'get_param', {
				projectId,
				target,
				...(typeof c.flags.at === 'string' ? { at: timeValue(c.flags.at) } : {}),
			});
			const body = jsonOf(r) as {
				property?: { value: unknown; evaluated: unknown };
				value?: unknown;
				evaluated?: unknown;
			};
			const p = body.property ?? body;
			return emit(
				c,
				body,
				`value:     ${JSON.stringify(p.value)}\nevaluated: ${JSON.stringify(p.evaluated)}`,
			);
		}
		const q = await c.s.link
			.client()
			.then((cl) => cl.agentQuery({ projectId, query: 'doc.get', args: { path: splitPath(args[0]!) } }));
		emit(c, q.result);
	},
	async set(c, args) {
		needArgs(args, 2, 'set <path> <value>');
		const target = paramTarget(args[0]!);
		if (!target)
			throw new UsageError(
				`set takes a parameter path: clip/<id>/<key>, effect/<id>/<param>, transition/<id>/<param> or track/<id>/volumeDb|pan`,
			);
		const command: Record<string, unknown> = { type: 'param.set', target, value: looseValue(args[1]!) };
		if (typeof c.flags.at === 'string') {
			// A keyframe at a sequence frame or timecode (param.set upserts it on an animated parameter).
			const t = timeValue(c.flags.at);
			if (typeof t === 'number') command.at = { sequenceFrame: t };
			else if (typeof t === 'string') command.at = t;
			else throw new UsageError('set --at takes a sequence frame or HH:MM:SS:FF');
		}
		const r = await tool(c, 'apply_commands', {
			projectId: await c.projectId(),
			label: typeof c.flags.label === 'string' ? c.flags.label : `Set ${target.slice(2).join('.')}`,
			commands: [command],
			...(c.flags['dry-run'] ? { dryRun: true } : {}),
		});
		emit(c, jsonOf(r));
	},
	async props(c, args) {
		needArgs(args, 1, 'props <clipId>');
		const r = await tool(c, 'get_clip_properties', {
			projectId: await c.projectId(),
			clipId: args[0],
			...(typeof c.flags.at === 'string' ? { at: timeValue(c.flags.at) } : {}),
			...(args.length > 1 ? { keys: args.slice(1) } : {}),
		});
		const body = jsonOf(r) as {
			properties?: {
				key: string;
				value: unknown;
				evaluated: unknown;
				animated: boolean;
				rendered?: boolean;
			}[];
			timecode?: string;
		};
		if (c.json) return emit(c, body);
		c.out.stdout(`# ${args[0]} at ${body.timecode}\n`);
		for (const p of body.properties ?? []) {
			const same = JSON.stringify(p.value) === JSON.stringify(p.evaluated);
			c.out.stdout(
				`${p.key}\t${JSON.stringify(p.value)}${same ? '' : `\t→ ${JSON.stringify(p.evaluated)}`}${p.animated ? '\t(keyframed)' : ''}${p.rendered === false ? '\t(not rendered)' : ''}\n`,
			);
		}
	},
	async inspect(c, args) {
		const projectId = await c.projectId();
		const sequenceId = args[0] ?? (typeof c.flags.sequence === 'string' ? c.flags.sequence : undefined);
		if (c.json) {
			const cl = await c.s.link.client();
			const q = await cl.agentQuery({
				projectId,
				query: 'sequence.summary',
				args: sequenceId ? { sequenceId } : {},
			});
			return emit(c, q.result);
		}
		const r = await tool(c, 'get_timeline', { projectId, ...(sequenceId ? { sequenceId } : {}) });
		c.out.stdout(`${textOf(r)}\n`);
	},
	async import(c, args) {
		needArgs(args, 1, 'import <file…>');
		const paths = args.map((p) => (isAbsolute(p) ? p : resolve(c.cwd, p)));
		const r = await tool(c, 'import_media', { projectId: await c.projectId(), paths }, true);
		emit(c, jsonOf(r));
	},
	async 'render-frame'(c) {
		if (typeof c.flags.at !== 'string' || typeof c.flags.out !== 'string')
			throw new UsageError('Usage: jasper render-frame --at <time> --out <file.png> [--width N]');
		const width = typeof c.flags.width === 'string' ? Number(c.flags.width) : undefined;
		if (width !== undefined && !Number.isInteger(width)) throw new UsageError('--width must be an integer');
		const r = await tool(
			c,
			'render_frame',
			{
				projectId: await c.projectId(),
				at: timeValue(c.flags.at),
				...(width ? { width } : {}),
				...(typeof c.flags.sequence === 'string' ? { sequenceId: c.flags.sequence } : {}),
			},
			true,
		);
		const png = imageOf(r);
		if (!png) throw new CommandFailed({ error: { code: 'INTERNAL', message: 'No image in the result' } });
		const out = resolve(c.cwd, c.flags.out);
		writeFileSync(out, png);
		emit(c, { ...(jsonOf(r) as object), out, bytes: png.length }, `wrote ${out} (${png.length} bytes)`);
	},
	async export(c) {
		if (typeof c.flags.out !== 'string')
			throw new UsageError(
				'Usage: jasper export --out <file> [--preset ID] [--range from..to] [--engine auto|native|remotion] [--overwrite]',
			);
		let range: unknown;
		if (typeof c.flags.range === 'string') {
			if (c.flags.range === 'entire' || c.flags.range === 'in-out') range = c.flags.range;
			else {
				const [from, to] = c.flags.range.split('..');
				if (!from || !to) throw new UsageError('--range is entire, in-out or <from>..<to>');
				range = { from: timeValue(from), to: timeValue(to) };
			}
		}
		const r = await tool(
			c,
			'start_export',
			{
				projectId: await c.projectId(),
				outputPath: resolve(c.cwd, c.flags.out),
				...(c.flags.overwrite ? { overwrite: true } : {}),
				wait: true,
				timeoutSeconds: typeof c.flags.timeout === 'string' ? Number(c.flags.timeout) : 3600,
				...(typeof c.flags.preset === 'string' ? { preset: c.flags.preset } : {}),
				...(typeof c.flags.engine === 'string' ? { engine: c.flags.engine } : {}),
				...(typeof c.flags.crf === 'string' ? { crf: Number(c.flags.crf) } : {}),
				...(typeof c.flags.sequence === 'string' ? { sequenceId: c.flags.sequence } : {}),
				...(range !== undefined ? { range } : {}),
			},
			true,
		);
		const body = jsonOf(r) as { timedOut?: boolean; path?: string; pathNote?: string };
		if (body.timedOut)
			throw new CommandFailed({
				error: { code: 'TIMEOUT', message: 'The export is still running', details: body },
			});
		emit(c, body, `wrote ${body.path ?? '(see result)'}${body.pathNote ? `\n${body.pathNote}` : ''}`);
	},
	async query(c, args) {
		needArgs(args, 1, 'query <name> [k=v…]');
		const name = AgentQueryNameSchema.safeParse(args[0]);
		if (!name.success) throw new UsageError(`Unknown query ${args[0]}`);
		const cl = await c.s.link.client();
		const q = await cl.agentQuery({
			projectId: await c.projectId(),
			query: name.data,
			args: kvArgs(args.slice(1)),
		});
		emit(c, q.result);
	},
	async ui(c, args) {
		needArgs(args, 1, 'ui <action> [k=v…]');
		const action = args[0]!;
		const name = action === 'command' ? 'ui_command' : action === 'commands' ? 'ui_commands' : `ui_${action}`;
		const known = (await listTools(c)).some((t) => t.name === name);
		if (!known)
			throw new UsageError(
				`Unknown ui action "${action}" (state, elements, screenshot, click, drag, scroll, key, type, set, locate, hit, commands, command)`,
			);
		const params = kvArgs(args.slice(1));
		if (typeof c.flags.project === 'string') params.projectId = await c.projectId();
		const r = await tool(c, name, params);
		const png = imageOf(r);
		if (png) {
			if (typeof c.flags.out !== 'string') throw new UsageError('ui screenshot needs --out <file.png>');
			const out = resolve(c.cwd, c.flags.out);
			writeFileSync(out, png);
			return emit(c, { ...(jsonOf(r) as object), out }, `wrote ${out}`);
		}
		emit(c, jsonOf(r));
	},
	async call(c, args) {
		needArgs(args, 1, 'call <tool> [k=v… | json]');
		const params = kvArgs(args.slice(1));
		const tools = await listTools(c);
		const def = tools.find((t) => t.name === args[0]);
		if (!def) throw new UsageError(`Unknown tool "${args[0]}" (jasper tools lists them)`);
		const props = (def.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
		if (
			'projectId' in props &&
			params.projectId === undefined &&
			(c.namedProject || !NAMED_PROJECT_TOOLS.has(args[0]!))
		)
			params.projectId = await c.projectId();
		// --timeout: how long a waiting tool may wait (its own timeoutSeconds wins; capped at the tool's maximum)
		const wait = props.timeoutSeconds as { maximum?: number } | undefined;
		if (wait && params.timeoutSeconds === undefined && typeof c.flags.timeout === 'string') {
			const sec = Number(c.flags.timeout);
			if (!Number.isInteger(sec) || sec < 1) throw new UsageError('--timeout takes whole seconds (≥ 1)');
			params.timeoutSeconds = typeof wait.maximum === 'number' ? Math.min(sec, wait.maximum) : sec;
		}
		const r = await tool(c, args[0]!, params, true);
		if (typeof c.flags.out === 'string')
			for (const path of writeToolImages(r, resolve(c.cwd, c.flags.out))) c.out.stderr(`wrote ${path}\n`);
		emit(c, jsonOf(r));
	},
	apply: (c, args) => applyScene(sceneCtx(c), args),
	preview: (c, args) => previewScene(sceneCtx(c), args),
	'export-scene': (c) => exportSceneFile(sceneCtx(c)),
};

let toolCache: { name: string; title?: string; inputSchema: unknown }[] | null = null;
async function listTools(c: Ctx) {
	if (toolCache) return toolCache;
	// The in-process server lists without touching the engine.
	const { server } = createJasperMcpServer({ link: c.s.link, agentName: 'jasper-cli', toolsets: 'all' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'jasper-cli-list', version: MCP_SERVER_VERSION });
	await Promise.all([server.connect(a), client.connect(b)]);
	toolCache = (await client.listTools()).tools;
	await client.close();
	return toolCache;
}

/** --project / JASPER_PROJECT (id or name), else the editor window's project, else the only project. */
async function resolveProject(s: CliSession, wanted: string | undefined): Promise<string> {
	const cl = await s.link.client();
	const { projects } = await cl.listProjects();
	if (wanted) {
		const byId = projects.find((p) => p.projectId === wanted);
		if (byId) return byId.projectId;
		const byName = projects.filter((p) => p.name === wanted);
		if (byName.length === 1) return byName[0]!.projectId;
		if (byName.length > 1)
			throw new UsageError(
				`Several projects are named "${wanted}": ${byName.map((p) => p.projectId).join(', ')}`,
			);
		throw new UsageError(
			`No project "${wanted}". Projects: ${projects.map((p) => `${p.projectId} (${p.name})`).join(', ') || 'none'}`,
		);
	}
	const live = await cl
		.agentUi({ action: 'state', args: {} })
		.then((r) => (r.result as { projectId?: string | null })?.projectId ?? null)
		.catch(() => null);
	if (live) return live;
	if (projects.length === 1) return projects[0]!.projectId;
	throw new UsageError(
		projects.length
			? `Which project? Pass --project <id|name>: ${projects.map((p) => `${p.projectId} (${p.name})`).join(', ')}`
			: 'There are no projects yet: create one in the editor or with `jasper call create_project name=…`',
	);
}

/** Runs one CLI invocation; returns the exit status. */
export async function runCli(
	argv: readonly string[],
	io: Out & { env?: NodeJS.ProcessEnv; cwd?: string; link?: EngineConnection; signal?: AbortSignal },
): Promise<number> {
	let parsed: ParsedArgs;
	try {
		parsed = parseArgv(argv);
	} catch (e) {
		io.stderr(`jasper: ${(e as Error).message}\n`);
		return 2;
	}
	const { flags, positional } = parsed;
	const json = flags.json === true;
	if (flags.version) {
		io.stdout(`${MCP_SERVER_VERSION}\n`);
		return 0;
	}
	if (flags.help || positional.length === 0) {
		(positional.length === 0 && !flags.help ? io.stderr : io.stdout)(`${CLI_HELP}\n`);
		return flags.help ? 0 : 2;
	}
	const [cmd, ...rest] = positional;
	const run = COMMANDS[cmd!];
	if (!run) {
		io.stderr(`jasper: unknown command "${cmd}" (jasper --help lists them)\n`);
		return 2;
	}
	const env = io.env ?? process.env;
	const str = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined);
	const timeoutSec = Number(str('request-timeout'));
	const link =
		io.link ??
		new EngineLink({
			url: str('engine-url'),
			token: str('token'),
			appdir: str('appdir'),
			startEngine: flags['start-engine'] === true,
			engineEntry: str('engine-entry'),
			enginePort: str('engine-port') ? Number(str('engine-port')) : undefined,
			requestTimeoutMs: Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : undefined,
			startupTimeoutMs: startupTimeoutMs(str('startup-timeout'), env),
			env,
			log: (l) => io.stderr(`[jasper] ${l}\n`),
		});
	const s = await openSession(link, str('agent-name') ?? 'jasper-cli', io.stderr, io.signal);
	let projectId: string | null = null;
	const ctx: Ctx = {
		s,
		flags,
		out: io,
		json,
		cwd: io.cwd ?? process.cwd(),
		...(io.signal ? { signal: io.signal } : {}),
		projectId: async () => {
			projectId ??= await resolveProject(s, str('project') ?? env.JASPER_PROJECT);
			return projectId;
		},
		namedProject: !!(str('project') ?? env.JASPER_PROJECT),
	};
	try {
		await run(ctx, rest);
		return 0;
	} catch (e) {
		if (e instanceof UsageError) {
			if (json)
				io.stdout(`${JSON.stringify({ ok: false, error: { code: 'E_USAGE', message: e.message } })}\n`);
			io.stderr(`jasper: ${e.message}\n`);
			return 2;
		}
		const body =
			e instanceof CommandFailed
				? e.body
				: { error: { code: (e as { code?: string }).code ?? 'INTERNAL', message: (e as Error).message } };
		if (json) io.stdout(`${JSON.stringify({ ok: false, ...(body as object) })}\n`);
		const err = (body as { error?: { code?: string; message?: string; hint?: string } }).error;
		io.stderr(
			err
				? `jasper: ${err.code ?? 'ERROR'}: ${err.message ?? ''}${err.hint ? `\n  hint: ${err.hint}` : ''}\n`
				: `jasper: ${JSON.stringify(body)}\n`,
		);
		return 1;
	} finally {
		await s.close();
		if (!io.link) await link.close();
	}
}
