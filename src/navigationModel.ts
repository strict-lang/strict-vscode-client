import { normalizeFsPath } from './paths';
import {
	chainBefore, Entry, isTrait, keywords, localOf, membersOf, parseType, resolve, Scope, scopeAt, StrictMethod,
	StrictType, typeNamed
} from './strictIndex';

export type Source = { file: string; text: string };
/** A type (isType), a member or method of owner, or a parameter or local of method in the file of owner. */
export type Target = { name: string; owner: StrictType; isType?: boolean; method?: StrictMethod };
/** A word using a target, `cells` for the type Cell, inside method (header, test or implementation) when in one. */
export type Hit = { file: string; line: number; character: number; word: string; method?: StrictMethod; isTest: boolean };
export type Edit = { file: string; line: number; character: number; length: number; text: string };
type Word = { character: number; word: string; dotted: boolean };

const anyWord = '[A-Za-z_]\\w*';
const reserved = new Set([...keywords, 'has', 'value', 'index', 'true', 'false']);
const parsedSources = new WeakMap<Source, { own: StrictType; lines: string[] }>();

/** What the word at character names, resolved like completion and hover do. */
export function targetAt(source: Source, types: StrictType[], line: number, character: number): Target | undefined {
	const { own, lines } = parsed(source);
	const word = wordsIn(lines[line] ?? '', anyWord).find((candidate) => candidate.character <= character &&
		character <= candidate.character + candidate.word.length);
	const scope = scopeAt(known(own, types), own, lines, line);
	const method = methodAt(own, line);
	if (!word || method?.line === line && word.character === 0) {
		return word && { name: word.word, owner: own };
	}
	const declared = localOf(lines[line])?.name === word.word;
	if (method && !word.dotted && (declared || scope.locals.has(word.word) || isParameter(method, word.word))) {
		return { name: word.word, owner: own, method };
	}
	const entry = entryAt(lines[line], word, scope, line);
	const named = typeNamed(word.word, types);
	const type = named?.element && named.type.name !== word.word ? typeNamed(named.element, types)?.type : named?.type;
	return entry ? { name: entry.name, owner: entry.owner } : type && !word.dotted ? { name: type.name, owner: type, isType: true }
		: undefined;
}

/** Words naming target: a type also as plural, `List(Type)`, `Package/Type` and members or parameters named after it. */
export function references(target: Target, sources: Source[], types: StrictType[]): Hit[] {
	if (target.method) {
		const source = sources.find((candidate) => sameFile(candidate, target.owner));
		return source ? localHits(source, target.method, target.name) : [];
	}
	return target.isType ? typeHits(target.owner, sources, types) : memberHits(target, sources, types);
}

/** Uses of a parameter in its method, of a local from its declaration on (a member of that name may be used before). */
function localHits(source: Source, method: StrictMethod, name: string): Hit[] {
	const { own, lines } = parsed(source);
	const declaration = isParameter(method, name) ? method.line : lines.findIndex((text, line) => line > method.line &&
		line <= method.endLine && localOf(text)?.name === name);
	const first = declaration < 0 ? method.line : declaration;
	return lines.slice(first, method.endLine + 1).flatMap((text, offset) => wordsIn(text, name)
		.filter((word) => !word.dotted).map((word) => hit(source.file, own, lines, first + offset, word)));
}

function memberHits(target: Target, sources: Source[], types: StrictType[]): Hit[] {
	return sources.filter((source) => source.text.includes(target.name)).flatMap((source) => {
		const { own, lines } = parsed(source);
		const scopeTypes = known(own, types);
		return lines.flatMap((text, line) => wordsIn(text, target.name).filter((word) => {
			const entry = entryAt(text, word, scopeAt(scopeTypes, own, lines, line), line);
			return entry !== undefined && sameFile(entry.owner, target.owner);
		}).map((word) => hit(source.file, own, lines, line, word)));
	});
}

function typeHits(type: StrictType, sources: Source[], types: StrictType[]): Hit[] {
	const lower = type.name[0].toLowerCase() + type.name.slice(1);
	const plural = types.some((other) => other.name === `${type.name}s`) ? '' : 's?';
	const isNamedAfter = (name: string, typeText: string) => [lower, `${lower}s`, type.name, `${type.name}s`].includes(name) &&
		name[0].toUpperCase() + name.slice(1) === typeText.replace(/^.*\//, '');
	return sources.filter((source) => source.text.includes(type.name) || source.text.includes(lower)).flatMap((source) => {
		const { own, lines } = parsed(source);
		const scopeTypes = known(own, types);
		const named = lines.flatMap((text, line) => wordsIn(text, type.name + plural).filter((word) => !word.dotted &&
			!entryAt(text, word, scopeAt(scopeTypes, own, lines, line), line)).map((word) =>
			hit(source.file, own, lines, line, word)));
		const members = own.members.filter((member) => isNamedAfter(member.name, member.type)).flatMap((member) =>
			memberHits({ name: member.name, owner: own }, sources, types));
		const parameters = own.methods.flatMap((method) => method.parameters.filter((parameter) =>
			isNamedAfter(parameter.name, parameter.type)).flatMap((parameter) => localHits(source, method, parameter.name)));
		return [...named, ...members, ...parameters];
	});
}

/** The member or method word refers to, none for parameters, locals and types. */
function entryAt(text: string, word: Word, scope: Scope, line: number): Entry | undefined {
	const named = (entries: Entry[]) => entries.filter((entry) => entry.name === word.word);
	if (!word.dotted) {
		return scope.locals.has(word.word) || isParameter(methodAt(scope.own, line), word.word) ? undefined
			: named(membersOf({ type: scope.own }, scope.types))[0];
	}
	const receiver = resolve(chainBefore(text.slice(0, word.character - 1)), scope);
	// ponytail: an unknown receiver (or one without that member) takes the only type having it; upgrade: types from Strict
	const anywhere = () => named(scope.types.flatMap((type) => membersOf({ type }, [])));
	const only = (entries: Entry[]) => entries.every((entry) => sameFile(entry.owner, entries[0].owner)) ? entries[0] : undefined;
	return named(receiver ? membersOf(receiver, scope.types) : [])[0] ?? only(anywhere());
}

/** Replaces the name in every hit (`cells` of the type Cell becomes `tiles`), an implicitly typed member or parameter keeps
 * its type: renaming `has logger` to output gives `has output Logger`. */
export function renameEdits(target: Target, name: string, hits: Hit[]): Edit[] {
	const declaration = target.isType ? undefined : implicitDeclaration(target);
	const typed = declaration && name[0].toUpperCase() + name.slice(1) !== declaration.type ? ` ${declaration.type}` : '';
	return hits.map((hit) => ({ file: hit.file, line: hit.line, character: hit.character, length: target.name.length,
		text: (hit.word.startsWith(target.name) ? name : name[0].toLowerCase() + name.slice(1)) + (sameFile(hit, target.owner) &&
		hit.line === declaration?.line && hit.character === declaration.character ? typed : '') }));
}

function implicitDeclaration(target: Target): { line: number; character: number; type: string } | undefined {
	const member = target.method ? undefined : target.owner.members.find((candidate) => candidate.name === target.name);
	const parameter = target.method?.parameters.find((candidate) => candidate.name === target.name);
	const inHeader = parameter && new RegExp(`(?<=[(,] ?)${target.name}(?=[,)])`).exec(target.method!.header);
	return member && /^\w+ \w+( with .*)?$/.test(member.text)
		? { line: member.line, character: member.text.indexOf(' ') + 1, type: member.type }
		: inHeader ? { line: target.method!.line, character: inHeader.index, type: parameter!.type } : undefined;
}

/** Why Strict would not take name for target: 2-50 letters or digits, no keyword, types upper case, not taken yet. */
export function nameError(target: Target, name: string, types: StrictType[]): string | undefined {
	const taken = name !== target.name && (target.isType ? types.some((type) => type.name === name)
		: [...membersOf({ type: target.owner }, types), ...target.method?.parameters ?? [],
			...(target.method?.implementation ?? []).flatMap((line) => localOf(line) ?? [])].some((entry) => entry.name === name));
	return !/^[A-Za-z][A-Za-z\d]{1,49}$/.test(name) || reserved.has(name)
		? `${name} is no Strict name: 2-50 letters or digits, no keyword, value or index`
		: target.isType && !/^[A-Z]/.test(name) ? `Type names start upper case: ${name}`
		: taken ? `${name} already exists` : undefined;
}

/** Type of the expression ending at character, the element type for lists. */
export function typeAt(source: Source, types: StrictType[], line: number, character: number): StrictType | undefined {
	const { own, lines } = parsed(source);
	const scope = { ...scopeAt(known(own, types), own, lines, line), method: methodAt(own, line) };
	const resolved = resolve(chainBefore((lines[line] ?? '').slice(0, character)), scope);
	return resolved?.element ? typeNamed(resolved.element, types)?.type : resolved?.type;
}

/** For a trait (or a member of one) the members of the types having it, for a trait method their methods of its name. */
export function implementationsOf(target: Target, types: StrictType[]): Array<{ file: string; line: number }> {
	const member = target.isType ? undefined : target.owner.members.find((candidate) => candidate.name === target.name);
	const trait = member ? typeNamed(member.type, types)?.type : target.owner;
	const name = target.isType || member ? undefined : target.name;
	return trait && !target.method && isTrait(trait) ? types.flatMap((type) => type.members.filter((candidate) => {
		const has = candidate.text.startsWith('has ') && typeNamed(candidate.type, types)?.type;
		return has && sameFile(has, trait);
	}).flatMap((candidate) => name === undefined ? [{ file: type.file, line: candidate.line }] : type.methods.filter((method) =>
		method.name === name).map((method) => ({ file: type.file, line: method.line })))) : [];
}

/** Hits grouped by the method containing them (its tests apart) or the members, declarations left out. */
export function callers(hits: Hit[]): Hit[][] {
	const groups = new Map<string, Hit[]>();
	for (const hit of hits.filter((candidate) => candidate.line !== candidate.method?.line || candidate.character > 0)) {
		const key = `${normalizeFsPath(hit.file)}:${hit.method?.line ?? 'members'}:${hit.isTest}`;
		groups.set(key, [...groups.get(key) ?? [], hit]);
	}
	return [...groups.values()];
}

/** Methods the implementation (not the tests) of the method declared at line calls, with the words calling them. */
export function calls(source: Source, line: number, types: StrictType[]): Array<{ entry: Entry; hits: Hit[] }> {
	const { own, lines } = parsed(source);
	const method = own.methods.find((candidate) => candidate.line === line);
	const found = new Map<StrictMethod, { entry: Entry; hits: Hit[] }>();
	const scopeTypes = known(own, types);
	for (let index = line + 1; method && index <= method.endLine; index++) {
		const scope = scopeAt(scopeTypes, own, lines, index);
		const words = method.tests.includes(lines[index].trimStart()) ? [] : wordsIn(lines[index], anyWord);
		for (const word of words) {
			const entry = entryAt(lines[index], word, scope, index);
			if (entry?.method) {
				found.set(entry.method, { entry, hits: [...found.get(entry.method)?.hits ?? [],
					hit(source.file, own, lines, index, word)] });
			}
		}
	}
	return [...found.values()];
}

function parsed(source: Source): { own: StrictType; lines: string[] } {
	if (!parsedSources.has(source)) {
		parsedSources.set(source, { own: parseType(source.file, source.text),
			lines: source.text.replace(/^﻿/, '').split(/\r?\n/) });
	}
	return parsedSources.get(source)!;
}

function known(own: StrictType, types: StrictType[]): StrictType[] {
	return [own, ...types.filter((type) => type.name !== own.name || !sameFile(type, own))];
}

/** Whole words matching pattern outside of texts, dotted when called on a receiver. */
function wordsIn(text: string, pattern: string): Word[] {
	const code = text.replace(/"(?:[^"\\]|\\.)*"/g, (literal) => ' '.repeat(literal.length));
	return [...code.matchAll(new RegExp(`\\b${pattern}\\b`, 'g'))].map((match) =>
		({ character: match.index!, word: match[0], dotted: code[match.index! - 1] === '.' }));
}

function hit(file: string, own: StrictType, lines: string[], line: number, word: Word): Hit {
	const method = methodAt(own, line);
	return { file, line, character: word.character, word: word.word, method,
		isTest: line !== method?.line && method?.tests.includes(lines[line].trimStart()) === true };
}

function methodAt(own: StrictType, line: number): StrictMethod | undefined {
	return own.methods.find((method) => method.line <= line && line <= method.endLine);
}

function isParameter(method: StrictMethod | undefined, name: string): boolean {
	return method?.parameters.some((parameter) => parameter.name === name) === true;
}

function sameFile(first: { file: string }, second: { file: string }): boolean {
	return normalizeFsPath(first.file) === normalizeFsPath(second.file);
}
