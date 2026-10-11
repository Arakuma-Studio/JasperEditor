#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/;
const NON_PRODUCTION =
	/(?:^|\/)(?:test|tests|__tests__|fixtures|__fixtures__|bench|benches)(?:\/|$)|\.(?:test|spec|bench)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/;
const pathKey = (file) => file.split(sep).join('/');

export function sourceFiles(root) {
	const files = [];
	const visit = (dir) => {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
			const file = join(dir, entry.name);
			if (NON_PRODUCTION.test(pathKey(relative(root, file)))) continue;
			if (entry.isDirectory()) visit(file);
			else if (entry.isFile() && SOURCE_EXTENSION.test(entry.name)) files.push(file);
		}
	};
	for (const top of ['apps', 'packages']) {
		const dir = join(root, top);
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
			if (entry.isDirectory() && existsSync(join(dir, entry.name, 'package.json')))
				visit(join(dir, entry.name, 'src'));
		}
	}
	return files.sort();
}

export function moduleReferences(file, text) {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const references = [];
	const add = (node, specifier, typeOnly = false, mode = ts.ModuleKind.ESNext) => {
		if (specifier && ts.isStringLiteralLike(specifier)) {
			references.push({
				spec: specifier.text,
				line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
				typeOnly,
				mode,
			});
		}
	};
	const visit = (node) => {
		if (ts.isImportDeclaration(node)) {
			const clause = node.importClause;
			const bindings = clause?.namedBindings;
			add(
				node,
				node.moduleSpecifier,
				Boolean(
					clause?.isTypeOnly ||
						(!clause?.name &&
							bindings &&
							ts.isNamedImports(bindings) &&
							bindings.elements.length > 0 &&
							bindings.elements.every((binding) => binding.isTypeOnly)),
				),
			);
		} else if (ts.isExportDeclaration(node)) {
			const bindings = node.exportClause;
			add(
				node,
				node.moduleSpecifier,
				node.isTypeOnly ||
					Boolean(
						bindings &&
							ts.isNamedExports(bindings) &&
							bindings.elements.length > 0 &&
							bindings.elements.every((binding) => binding.isTypeOnly),
					),
			);
		} else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
			add(node, node.moduleReference.expression, node.isTypeOnly, ts.ModuleKind.CommonJS);
		} else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
			add(node, node.argument.literal, true);
		} else if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === 'require'))
		) {
			add(
				node,
				node.arguments[0],
				false,
				node.expression.kind === ts.SyntaxKind.ImportKeyword ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS,
			);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return references;
}

function packageCompiler(root, file, cache) {
	const packageRoot = join(root, ...relative(root, file).split(sep).slice(0, 2));
	if (cache.has(packageRoot)) return cache.get(packageRoot);
	const config = ts.findConfigFile(packageRoot, ts.sys.fileExists);
	const parsed = config
		? ts.getParsedCommandLineOfConfigFile(
				config,
				{},
				{
					...ts.sys,
					onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
						throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
					},
				},
			)
		: undefined;
	if (parsed?.errors.length) {
		throw new Error(
			ts.formatDiagnostics(parsed.errors, {
				getCanonicalFileName: (file) => file,
				getCurrentDirectory: () => root,
				getNewLine: () => '\n',
			}),
		);
	}
	const options = {
		module: ts.ModuleKind.Preserve,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		...parsed?.options,
		// TypeScript otherwise prefers declaration-only export conditions over the runtime entry.
		noDtsResolution: true,
	};
	const compiler = { options, resolution: ts.createModuleResolutionCache(root, (file) => file, options) };
	cache.set(packageRoot, compiler);
	return compiler;
}

export function dependencyGraph(root) {
	root = resolve(root);
	const files = sourceFiles(root);
	const graph = new Map(files.map((file) => [file, []]));
	const optionsCache = new Map();
	for (const file of files) {
		const text = readFileSync(file, 'utf8');
		const { options, resolution } = packageCompiler(root, file, optionsCache);
		const references = moduleReferences(file, text);
		if (references.every((reference) => reference.typeOnly) && !options.verbatimModuleSyntax) continue;
		const emitted = ts.transpileModule(text, {
			fileName: file,
			compilerOptions: { ...options, noEmit: false, module: ts.ModuleKind.Preserve, sourceMap: false },
		}).outputText;
		const runtime = new Map(
			moduleReferences(`${file}.js`, emitted).map((reference) => [
				`${reference.mode}:${reference.spec}`,
				reference,
			]),
		);
		for (const { spec, mode } of runtime.values()) {
			const matching = references.filter((reference) => reference.spec === spec && reference.mode === mode);
			const reference = matching.find((reference) => !reference.typeOnly) ?? matching[0];
			if (!reference) continue;
			const target = ts.resolveModuleName(spec, file, options, ts.sys, resolution, undefined, reference.mode)
				.resolvedModule?.resolvedFileName;
			if (!target || !SOURCE_EXTENSION.test(target)) continue;
			const local = pathKey(relative(root, target));
			const segments = local.split('/');
			if (
				!['apps', 'packages'].includes(segments[0]) ||
				segments.some((segment) => segment.startsWith('.') || segment === 'node_modules') ||
				NON_PRODUCTION.test(local)
			)
				continue;
			if (!existsSync(join(root, segments[0], segments[1], 'package.json'))) continue;
			if (!graph.has(target)) {
				graph.set(target, []);
				files.push(target);
			}
			graph.get(file).push({ ...reference, target });
		}
	}
	return graph;
}

export function cyclicComponents(graph) {
	const visited = new Set();
	const order = [];
	const reverse = new Map([...graph.keys()].map((file) => [file, []]));
	for (const [file, edges] of graph) {
		for (const { target } of edges) reverse.get(target).push(file);
	}
	for (const file of graph.keys()) {
		if (visited.has(file)) continue;
		visited.add(file);
		const pending = [{ file, edges: graph.get(file)[Symbol.iterator]() }];
		while (pending.length) {
			const current = pending.at(-1);
			const next = current.edges.next();
			if (next.done) {
				order.push(current.file);
				pending.pop();
			} else if (!visited.has(next.value.target)) {
				visited.add(next.value.target);
				pending.push({ file: next.value.target, edges: graph.get(next.value.target)[Symbol.iterator]() });
			}
		}
	}
	visited.clear();
	const cycles = [];
	for (const file of order.reverse()) {
		if (visited.has(file)) continue;
		const component = [];
		const pending = [file];
		visited.add(file);
		while (pending.length) {
			const current = pending.pop();
			component.push(current);
			for (const importer of reverse.get(current)) {
				if (!visited.has(importer)) {
					visited.add(importer);
					pending.push(importer);
				}
			}
		}
		if (component.length > 1 || graph.get(file).some(({ target }) => target === file))
			cycles.push(component.sort());
	}
	return cycles.sort((a, b) => a[0].localeCompare(b[0]));
}

export function cycleViolations(root, graph = dependencyGraph(root)) {
	return cyclicComponents(graph).map((component) => {
		const members = new Set(component);
		const edges = component.flatMap((file) =>
			graph
				.get(file)
				.filter(({ target }) => members.has(target))
				.map((edge) => ({ file: pathKey(relative(root, file)), ...edge })),
		);
		const first = edges[0];
		return {
			file: first.file,
			line: first.line,
			rule: 'runtime-cycle',
			spec: first.spec,
			message: `cyclic runtime dependencies; move shared values below their consumers:\n${edges.map((edge) => `  ${edge.file}:${edge.line} -> ${pathKey(relative(root, edge.target))}`).join('\n')}`,
		};
	});
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
	const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
	const graph = dependencyGraph(root);
	const components = cyclicComponents(graph);
	console.log(
		`${graph.size} source modules, ${[...graph.values()].reduce((sum, edges) => sum + edges.length, 0)} runtime imports, ${components.length} cyclic components`,
	);
	for (const problem of cycleViolations(root, graph)) {
		console.error(`${problem.file}:${problem.line}  ${problem.rule}  ${problem.spec}\n  ${problem.message}`);
	}
	process.exitCode = components.length ? 1 : 0;
}
