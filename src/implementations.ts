import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runStrict } from './nativeCompiler';
import { typeNameFromPath } from './scrunchDiscover';
import { isNamed, keywords, parseType, StrictMethod, StrictType, typeNamed } from './strictIndex';

export type ExistingCall = { owner: StrictType; method: StrictMethod; call?: string };
type Value = { name: string; type: string };

const tokenPattern = /"(?:[^"\\]|\\.)*"|\d+(?:\.\d+)?|[A-Za-z_]\w*|\S/g;
const literalPattern = /"(?:[^"\\]|\\.)*"|-?\b\d+(?:\.\d+)?\b/g;
const implementationStart = /^(for|if|return|constant|mutable|let)\b/;
const wordOperators = new Set(['and', 'or', 'xor', 'is']);
const minimumCopyTokens = 12;
const maximumCandidates = 32;
const parallelRuns = Math.max(1, Math.floor(os.cpus().length / 2));
const normalizedBodies = new WeakMap<StrictMethod, { tokens: string; count: number; names: string[] }>();

// ponytail: exact token match with consistently renamed names, misses reordered or partly changed copies; upgrade: Strict compares syntax trees
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
					original.names.includes(has[0].name) ? counterpart(has[0].name) : hasMembers(type) ? undefined : type.name;
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

/** All lines of a method without implementation yet are its tests, otherwise undefined. */
export function pendingTests(method: StrictMethod): string[] | undefined {
	const isTest = (line: string) => /^\t[^\t]/.test(line) && !implementationStart.test(line.trim()) && !/\bthen\b/.test(line) &&
		/\bis\b|[<>]/.test(line) && !['value', ...method.parameters.map((parameter) => parameter.name)].some((name) =>
		new RegExp(`\\b${name}\\b`).test(line));
	const tests = [...method.tests, ...method.implementation.map((line) => line.slice(1))];
	return tests.length > 0 && method.implementation.every(isTest) ? tests : undefined;
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

// ponytail: follows type names mentioned in implementations, over-approximates calls; upgrade: call graph from Strict
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

// ponytail: one level of calls and binary operators over parameters and members, capped; upgrade: a `strict` search with type inference
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
			values.filter((other) => other !== value && sameType(other.type, existing.parameters[0].type)).map((other) =>
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

function sameType(first: string, second: string): boolean {
	return first !== '' && normalizedType(first) === normalizedType(second);
}

function normalizedType(typeText: string): string {
	const generic = /^([\w/]+)\((.+)\)$/.exec(typeText);
	return generic?.[1] === 'Mutable' ? normalizedType(generic[2]) : generic?.[1] === 'List'
		? normalizedType(generic[2]) + 's' : typeText.replace(/^.*\//, '');
}

// ponytail: drops one ending (Clamped, Rounds, Normalize), English only; upgrade: compare what methods do, not names
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

// ponytail: finds types by their names (`has board`, `Cells`), may take a few unused ones along; upgrade: dependencies from Strict
/** Files of the types in the folder of file that source uses directly or through them, `strict` parses every file it copies. */
export function usedSiblings(file: string, source: string): string[] {
	const folder = path.dirname(file);
	const siblings = fs.readdirSync(folder).filter((name) => name.endsWith('.strict') && name !== path.basename(file));
	const used: string[] = [];
	const texts = [source];
	for (const text of texts) {
		for (const sibling of siblings.filter((name) => !used.includes(name))) {
			const name = typeNameFromPath(sibling);
			if (new RegExp(`\\b[${name[0]}${name[0].toLowerCase()}]${name.slice(1)}s?\\b`).test(text)) {
				used.push(sibling);
				texts.push(fs.readFileSync(path.join(folder, sibling), 'utf8'));
			}
		}
	}
	return used;
}

export function passedAll(output: string, methodName: string, testCount: number): boolean {
	const results = output.split(/\r?\n/).map((line) => /^Test (passed|failed): .* in (\S+) at .+:line \d+$/.exec(line))
		.filter((result) => result?.[2] === methodName);
	return results.length === testCount && results.every((result) => result![1] === 'passed');
}

// ponytail: one strict process per body in a temporary copy (40 ms each for small types), sibling types outside the Strict
// folder are copied flat (no sub folders of a project); upgrade: verify all bodies in one strict process
/** Bodies for method that pass all its tests on the Strict VM, in the order given. */
export async function passingBodies(root: string, file: string, source: string, method: StrictMethod, bodies: string[],
	isCancelled = () => false): Promise<string[]> {
	const tests = pendingTests(method) ?? method.tests;
	const relative = path.relative(root, path.dirname(file));
	const siblings = relative.startsWith('..') || path.isAbsolute(relative) ? usedSiblings(file, source) : [];
	const passed = new Set<string>();
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(parallelRuns, bodies.length) }, async () => {
		const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-'));
		const copy = path.join(folder, path.basename(file));
		try {
			for (const sibling of siblings) {
				fs.copyFileSync(path.join(path.dirname(file), sibling), path.join(folder, sibling));
			}
			while (next < bodies.length && !isCancelled()) {
				const body = bodies[next++];
				fs.writeFileSync(copy, withImplementation(source, method, body, tests));
				fs.rmSync(copy.replace(/\.strict$/, '.strictbinary'), { force: true });
				if (passedAll((await runStrict(root, ['test', copy, '.'])).output, method.name, tests.length)) {
					passed.add(body);
				}
			}
		} finally {
			fs.rmSync(folder, { recursive: true, force: true });
		}
	}));
	return bodies.filter((body) => passed.has(body));
}
