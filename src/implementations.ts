import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { crashText, runStrict, StrictRun, testDuration, testResults } from './nativeCompiler';
import { compilerFile, strictPath } from './paths';
import { isTest } from './scrunchDiscover';
import { isNamed, keywords, parseType, resolve, Resolved, Scope, StrictMethod, StrictType, typeNamed } from './strictIndex';

export type ExistingCall = { owner: StrictType; method: StrictMethod; call?: string };
export type SharedRun = { bodies: Promise<string[]>; waiting: Array<() => boolean> };
export type Evaluation = { value?: string; error?: string };
type Value = { name: string; type: string };

const tokenPattern = /"(?:[^"\\]|\\.)*"|\d+(?:\.\d+)?|[A-Za-z_]\w*|\S/g;
const literalPattern = /"(?:[^"\\]|\\.)*"|-?\b\d+(?:\.\d+)?\b/g;
const implementationStart = /^(for|if|return|constant|mutable|let)\b/;
const wordOperators = new Set(['and', 'or', 'xor', 'is']);
const minimumCopyTokens = 12;
const maximumCandidates = 32;
const parallelRuns = Math.max(1, Math.floor(os.cpus().length / 2));
const normalizedBodies = new WeakMap<StrictMethod, { tokens: string; count: number; names: string[] }>();
const suggestionCommands = new Map<string, Promise<boolean>>();

// Matches tokens with consistent renaming; reordered or partially changed copies do not match.
export function copiedFrom(method: StrictMethod, own: StrictType, types: StrictType[]): ExistingCall | undefined {
	const typeNames = new Set(types.map((type) => type.name));
	const copy = normalized(method, typeNames);
	if (copy.count < minimumCopyTokens) {
		return undefined;
	}
	for (const type of types.filter((candidate) => candidate.file !== own.file)) {
		for (const existing of type.methods.filter((candidate) => isNamed(candidate.name))) {
			const original = normalized(existing, typeNames);
			if (original.tokens === copy.tokens) {
				const counterpart = (name: string): string | undefined => copy.names[original.names.indexOf(name)];
				const has = type.members.filter((member) => member.text.startsWith('has '));
				const receiver = original.names.includes('value') ? counterpart('value') : has.length === 1 &&
					original.names.includes(has[0].name) ? `${type.name}(${counterpart(has[0].name)})` : hasMembers(type) ? undefined
					: type.name;
				const names = existing.parameters.map((parameter) => counterpart(parameter.name));
				while (names.length > 0 && names[names.length - 1] === undefined && existing.parameters[names.length - 1].optional) {
					names.pop();
				}
				const isComplete = (all: Array<string | undefined>): all is string[] => !all.includes(undefined);
				return { owner: type, method: existing,
					call: receiver && isComplete(names) ? callText(`${receiver}.${existing.name}`, names) : undefined };
			}
		}
	}
	return undefined;
}

/** Implementation tokens with names numbered by first use, `index` and the `value` of a loop stay as they are. */
function normalized(method: StrictMethod, typeNames: Set<string>): { tokens: string; count: number; names: string[] } {
	const cached = normalizedBodies.get(method);
	if (cached) {
		return cached;
	}
	const names: string[] = [];
	const literal = new Set(['index', ...method.implementation.some((line) => /^\t+for\b/.test(line)) ? ['value'] : []]);
	const tokens = method.implementation.flatMap((line) => {
		const words = line.trim().match(tokenPattern) ?? [];
		return [String(line.search(/\S/)), ...words.map((word, index) => {
			if (!/^[A-Za-z_]/.test(word) || keywords.has(word) || literal.has(word) || words[index - 1] === '.' ||
				typeNames.has(word)) {
				return word;
			}
			return `$${names.includes(word) ? names.indexOf(word) : names.push(word) - 1}`;
		})];
	});
	const body = { tokens: tokens.join('\n'), count: tokens.length, names };
	normalizedBodies.set(method, body);
	return body;
}

// Bracketed expressions using members can be mistaken for tests without compiler test-line metadata.
/** All lines of a method without implementation yet are its tests, otherwise undefined. */
export function pendingTests(method: StrictMethod): string[] | undefined {
	const isPending = (line: string) => /^\t[^\t]/.test(line) && isTest(line.trim()) && !/\bthen\b/.test(line) &&
		/\bis\b|[<>]/.test(line) && !['value', ...method.parameters.map((parameter) => parameter.name)].some((name) =>
		new RegExp(`\\b${name}\\b`).test(line));
	const tests = [...method.tests, ...method.implementation.map((line) => line.slice(1))];
	return tests.length > 0 && method.implementation.every(isPending) ? tests : undefined;
}

/** Calls of existing methods (outside own) returning the same type and doing what method does: its copied body, then the
 * same name, then the same test values. Methods calling method itself (dispatchers) are left out. */
export function existingCalls(method: StrictMethod, own: StrictType, types: StrictType[]): ExistingCall[] {
	const pending = pendingTests(method);
	const copy = pending ? undefined : copiedFrom(method, own, types);
	const values = valuesOf(method, own);
	const receivers = [...values.slice(method.parameters.length), ...method.parameters];
	const tests = new Set((pending ?? method.tests).flatMap(testValues));
	const isCalled = (existing: StrictMethod) => !pending &&
		new RegExp(`\\b${existing.name}\\b`).test(method.implementation.join('\n'));
	const byName = new Map(types.map((type) => [type.name, type]));
	const matching = (type: StrictType, element?: string) => type.methods.filter((existing) => isNamed(existing.name) &&
		existing.tests.length > 0 && !usesType(existing, own.name, byName) &&
		sameType(existing.returns === 'Generic' ? element ?? '' : existing.returns, method.returns));
	const found = [
		(existing: StrictMethod) => stem(existing.name) === stem(method.name),
		(existing: StrictMethod) => existing.tests.flatMap(testValues).some((test) => tests.has(test))
	].flatMap((isSame) => [
		...receivers.flatMap((value) => {
			const resolved = typeNamed(value.type, types);
			return resolved && resolved.type.file !== own.file ? matching(resolved.type, resolved.element).filter(isSame).map(
				(existing) => ({ owner: resolved.type, method: existing,
					call: callOf(`${value.name}.${existing.name}`, existing, values, [value.name]) })) : [];
		}),
		...types.filter((type) => type.file !== own.file && !hasMembers(type)).flatMap((type) =>
			matching(type).filter(isSame).map((existing) =>
				({ owner: type, method: existing, call: callOf(`${type.name}.${existing.name}`, existing, values, []) })))
	]);
	return [...(copy ? [copy] : []), ...found].filter((existing, index, all) => existing.call && !isCalled(existing.method) &&
		all.findIndex((other) => other.call === existing.call) === index);
}

// Type mentions approximate dependencies and can include types that are never called.
/** Whether existing reaches a type named name through the types its implementation uses, like a dispatcher does. */
function usesType(existing: StrictMethod, name: string, byName: Map<string, StrictType>): boolean {
	const seen = new Set<string>();
	const pending = [existing.implementation.join('\n')];
	for (const text of pending) {
		for (const used of text.match(/\b[A-Z]\w*/g) ?? []) {
			const type = byName.get(used);
			if (used === name) {
				return true;
			}
			if (type && !seen.has(used)) {
				seen.add(used);
				pending.push(type.methods.flatMap((method) => method.implementation).join('\n'));
			}
		}
	}
	return false;
}

// Older compilers search one level of calls and binary operators over parameters and members.
export function implementationCandidates(method: StrictMethod, own: StrictType, types: StrictType[]): string[] {
	const values = valuesOf(method, own);
	const returns = (candidate: StrictMethod) => sameType(candidate.returns, method.returns);
	const receivers = [...values.slice(method.parameters.length), ...method.parameters];
	const methodsOfValues = receivers.flatMap((value) => (typeNamed(value.type, types)?.type.methods ?? []).map((existing) =>
		({ value, existing })));
	return [...new Set([
		...existingCalls(method, own, types).map((existing) => existing.call!),
		...values.filter((value) => sameType(value.type, method.returns)).map((value) => value.name),
		...own.methods.filter((existing) => existing !== method && isNamed(existing.name) && returns(existing)).map((existing) =>
			callOf(existing.name, existing, values, [])),
		...methodsOfValues.filter(({ existing }) => isNamed(existing.name) && returns(existing)).map(({ value, existing }) =>
			callOf(`${value.name}.${existing.name}`, existing, values, [value.name])),
		...methodsOfValues.filter(({ existing }) => !isNamed(existing.name) && existing.parameters.length === 1 &&
			(!/\w/.test(existing.name) || wordOperators.has(existing.name)) && returns(existing)).flatMap(({ value, existing }) =>
			values.filter((other) => sameType(other.type, existing.parameters[0].type)).map((other) =>
				`${value.name} ${existing.name} ${other.name}`))
	].filter((candidate): candidate is string => Boolean(candidate)))].slice(0, maximumCandidates);
}

function valuesOf(method: StrictMethod, own: StrictType): Value[] {
	return [...method.parameters, ...own.members.filter((member) => !member.text.startsWith('constant '))];
}

function callOf(prefix: string, existing: StrictMethod, values: Value[], used: string[]): string | undefined {
	const names: string[] = [];
	for (const parameter of existing.parameters) {
		const argument = values.find((value) => value.name && ![...used, ...names].includes(value.name) &&
			sameType(value.type, parameter.type));
		if (!argument) {
			return parameter.optional ? callText(prefix, names) : undefined;
		}
		names.push(argument.name);
	}
	return callText(prefix, names);
}

function callText(prefix: string, names: string[]): string {
	return names.length > 0 ? `${prefix}(${names.join(', ')})` : prefix;
}

function hasMembers(type: StrictType): boolean {
	return type.members.some((member) => !member.text.startsWith('constant '));
}

export function sameType(first: string, second: string): boolean {
	return first !== '' && normalizedType(first) === normalizedType(second);
}

function normalizedType(typeText: string): string {
	const generic = /^([\w/]+)\((.+)\)$/.exec(typeText);
	return generic?.[1] === 'Mutable' ? normalizedType(generic[2]) : generic?.[1] === 'List'
		? normalizedType(generic[2]) + 's' : typeText.replace(/^.*\//, '');
}

// Strips one English suffix to match related method names.
function stem(name: string): string {
	return name.toLowerCase().replace(/ed$/, '').replace(/[eds]$/, '');
}

/** Sorted literals of a test and its expected value, only for tests with 3 or more literals to avoid trivial matches. */
function testValues(test: string): string[] {
	const split = test.lastIndexOf(' is ');
	const inputs = split > 0 && !test.includes(' is not ') ? test.slice(0, split).match(literalPattern) ?? [] : [];
	const expected = test.slice(split + 4).trim();
	return inputs.length + (expected.match(literalPattern)?.length ?? 0) >= 3 ? [`${inputs.sort().join(',')}=${expected}`] : [];
}

export function withImplementation(source: string, method: StrictMethod, body: string,
	tests = pendingTests(method) ?? method.tests): string {
	const pending = parseType('', source).methods.filter((other) => other.line !== method.line && pendingTests(other));
	const isKept = (line: number) => (line <= method.line || line > method.endLine) &&
		!pending.some((other) => other.line <= line && line <= other.endLine);
	return source.split(/\r?\n/).flatMap((line, index) => [...(isKept(index) ? [line] : []),
		...(index === method.line ? [...tests.map((test) => `\t${test}`), `\t${body}`] : [])]).join('\n');
}

/** Left side of a test line ending in `is` or `is ?`, still waiting for its expected value, otherwise undefined. */
export function unfinishedTest(line: string): string | undefined {
	const left = /^\t(\S.*?) is(?: \?)?\s*$/.exec(line)?.[1];
	return left && !implementationStart.test(left) ? left : undefined;
}

/** Copy of source with `expression is <placeholder fitting resolved>` as the first test of method (`is ()` crashes Strict,
 * lists take `(0)`), unfinished tests and other methods without implementation are left out: Strict can not run them. */
export function withEvaluation(source: string, method: StrictMethod, expression: string, resolved?: Resolved):
	{ text: string; test: string } {
	const name = resolved?.type.name;
	const test = `${grouped(expression)} is ${name === 'Text' ? '""' : name === 'Boolean' ? 'true' : name === 'List' ? '(0)' : '0'}`;
	const text = withImplementation(source, method, method.implementation.join('\n').slice(1), [test, ...method.tests]);
	return { text: text.split('\n').filter((line) => unfinishedTest(line) === undefined).join('\n'), test };
}

/** expression in brackets when its outermost operator is and, or, xor or then: they bind weaker than is, a bracketed value
 * is a list. */
export function grouped(expression: string): string {
	return / (and|or|xor|then) /.test(outermost(expression)) ? `(${expression})` : expression;
}

/** Type of the value of expression: Boolean for outermost comparisons, and, or, xor and not, X for `to X`, the then value of
 * a conditional, else what resolve finds. */
export function evaluatedType(expression: string, scope: Scope): Resolved | undefined {
	const outer = outermost(expression);
	const then = / then (.+?) else /.exec(outer);
	const to = / to (\S+)$/.exec(outer);
	return then ? evaluatedType(expression.slice(then.index + 6, then.index + 6 + then[1].length), scope)
		: /^not | (is|and|or|xor) |[<>]/.test(outer) ? typeNamed('Boolean', scope.types)
		: to ? typeNamed(expression.slice(to.index + 4), scope.types) : resolve(expression, scope);
}

/** expression with its texts and bracketed parts blanked, positions kept: what is left are its outermost operators. */
function outermost(expression: string): string {
	const blank = (part: string) => '_'.repeat(part.length);
	const blanked = expression.replace(/"(?:[^"\\]|\\.)*"/g, blank).replace(/\([^()]*\)/g, blank);
	return blanked === expression ? expression : outermost(blanked);
}

/** Value of the left side of the evaluation test as Strict code from `strict test` of its text: printed after `got:` when it
 * failed, the placeholder when it passed, else the first error Strict reports, located by file name only. */
export function evaluated(evaluation: { text: string; test: string }, run: StrictRun): Evaluation {
	const result = testResults(evaluation.text, '', run).find((candidate) => candidate.expression === evaluation.test);
	if (result?.actual !== undefined) {
		return { value: result.actual };
	}
	const passed = result && run.output.split(/\r?\n/).some((line) => line.startsWith('Test passed: ') &&
		line.replace(testDuration, '').endsWith(`:line ${result.lineNumber + 1}`));
	const error = result?.consoleOutput ?? crashText(run) ?? result?.message ?? `Strict did not run ${evaluation.test}`;
	return passed ? { value: evaluation.test.slice(evaluation.test.lastIndexOf(' is ') + 4) }
		: { error: error.split('\n')[0].replace(/ in \S*?([^\\/\s]+\.strict):\d+$/, ' in $1') };
}

/** Value of expression in the context of method, evaluated as its first test of file with source, run in project, the project
 * folder of file. */
export async function evaluate(root: string, project: string, file: string, source: string, method: StrictMethod,
	expression: string, resolved?: Resolved): Promise<Evaluation> {
	const evaluation = withEvaluation(source, method, expression, resolved);
	return evaluated(evaluation, await testText(root, project, file, evaluation.text));
}

export function passedAll(output: string, methodName: string, testCount: number): boolean {
	const results = output.split(/\r?\n/).map((line) =>
		/^Test (passed|failed): .* in (\S+) at .+:line \d+$/.exec(line.replace(testDuration, '')))
		.filter((result) => result?.[2] === methodName);
	return results.length === testCount && results.every((result) => result![1] === 'passed');
}

// Older compilers verify each candidate in a separate process.
/** Native selected-method search when available, otherwise verify supplied candidates on the Strict VM. */
export async function passingBodies(root: string, project: string, file: string, source: string, method: StrictMethod,
	bodies: string[] | (() => string[]), isCancelled = () => false): Promise<string[]> {
	if (isCancelled()) {
		return [];
	}
	const compiler = path.join(root, compilerFile);
	const key = `${compiler}:${fs.statSync(compiler).mtimeMs}`;
	let command = suggestionCommands.get(key);
	if (!command) {
		suggestionCommands.clear();
		command = runStrict(root, ['help'], { cwd: project }).then((run) =>
			run.exitCode === 0 && /^strict suggest /m.test(run.output));
		suggestionCommands.set(key, command);
	}
	if (await command) {
		if (isCancelled()) {
			return [];
		}
		const run = await runStrict(root, ['suggest', strictPath(project, file), root.replace(/\\/g, '/'),
			String(method.line + 1), '-'], { cwd: project, input: source });
		if (run.exitCode !== 0) {
			throw new Error(run.output.trim() || `Strict suggest failed with exit code ${run.exitCode}`);
		}
		return run.output.split(/\r?\n/).filter((line) => line.startsWith('Suggestion: ')).map((line) => line.slice(12));
	}
	const candidates = typeof bodies === 'function' ? bodies() : bodies;
	const tests = pendingTests(method) ?? method.tests;
	const passed = new Set<string>();
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(parallelRuns, candidates.length) }, async () => {
		while (next < candidates.length && !isCancelled()) {
			const body = candidates[next++];
			if (passedAll((await testText(root, project, file, withImplementation(source, method, body, tests))).output,
				method.name, tests.length)) {
				passed.add(body);
			}
		}
	}));
	return candidates.filter((body) => passed.has(body));
}

/** The run of key in runs for one more caller, started anew when there is none or every caller waiting for it is cancelled:
 * then it stops starting `strict` and is not kept, so a cancelled run never counts as one without passing bodies. */
export function sharedRun(runs: Map<string, SharedRun>, key: string, isCancelled: () => boolean,
	start: (isCancelled: () => boolean) => Promise<string[]>): Promise<string[]> {
	const cancelled = (waiting: Array<() => boolean>) => waiting.every((waiter) => waiter());
	const cached = runs.get(key);
	if (cached && !cancelled(cached.waiting)) {
		cached.waiting.push(isCancelled);
		return cached.bodies;
	}
	const waiting = [isCancelled];
	const run = { bodies: start(() => cancelled(waiting)), waiting };
	const forget = () => runs.get(key) === run && runs.delete(key);
	run.bodies.then(() => cancelled(waiting) && forget(), forget);
	runs.set(key, run);
	return run.bodies;
}

/** `strict test` of text as file, read from standard input (file and its cache stay as they are), run in project. */
export function testText(root: string, project: string, file: string, text: string): Promise<StrictRun> {
	return runStrict(root, ['test', strictPath(project, file), '-'], { cwd: project, input: text });
}
