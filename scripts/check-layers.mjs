#!/usr/bin/env node
// Allowed package edges are architecture decisions: update ARCHITECTURE §3.1 and its decision log.
// A `layers-allow: <reason>` comment on or above an import exempts that edge, never a runtime cycle.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cycleViolations, dependencyGraph, moduleReferences } from './check-cycles.mjs';

const NODE_BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const GROUPS = {
	node: {
		test: (s) => s.startsWith('node:') || NODE_BUILTINS.has(s) || NODE_BUILTINS.has(s.split('/')[0]),
		why: 'Node built-ins: this package runs in the browser (and must stay portable)',
	},
	react: {
		test: (s) => /^(?:react|react-dom)(?:\/|$)/.test(s),
		why: 'React: this layer has no UI',
	},
	uiLibs: {
		test: (s) =>
			/^(?:@radix-ui\/|(?:radix-ui|lucide-react|dockview|dockview-react|dockview-core|react-router)(?:\/|$))/.test(
				s,
			),
		why: 'UI libraries belong to apps/web and @jasper/ui',
	},
	tailwind: {
		test: (s) => /^(?:@tailwindcss\/|tailwindcss(?:\/|$))/.test(s),
		why: 'compositions use inline styles only (D-14): the Remotion bundle has no Tailwind',
	},
	remotion: {
		test: (s) => /^(?:@remotion\/|remotion(?:\/|$))/.test(s),
		why: 'Remotion belongs to compositions, motion, web (Player) and the engine (renderer/bundler)',
	},
	anime: {
		test: (s) => s === 'animejs' || s.startsWith('animejs/'),
		why: 'anime.js is used only inside @jasper/motion (D-31)',
	},
	electron: { test: (s) => /^electron(?:\/|$)/.test(s), why: 'Electron belongs to apps/desktop only' },
	server: {
		test: (s) =>
			/^(?:@fastify\/|(?:fastify|ws|onnxruntime-node|@techstark\/opencv-js|esbuild)(?:\/|$))/.test(s),
		why: 'engine-only (server, native and build) modules',
	},
};
const BROWSER_LAYER = ['node', 'electron', 'server'];

/**
 * The table (ARCHITECTURE §3.1). `deps`: workspace packages its source may import; `testDeps`: extra ones only tests
 * may use (devDependencies); `typeDeps`: explicit type imports only; `forbid`: keys of GROUPS;
 * `nodeOnly`: source files that are Node scripts (Node
 * built-ins allowed, with the reason); `reactOnlyUnder`: React only in this subdirectory of `src/`.
 */
const LAYERS = {
	'packages/audio-dsp': {
		name: '@jasper/audio-dsp',
		deps: [],
		forbid: [...BROWSER_LAYER, 'react', 'uiLibs', 'tailwind', 'remotion', 'anime'],
		note: 'dependency-free DSP: no DOM, no Node, no zod',
	},
	'packages/testkit': {
		name: '@jasper/testkit',
		deps: [],
		forbid: ['react', 'uiLibs', 'tailwind', 'remotion', 'anime', 'electron'],
		note: 'test-only: Node, vitest, fast-check and Playwright; no workspace dependencies',
	},
	'packages/project': {
		name: '@jasper/project',
		deps: ['@jasper/audio-dsp'],
		testDeps: ['@jasper/testkit'],
		forbid: [...BROWSER_LAYER, 'react', 'uiLibs', 'tailwind', 'remotion', 'anime'],
		note: 'the pure model: zod, immer and @jasper/audio-dsp only, no DOM, no Node, no UI, no Remotion, no engine',
	},
	'packages/audio-fx': {
		name: '@jasper/audio-fx',
		deps: ['@jasper/audio-dsp', '@jasper/project'],
		forbid: [...BROWSER_LAYER, 'react', 'uiLibs', 'tailwind', 'remotion', 'anime'],
		note: 'pure effect DSP: no DOM, no Node, no UI',
	},
	'packages/mg-templates': {
		name: '@jasper/mg-templates',
		deps: ['@jasper/project'],
		forbid: [...BROWSER_LAYER, 'react', 'uiLibs', 'tailwind', 'remotion', 'anime'],
	},
	// Wave expressions (docs/wp-notes/expressions.md): the After Effects-style expression engine (QuickJS compiled to
	// WebAssembly, acorn). It sits right above the model: @jasper/project only holds the storage and the evaluator hook
	// (`EXPRESSION_BINDING`), so the model stays free of WebAssembly. Runs in the browser, the Remotion bundle and Node.
	'packages/expressions': {
		name: '@jasper/expressions',
		deps: ['@jasper/project'],
		testDeps: ['@jasper/testkit'],
		forbid: [...BROWSER_LAYER, 'react', 'uiLibs', 'tailwind', 'remotion', 'anime'],
		note: 'QuickJS-wasm + the AE object model: no DOM, no Node, no UI, no Remotion',
	},
	// Timeline interchange (docs/wp-notes/interchange.md): FCP7 XML, FCPXML, OTIO, EDL, AAF, OMF, ALE readers and
	// writers over the pure model. Pure TypeScript (no fs): the engine reads/writes files, probes, relinks, renders.
	'packages/interchange': {
		name: '@jasper/interchange',
		deps: ['@jasper/project'],
		testDeps: ['@jasper/testkit'],
		forbid: [...BROWSER_LAYER, 'react', 'uiLibs', 'tailwind', 'remotion', 'anime'],
		note: 'bytes in, bytes out: no DOM, no Node, no UI',
	},
	'packages/api': {
		name: '@jasper/api',
		deps: ['@jasper/project'],
		forbid: [...BROWSER_LAYER, 'react', 'uiLibs', 'tailwind', 'remotion', 'anime'],
	},
	'packages/engine-client': {
		name: '@jasper/engine-client',
		deps: ['@jasper/api'],
		forbid: [...BROWSER_LAYER, 'react', 'uiLibs', 'tailwind', 'remotion', 'anime'],
		note: 'fetch + ReadableStream only: runs in the browser and in Node 20',
	},
	'packages/session': {
		name: '@jasper/session',
		deps: ['@jasper/project', '@jasper/api', '@jasper/engine-client'],
		forbid: [...BROWSER_LAYER, 'uiLibs', 'tailwind', 'remotion', 'anime'],
		reactOnlyUnder: 'react/',
	},
	'packages/ui': {
		name: '@jasper/ui',
		deps: ['@jasper/project'],
		forbid: [...BROWSER_LAYER, 'remotion', 'anime', 'tailwind'],
	},
	'packages/motion': {
		name: '@jasper/motion',
		deps: ['@jasper/project', '@jasper/mg-templates'],
		forbid: [...BROWSER_LAYER, 'uiLibs', 'tailwind'],
		allowAnime: true,
	},
	'packages/compositions': {
		name: '@jasper/compositions',
		deps: [
			'@jasper/project',
			'@jasper/mg-templates',
			'@jasper/motion',
			'@jasper/audio-dsp',
			'@jasper/audio-fx',
			'@jasper/expressions',
		],
		testDeps: ['@jasper/testkit'],
		forbid: [...BROWSER_LAYER, 'uiLibs', 'tailwind', 'anime'],
		note: 'the Remotion bundle: no session, ui, engine-client or Tailwind',
	},
	'packages/config': {
		name: '@jasper/config',
		deps: [],
		forbid: ['react', 'uiLibs', 'tailwind', 'remotion', 'anime', 'electron', 'server'],
		note: 'appdir layout, env, ports: Node only',
	},
	'apps/web': {
		name: '@jasper/web',
		deps: [
			'@jasper/api',
			'@jasper/audio-dsp',
			'@jasper/audio-fx',
			'@jasper/compositions',
			'@jasper/engine-client',
			'@jasper/expressions',
			'@jasper/interchange',
			'@jasper/mg-templates',
			'@jasper/project',
			'@jasper/session',
			'@jasper/ui',
		],
		forbid: [...BROWSER_LAYER, 'anime'],
		nodeOnly: {
			'apps/web/src/pwa/generate-icons.mjs': 'icon generator run with `node`, not bundled',
		},
	},
	'apps/engine': {
		name: '@jasper/engine',
		// @jasper/mcp: the engine serves the same MCP tools over Streamable HTTP at /mcp (D-18, routes/mcp.ts).
		deps: [
			'@jasper/api',
			'@jasper/audio-dsp',
			'@jasper/audio-fx',
			'@jasper/compositions',
			'@jasper/config',
			'@jasper/expressions',
			'@jasper/interchange',
			'@jasper/mcp',
			'@jasper/mg-templates',
			'@jasper/project',
		],
		testDeps: ['@jasper/engine-client', '@jasper/session', '@jasper/testkit'],
		forbid: ['uiLibs', 'tailwind', 'anime', 'electron'],
	},
	'apps/mcp': {
		name: '@jasper/mcp',
		deps: [
			'@jasper/api',
			'@jasper/config',
			'@jasper/engine-client',
			'@jasper/expressions',
			'@jasper/project',
		],
		// tests may drive the tools against the real template catalogue (the engine serves it in production)
		testDeps: ['@jasper/testkit', '@jasper/mg-templates'],
		forbid: ['react', 'uiLibs', 'tailwind', 'remotion', 'anime', 'electron', 'server'],
	},
	'apps/desktop': {
		name: '@jasper/desktop',
		deps: ['@jasper/config'],
		typeDeps: ['@jasper/api'],
		forbid: ['react', 'uiLibs', 'tailwind', 'remotion', 'anime', 'server'],
		note: 'the Electron shell only: it loads the SPA over HTTP and forks the engine bundle',
	},
};

const APPS = new Set(Object.entries(LAYERS).flatMap(([dir, l]) => (dir.startsWith('apps/') ? [l.name] : [])));

const allowedLine = (lines, i) => {
	const at = (l) => /layers-allow:\s*\S/.test(l ?? '');
	return at(lines[i]) || at(lines[i - 1]);
};

/** `@jasper/x/sub` → `{pkg: '@jasper/x', sub: './sub'}`; external specs → package name. */
function splitSpec(spec) {
	const parts = spec.split('/');
	const pkg = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
	const rest = spec.startsWith('@') ? parts.slice(2) : parts.slice(1);
	return { pkg, sub: rest.length ? `./${rest.join('/')}` : '.' };
}

const fix = {
	edge: (from, to) =>
		`${to} is not an allowed dependency of ${from} (ARCHITECTURE §3.1); move the code to a lower layer or record a decision and add the edge to LAYERS in scripts/check-layers.mjs`,
	declare: (dir, to) => `add "${to}": "workspace:*" to ${dir}/package.json dependencies`,
};

/**
 * Violations of one source file. `rel` is repo-relative with `/`; `ctx` = {dir, layer, declared: Set, exportsOf(name)}.
 * @returns {{line: number, rule: string, spec: string, message: string}[]}
 */
function fileViolations(rel, text, ctx) {
	const { dir, layer } = ctx;
	const out = [];
	const lines = text.split('\n');
	const nodeOnly = layer.nodeOnly && Object.hasOwn(layer.nodeOnly, rel);
	const inReactDir = layer.reactOnlyUnder && rel.startsWith(`${dir}/src/${layer.reactOnlyUnder}`);
	for (const imp of moduleReferences(rel, text)) {
		const { spec, line } = imp;
		if (allowedLine(lines, line - 1)) continue;
		const v = (rule, message) => out.push({ line, rule, spec, message });
		if (spec.startsWith('.') || spec.startsWith('/')) {
			const target = resolve('/', dirname(rel), spec).slice(1);
			if (!target.startsWith(`${dir}/`)) {
				const other = Object.keys(LAYERS).find((d) => target.startsWith(`${d}/`));
				if (dir.startsWith('packages/') && target.startsWith('apps/'))
					v('package-imports-app', 'packages/* never import apps/*: move the shared code into a package');
				else
					v(
						'relative-outside-package',
						other
							? `relative import into ${other}: import it from \`${LAYERS[other].name}\` (its public exports) instead`
							: 'relative import leaves the package root: move the file into the package or make it a package export',
					);
			}
			continue;
		}
		const { pkg, sub } = splitSpec(spec);
		if (pkg.startsWith('@jasper/')) {
			if (pkg === layer.name) {
				v('self-import', `import your own package's files relatively, not through \`${pkg}\``);
				continue;
			}
			if (dir.startsWith('packages/') && APPS.has(pkg)) {
				v('package-imports-app', 'packages/* never import apps/*: move the shared code into a package');
				continue;
			}
			if (!layer.deps.includes(pkg) && !(imp.typeOnly && layer.typeDeps?.includes(pkg))) {
				v('forbidden-edge', fix.edge(layer.name, pkg));
				continue;
			}
			if (!ctx.declared.has(pkg) && !(imp.typeOnly && ctx.declaredTypes?.has(pkg)))
				v('undeclared-dependency', fix.declare(dir, pkg));
			const exp = ctx.exportsOf(pkg);
			if (exp && !exp.includes(sub))
				v(
					'not-exported',
					`\`${spec}\` is not in ${pkg}'s package.json "exports" (${exp.join(', ')}): import the public entry, or export the subpath`,
				);
			continue;
		}
		if (GROUPS.anime.test(spec) && !layer.allowAnime) {
			v('forbidden-external', `${spec}: ${GROUPS.anime.why}`);
			continue;
		}
		if (GROUPS.react.test(spec) && layer.reactOnlyUnder && !inReactDir) {
			v(
				'forbidden-external',
				`${spec}: React only under ${dir}/src/${layer.reactOnlyUnder} (the ./react subpath)`,
			);
			continue;
		}
		for (const g of layer.forbid) {
			if (g === 'node' && nodeOnly) continue;
			if (GROUPS[g].test(spec)) {
				v('forbidden-external', `${spec}: ${GROUPS[g].why} (${layer.name} may not import it)`);
				break;
			}
		}
	}
	return out;
}

function manifestViolations(dir, layer, pkg) {
	const out = [];
	const where = `${dir}/package.json`;
	if (pkg.name !== layer.name)
		out.push({ file: where, line: 1, rule: 'name', spec: pkg.name, message: `expected name ${layer.name}` });
	const check = (field, allowed) => {
		for (const dep of Object.keys(pkg[field] ?? {})) {
			if (!dep.startsWith('@jasper/')) continue;
			if (dir.startsWith('packages/') && APPS.has(dep))
				out.push({
					file: where,
					line: 1,
					rule: 'package-imports-app',
					spec: dep,
					message: `${field}: packages/* never depend on apps/*`,
				});
			else if (!allowed.includes(dep))
				out.push({
					file: where,
					line: 1,
					rule: 'forbidden-edge',
					spec: dep,
					message: `${field}: ${fix.edge(layer.name, dep)}`,
				});
		}
	};
	const productionDeps = [...layer.deps, ...(layer.typeDeps ?? [])];
	check('dependencies', productionDeps);
	check('peerDependencies', productionDeps);
	check('optionalDependencies', productionDeps);
	check('devDependencies', [...productionDeps, ...(layer.testDeps ?? [])]);
	return out;
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** Subpaths a workspace package exports (`['.', './react']`), or null when it has no `exports` field. */
function exportsOf(root, name) {
	for (const dir of Object.keys(LAYERS)) {
		if (LAYERS[dir].name !== name) continue;
		const file = join(root, dir, 'package.json');
		if (!existsSync(file)) return null;
		const exp = readJson(file).exports;
		if (!exp) return null;
		return typeof exp === 'string' ? ['.'] : Object.keys(exp);
	}
	return null;
}

export function checkRepo(root) {
	root = resolve(root);
	const problems = [];
	const graph = dependencyGraph(root);
	const sources = [...graph.keys()];
	for (const top of ['packages', 'apps']) {
		if (!existsSync(join(root, top))) continue;
		const names = readdirSync(join(root, top));
		for (const n of names) {
			if (n.startsWith('.') || n === 'node_modules') continue;
			const dir = `${top}/${n}`;
			const manifest = join(root, dir, 'package.json');
			if (!existsSync(manifest)) continue;
			const layer = LAYERS[dir];
			if (!layer) {
				problems.push({
					file: `${dir}/package.json`,
					line: 1,
					rule: 'unknown-package',
					spec: n,
					message:
						'a new workspace package needs a row in LAYERS (scripts/check-layers.mjs) and in ARCHITECTURE §3.1: which packages may it use, and which may use it?',
				});
				continue;
			}
			const pkg = readJson(manifest);
			problems.push(...manifestViolations(dir, layer, pkg));
			const declared = new Set(
				['dependencies', 'peerDependencies', 'optionalDependencies'].flatMap((f) =>
					Object.keys(pkg[f] ?? {}),
				),
			);
			for (const file of sources.filter((file) => file.startsWith(`${join(root, dir)}${sep}`))) {
				const rel = relative(root, file).split(sep).join('/');
				const ctx = {
					dir,
					layer,
					declared,
					declaredTypes: new Set(Object.keys(pkg.devDependencies ?? {})),
					exportsOf: (name) => exportsOf(root, name),
				};
				for (const v of fileViolations(rel, readFileSync(file, 'utf8'), ctx))
					problems.push({ file: rel, ...v });
			}
		}
	}
	return [...problems, ...cycleViolations(root, graph)];
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
	const root = join(dirname(fileURLToPath(import.meta.url)), '..');
	const problems = checkRepo(root);
	if (problems.length > 0) {
		for (const p of problems) console.error(`${p.file}:${p.line}  ${p.rule}  ${p.spec}\n  ${p.message}`);
		console.error(
			`\ncheck-layers: ${problems.length} problem(s). The dependency table is ARCHITECTURE §3.1 (LAYERS in scripts/check-layers.mjs); \`layers-allow: <reason>\` excuses one line.`,
		);
		process.exit(1);
	}
	console.log('check-layers: ok');
}
