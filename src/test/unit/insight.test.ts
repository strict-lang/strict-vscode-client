import * as assert from 'assert';
import { calledMethods, constructors, expectedType, fits, inlayHints, semanticTokens, typeText } from '../../insightModel';
import { parseType, scopeAt } from '../../strictIndex';
import { list, types } from './strictIndex.test';

const iterator = parseType('C:/Strict/Iterator.strict',
	['has length', 'for Iterator(Generic)', 'in(element Generic) Boolean'].join('\n'));
const boolean = parseType('C:/Strict/Boolean.strict', '');
const shiftsLines = [
	'has numbers',
	'constant Limit = 3',
	'mutable count Number',
	'Shifted(offset Number) Number',
	'\tShifts((1, 2)).Shifted(1) is 2',
	'\tlet clamped = offset.Clamp(0.5, 1.5)',
	'\tmutable total = Limit',
	'\tfor digit in Range(0, 3)',
	'\t\ttotal = clamped.Clamp(digit, 2)',
	'\tlet unknown = missing.Call(1)',
	'\ttotal + count + numbers.First'
];
const shifts = parseType('C:/Code/Shifts.strict', shiftsLines.join('\n'));
const all = [shifts, ...types, iterator, boolean];

suite('insight', () => {
	test('inlayHints show types of locals and loop variables, parameter and member names before literal arguments', () => {
		assert.deepStrictEqual(inlayHints(shiftsLines, shifts, all).map((hint) => `${hint.line}:${hint.character} ${hint.label}`), [
			'1:14 : Number', '4:8 numbers:', '4:24 offset:', '5:12 : Number', '5:28 minimum:', '5:33 maximum:', '6:14 : Number',
			'7:10 : Number', '7:20 Start:', '7:23 ExclusiveEnd:', '8:31 maximum:'
		]);
	});

	test('semanticTokens mark resolved types, methods, members, parameters and locals, test lines and Strict folder types', () => {
		const tokens = semanticTokens(shiftsLines, shifts, all, 'C:/Strict').map((token) => `${token.line}:${shiftsLines[token.line]
			.substr(token.character, token.length)} ${[token.type, ...token.modifiers].join('.')}`);
		assert.deepStrictEqual(tokens, [
			'0:numbers property', '1:Limit enumMember', '2:count property.mutable', '2:Number type.defaultLibrary',
			'3:Shifted method', '3:offset parameter', '3:Number type.defaultLibrary', '3:Number type.defaultLibrary',
			'4:Shifts type.test', '4:Shifted method.test', '5:clamped variable.readonly', '5:offset parameter', '5:Clamp method',
			'6:total variable.mutable', '6:Limit enumMember', '7:digit variable', '7:Range type.defaultLibrary',
			'8:total variable.mutable', '8:clamped variable.readonly', '8:Clamp method', '8:digit variable',
			'9:unknown variable.readonly', '10:total variable.mutable', '10:count property.mutable', '10:numbers property',
			'10:First method'
		]);
	});

	test('calledMethods prefer an own method named like a type, a last line before the final newline expects the return type', () => {
		const lines = ['has numbers', 'Error(line Numbers) Number', '\tFit((1)).Error((1)) is 1', '\tline.Sum', ''];
		const fit = parseType('C:/Code/Fit.strict', lines.join('\n'));
		const error = parseType('C:/Strict/Error.strict', ['has name', 'from(name)', '\tError("a").name is "a"', '\tvalue']
			.join('\n'));
		const scope = scopeAt([fit, error, ...all], fit, lines, 3);
		assert.deepStrictEqual(calledMethods('Error', scope).map((method) => method.header), ['Error(line Numbers) Number']);
		assert.strictEqual(expectedType('\t', scope, 3), 'Number');
	});

	test('expectedType is the parameter type around the cursor or the return type on the last line, fits compares with it', () => {
		const scope = (line: number) => scopeAt(all, shifts, shiftsLines, line);
		assert.deepStrictEqual([expectedType('\tShifts(', scope(4), 4), expectedType('\tlet x = ', scope(5), 5),
			expectedType('\ttotal + ', scope(10), 10)], ['Numbers', undefined, 'Number']);
		const fitting = (expected: string) => ['offset', 'numbers', 'numbers.First', 'true', 'Shifts'].filter((name) =>
			fits(name, expected, scope(9)));
		assert.deepStrictEqual(['Number', 'Boolean', 'List(Number)', 'Shifts'].map(fitting),
			[['offset', 'numbers.First'], ['true'], ['numbers'], ['Shifts']]);
	});

	test('constructors are the from methods and the members without constants and traits, computed methods are no trait', () => {
		const area = parseType('C:/Code/Area.strict', ['has Width Number', 'Area = Width * 2'].join('\n'));
		const sized = parseType('C:/Code/Sized.strict',
			['has iterator', 'has area', 'constant Unit = 1', 'from(text)', '\tSized(Area(1))'].join('\n'));
		assert.deepStrictEqual(constructors(sized, [sized, area, iterator]).map((method) => method.header),
			['Sized(text)', 'Sized(area)']);
	});

	test('typeText writes lists of single types in plural, lists of lists and other generics with brackets', () => {
		assert.deepStrictEqual([...['Number', 'Numbers', 'Process'].map((element) => typeText({ type: list, element })),
			typeText({ type: iterator, element: 'Number' })], ['Numbers', 'List(Numbers)', 'List(Process)', 'Iterator(Number)']);
	});
});
