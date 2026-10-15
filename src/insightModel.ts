import { sameType } from './implementations';
import { normalizeFsPath } from './paths';
import {
	callBefore, chainBefore, Entry, isTrait, localOf, membersOf, resolve, Resolved, Scope, scopeAt, StrictMethod,
	StrictType, typeNamed
} from './strictIndex';

export type Hint = { line: number; character: number; label: string; parameter: boolean };
export type Token = { line: number; character: number; length: number; type: string; modifiers: string[] };
export const tokenTypes = ['type', 'method', 'property', 'parameter', 'variable', 'enumMember'];
export const tokenModifiers = ['defaultLibrary', 'readonly', 'mutable', 'test'];
type Call = { callee: string; start: number; written: Array<{ start: number; text: string }> };

const literal = /^(-?\d+(\.\d+)?|"(?:[^"\\]|\\.)*"|true|false|\(.*\))$/;
const names = /"(?:[^"\\]|\\.)*"|\d+(?:\.\d+)?|([A-Za-z_]\w*)/g;

/** `: Type` after `let`, `constant`, `mutable` and `for x in` names, the parameter or member name before a literal argument
 * like `Clamp(minimum: 0.5)`. */
export function inlayHints(lines: string[], own: StrictType, types: StrictType[], from = 0, to = lines.length - 1): Hint[] {
	return lines.slice(from, to + 1).flatMap((text, offset) => {
		const line = from + offset;
		const scope = scopeAt(types, own, lines, line, true);
		const declared = localOf(text);
		const local = declared && resolve(declared.name, scope);
		const end = declared ? text.indexOf(`${declared.keyword} ${declared.name}`) + declared.keyword.length + declared.name.length + 1
			: 0;
		return [...local ? [{ line, character: end, label: `: ${typeText(local)}`, parameter: false }] : [],
			...calls(text).flatMap((call) => {
				const methods = calledMethods(call.callee, scope).filter((method) =>
					method.parameters.length >= call.written.length);
				return call.written.flatMap((argument, index) => {
					const name = literal.test(argument.text) && parameterName(methods, index, argument.text, scope);
					return name ? [{ line, character: argument.start, label: `${name}:`, parameter: true }] : [];
				});
			})];
	});
}

/** Every name that resolves: types (defaultLibrary from the Strict folder), methods, members, parameters and locals, with
 * the test modifier on test lines. */
export function semanticTokens(lines: string[], own: StrictType, types: StrictType[], root = ''): Token[] {
	const ownEntries = membersOf({ type: own }, types);
	return lines.flatMap((text, line) => {
		const scope = scopeAt(types, own, lines, line, true);
		scope.method ??= own.methods.find((method) => method.line === line);
		const test = scope.method && line > scope.method.line && line <= scope.method.line + scope.method.tests.length
			? ['test'] : [];
		return [...text.matchAll(names)].flatMap((match) => {
			const token = match[1] && tokenOf(match[1], text.slice(0, match.index), scope, ownEntries, root);
			return token ? [{ line, character: match.index!, length: match[1].length, type: token[0],
				modifiers: [...token.slice(1), ...test] }] : [];
		});
	});
}

/** Token type and modifiers of name, undefined when it does not resolve. */
function tokenOf(name: string, before: string, scope: Scope, ownEntries: Entry[], root: string): string[] | undefined {
	if (before.endsWith('.')) {
		const receiver = resolve(chainBefore(before.slice(0, -1)), scope);
		const entry = receiver && membersOf(receiver, scope.types).find((candidate) => candidate.name === name);
		return entry ? entryToken(entry) : undefined;
	}
	const local = scope.locals.get(name);
	const entry = ownEntries.find((candidate) => candidate.name === name);
	const type = /^[A-Z]/.test(name) ? typeNamed(name, scope.types)?.type : undefined;
	return scope.method?.parameters.some((parameter) => parameter.name === name) ? ['parameter']
		: local ? ['variable', ...local.keyword === 'mutable' ? ['mutable'] : local.keyword === 'for' ? [] : ['readonly']]
		: entry ? entryToken(entry) : type ? ['type', ...isInside(type.file, root) ? ['defaultLibrary'] : []] : undefined;
}

function entryToken(entry: Entry): string[] {
	const keyword = entry.member?.text.split(' ')[0];
	return entry.method ? ['method'] : keyword === 'constant' ? ['enumMember']
		: ['property', ...keyword === 'mutable' ? ['mutable'] : []];
}

function isInside(file: string, folder: string): boolean {
	return folder !== '' && normalizeFsPath(file).startsWith(`${normalizeFsPath(folder)}/`);
}

/** The type the code at the end of before needs: the parameter type of the call around it, else the return type on the
 * last line of a method. */
export function expectedType(before: string, scope: Scope, line: number): string | undefined {
	const call = callBefore(before);
	return call ? calledMethods(call.callee, scope).find((method) => method.parameters.length > call.argument)
		?.parameters[call.argument].type : scope.method && line === scope.method.line + scope.method.tests.length +
		scope.method.implementation.length ? scope.method.returns : undefined;
}

export function fits(expression: string, expected: string | undefined, scope: Scope): boolean {
	const resolved = expected ? resolve(expression, scope) : undefined;
	return resolved !== undefined && sameType(typeText(resolved), expected!);
}

// ponytail: of several methods with enough parameters the one whose parameter has exactly the type of the literal, a number
// for a Byte parameter gets no hint then; upgrade: overloads chosen by Strict's type inference
function parameterName(methods: StrictMethod[], index: number, literalText: string, scope: Scope): string | undefined {
	const parameters = methods.map((method) => method.parameters[index]);
	const type = resolve(literalText, scope)?.type;
	return (parameters.length > 1 ? parameters.filter((parameter) => typeNamed(parameter.type, scope.types)?.type === type)
		: parameters)[0]?.name;
}

/** Calls closed in text with their arguments, `(1, 2)` without a name in front is a list, not a call. */
function calls(text: string): Call[] {
	const closed: Call[] = [];
	const open: Call[] = [];
	let inText = false;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		const current = open[open.length - 1];
		inText = character === '"' && text[index - 1] !== '\\' ? !inText : inText;
		if (!inText && character === '(') {
			open.push({ callee: chainBefore(text.slice(0, index)), start: index + 1, written: [] });
		} else if (!inText && current && (character === ',' || character === ')')) {
			const argument = text.slice(current.start, index);
			current.written.push({ start: current.start + argument.length - argument.trimStart().length,
				text: argument.trim() });
			current.start = index + 1;
			if (character === ')') {
				closed.push(open.pop()!);
			}
		}
	}
	return closed.filter((call) => call.callee);
}

/** Methods a call of callee reaches: the constructors of a type or the named methods of its receiver, those of every type
 * when anyReceiver and the receiver is unknown. */
export function calledMethods(callee: string, scope: Scope, anyReceiver = false): StrictMethod[] {
	const dot = callee.lastIndexOf('.');
	const name = callee.slice(dot + 1);
	const own = dot < 0 ? scope.own.methods.filter((method) => method.name === name) : [];
	const type = dot < 0 && own.length === 0 ? typeNamed(name, scope.types)?.type : undefined;
	if (own.length > 0 || type) {
		return own.length > 0 ? own : constructors(type!, scope.types);
	}
	const receiver = dot > 0 ? resolve(callee.slice(0, dot), scope) : { type: scope.own };
	const entries = receiver ? membersOf(receiver, scope.types)
		: anyReceiver ? scope.types.flatMap((candidate) => membersOf({ type: candidate }, [])) : [];
	return entries.flatMap((entry) => entry.name === name && entry.method ? [entry.method] : []);
}

/** The `from` methods of a type and the constructor of its members, constants and traits (`has iterator`) are not passed. */
export function constructors(type: StrictType, types: StrictType[]): StrictMethod[] {
	const from = type.methods.filter((method) => method.name === 'from').map((method) =>
		({ ...method, header: type.name + method.header.slice(4) }));
	const members = type.members.filter((member) => !member.text.startsWith('constant ') &&
		!isTrait(typeNamed(member.type, types)?.type));
	return from.length > 0 && members.length === 0 ? from : [...from, {
		name: type.name, header: `${type.name}(${members.map((member) => member.name).join(', ')})`, line: 0, endLine: 0,
		parameters: members.map((member) => ({ name: member.name, type: member.type, optional: false })),
		returns: type.name, tests: [], implementation: []
	}];
}

/** `Numbers` for a list of Number, `List(Texts)` or `Iterator(Number)` for other generic types, else the type name. */
export function typeText(resolved: Resolved): string {
	return !resolved.element ? resolved.type.name : resolved.type.name === 'List' && /^\w+$/.test(resolved.element) &&
		!resolved.element.endsWith('s') ? `${resolved.element}s` : `${resolved.type.name}(${resolved.element})`;
}
