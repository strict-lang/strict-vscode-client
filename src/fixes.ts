import { indentUnit, withTabs } from './formatting';
import { copiedFrom } from './implementations';
import { typeNameFromPath } from './scrunchDiscover';
import {
	closingBracket, isNamed, localOf, membersOf, parseType, scopeAt, splitArguments, StrictType, typeNamed
} from './strictIndex';

/** Replaces range (start line, start character, end line, end character, zero based) with text. */
export type Edit = { range: [number, number, number, number]; text: string };
/** Edits of a quick fix, or the position of a name the user renames. */
export type Fix = { title: string; edits: Edit[]; rename?: [number, number] };
export type Issue = { rule: string; line: number; target: string };

const titles = new Map([['ExtraWhitespacesFoundAtBeginningOfLine', 'Indent with tabs'], ['UseConstantHere', 'Use constant'],
	['VariableDeclaredAsMutableButValueNeverChanged', 'Use let, it never changes'], ['IsTrueIsNotNeeded', 'Remove is true']]);
const renamedRules = new Set(['ParameterHidesMemberUseDifferentName', 'VariableHidesMemberUseDifferentName']);
const safeMutable = 'VariableDeclaredAsMutableButValueNeverChanged';
const isTrueRule = 'IsTrueIsNotNeeded';
/** `TypeNotFound: Name used in File.strict:3` and the same for NameNotFound and MethodNotFound. */
export const notFoundPattern = /^(TypeNotFound|NameNotFound|MethodNotFound): (\S+) used in (.+?\.strict):(\d+)/gm;

/** What a polished `strict check` message names after its rule, `five` in `Use constant here: five`. */
export function issueTarget(message: string): string {
	const first = message.split('\n')[0];
	const colon = first.indexOf(': ');
	return colon < 0 ? first : first.slice(colon + 2);
}

/** Quick fix for an issue `strict check` reports for rule on line naming target, undefined when there is none. */
export function ruleFix(rule: string, lines: string[], line: number, target: string): Fix | undefined {
	const text = lines[line] ?? '';
	const fixed = fixedLine(rule, text, target, indentUnit(lines));
	const at = /^\w+$/.test(target) ? text.search(new RegExp(`\\b${target}\\b`)) : -1;
	const rename: Fix | undefined = at < 0 ? undefined : { title: `Rename ${target}`, edits: [], rename: [line, at] };
	const call = /^`([^`]+)` passes/.exec(target)?.[1];
	if (fixed !== undefined) {
		return { title: titles.get(rule)!, edits: [{ range: [line, 0, line, text.length], text: fixed }] };
	}
	switch (rule) {
		case 'MethodAlreadyExists':
			return call ? callFix(lines, line, call) : undefined;
		case 'UnusedMethodVariableMustBeRemoved':
		case 'UnusedMemberMustBeRemoved':
			return /^\s*(?:has|let|mutable|constant) (\w+)\b/.exec(text)?.[1] === target ? removedLine(lines, line, target)
				: undefined;
		case 'EmptyLineInsideMethod':
			return { ...removedLine(lines, line, ''), title: 'Remove empty line' };
		case 'UnusedMethodParameterMustBeRemoved':
			return at < 0 ? undefined : withoutParameter(lines, line, target);
		case 'ListPrefixIsNotAllowedUseImplementationTypeNameInPlural':
			return rename && (pluralRename(lines, line, target) ?? rename);
		default:
			return renamedRules.has(rule) ? rename : undefined;
	}
}

/** Fixes that never change what code does, for Fix All: a let becomes constant, a never changed mutable a let. */
export function safeFixes(lines: string[], issues: Issue[]): Edit[] {
	const fixed = new Map<number, string>();
	for (const issue of issues.filter((candidate) => candidate.line < lines.length && (candidate.rule === safeMutable ||
		candidate.rule === isTrueRule ||
		candidate.rule === 'UseConstantHere' && /^\s+let /.test(lines[candidate.line])))) {
		const text = fixedLine(issue.rule, fixed.get(issue.line) ?? lines[issue.line], issue.target);
		if (text !== undefined) {
			fixed.set(issue.line, text);
		}
	}
	return [...fixed].map(([line, text]) => ({ range: [line, 0, line, lines[line].length], text }));
}

/** text fixed for one of the safe rules, undefined for other rules or when text does not declare target. */
function fixedLine(rule: string, text: string, target: string, unit = 4): string | undefined {
	const fixed = rule === 'ExtraWhitespacesFoundAtBeginningOfLine' ? withTabs(text, unit)
		: rule === 'UseConstantHere' ? text.replace(/^(\s*)(?:let|has) (\w+)\b/, (all, indent, name) =>
			name === target ? `${indent}constant ${name}` : all)
		: rule === safeMutable ? text.replace(/^(\s*)mutable (\w+)\b/, (all, indent, name) =>
			name === target ? `${indent}let ${name}` : all)
		: rule === isTrueRule ? text.replace(/^(\s*)(.+) is true$/, (all, indent, code) =>
			target === code || target.startsWith(`${code}, `) ? indent + code : all) : text;
	return fixed === text ? undefined : fixed;
}

function removedLine(lines: string[], line: number, name: string): Fix {
	const range: Edit['range'] = line + 1 < lines.length ? [line, 0, line + 1, 0] : line > 0
		? [line - 1, lines[line - 1].length, line, lines[line].length] : [line, 0, line, lines[line].length];
	return { title: `Remove unused ${name}`, edits: [{ range, text: '' }] };
}

/** The header without the parameter name, only when no call in the other lines passes a value for it. */
function withoutParameter(lines: string[], line: number, name: string): Fix | undefined {
	const header = lines[line];
	const method = parseType('', lines.join('\n')).methods.find((candidate) => candidate.line === line);
	const index = method?.parameters.findIndex((parameter) => parameter.name === name) ?? -1;
	if (!method || index < 0 || !isNamed(method.name) || lines.some((text, at) => at !== line && passed(text, method.name) > index)) {
		return undefined;
	}
	const open = header.indexOf('(');
	const close = open + closingBracket(header.slice(open));
	const kept = splitArguments(header.slice(open + 1, close)).filter((_parameter, at) => at !== index);
	return { title: `Remove unused parameter ${name}`, edits: [{ range: [line, 0, line, header.length],
		text: method.name + (kept.length > 0 ? `(${kept.join(', ')})` : '') + header.slice(close + 1) }] };
}

/** Most arguments a call of name in text passes, 0 without a call. */
function passed(text: string, name: string): number {
	return Math.max(0, ...[...text.matchAll(new RegExp(`(?<!\\w)${name}\\(`, 'g'))].map((match) => {
		const open = match.index! + name.length;
		return splitArguments(text.slice(open + 1, open + closingBracket(text.slice(open)))).length;
	}));
}

/** `listNumbers List(Number)` or `listNumbers Numbers` becomes `numbers` wherever it is visible, the name says its type. */
function pluralRename(lines: string[], line: number, name: string): Fix | undefined {
	const declared = new RegExp(`\\b${name} (?:List\\((\\w+)\\)|(\\w+s))(?=[,)]|$)`).exec(lines[line]);
	const plural = declared?.[1] ? `${declared[1]}s` : declared?.[2];
	const renamed = plural && (/^[a-z]/.test(name) ? plural[0].toLowerCase() + plural.slice(1) : plural);
	if (!declared || !renamed || renamedPositions(lines, line, renamed).length > 0) {
		return undefined;
	}
	return { title: `Rename ${name} to ${renamed}`, edits: renamedPositions(lines, line, name).map(([at, character]) => ({
		range: [at, character, at, character + (at === line && character === declared.index ? declared[0].length : name.length)],
		text: renamed })) };
}

// ponytail: whole words of this file outside of texts, other files using a renamed member or method keep the old name, a
// keyword used as name is renamed where it is used as keyword too; upgrade: renames from Strict
/** Where the word name is renamed together with its occurrence on line: in its method when it is a parameter or local
 * there, else in the whole file. */
export function renamedPositions(lines: string[], line: number, name: string): Array<[number, number]> {
	const method = parseType('', lines.join('\n')).methods.find((candidate) => candidate.line <= line && line <= candidate.endLine);
	const isLocal = method !== undefined && (method.parameters.some((parameter) => parameter.name === name) ||
		lines.slice(method.line + 1, method.endLine + 1).some((text) => localOf(text)?.name === name));
	const first = isLocal ? method.line : 0;
	return lines.slice(first, isLocal ? method.endLine + 1 : undefined).flatMap((text, index) =>
		[...text.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].filter((match) => text.slice(0, match.index).split('"').length % 2 === 1)
			.map((match): [number, number] => [first + index, match.index!]));
}

/** Fixes needing all types: the call of the method `strict check` reports as copied (`MethodAlreadyExists: Type.Method`),
 * or the names closest to the one Strict did not find on line (`TypeNotFound`, `NameNotFound`, `MethodNotFound`). */
export function typeFixes(message: string, rule: string | undefined, lines: string[], line: number,
	index: () => { own: StrictType; types: StrictType[] }): Fix[] {
	const copied = rule === 'MethodAlreadyExists' ? /^(\w+)\.(\w+)$/.exec(issueTarget(message)) : undefined;
	const unknown = [...message.matchAll(notFoundPattern)].find((match) => Number(match[4]) - 1 === line);
	if (!copied && !unknown) {
		return [];
	}
	const { own, types } = index();
	const fix = copied && copyFix(lines, line, copied[1], copied[2], own, types);
	return fix ? [fix] : unknown && typeNameFromPath(unknown[3]) === own.name
		? changes(unknown[1], unknown[2], lines, line, own, types) : [];
}

/** The call of typeName.methodName, which the method at line copies, built like copiedFrom builds it. */
function copyFix(lines: string[], line: number, typeName: string, methodName: string, own: StrictType, types: StrictType[]):
	Fix | undefined {
	const method = own.methods.find((candidate) => candidate.line === line);
	const owners = types.filter((type) => type.name === typeName && type.file !== own.file);
	const copy = method && copiedFrom(method, own, [...owners, ...types.filter((type) => !owners.includes(type))]);
	return copy?.call && copy.owner.name === typeName && copy.method.name === methodName ? callFix(lines, line, copy.call)
		: undefined;
}

/** Replaces the implementation of the method at line with call, its tests stay. */
function callFix(lines: string[], line: number, call: string): Fix | undefined {
	const method = parseType('', lines.join('\n')).methods.find((candidate) => candidate.line === line);
	if (!method || method.implementation.length === 0) {
		return undefined;
	}
	const start = line + 1 + method.tests.length;
	const end = start + method.implementation.length - 1;
	return { title: `Use ${call}`, edits: [{ range: [start, 0, end, lines[end].length], text: `\t${call}` }] };
}

/** "Change to" the 3 closest names: types for a type, members of the receiver for a method, otherwise names in scope. A type
 * Strict took from a member name (`has numbr`) is renamed with the member. */
function changes(rule: string, unknown: string, lines: string[], line: number, own: StrictType, types: StrictType[]): Fix[] {
	const dot = rule === 'MethodNotFound' ? unknown.lastIndexOf('.') : -1;
	const name = unknown.slice(dot + 1);
	const word = /^\w+$/.test(name) ? new RegExp(`\\b${name}\\b`, rule === 'TypeNotFound' ? 'i' : '').exec(lines[line])?.[0]
		: undefined;
	if (!word) {
		return [];
	}
	const receiver = dot > 0 ? typeNamed(unknown.slice(0, dot), types) : undefined;
	const scope = scopeAt(types, own, lines, line);
	const names = (entries: Array<{ name: string }>) => entries.map((entry) => entry.name);
	const candidates = rule === 'TypeNotFound' ? names(types)
		: rule === 'MethodNotFound' ? names(receiver ? membersOf(receiver, types) : types.flatMap((type) => membersOf({ type }, [])))
		: [...names(scope.method?.parameters ?? []), ...scope.locals.keys(), ...names(membersOf({ type: own }, types)), ...names(types)];
	const isMember = rule === 'TypeNotFound' && /^[a-z]/.test(word);
	const positions = isMember ? renamedPositions(lines, line, word)
		: [...lines[line].matchAll(new RegExp(`\\b${word}\\b`, 'g'))].map((match): [number, number] => [line, match.index!]);
	return nearestNames(name, candidates).map((candidate) => {
		const text = isMember ? candidate[0].toLowerCase() + candidate.slice(1) : candidate;
		return { title: `Change to ${text}`, edits: positions.map(([at, character]) =>
			({ range: [at, character, at, character + word.length], text })) };
	});
}

// ponytail: edit distance to every candidate, O(names * length²), fine for the few thousand names of a workspace
/** Up to 3 candidates closest to name ignoring case, differing in at most half of its characters. */
function nearestNames(name: string, candidates: string[]): string[] {
	const lower = name.toLowerCase();
	return [...new Set(candidates)].filter((candidate) => candidate !== name).map((candidate) =>
		({ candidate, distance: editDistance(lower, candidate.toLowerCase()) }))
		.filter((scored) => scored.distance <= Math.max(1, Math.floor(name.length / 2)))
		.sort((first, second) => first.distance - second.distance).slice(0, 3).map((scored) => scored.candidate);
}

function editDistance(first: string, second: string): number {
	let previous = [...Array(second.length + 1).keys()];
	for (let row = 1; row <= first.length; row++) {
		const current = [row];
		for (let column = 1; column <= second.length; column++) {
			current[column] = Math.min(previous[column] + 1, current[column - 1] + 1,
				previous[column - 1] + (first[row - 1] === second[column - 1] ? 0 : 1));
		}
		previous = current;
	}
	return previous[second.length];
}
