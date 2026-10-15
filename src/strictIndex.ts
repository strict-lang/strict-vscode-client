import * as fs from 'fs';
import * as path from 'path';
import { discoverStrictTests, typeNameFromPath } from './scrunchDiscover';

export type StrictParameter = { name: string; type: string; optional: boolean };
export type StrictMember = { name: string; type: string; line: number; text: string };
export type StrictMethod = { name: string; header: string; line: number; endLine: number; parameters: StrictParameter[];
	returns: string; tests: string[]; implementation: string[] };
export type StrictType = { name: string; file: string; members: StrictMember[]; methods: StrictMethod[] };
/** A value of `type` (`element` for lists), or the type itself when `isType`, like `Vector2` in `Vector2.One`. */
export type Resolved = { type: StrictType; element?: string; isType?: boolean };
export type Entry = { owner: StrictType; name: string; method?: StrictMethod; member?: StrictMember };
/** `loops` are the iterables of the `for` loops around a line (innermost last), the loops without `in` set `value`. */
export type Local = { keyword: string; expression: string; loops: string[] };
export type Scope = { types: StrictType[]; own: StrictType; method?: StrictMethod;
	locals: Map<string, Local>; loops: string[] };

const memberLine = /^(has|constant|mutable) (\S+)(?: (.*))?$/;
const explicitType = /^[A-Z][\w/]*(\([^)]*\))?/;
const skippedFolders = new Set(['node_modules', 'bin', 'obj', 'out']);
export const keywords = new Set(['and', 'constant', 'else', 'for', 'from', 'if', 'in', 'is', 'let', 'mutable', 'not', 'or',
	'return', 'then', 'to', 'with', 'xor']);

export function parseType(file: string, text: string): StrictType {
	const source = text.replace(/^﻿/, '');
	const lines = source.split(/\r?\n/);
	const name = typeNameFromPath(file);
	const members = lines.flatMap((text, line) => {
		const match = memberLine.exec(text);
		return match ? [{ name: match[2], type: declaredType(match[2], match[3] ?? '', name, []), line, text }] : [];
	});
	const methods = discoverStrictTests(source).map((method): StrictMethod => {
		let endLine = method.lineNumber;
		while (endLine + 1 < lines.length && /^(\s|$)/.test(lines[endLine + 1])) {
			endLine++;
		}
		const header = lines[method.lineNumber];
		const methodName = /^[^\s(]+/.exec(header)?.[0] ?? header;
		let rest = header.slice(methodName.length);
		let parameters: string[] = [];
		if (rest.startsWith('(')) {
			const close = closingBracket(rest);
			parameters = splitArguments(rest.slice(1, close));
			rest = rest.slice(close + 1);
		}
		const tests = method.tests.map((test) => test.expression);
		return {
			name: methodName, header, line: method.lineNumber, endLine, returns: rest.trim().startsWith('=') ? '' : rest.trim(),
			parameters: parameters.map((parameter) => {
				const [parameterName, ...typeAndDefault] = parameter.split(' ');
				const typeText = typeAndDefault.join(' ');
				return { name: parameterName, type: declaredType(parameterName, typeText, name, members),
					optional: typeText.includes('= ') };
			}),
			tests, implementation: lines.slice(method.lineNumber + 1, endLine + 1).filter((line) => line.trim()).slice(tests.length)
		};
	});
	return { name, file, members, methods };
}

function declaredType(name: string, rest: string, own: string, members: StrictMember[]): string {
	const explicit = explicitType.exec(rest)?.[0];
	const value = /^= (.+)$/.exec(rest)?.[1];
	return explicit ?? (value !== undefined ? valueType(value, members) : name === 'other' ? own :
		name[0].toUpperCase() + name.slice(1));
}

export function valueType(value: string, members: StrictMember[]): string {
	return /^-?\d/.test(value) ? 'Number' : value.startsWith('"') ? 'Text' : value.startsWith('(') ? 'List' :
		/^(true|false)$/.test(value) ? 'Boolean' : /^([A-Z]\w*)\(/.exec(value)?.[1] ??
		members.find((member) => member.name === value)?.type ?? '';
}

/** Index of the bracket closing the one text starts with, brackets in texts are skipped. */
export function closingBracket(text: string): number {
	let depth = 0;
	let inText = false;
	for (let index = 0; index < text.length; index++) {
		inText = text[index] === '"' ? !inText : inText;
		depth += inText ? 0 : text[index] === '(' ? 1 : text[index] === ')' ? -1 : 0;
		if (depth === 0) {
			return index;
		}
	}
	return text.length;
}

export function splitArguments(text: string): string[] {
	const parts = [''];
	let depth = 0;
	let inText = false;
	for (const character of text) {
		inText = character === '"' ? !inText : inText;
		depth += inText ? 0 : character === '(' ? 1 : character === ')' ? -1 : 0;
		if (character === ',' && depth === 0 && !inText) {
			parts.push('');
		} else {
			parts[parts.length - 1] += character;
		}
	}
	return parts.map((part) => part.trim()).filter(Boolean);
}

/** `Numbers` and `List(Number)` are lists of Number, `Mutable(Number)` is used as a Number, packages are skipped. */
export function typeNamed(typeText: string, types: StrictType[]): Resolved | undefined {
	const generic = /^([\w/]+)\((.+)\)$/.exec(typeText);
	const base = (generic?.[1] ?? typeText).replace(/^.*\//, '');
	if (base === 'Mutable' && generic) {
		return typeNamed(generic[2], types);
	}
	const type = types.find((candidate) => candidate.name === base);
	if (type) {
		return { type, element: generic?.[2] };
	}
	const single = base.endsWith('s') ? types.find((candidate) => candidate.name === base.slice(0, -1)) : undefined;
	const list = types.find((candidate) => candidate.name === 'List');
	return single && list ? { type: list, element: single.name } : undefined;
}

/** The local line declares: `let name = expression`, also with constant or mutable (members too), or `for name in`. */
export function localOf(line: string): { keyword: string; name: string; expression: string } | undefined {
	const [, keyword, name, expression] = /^\t*(let|constant|mutable|for) (\w+) (?:=|in) (.+)$/.exec(line) ?? [];
	return name ? { keyword, name, expression } : undefined;
}

/** Names known at line, its own declaration only withLine (hover and hints on it), not inside its initializer. */
export function scopeAt(types: StrictType[], own: StrictType, lines: string[], line: number, withLine = false): Scope {
	const method = own.methods.find((candidate) => candidate.line < line && line <= candidate.endLine);
	const locals = new Map<string, Local>();
	const loops: Array<{ indent: number; iterable: string }> = [];
	const iterables = () => loops.map((loop) => loop.iterable);
	(method ? lines.slice(method.line + 1, line + 1) : []).forEach((text, index, body) => {
		const indent = /^\t*/.exec(text)![0].length;
		const isLine = index === body.length - 1;
		while (text && loops.length > 0 && loops[loops.length - 1].indent >= indent) {
			loops.pop();
		}
		const local = localOf(text);
		if (local && (withLine || !isLine)) {
			locals.set(local.name, { keyword: local.keyword, expression: local.expression, loops: iterables() });
		} else if (!local && !isLine && /^\t+for\b/.test(text)) {
			loops.push({ indent, iterable: text.trim().slice(4) });
		}
	});
	return { types, own, method, locals, loops: iterables() };
}

/** Type of an expression chain like `vector.Normalize.X`, `"hi".Length` or `numbers(0)`, undefined when unknown. */
export function resolve(chain: string, scope: Scope, depth = 0): Resolved | undefined {
	const [first, ...rest] = splitChain(chain);
	let current = depth > 5 ? undefined : resolveFirst(first, scope, depth);
	for (const segment of rest) {
		const [, name, call] = /^(\w+)(\(.*\))?$/s.exec(segment) ?? [];
		const entry = current && membersOf(current, scope.types).find((candidate) => candidate.name === name);
		current = entry?.method ? returned(entry.method, current!, scope.types)
			: entry?.member && indexed(typeNamed(entry.member.type, scope.types), call, scope.types);
	}
	return current;
}

function splitChain(chain: string): string[] {
	const number = /^-?\d+(\.\d+)?/.exec(chain)?.[0] ?? '';
	const segments = [number];
	let depth = 0;
	let inText = false;
	for (const character of chain.slice(number.length)) {
		inText = character === '"' ? !inText : inText;
		depth += inText ? 0 : character === '(' ? 1 : character === ')' ? -1 : 0;
		if (character === '.' && depth === 0 && !inText) {
			segments.push('');
		} else {
			segments[segments.length - 1] += character;
		}
	}
	return number ? segments : segments.slice(segments[0] ? 0 : 1);
}

function resolveFirst(segment: string, scope: Scope, depth: number): Resolved | undefined {
	if (/^(-?\d|"|\(|(true|false)$)/.test(segment)) {
		return typeNamed(valueType(segment, []), scope.types);
	}
	const [, name, call] = /^(\w+)(\(.*\))?$/s.exec(segment) ?? [];
	if (!name) {
		return undefined;
	}
	if (name === 'value' && scope.loops.length > 0) {
		const loops = scope.loops.slice(0, -1);
		return indexed(iterated(resolve(scope.loops[loops.length] || 'value', { ...scope, loops }, depth + 1), scope.types), call,
			scope.types);
	}
	const declared = name === 'value' ? scope.own.name : name === 'index' ? 'Number' :
		scope.method?.parameters.find((parameter) => parameter.name === name)?.type ??
		scope.own.members.find((member) => member.name === name)?.type;
	const local = scope.locals.get(name);
	const localType = local && resolve(local.expression, { ...scope, loops: local.loops }, depth + 1);
	const value = declared !== undefined ? typeNamed(declared, scope.types) : local?.keyword === 'for'
		? iterated(localType, scope.types) : localType;
	if (value) {
		return indexed(value, call, scope.types);
	}
	const method = scope.own.methods.find((candidate) => candidate.name === name);
	if (method) {
		return returned(method, { type: scope.own }, scope.types);
	}
	const type = typeNamed(name, scope.types);
	return type && { ...type, isType: !call };
}

function indexed(resolved: Resolved | undefined, call: string | undefined, types: StrictType[]): Resolved | undefined {
	return call && resolved ? resolved.element ? typeNamed(resolved.element, types) : undefined : resolved;
}

// ponytail: the value of a for loop is the element of a list or of the list a type has (Text has characters), X of its
// `for Iterator(X)` (Range), else a type that has an iterator gives itself (`for 10`), Dictionary pairs and Enum values
// stay unknown; upgrade: loop types from Strict's type inference
function iterated(resolved: Resolved | undefined, types: StrictType[]): Resolved | undefined {
	const list = resolved?.element ? resolved : resolved?.type.members.map((member) => typeNamed(member.type, types))
		.find((member) => member?.element);
	const iterator = /^Iterator\((\w+)\)$/.exec(resolved?.type.methods.find((method) => method.name === 'for')?.returns ?? '');
	return list ? typeNamed(list.element!, types) : iterator ? typeNamed(iterator[1], types)
		: resolved?.type.members.some((member) => member.type === 'Iterator') ? resolved : undefined;
}

/** A method returning its own type keeps the element of the receiver, `numbers.Reverse` stays a list of Number. */
function returned(method: StrictMethod, receiver: Resolved, types: StrictType[]): Resolved | undefined {
	const type = method.returns === 'Generic' ? receiver.element ? typeNamed(receiver.element, types) : undefined
		: typeNamed(method.returns, types);
	return type?.type === receiver.type && !type.element ? { type: receiver.type, element: receiver.element } : type;
}

/** Members and named methods usable after a dot: the type's own, then those of each type it has (`has number`). */
export function membersOf(resolved: Resolved, types: StrictType[]): Entry[] {
	const delegated = resolved.type.members.filter((member) => member.text.startsWith('has ')).flatMap((member) => {
		const type = typeNamed(member.type, types)?.type;
		return type && type !== resolved.type ? entries(type) : [];
	});
	return [...entries(resolved.type), ...delegated];
}

function entries(type: StrictType): Entry[] {
	return [...type.members.map((member) => ({ owner: type, name: member.name, member })),
		...type.methods.filter((method) => isNamed(method.name)).map((method) => ({ owner: type, name: method.name, method }))];
}

// ponytail: like Strict's TypeShape.IsTrait no method has a body or is computed (`Area = Width * Height`), so native types
// without Strict bodies (File) count as traits too; upgrade: the shapes of Strict
export function isTrait(type: StrictType | undefined): boolean {
	return type !== undefined && type.methods.length > 0 && type.methods.every((method) =>
		method.tests.length + method.implementation.length === 0 && !/^[^\s(]+(\(.*\))? = /.test(method.header));
}

export function isNamed(name: string): boolean {
	return /^[A-Za-z]\w*$/.test(name) && !keywords.has(name);
}

/** The expression chain ending at the end of text, `numbers(0)` in `value + numbers(0)`. */
export function chainBefore(text: string): string {
	let depth = 0;
	let index = text.length;
	while (index > 0) {
		const character = text[index - 1];
		if (character === '"') {
			const start = text.lastIndexOf('"', index - 2);
			if (start < 0) {
				break;
			}
			index = start;
			continue;
		}
		if (character === '(' && depth === 0 || depth === 0 && !/[\w.()]/.test(character)) {
			break;
		}
		depth += character === ')' ? 1 : character === '(' ? -1 : 0;
		index--;
	}
	return text.slice(index);
}

/** The innermost call around the end of text with the index of the argument written there. */
export function callBefore(text: string): { callee: string; argument: number } | undefined {
	const opened: Array<{ index: number; commas: number }> = [];
	let inText = false;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		inText = character === '"' ? !inText : inText;
		if (inText) {
			continue;
		}
		if (character === '(') {
			opened.push({ index, commas: 0 });
		} else if (character === ')') {
			opened.pop();
		} else if (character === ',' && opened.length > 0) {
			opened[opened.length - 1].commas++;
		}
	}
	for (const open of opened.reverse()) {
		const callee = chainBefore(text.slice(0, open.index));
		if (callee) {
			return { callee, argument: open.commas };
		}
	}
	return undefined;
}

export function strictFiles(folder: string): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(folder, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.flatMap((entry) => entry.isDirectory()
		? entry.name.startsWith('.') || skippedFolders.has(entry.name) ? [] : strictFiles(path.join(folder, entry.name))
		: entry.name.endsWith('.strict') ? [path.join(folder, entry.name)] : []);
}
