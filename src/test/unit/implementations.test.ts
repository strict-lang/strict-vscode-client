import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	copiedFrom, evaluated, evaluatedType, existingCalls, implementationCandidates, passedAll, pendingTests, sharedRun, SharedRun,
	unfinishedTest, usedSiblings, withEvaluation, withImplementation, withTemporaryCopy
} from '../../implementations';
import { parseType, Resolved } from '../../strictIndex';
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

async function inBoardFolder(use: (folder: string) => unknown): Promise<void> {
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-siblings-'));
	try {
		fs.writeFileSync(path.join(folder, 'Board.strict'), 'has cells List(Cell)');
		fs.writeFileSync(path.join(folder, 'Cell.strict'), 'has color Color');
		fs.writeFileSync(path.join(folder, 'Color.strict'), 'has red Number');
		fs.writeFileSync(path.join(folder, 'Broken.strict'), 'has (');
		await use(folder);
	} finally {
		fs.rmSync(folder, { recursive: true, force: true });
	}
}

suite('implementations', () => {
	test('copiedFrom finds an existing method with the same body up to names and calls it with the same values', () => {
		const copy = copiedFrom(own.methods[0], own, types);
		assert.strictEqual(`${copy?.owner.name}.${copy?.method.name}`, 'Number.Clamp');
		assert.strictEqual(copy?.call, 'celsius.Clamp(low, high)');
		assert.strictEqual(copiedFrom(own.methods[2], own, types), undefined);
	});

	test('copiedFrom keeps index and value of a loop and builds the existing type from the list it has', () => {
		const loop = (name: string, element: string) => parseType(`C:/Code/${name}.strict`, ['has numbers', `${name} Number`,
			`\t${name}((1, 2)).${name} is 3`, '\tmutable sum = 0', '\tfor numbers', `\t\tsum = sum + ${element}`, '\tsum'].join('\n'));
		const summer = loop('Summer', 'value');
		assert.strictEqual(copiedFrom(summer.methods[0], summer, [summer, loop('Counter', 'index')]), undefined);
		assert.strictEqual(copiedFrom(summer.methods[0], summer, [summer, loop('Adder', 'value')])?.call, 'Adder(numbers).Adder');
	});

	test('pendingTests are the tests of a method without implementation yet', () => {
		assert.deepStrictEqual(pendingTests(own.methods[1]), ['Temperature(30).Clamped(0, 20) is 20',
			'Temperature(10).Clamped(0, 20) is 10']);
		assert.strictEqual(pendingTests(own.methods[0]), undefined);
		assert.strictEqual(pendingTests(own.methods[2]), undefined);
		assert.strictEqual(pendingTests(parseType('C:/Code/Temperature.strict',
			'has celsius Number\nIsFrozen Boolean\n\tcelsius is 0').methods[0]), undefined);
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

	test('usedSiblings are the types of the folder the source uses, also through other types, broken unused ones stay out', () =>
		inBoardFolder((folder) => assert.deepStrictEqual(usedSiblings(path.join(folder, 'Game.strict'), 'has board\nhas cells Cells'),
			['Board.strict', 'Cell.strict', 'Color.strict'])));

	test('withTemporaryCopy copies the sibling types any of the texts uses next to the copy, no native traits or base types', () =>
		inBoardFolder(async (folder) => {
			const copied = () => withTemporaryCopy(path.join(folder, 'Game.strict'), ['has number', '\tBoard(number)'],
				async (copy) => ({ copy, files: fs.readdirSync(path.dirname(copy)).sort() }));
			const { copy, files } = await copied();
			assert.deepStrictEqual(files, ['Board.strict', 'Cell.strict', 'Color.strict']);
			assert.ok(path.basename(copy) === 'Game.strict' && !fs.existsSync(path.dirname(copy)), copy);
			fs.mkdirSync(path.join(folder, 'native'));
			fs.writeFileSync(path.join(folder, 'Color.strict'), 'has red Number\nBrightness Number');
			fs.writeFileSync(path.join(folder, 'Board.strict'), 'has cells List(Cell)\nCount = cells.Length');
			assert.deepStrictEqual((await copied()).files, ['Board.strict', 'Cell.strict']);
			fs.writeFileSync(path.join(folder, 'Any.strict'), '');
			assert.deepStrictEqual((await copied()).files, []);
		}));

	test('sharedRun runs once for all callers until every one of them is cancelled, a cancelled run is not kept', async () => {
		const runs = new Map<string, SharedRun>();
		let starts = 0;
		const start = async (isCancelled: () => boolean) => {
			starts++;
			await new Promise((resolve) => setImmediate(resolve));
			return isCancelled() ? [] : ['celsius'];
		};
		let movedOn = false;
		const clamped = [sharedRun(runs, 'Clamped', () => movedOn, start), sharedRun(runs, 'Clamped', () => false, start)];
		movedOn = true;
		const doubled = sharedRun(runs, 'Doubled', () => true, start);
		const limited = [sharedRun(runs, 'Limited', () => true, start), sharedRun(runs, 'Limited', () => false, start)];
		assert.deepStrictEqual(await Promise.all([...clamped, doubled, ...limited]),
			[['celsius'], ['celsius'], [], [], ['celsius']]);
		assert.deepStrictEqual([starts, [...runs.keys()]], [4, ['Clamped', 'Limited']]);
	});

	test('unfinishedTest is the left side of a test ending in is or is ?, complete tests and implementation lines have none', () =>
		assert.deepStrictEqual(['\tTemperature(3).Doubled is', '\tTemperature(3).Doubled is ? ', '\tTemperature(3).Doubled is 6',
			'\tconstant done = celsius is', '\t\tcelsius is'].map(unfinishedTest),
		['Temperature(3).Doubled', 'Temperature(3).Doubled', undefined, undefined, undefined]));

	test('withEvaluation tests the expression first against a placeholder of its type, without lines Strict can not run', () => {
		const unfinished = temperature.replace('\tcelsius * 2', '\tTemperature(3).Doubled is ?\n\tcelsius * 2');
		const doubled = parseType('C:/Code/Temperature.strict', unfinished).methods[2];
		const evaluation = withEvaluation(unfinished, doubled, '"hi" + "there"', { type: text });
		assert.deepStrictEqual(evaluation.text.split('\n'), ['has celsius Number', 'Limited(low Number, high Number) Number',
			'\tTemperature(30).Limited(0, 20) is 20', '\tcelsius > high then high else celsius < low then low else celsius',
			'Doubled Number', '\t"hi" + "there" is ""', '\t"hi" + "there" is Error', '\tTemperature(2).Doubled is 4',
			'\tcelsius * 2']);
		assert.deepStrictEqual([undefined, { type: number }, { type: list, element: 'Number' },
			{ type: parseType('C:/Strict/Boolean.strict', '') }].map((resolved) =>
			withEvaluation(unfinished, doubled, 'celsius', resolved).test),
		['celsius is 0', 'celsius is 0', 'celsius is (0)', 'celsius is true']);
		assert.deepStrictEqual(['celsius > 0 and celsius < 9', 'celsius > 0 then 1 else 2', 'Limited(0 or 1, 2)', '"a or b"']
			.map((expression) => withEvaluation(unfinished, doubled, expression).test), ['(celsius > 0 and celsius < 9) is 0',
			'(celsius > 0 then 1 else 2) is 0', 'Limited(0 or 1, 2) is 0', '"a or b" is 0']);
	});

	test('evaluated is the value after got: as Strict code, the placeholder when the test passed, else the error of Strict', () => {
		const at = 'in Doubled at ../Temp/strict-1/Temperature.strict:line 6';
		const evaluation = (expression: string, output: string, resolved?: Resolved, exitCode = 1) => evaluated(
			withEvaluation(temperature, own.methods[2], expression, resolved), { exitCode, durationMs: 1, output }, resolved);
		assert.deepStrictEqual(evaluation('celsius * 3', `Test failed: celsius * 3 is 0 ${at}\n  got: 9\n1 tests failed in x`),
			{ value: '9' });
		assert.deepStrictEqual(evaluation('celsius * 3', `Test passed: celsius * 3 is 0 ${at} (0.01 ms)\nAll tests passed in x`,
			undefined, 0), { value: '0' });
		assert.deepStrictEqual(evaluation('"a b".Split(" ")', `Test failed: "a b".Split(" ") is (0) ${at}\n  got: (a, b)`,
			{ type: list, element: 'Text' }), { value: '("a", "b")' });
		assert.deepStrictEqual(evaluation('celsius / 0', `Test failed: celsius / 0 is 0 ${at}\n  got: Error: DivisionByZero`),
			{ value: 'Error("DivisionByZero")' });
		assert.deepStrictEqual(evaluation('celsius', `Test failed: celsius is 0 ${at}\n  got: Error: ConstraintNotMet: "0" > 0`),
			{ value: 'Error("ConstraintNotMet: \\"0\\" > 0")' });
		const named = (errorTest: string) => evaluation('"Error: " + name', `Test failed: "Error: " + name is "" ${at}\n` +
			`  got: Error: Boom\nTest ${errorTest}: "Error: " + name is Error ${at.replace('line 6', 'line 7')}\n  got: Error: Boom`,
			{ type: text });
		assert.deepStrictEqual([named('failed'), named('passed')], [{ value: '"Error: Boom"' }, { value: 'Error("Boom")' }]);
		assert.deepStrictEqual(evaluation('name', `Test failed: name is "" ${at}\n  got: say "hi" \\ now`, { type: text }),
			{ value: '"say \\"hi\\" \\\\ now"' });
		assert.deepStrictEqual(evaluation('scaled', 'NameNotFound: scaled used in ./../Temp/strict-1/Temperature.strict:6'),
			{ error: 'NameNotFound: scaled used in Temperature.strict' });
		assert.deepStrictEqual(evaluation('celsius / 0', `Test failed: celsius / 0 is 0 ${at}`, undefined, 3221225477),
			{ error: 'Strict crashed with exit code 3221225477' });
	});

	test('evaluatedType is Boolean for outermost comparisons, X for to X, the then value of a conditional, else what resolve finds',
		() => {
			const scope = { types: [...types, parseType('C:/Strict/Boolean.strict', '')], own, method: own.methods[2],
				locals: new Map(), loops: [] };
			assert.deepStrictEqual(['"a" is "b"', 'celsius > 0', 'not true', 'celsius to Text', 'celsius > 0 then "hot" else "cold"',
				'"a is b"', 'Limited(0 is 1, 2)'].map((expression) => evaluatedType(expression, scope)?.type.name),
			['Boolean', 'Boolean', 'Boolean', 'Text', 'Text', 'Text', 'Number']);
		});

	test('passedAll only when every test of the method passed', () => {
		const passed = (line: number) => `Test passed: Temperature(30).Clamped(0, 20) is 20 in Clamped at x/Temperature.strict:line ${line}`;
		assert.ok(passedAll(`${passed(6)}\n${passed(7)}\nAll tests passed in x/Temperature.strict`, 'Clamped', 2));
		assert.ok(passedAll(`${passed(6)} (0.02 ms)\n${passed(7)} (97.57 ms)\nAll tests passed in x/Temperature.strict`,
			'Clamped', 2));
		assert.ok(!passedAll(`${passed(6)}\nAll tests passed in x/Temperature.strict`, 'Clamped', 2));
		assert.ok(!passedAll(`${passed(6)}\nTest failed: Temperature(10).Clamped(0, 20) is 10 in Clamped at x:line 7\n  got: 0`,
			'Clamped', 2));
		assert.ok(!passedAll('ParsingFailed: Clamp( in x/Temperature.strict:8', 'Clamped', 2));
	});
});
