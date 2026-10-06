// The sandboxed JavaScript engine: QuickJS compiled to WebAssembly (quickjs-emscripten, MIT). One runtime and one
// context per JavaScript realm (browser tab, Remotion render page, Node process), the prelude loaded once, every
// expression compiled once into a function and cached by text.
//
// Why QuickJS-wasm: the same WebAssembly binary runs in the editor (browser), the Remotion renderer (headless
// Chrome) and Node (engine native export, MCP), so expression maths — including Math.sin/exp/pow, which are libm
// code inside the binary rather than the host's — is bit-identical everywhere. It has no I/O (no std/os modules
// are linked), a memory limit, a stack limit and an interrupt hook for a time limit.
//
// Limits: memory 64 MiB, stack 1 MiB, and an operation budget: QuickJS calls the interrupt hook every ~10 000
// interpreter steps (calls and loop iterations), and an evaluation that reaches OPERATION_BUDGET hook calls (~5 M
// steps, ~0.5 s) is stopped deterministically. A wall-clock guard (WALL_CLOCK_MS) also stops runaway host work; on
// any machine that renders in real time it is never the first limit reached.
import variant from '@jitl/quickjs-singlefile-browser-release-sync';
import {
	newQuickJSWASMModuleFromVariant,
	type QuickJSContext,
	type QuickJSHandle,
	type QuickJSRuntime,
	type QuickJSWASMModule,
} from 'quickjs-emscripten-core';
import { compileExpressionSource } from './compile.ts';
import { PRELUDE } from './prelude.ts';

export const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
export const STACK_LIMIT_BYTES = 1024 * 1024;
/** Interrupt-hook calls (≈ 10 000 interpreter steps each) one top-level evaluation may use. */
export const OPERATION_BUDGET = 500;
export const WALL_CLOCK_MS = 2000;
/** Expressions reading each other nest up to this depth (cycles stop here with an error). */
export const MAX_DEPTH = 16;
const MAX_FUNCTIONS = 2048;

/** Answers a host request (`op`, JSON args) with JSON. Throwing becomes a JavaScript error in the expression. */
export type HostHandler = (op: number, args: unknown[]) => unknown;

/** The per-evaluation state handed to the prelude's `__run`. */
export type RunState = {
	time: number;
	value: unknown;
	seq: string;
	owner: string;
	path: string;
	/** Random/wiggle seed of the property (stable across edits: owner id + property path). */
	seed: string;
	/** Frame duration in seconds. */
	fd: number;
	kind: string;
	textIndex: number;
	textTotal: number;
	selectorValue: [number, number, number];
};

export type RunOutcome = { ok: true; result: unknown } | { ok: false; error: string };

type Engine = {
	module: QuickJSWASMModule;
	runtime: QuickJSRuntime;
	context: QuickJSContext;
	run: QuickJSHandle;
	functions: Map<string, { fn: QuickJSHandle } | { error: string }>;
};

let modulePromise: Promise<QuickJSWASMModule> | null = null;
let engine: Engine | null = null;
let loadError: string | null = null;

/** Loads the WebAssembly engine (idempotent). Everything else is synchronous once this resolved. */
export function loadExpressionEngine(): Promise<void> {
	if (engine) return Promise.resolve();
	if (!modulePromise) modulePromise = newQuickJSWASMModuleFromVariant(variant);
	return modulePromise.then(
		(m) => {
			if (!engine) engine = createEngine(m);
		},
		(e) => {
			loadError = `Error: the expression engine could not be loaded (${(e as Error).message ?? e})`;
			modulePromise = null;
			throw e;
		},
	);
}

export function isExpressionEngineLoaded(): boolean {
	return engine !== null;
}

// ---------------------------------------------------------------- host request stack

const hosts: HostHandler[] = [];
let depth = 0;
let ticks = 0;
let deadline = 0;

function createEngine(module: QuickJSWASMModule): Engine {
	const runtime = module.newRuntime();
	runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
	runtime.setMaxStackSize(STACK_LIMIT_BYTES);
	runtime.setInterruptHandler(() => {
		if (depth === 0) return false;
		ticks++;
		return ticks > OPERATION_BUDGET || (ticks % 16 === 0 && now() > deadline);
	});
	const context = runtime.newContext();
	const host = context.newFunction('__host', (opH, argsH) => {
		const handler = hosts[hosts.length - 1];
		if (!handler) return { error: context.newError('expression host request outside an evaluation') };
		try {
			const op = context.getNumber(opH);
			const args = JSON.parse(context.getString(argsH)) as unknown[];
			const out = handler(op, args);
			return context.newString(JSON.stringify(out === undefined ? null : out));
		} catch (e) {
			return { error: context.newError((e as Error).message ?? String(e)) };
		}
	});
	context.setProp(context.global, '__host', host);
	host.dispose();
	const prelude = context.evalCode(PRELUDE, 'prelude.js');
	if (prelude.error) {
		const err = context.dump(prelude.error);
		prelude.error.dispose();
		throw new Error(`expression prelude: ${JSON.stringify(err)}`);
	}
	prelude.value.dispose();
	const run = context.getProp(context.global, '__run');
	return { module, runtime, context, run, functions: new Map() };
}

function now(): number {
	return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Replace the runtime after a fatal condition (out of memory): every cached function is dropped. */
function resetEngine(): void {
	if (!engine || depth > 0) return;
	const m = engine.module;
	try {
		for (const f of engine.functions.values()) if ('fn' in f) f.fn.dispose();
		engine.run.dispose();
		engine.context.dispose();
		engine.runtime.dispose();
	} catch {
		// A runtime that ran out of memory may refuse to free cleanly; it is abandoned either way.
	}
	engine = createEngine(m);
}

// ---------------------------------------------------------------- errors

/** QuickJS error → `Error at line N: message` (the user's line; the wrapper shares line 1). */
function formatError(dumped: unknown): string {
	if (dumped && typeof dumped === 'object') {
		const d = dumped as { name?: string; message?: string; stack?: string };
		let msg = d.message ?? String(dumped);
		if (d.name === 'InternalError' && msg === 'interrupted')
			msg = 'the expression took too long (operation limit reached; is there an endless loop?)';
		else if (/out of memory/i.test(msg)) msg = 'the expression ran out of memory';
		else if (/stack overflow/i.test(msg)) msg = 'too much recursion (stack overflow)';
		else if (d.name && d.name !== 'Error') msg = `${d.name}: ${msg}`;
		const line = /expression:(\d+)/.exec(d.stack ?? '')?.[1];
		return line ? `Error at line ${line}: ${msg}` : `Error: ${msg}`;
	}
	return `Error: ${String(dumped)}`;
}

// ---------------------------------------------------------------- compile and run

function compiled(e: Engine, text: string): { fn: QuickJSHandle } | { error: string } {
	const hit = e.functions.get(text);
	if (hit) {
		// LRU: most recently used last.
		e.functions.delete(text);
		e.functions.set(text, hit);
		return hit;
	}
	const src = compileExpressionSource(text);
	let entry: { fn: QuickJSHandle } | { error: string };
	if (!src.ok) entry = { error: src.error };
	else {
		const r = e.context.evalCode(src.code, 'expression');
		if (r.error) {
			entry = { error: formatError(e.context.dump(r.error)) };
			r.error.dispose();
		} else entry = { fn: r.value };
	}
	if (e.functions.size >= MAX_FUNCTIONS) {
		const oldest = e.functions.keys().next().value as string;
		const old = e.functions.get(oldest);
		// Functions on the evaluation stack stay alive: only evict at depth 0.
		if (old && depth === 0) {
			if ('fn' in old) old.fn.dispose();
			e.functions.delete(oldest);
		}
	}
	e.functions.set(text, entry);
	return entry;
}

/** Syntax check of an expression (`null` = compiles). Needs no loaded engine for parse errors. */
export function checkExpressionSyntax(text: string): string | null {
	const src = compileExpressionSource(text);
	if (!src.ok) return src.error;
	if (!engine) return null;
	const c = compiled(engine, text);
	return 'error' in c ? c.error : null;
}

/**
 * Runs one expression with `state`; `host` answers its project requests (it may call `runExpression` again for
 * properties the expression reads). Never throws: failures come back as AE-style messages.
 */
export function runExpression(text: string, state: RunState, host: HostHandler): RunOutcome {
	const e = engine;
	if (!e) return { ok: false, error: loadError ?? 'Error: the expression engine is still loading' };
	if (depth >= MAX_DEPTH)
		return { ok: false, error: 'Error: expressions reference each other too deeply (circular reference?)' };
	const c = compiled(e, text);
	if ('error' in c) return { ok: false, error: c.error };
	const top = depth === 0;
	if (top) {
		ticks = 0;
		deadline = now() + WALL_CLOCK_MS;
	}
	depth++;
	hosts.push(host);
	let fatal = false;
	try {
		const json = e.context.newString(JSON.stringify({ ...state, top }));
		const r = e.context.callFunction(e.run, e.context.undefined, c.fn, json);
		json.dispose();
		if (r.error) {
			const dumped = e.context.dump(r.error);
			r.error.dispose();
			const msg = formatError(dumped);
			fatal = /ran out of memory/.test(msg);
			return { ok: false, error: msg };
		}
		const out = e.context.getString(r.value);
		r.value.dispose();
		return { ok: true, result: out === undefined ? undefined : JSON.parse(out) };
	} catch (err) {
		fatal = true;
		return { ok: false, error: `Error: ${(err as Error).message ?? String(err)}` };
	} finally {
		hosts.pop();
		depth--;
		if (fatal && depth === 0) resetEngine();
	}
}
