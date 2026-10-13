import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	copiedFrom, existingCalls, implementationCandidates, passedAll, pendingTests, usedSiblings, withImplementation
} from '../../implementations';
import { parseType } from '../../strictIndex';
import { number, text, list, vector } from './strictIndex.test';

const temperature = [
	'has celsius Number',
	'Limited(low Number, high Number) Number',
	'\tTemperature(30).Limited(0, 20) is 20',
	'\tcelsius > high then high else celsius < low then low else celsius',
	'Clamped(minimum Number, maximum Number) Number',
	'\tTemperature(30).Clamped(0, 20) is 20',
	'\tTemperature(10).Clamped(0, 20) is 10',
	'\t',
	'Doubled Number',
	'\tTemperature(2).Doubled is 4',
	'\tcelsius * 2'
].join('\n');
const own = parseType('C:/Code/Temperature.strict', temperature);
const types = [own, number, text, list, vector];

suite('implementations', () => {
	test('copiedFrom finds an existing method with the same body up to names and calls it with the same values', () => {
		const copy = copiedFrom(own.methods[0], own, types);
		assert.strictEqual(`${copy?.owner.name}.${copy?.method.name}`, 'Number.Clamp');
		assert.strictEqual(copy?.call, 'celsius.Clamp(low, high)');
		assert.strictEqual(copiedFrom(own.methods[2], own, types), undefined);
	});

	test('copiedFrom keeps index and value of a loop and calls on the list the existing type has', () => {
		const loop = (name: string, element: string) => parseType(`C:/Code/${name}.strict`, ['has numbers', `${name} Number`,
			`\t${name}((1, 2)).${name} is 3`, '\tmutable sum = 0', '\tfor numbers', `\t\tsum = sum + ${element}`, '\tsum'].join('\n'));
		const summer = loop('Summer', 'value');
		assert.strictEqual(copiedFrom(summer.methods[0], summer, [summer, loop('Counter', 'index')]), undefined);
		assert.strictEqual(copiedFrom(summer.methods[0], summer, [summer, loop('Adder', 'value')])?.call, 'numbers.Adder');
	});

	test('pendingTests are the tests of a method without implementation yet', () => {
		assert.deepStrictEqual(pendingTests(own.methods[1]), ['Temperature(30).Clamped(0, 20) is 20',
			'Temperature(10).Clamped(0, 20) is 10']);
		assert.strictEqual(pendingTests(own.methods[0]), undefined);
		assert.strictEqual(pendingTests(own.methods[2]), undefined);
	});

	test('implementationCandidates call existing methods of the same name first, then by return type and operators', () => {
		const candidates = implementationCandidates(own.methods[1], own, types);
		assert.strictEqual(candidates[0], 'celsius.Clamp(minimum, maximum)');
		for (const expected of ['minimum', 'celsius', 'celsius + minimum', 'maximum + minimum', 'Doubled',
			'Limited(minimum, maximum)']) {
			assert.ok(candidates.includes(expected), `${expected} in ${candidates.join(' | ')}`);
		}
		for (const unexpected of ['celsius.IsNearlyEqual(minimum)', 'Clamped(minimum, maximum)', 'celsius.digits']) {
			assert.ok(!candidates.includes(unexpected), unexpected);
		}
		assert.strictEqual(new Set(candidates).size, candidates.length);
	});

	test('existingCalls return the type of the method, same names first, never a method calling it', () => {
		const pair = parseType('C:/Code/Pair.strict', ['has numbers', 'Y Number', '\tPair((1, 2)).Y is 2', '\tnumbers(1)',
			'Doubled Pair', '\tPair((1, 2)).Doubled is 2', '\tPair(numbers * 2)'].join('\n'));
		const listType = parseType('C:/Strict/List.strict', ['has elements', 'Length Number', '\t(1, 2).Length is 2', '\t2',
			'Y Generic', '\t(1, 2).Y is 2', '\telements(1)'].join('\n'));
		const calls = (method: number, own = pair, all = [pair, listType, number]) =>
			existingCalls(own.methods[method], own, all).map((existing) => existing.call);
		assert.deepStrictEqual(calls(0), ['numbers.Y', 'numbers.Length']);
		assert.deepStrictEqual(calls(1), []);
		const caller = parseType('C:/Code/Caller.strict', ['has callee Callee', 'Emitted Number', '\tCaller(Callee(1)).Emitted is 1',
			'\tcallee.number'].join('\n'));
		const callee = parseType('C:/Code/Callee.strict', ['has number', 'Emitted Number', '\tCallee(1).Emitted is 1',
			'\tMiddle(value).Emitted'].join('\n'));
		const middle = parseType('C:/Code/Middle.strict', ['has number', 'Emitted Number', '\tMiddle(1).Emitted is 1',
			'\tCaller(Callee(number)).Emitted'].join('\n'));
		assert.deepStrictEqual(calls(0, caller, [caller, callee, number]), ['callee.Emitted']);
		assert.deepStrictEqual(calls(0, caller, [caller, callee, middle, number]), []);
	});

	test('existingCalls leave out methods the implementation already calls', () => {
		const wrapper = parseType('C:/Code/Temperature.strict', withImplementation(temperature, own.methods[1],
			'celsius.Clamp(minimum, maximum)'));
		assert.deepStrictEqual(existingCalls(wrapper.methods[1], wrapper, types).map((existing) => existing.call), []);
		assert.deepStrictEqual(existingCalls(own.methods[0], own, types).map((existing) => existing.call),
			['celsius.Clamp(low, high)']);
	});

	test('withImplementation keeps the tests of the method and replaces everything after them', () => {
		const lines = withImplementation(temperature, own.methods[1], 'celsius.Clamp(minimum, maximum)').split('\n');
		assert.deepStrictEqual(lines.slice(4, 9), ['Clamped(minimum Number, maximum Number) Number',
			'\tTemperature(30).Clamped(0, 20) is 20', '\tTemperature(10).Clamped(0, 20) is 10',
			'\tcelsius.Clamp(minimum, maximum)', 'Doubled Number']);
		assert.strictEqual(lines.length, 11);
	});

	test('withImplementation leaves out other methods without implementation, Strict can not run them', () => {
		const lines = withImplementation(temperature, own.methods[0], 'celsius.Clamp(low, high)').split('\n');
		assert.deepStrictEqual(lines.slice(3), ['\tcelsius.Clamp(low, high)', 'Doubled Number', '\tTemperature(2).Doubled is 4',
			'\tcelsius * 2']);
	});

	test('usedSiblings are the types of the folder the source uses, also through other types, broken unused ones stay out', () => {
		const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-siblings-'));
		try {
			fs.writeFileSync(path.join(folder, 'Board.strict'), 'has cells List(Cell)');
			fs.writeFileSync(path.join(folder, 'Cell.strict'), 'has color Color');
			fs.writeFileSync(path.join(folder, 'Color.strict'), 'has red Number');
			fs.writeFileSync(path.join(folder, 'Broken.strict'), 'has (');
			assert.deepStrictEqual(usedSiblings(path.join(folder, 'Game.strict'), 'has board\nhas cells Cells'),
				['Board.strict', 'Cell.strict', 'Color.strict']);
		} finally {
			fs.rmSync(folder, { recursive: true, force: true });
		}
	});

	test('passedAll only when every test of the method passed', () => {
		const passed = (line: number) => `Test passed: Temperature(30).Clamped(0, 20) is 20 in Clamped at x/Temperature.strict:line ${line}`;
		assert.ok(passedAll(`${passed(6)}\n${passed(7)}\nAll tests passed in x/Temperature.strict`, 'Clamped', 2));
		assert.ok(!passedAll(`${passed(6)}\nAll tests passed in x/Temperature.strict`, 'Clamped', 2));
		assert.ok(!passedAll(`${passed(6)}\nTest failed: Temperature(10).Clamped(0, 20) is 10 in Clamped at x:line 7\n  got: 0`,
			'Clamped', 2));
		assert.ok(!passedAll('ParsingFailed: Clamp( in x/Temperature.strict:8', 'Clamped', 2));
	});
});
