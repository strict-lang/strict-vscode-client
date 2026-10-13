import * as assert from 'assert';
import { callBefore, chainBefore, membersOf, parseType, resolve, scopeAt } from '../../strictIndex';

export const number = parseType('C:/Strict/Number.strict', [
	'has iterator',
	'constant Epsilon = 0.00001',
	'digits Numbers',
	'\t123.digits is (1, 2, 3)',
	'\t(value / 10).digits + value % 10',
	'Clamp(minimum = 0, maximum = 1) Number',
	'\t1.7.Clamp(0.5, 1.5) is 1.5',
	'\t0.3.Clamp is 0.3',
	'\tvalue > maximum then maximum else value < minimum then minimum else value',
	'IsNearlyEqual(other, difference = Epsilon) Boolean',
	'\t2.30000001.IsNearlyEqual(2.3)',
	'\t(value - other).Absolute < difference',
	'Increment(amount = 1) Mutable(Number)',
	'\tMutable(5).Increment is 6',
	'\tvalue = value + amount',
	'+(other) Number',
	'\t3 + 4 is 7',
	'\tvalue + other'
].join('\n'));
export const text = parseType('C:/Strict/Text.strict', ['has characters', 'Length Number', '\t"ab".Length is 2', '\t2'].join('\n'));
export const list = parseType('C:/Strict/List.strict',
	['has elements', 'First Generic', '\t(1, 2).First is 1', '\telements(0)'].join('\n'));
export const vector = parseType('C:/Strict/Math/Vector2.strict', [
	'has numbers with Length is 2',
	'constant One = Vector2(1, 1)',
	'X Number',
	'\tVector2(1, 2).X is 1',
	'\tnumbers(0)',
	'Normalize Vector2',
	'\tVector2(0, 5).Normalize is Vector2(0, 1)',
	'\tVector2(X / 5, 1)'
].join('\n'));
const ownLines = [
	'has vector Vector2',
	'has name Text',
	'Scaled(factor Number) Text',
	'\tOwn(Vector2(1, 2), "a").Scaled(2) is "1"',
	'\tlet doubled = vector.Normalize',
	'\tfor digit in factor.digits',
	'\t\tdoubled.X to Text'
];
const own = parseType('C:/Code/Own.strict', ownLines.join('\n'));
export const types = [own, number, text, list, vector];

suite('strict index', () => {
	test('parseType reads members, parameters with their inferred types, return types and tests', () => {
		assert.deepStrictEqual(number.members.map((member) => [member.name, member.type]),
			[['iterator', 'Iterator'], ['Epsilon', 'Number']]);
		assert.deepStrictEqual(vector.members.map((member) => [member.name, member.type]),
			[['numbers', 'Numbers'], ['One', 'Vector2']]);
		assert.deepStrictEqual(number.methods.map((method) =>
			[method.name, method.parameters.map((parameter) => `${parameter.name} ${parameter.type}`).join(', '), method.returns]), [
			['digits', '', 'Numbers'],
			['Clamp', 'minimum Number, maximum Number', 'Number'],
			['IsNearlyEqual', 'other Number, difference Number', 'Boolean'],
			['Increment', 'amount Number', 'Mutable(Number)'],
			['+', 'other Number', 'Number']
		]);
		assert.deepStrictEqual(number.methods[1].tests, ['1.7.Clamp(0.5, 1.5) is 1.5', '0.3.Clamp is 0.3']);
		assert.deepStrictEqual([number.methods[1].line, number.methods[1].endLine], [5, 8]);
		assert.deepStrictEqual(parseType('C:/Strict/Math/Ratio.strict', '﻿has number').members.map((member) => member.name),
			['number']);
	});

	test('chainBefore takes the receiver expression in front of the cursor', () => {
		assert.strictEqual(chainBefore('\tlet doubled = vector.Normalize'), 'vector.Normalize');
		assert.strictEqual(chainBefore('\t1.7'), '1.7');
		assert.strictEqual(chainBefore('\tif "hi there".Length'), '"hi there".Length');
		assert.strictEqual(chainBefore('\tlogger.Log(Vector2(1, 2).Normalize'), 'Vector2(1, 2).Normalize');
		assert.strictEqual(chainBefore('\tvalue + numbers(0)'), 'numbers(0)');
	});

	test('resolve follows literals, members, parameters, locals, loop variables and return types', () => {
		const scope = scopeAt(types, own, ownLines, 6);
		const typeOf = (chain: string) => resolve(chain, scope)?.type.name;
		assert.deepStrictEqual(['1.7', '"hi"', '"hi".Length', 'vector', 'vector.Normalize.X', 'doubled', 'factor', 'digit',
			'Vector2(1, 2)', 'vector.numbers(0)', 'Vector2.One', 'name.Length', 'vector.numbers.First', 'unknown'].map(typeOf),
		['Number', 'Text', 'Number', 'Vector2', 'Number', 'Vector2', 'Number', 'Number', 'Vector2', 'Number', 'Vector2', 'Number',
			'Number', undefined]);
		assert.strictEqual(resolve('Vector2', scope)?.isType, true);
	});

	test('membersOf lists methods and members of a type and of the types it has', () => {
		const names = membersOf({ type: own }, types).map((entry) => `${entry.owner.name}.${entry.name}`);
		assert.deepStrictEqual(names, ['Own.vector', 'Own.name', 'Own.Scaled', 'Vector2.numbers', 'Vector2.One', 'Vector2.X',
			'Vector2.Normalize', 'Text.characters', 'Text.Length']);
	});

	test('callBefore finds the called chain and the index of the argument being typed', () => {
		assert.deepStrictEqual(callBefore('\tvector.Lerp(other, '), { callee: 'vector.Lerp', argument: 1 });
		assert.deepStrictEqual(callBefore('\tVector2(1, (2'), { callee: 'Vector2', argument: 1 });
		assert.strictEqual(callBefore('\tVector2(1, 2) + 3'), undefined);
	});
});
