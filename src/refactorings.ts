import * as path from 'path';
import { notFoundPattern } from './fixes';
import { discoverStrictTests, typeNameFromPath } from './scrunchDiscover';
import {
	chainBefore, closingBracket, keywords, resolve, Scope, splitArguments, StrictType, typeNamed, valueType
} from './strictIndex';

/** Replaces line:character to endLine:endCharacter (the same position when left out) of file (the edited one when left out). */
export type FileEdit = { file?: string; line: number; character: number; endLine?: number; endCharacter?: number; text: string };
export type Refactoring = { title: string; kind: 'RefactorExtract' | 'RefactorInline' | 'QuickFix'; edits: FileEdit[];
	newFile?: string };

const textLiteral = /"(?:[^"\\]|\\.)*"/g;
const ordinals = ['first', 'second', 'third', 'fourth'];

// ponytail: text checks for a whole expression (a partial `a then b` passes), named after its type or `extracted` without a
// rename afterwards; upgrade: Strict parses the selection, a snippet edit lets the user name it right away
/** `let name = expression` above the line of the selected expression in a method body (a constant when it only uses literals,
 * constants and types), the selection becomes name. */
export function extractToLet(lines: string[], line: number, start: number, end: number, scope: Scope): Refactoring | undefined {
	const text = lines[line];
	const selected = text.slice(start, end);
	const from = start + selected.length - selected.trimStart().length;
	const to = end - selected.length + selected.trimEnd().length;
	const expression = text.slice(from, to);
	const method = scope.method;
	if (!method || line <= method.line + method.tests.length || /^\s*else\b/.test(text) || !isExpression(expression) ||
		/[\w.]/.test(text[from - 1] ?? '') || /[\w(]/.test(text[to] ?? '') || text.slice(0, from).split('"').length % 2 === 0) {
		return undefined;
	}
	const keyword = isConstant(expression, scope, lines.slice(method.line + 1, line)) ? 'constant' : 'let';
	const taken = [...scope.own.members.map((member) => member.name), ...method.parameters.map((parameter) => parameter.name),
		...scope.locals.keys(), 'value', 'index', ...keywords];
	const name = [lowered(typeOf(expression, scope)), 'extracted', 'extracted2', 'extracted3'].find((candidate) =>
		candidate && !taken.includes(candidate));
	if (!name) {
		return undefined;
	}
	return { title: `Extract to ${keyword} ${name}`, kind: 'RefactorExtract', edits: [
		{ line, character: 0, text: `${/^\s*/.exec(text)![0]}${keyword} ${name} = ${expression}\n` },
		{ line, character: from, endCharacter: to, text: name }] };
}

function isExpression(text: string): boolean {
	return /^-?[\w"(]/.test(text) && /[\w")]$/.test(text) && !text.includes(' = ') &&
		!/^(let|constant|mutable|if|else|for|return)\b/.test(text) && closingBracket(`(${text})`) === text.length + 1;
}

/** Whether expression only uses literals, constants, types and what is called on them, like `Limit * 2` or `Vector2(1, 2).X`. */
function isConstant(expression: string, scope: Scope, before: string[]): boolean {
	return (expression.replace(textLiteral, '""').match(/(?<![\w.])[A-Za-z_]\w*/g) ?? []).every((word) => {
		const member = scope.own.members.find((candidate) => candidate.name === word);
		return member ? member.text.startsWith('constant ') : scope.locals.has(word)
			? before.some((text) => text.trim().startsWith(`constant ${word} = `)) : keywords.has(word) ||
			/^(true|false)$/.test(word) || /^[A-Z]/.test(word) && !scope.own.methods.some((method) => method.name === word);
	});
}

/** Replaces the only later use of the let declared on line with its value (bracketed inside other expressions) and removes the
 * declaration. */
export function inlineLet(lines: string[], line: number, scope: Scope): Refactoring | undefined {
	const [, name, value] = /^\t+(?:let|constant) (\w+) = (.+)$/.exec(lines[line]) ?? [];
	if (!name || !scope.method) {
		return undefined;
	}
	const use = new RegExp(`(?<![\\w.])${name}(?!\\w)`, 'g');
	const uses = lines.slice(line + 1, scope.method.endLine + 1).flatMap((text, offset) => [...text.replace(textLiteral,
		(literal) => ' '.repeat(literal.length)).matchAll(use)].map((found) => ({ line: line + 1 + offset, text, at: found.index! })));
	const isLoopValue = /\b(value|index)\b/.test(value) &&
		lines.slice(line + 1, uses[0]?.line).some((text) => /^\t+for\b/.test(text));
	if (uses.length !== 1 || isLoopValue) {
		return undefined;
	}
	const [only] = uses;
	const isWhole = chainBefore(value) === value || /(^\t*|= |return |[(,] ?)$/.test(only.text.slice(0, only.at)) &&
		/^($|[),])/.test(only.text.slice(only.at + name.length));
	return { title: `Inline ${name}`, kind: 'RefactorInline', edits: [
		{ line, character: 0, endLine: line + 1, endCharacter: 0, text: '' },
		{ line: only.line, character: only.at, endCharacter: only.at + name.length, text: isWhole ? value : `(${value})` }] };
}

/** Fixes for the missing methods and types Strict reports in message for line of file: the method in the type it was called
 * on (with that line as its first test when it is one), an unknown type as a new file next to file. */
export function creations(message: string, file: string, lines: string[], line: number, scope: Scope,
	read: (file: string) => string): Refactoring[] {
	return [...message.matchAll(notFoundPattern)].filter((found) => Number(found[4]) === line + 1 && /^\w+(\.\w+)?$/.test(found[2]) &&
		typeNameFromPath(found[3]) === typeNameFromPath(file)).flatMap(([, error, name]) => {
		const dot = name.lastIndexOf('.');
		const owner = dot > 0 ? typeNamed(name.slice(0, dot), scope.types)?.type : scope.own;
		const method = owner ? createdMethod(name.slice(dot + 1), dot > 0, owner, lines, line, scope, read) : [];
		return [...error === 'TypeNotFound' ? createdType(name, file, lines[line], scope) : [], ...method];
	});
}

function createdMethod(name: string, isCalledOn: boolean, owner: StrictType, lines: string[], line: number, scope: Scope,
	read: (file: string) => string): Refactoring[] {
	const used = usage(lines[line], name, isCalledOn);
	if (!used) {
		return [];
	}
	const types = used.values.map((value) => typeOf(value, scope) || 'Any');
	const parameters = named(types, [...owner.members.map((member) => member.name), 'value']).map((parameter, index) =>
		`${parameter} ${types[index]}`);
	const compared = /^ (?:is not|is|>=|<=|>|<) (.+)$/.exec(used.rest)?.[1];
	const isTest = discoverStrictTests(lines.join('\n')).some((method) => method.tests.some((test) => test.lineNumber === line));
	const returns = compared ? typeOf(compared, scope) : !used.rest.trim() && isTest ? 'Boolean' : '';
	const header = `${name}${parameters.length > 0 ? `(${parameters.join(', ')})` : ''}${returns ? ` ${returns}` : ''}`;
	return [{ title: `Create method ${name} in ${owner.name}`, kind: 'QuickFix',
		edits: [appended(owner.file, read(owner.file), [header, ...isTest ? [`\t${lines[line].trim()}`] : []].join('\n'))] }];
}

function createdType(name: string, file: string, text: string, scope: Scope): Refactoring[] {
	const types = (usage(text, name, false)?.values ?? []).map((value) => typeOf(value, scope) || 'Any');
	const members = named(types, []).map((member, index) => member === lowered(types[index]) ? `has ${member}`
		: `has ${member} ${types[index]}`);
	const newFile = path.join(path.dirname(file), `${name}.strict`);
	return [{ title: `Create type ${name}`, kind: 'QuickFix', newFile,
		edits: [{ file: newFile, line: 0, character: 0, text: members.join('\n') }] }];
}

// ponytail: the first use of name on the line, also one inside a text; upgrade: positions of unknown names from Strict
/** Arguments of the first call of name in text (on a value when isCalledOn) and what follows the call. */
function usage(text: string, name: string, isCalledOn: boolean): { values: string[]; rest: string } | undefined {
	const found = new RegExp(`${isCalledOn ? '\\.' : '(?<![\\w.])'}${name}(?!\\w)`).exec(text);
	const after = found ? text.slice(found.index + found[0].length) : '';
	const close = after.startsWith('(') ? closingBracket(after) : -1;
	return found ? { values: close > 0 ? splitArguments(after.slice(1, close)) : [], rest: after.slice(close + 1) } : undefined;
}

/** Type of a literal, of a list literal (`Numbers` for `(1, 2)`) or what resolve finds, empty when unknown. */
function typeOf(value: string, scope: Scope): string {
	if (value.startsWith('(') && closingBracket(value) === value.length - 1) {
		const elements = splitArguments(value.slice(1, -1));
		const element = elements.length > 0 ? typeOf(elements[0], scope) : '';
		return elements.length > 1 && element ? `${element}s` : element;
	}
	const resolved = value ? resolve(value, scope) : undefined;
	return resolved?.element ? `${resolved.element}s` : resolved?.type.name ?? valueType(value, scope.own.members);
}

/** `number` for a Number, ordinals for a type used twice or a taken name, `other` when it is the only one. */
function named(types: string[], taken: string[]): string[] {
	return types.map((type, index) => types.indexOf(type) === types.lastIndexOf(type) && !taken.includes(lowered(type))
		? lowered(type) : types.length === 1 ? 'other' : ordinals[index] ?? `${lowered(type)}${index + 1}`);
}

function lowered(type: string): string {
	return type.slice(0, 1).toLowerCase() + type.slice(1);
}

/** Inserts text as new lines at the end of source, a final line break stays the last character. */
function appended(file: string, source: string, text: string): FileEdit {
	const lines = source.split(/\r?\n/);
	const last = lines[lines.length - 1];
	return { file, line: lines.length - 1, character: last.length, text: last ? `\n${text}` : `${text}\n` };
}
