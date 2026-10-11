// The sandboxed JavaScript engine: QuickJS compiled to WebAssembly (quickjs-emscripten, MIT). One runtime and one
// context per JavaScript realm (browser tab, Remotion render page, Node process), the prelude loaded once, every
// expression compiled once into a function and cached by text.
//
// Why QuickJS-wasm: the same WebAssembly binary runs in the editor (browser), the Remotion renderer (headless
// Chrome) and Node (engine native export, MCP), so expression maths — including Math.sin/exp/pow, which are libm
// code inside the binary rather than the host's — is bit-identical everywhere. It has no I/O (no std/os modules
// are linked), a memory limit, a stack limit and an interrupt hook for a time limit.
//
// Limits: memory 64 MiB, stack 160 KiB, and an operation budget: QuickJS calls the interrupt hook every ~10 000
// interpreter steps (calls and loop iterations), and an evaluation that reaches OPERATION_BUDGET hook calls (~5 M
// steps, ~0.5 s) is stopped deterministically. A wall-clock guard (WALL_CLOCK_MS) also stops runaway host work; on
// any machine that renders in real time it is never the first limit reached.
import {
	newQuickJSWASMModuleFromVariant,
	type QuickJSContext,
	type QuickJSHandle,
	type QuickJSRuntime,
	type QuickJSWASMModule,
} from 'quickjs-emscripten-core';
import { compileExpressionSource, setRealmGlobals } from './compile.ts';
import { HARDEN } from './harden.ts';
import { PRELUDE } from './prelude.ts';

export const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
/**
 * QuickJS's own stack limit. It must trip before the host engine's (V8's ~1 MB) native stack overflows under the
 * WebAssembly frames, which would abort the instance instead of throwing a catchable "stack overflow": 160 KiB
 * allows ~800 nested JavaScript calls (measured; AE expressions rarely recurse at all).
 */
export const STACK_LIMIT_BYTES = 160 * 1024;
/** Interrupt-hook calls (≈ 10 000 interpreter steps each) one top-level evaluation may use. */
export const OPERATION_BUDGET = 500;
export const WALL_CLOCK_MS = 2000;
/** Expressions reading each other nest up to this depth (cycles stop here with an error). */
export const MAX_DEPTH = 16;
const MAX_FUNCTIONS = 2048;
/**
 * Expressions stopped by a resource limit are not run again in this realm: the heap limit, the operation budget,
 * the wall-clock guard, or a run past twice the wall-clock limit (time spent where the interrupt hook cannot fire:
 * native built-ins, the garbage collector at the memory limit). One such evaluation blocks its thread for up to
 * seconds; without the quarantine a hostile project paid that per frame and per property, freezing the editor or the
 * engine (docs/security-review.md, EXPR-2). Which limit trips first depends on the machine and its load (on a busy
 * host the wall clock can come before the heap), so every one of them quarantines.
 */
const quarantine = new Map<string, string>();
const MAX_QUARANTINE = 512;

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
	// The engine (~580 KB of JavaScript with the WebAssembly inlined) is a lazy chunk: bundles only fetch it when a
	// document has expressions.
	if (!modulePromise)
		modulePromise = import('@jitl/quickjs-singlefile-browser-release-sync').then((m) =>
			newQuickJSWASMModuleFromVariant(m.default),
		);
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

const hosts: HostHandler[] = [];
let depth = 0;
let ticks = 0;
let deadline = 0;
/** Why the interrupt hook stopped the current top-level evaluation (null: it did not). */
let interruptedBy: 'operations' | 'clock' | null = null;

function createEngine(module: QuickJSWASMModule): Engine {
	const runtime = module.newRuntime();
	runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
	runtime.setMaxStackSize(STACK_LIMIT_BYTES);
	runtime.setInterruptHandler(() => {
		if (depth === 0) return false;
		ticks++;
		if (ticks > OPERATION_BUDGET) interruptedBy = 'operations';
		else if (ticks % 16 === 0 && now() > deadline) interruptedBy = 'clock';
		return interruptedBy !== null;
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
	// Nothing an expression does may outlive its evaluation (harden.ts): frozen intrinsics, read-only globals.
	const hardened = context.evalCode(HARDEN, 'harden.js');
	if (hardened.error) {
		const err = context.dump(hardened.error);
		hardened.error.dispose();
		throw new Error(`expression realm hardening: ${JSON.stringify(err)}`);
	}
	hardened.value.dispose();
	const names = context.evalCode('Object.getOwnPropertyNames(globalThis)', 'globals.js');
	if (names.error) {
		names.error.dispose();
		throw new Error('expression realm: cannot list the global names');
	}
	// Implicit globals of expressions become locals of their function, except names the realm defines.
	setRealmGlobals(context.dump(names.value) as string[]);
	names.value.dispose();
	const run = context.getProp(context.global, '__run');
	return { module, runtime, context, run, functions: new Map() };
}

let clock: (() => number) | null = null;
function now(): number {
	if (clock) return clock();
	return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Tests: replace the wall clock the limits read (null restores it). */
export function setExpressionClockForTests(fn: (() => number) | null): void {
	clock = fn;
}

/** Tests: forget every quarantined expression. */
export function clearExpressionQuarantineForTests(): void {
	quarantine.clear();
}

/**
 * The WebAssembly instance aborted (a QuickJS assertion or a host-side failure): drop it and load a fresh one in the
 * background. Evaluations meanwhile report an error (the properties render their keyframed values). Running out of
 * the 64 MiB heap is not fatal: QuickJS throws, the expression's objects are freed as the stack unwinds.
 */
function abandonEngine(reason: string): void {
	engine = null;
	modulePromise = null;
	loadError = `Error: the expression engine stopped (${reason}); it is restarting`;
	void loadExpressionEngine().then(
		() => {
			loadError = null;
		},
		() => {},
	);
}

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

function quarantineText(text: string, error: string): void {
	if (quarantine.size >= MAX_QUARANTINE) quarantine.clear();
	quarantine.set(text, `${error} (it is not run again until the editor or engine restarts)`);
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
	const banned = quarantine.get(text);
	if (banned) return { ok: false, error: banned };
	const c = compiled(e, text);
	if ('error' in c) return { ok: false, error: c.error };
	const top = depth === 0;
	const started = now();
	if (top) {
		ticks = 0;
		interruptedBy = null;
		deadline = now() + WALL_CLOCK_MS;
	}
	depth++;
	hosts.push(host);
	try {
		const json = e.context.newString(JSON.stringify({ ...state, top }));
		const r = e.context.callFunction(e.run, e.context.undefined, c.fn, json);
		json.dispose();
		if (r.error) {
			const dumped = e.context.dump(r.error);
			r.error.dispose();
			let error = formatError(dumped);
			const interrupted = /took too long/.test(error);
			if (interrupted && interruptedBy === 'clock')
				error = error.replace(
					/the expression took too long \([^)]*\)/,
					`the expression took too long (over ${WALL_CLOCK_MS / 1000} s)`,
				);
			// A resource limit, whichever tripped first: never run it again (EXPR-2). Ordinary errors (a typo, a bad
			// reference) are cheap and are reported again on every evaluation. The operation budget and the clock belong
			// to the top-level evaluation: an expression it reads that happened to be running when they ran out is not
			// to blame, the one that started the evaluation is.
			if ((interrupted && top) || /ran out of memory/.test(error) || now() - started > 2 * WALL_CLOCK_MS)
				quarantineText(text, error);
			return { ok: false, error };
		}
		const out = e.context.getString(r.value);
		r.value.dispose();
		return { ok: true, result: (JSON.parse(out) as { r?: unknown }).r };
	} catch (err) {
		const msg = (err as Error).message ?? String(err);
		if (depth === 1) abandonEngine(msg);
		return { ok: false, error: `Error: ${msg}` };
	} finally {
		hosts.pop();
		depth--;
	}
}
