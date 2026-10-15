import * as assert from 'assert';
import { isStrictBinaryPath } from '../../scrunchCache';
import { discoverStrictTests, isRunnableHeader, typeNameFromPath } from '../../scrunchDiscover';
import {
	enrichNotification,
	formatCoverageHover,
	formatInlineFailure,
	formatInlineSlow,
	groupByMethod,
	isManualMethod,
	lineCoverageMarks,
	manualResults,
	methodForLine,
	methodsWithTests,
	shouldExecuteManual,
	visibleMethods
} from '../../scrunchModel';
import {
	formatDuration,
	formatErrorSummary,
	formatFailureOutput,
	formatMethodOutput,
	MethodOutput,
	methodLine,
	parseDiscrepancy,
	parseStackFrames,
	TestRunnerNotification,
	unprintedOutput
} from '../../testResults';

suite('scrunch discover', () => {
	test('implementation includes the nested lines of conditions and loops', () => {
		assert.deepStrictEqual(discoverStrictTests(['Sum Number', '\tLoop(3).Sum is 6', '\tif number < 0', '\t\treturn 0',
			'\tfor Range(0, number)', '\t\ttotal = total + value', '\ttotal'].join('\n'))[0].implementation.map((line) =>
			line.lineNumber), [2, 3, 4, 5, 6]);
	});

	test('finds methods and leading tests, skips members and implementation', () => {
		const source = [
			'has number',
			'not Boolean',
			'\tnot true is false',
			'\tnot false is true',
			'\tvalue then false else true',
			'and(other) Boolean',
			'\ttrue and false is false',
			'\ttrue and true',
			'\tvalue then other else false'
		].join('\n');
		const methods = discoverStrictTests(source);
		assert.deepStrictEqual(
			methods.map((method) => method.name),
			['not', 'and']
		);
		assert.deepStrictEqual(
			methods[0].tests.map((test) => ({ line: test.lineNumber, text: test.expression })),
			[
				{ line: 2, text: 'not true is false' },
				{ line: 3, text: 'not false is true' }
			]
		);
		assert.deepStrictEqual(
			methods[1].tests.map((test) => test.expression),
			['true and false is false', 'true and true']
		);
	});

	test('stops tests at for/if implementation', () => {
		const source = [
			'in(key Generic) Boolean',
			'\t2 is in Dictionary((1, 1), (2, 2))',
			'\t3 is not in Dictionary((1, 1), (2, 2))',
			'\tfor keysAndValues',
			'\t\tvalue.Key is key'
		].join('\n');
		const [method] = discoverStrictTests(source);
		assert.strictEqual(method.name, 'in');
		assert.deepStrictEqual(
			method.tests.map((test) => test.expression),
			['2 is in Dictionary((1, 1), (2, 2))', '3 is not in Dictionary((1, 1), (2, 2))']
		);
	});

	test('ignores has/constant/mutable lines as methods', () => {
		const source = ['has logger', 'constant Pi = 3', 'Run', '\t5 is 5', '\tlogger.Log(Pi)'].join('\n');
		const methods = discoverStrictTests(source);
		assert.strictEqual(methods.length, 1);
		assert.strictEqual(methods[0].name, 'Run');
		assert.strictEqual(methods[0].tests[0].expression, '5 is 5');
	});

	test('does not treat implementation that uses value as a test', () => {
		const source = [
			'has value Text',
			'Greet Text',
			'\tTextHelper("World").Greet is "Hello, World!"',
			'\tTextHelper("Strict").Greet is "Hello, Strict!"',
			'\t"Hello, " + value + "!"'
		].join('\n');
		const [method] = discoverStrictTests(source);
		assert.strictEqual(method.name, 'Greet');
		assert.deepStrictEqual(
			method.tests.map((test) => test.expression),
			['TextHelper("World").Greet is "Hello, World!"', 'TextHelper("Strict").Greet is "Hello, Strict!"']
		);
		assert.deepStrictEqual(
			method.implementation.map((line) => line.expression),
			['"Hello, " + value + "!"']
		);
	});

	test('typeNameFromPath drops the .strict suffix', () => {
		assert.strictEqual(typeNameFromPath('C:\\repo\\TextHelper.strict'), 'TextHelper');
		assert.strictEqual(typeNameFromPath('/tmp/Boolean.STRICT'), 'Boolean');
	});

	test('methodsWithTests hides Run and keeps Greet', () => {
		const source = [
			'has logger',
			'Run',
			'\tconstant worldHelper = TextHelper("World")',
			'\tlogger.Log(worldHelper.Greet)',
			'Greet Text',
			'\tTextHelper("World").Greet is "Hello, World!"',
			'\t"Hello, " + value + "!"'
		].join('\n');
		const methods = discoverStrictTests(source);
		assert.deepStrictEqual(methodsWithTests(methods).map((method) => method.name), ['Greet']);
		assert.deepStrictEqual(visibleMethods(methods).map((method) => method.name), ['Run', 'Greet']);
		assert.strictEqual(methods.find((method) => method.name === 'Run')?.runnable, true);
		assert.strictEqual(methods.find((method) => method.name === 'Greet')?.runnable, true);
	});

	test('isRunnableHeader treats missing or defaulted parameters as runnable', () => {
		assert.strictEqual(isRunnableHeader('Run'), true);
		assert.strictEqual(isRunnableHeader('Greet Text'), true);
		assert.strictEqual(isRunnableHeader('Run()'), true);
		assert.strictEqual(isRunnableHeader('Run(input = 5)'), true);
		assert.strictEqual(isRunnableHeader('and(other)'), false);
		assert.strictEqual(isRunnableHeader('from(value Number)'), false);
	});

	test('Run without tests is manual and only executes when requested explicitly', () => {
		const methods = discoverStrictTests([
			'has logger',
			'Run',
			'\tconstant worldHelper = TextHelper("World")',
			'\tlogger.Log(worldHelper.Greet)'
		].join('\n'));
		const run = methods.find((method) => method.name === 'Run');
		assert.ok(run);
		assert.strictEqual(isManualMethod(run!), true);
		assert.strictEqual(shouldExecuteManual(run!, false), false);
		assert.strictEqual(shouldExecuteManual(run!, true), true);
		assert.strictEqual(methodsWithTests(methods).length, 0);
	});

	test('methodForLine maps a test line to its method, never a tests node', () => {
		const methods = discoverStrictTests([
			'has value Text',
			'Greet Text',
			'\tTextHelper("World").Greet is "Hello, World!"',
			'\tTextHelper("Strict").Greet is "Hello, Strict!"',
			'\t"Hello, " + value + "!"'
		].join('\n'));
		assert.strictEqual(methodForLine(methods, 2)?.name, 'Greet');
		assert.strictEqual(methodForLine(methods, 3)?.name, 'Greet');
		assert.strictEqual(methodForLine(methods, 1)?.name, 'Greet');
		assert.strictEqual(methodForLine(methods, 0), undefined);
	});

	test('tests never start with a member or parameter, a constant before a test belongs to the tests', () => {
		const methods = discoverStrictTests(['has logger', 'Run', '\tlogger.Log("a is b")', '\tlogger.Log("c")',
			'Digit Character', '\t5.Digit is "5"', '\tconstant invalid = Error', '\t10.Digit is invalid', '\t10.Random < 10',
			'\tvalue is in Range(0, 10) then Character(value) else invalid'].join('\n'));
		assert.deepStrictEqual(methods.map((method) => method.tests.map((test) => test.lineNumber)), [[], [5, 7, 8]]);
		assert.strictEqual(methods[0].runnable && methods[0].tests.length === 0, true);
	});

	test('manualResults keep only the results of Run methods without tests, a new strict test replaces the others', () => {
		const methods = discoverStrictTests(['has logger', 'Run', '\tlogger.Log("a")', 'Twice Number', '\tA.Twice is 2', '\t2']
			.join('\n'));
		const results = new Map<number, TestRunnerNotification>([[1, { lineNumber: 1, state: 1, methodName: 'Run' }],
			[4, { lineNumber: 4, state: 0, methodName: 'Twice', expression: 'A.Twice is 2' }]]);
		assert.deepStrictEqual([...manualResults(results, methods).keys()], [1]);
	});

	test('groupByMethod keeps overloads apart by their header', () => {
		const methods = discoverStrictTests(['has characters', '+(other) Text', '\t"" + "more" is "more"',
			'\tcharacters + other.characters', '+(number) Text', '\t"" + 1 is "1"', '\tcharacters + number to Text'].join('\n'));
		const results = new Map<number, TestRunnerNotification>([[2, { lineNumber: 2, state: 1, methodName: '+' }],
			[5, { lineNumber: 5, state: 0, methodName: '+' }]]);
		assert.deepStrictEqual([...groupByMethod(results, methods)].map(([header, summary]) => [header, summary.failed]),
			[['+(other) Text', false], ['+(number) Text', true]]);
	});

	test('enrichNotification fills method from line when the server omits it', () => {
		const methods = discoverStrictTests([
			'Greet Text',
			'\tTextHelper("World").Greet is "Hello, World!"',
			'\t"Hello, " + value + "!"'
		].join('\n'));
		const enriched = enrichNotification({ lineNumber: 1, state: 1 }, methods, 'TextHelper');
		assert.strictEqual(enriched.methodName, 'Greet');
		assert.strictEqual(enriched.typeName, 'TextHelper');
		assert.strictEqual(enriched.expression, 'TextHelper("World").Greet is "Hello, World!"');
		assert.strictEqual(enriched.lineNumber, 1);
		assert.notStrictEqual(enriched.methodName, 'tests');
	});

	test('enrichNotification accepts 1-based line numbers from the server', () => {
		const methods = discoverStrictTests([
			'Greet Text',
			'\tTextHelper("World").Greet is "Hello, World!"',
			'\t"Hello, " + value + "!"'
		].join('\n'));
		const enriched = enrichNotification({ lineNumber: 2, state: 1 }, methods, 'TextHelper');
		assert.strictEqual(enriched.methodName, 'Greet');
		assert.strictEqual(enriched.lineNumber, 1);
		assert.strictEqual(enriched.expression, 'TextHelper("World").Greet is "Hello, World!"');
	});
});

suite('scrunch format', () => {
	test('formatDuration uses us below 100us and a single ms value at or above', () => {
		assert.strictEqual(formatDuration(undefined), undefined);
		assert.strictEqual(formatDuration(0), '<1us');
		assert.strictEqual(formatDuration(0.0004), '<1us');
		assert.strictEqual(formatDuration(0.04), '40us');
		assert.strictEqual(formatDuration(0.099), '99us');
		assert.strictEqual(formatDuration(0.1), '0.1ms');
		assert.strictEqual(formatDuration(0.8), '0.8ms');
		assert.strictEqual(formatDuration(1.24), '1.2ms');
		assert.strictEqual(formatDuration(18), '18ms');
		assert.strictEqual(formatDuration(1500), '1.5s');
	});

	test('parseStackFrames keeps Strict frames and drops C# runtime frames', () => {
		const frames = parseStackFrames(
			'at TextHelper.Greet in C:\\repo\\TextHelper.strict:line 5\n' +
			'at Strict.HighLevelRuntime.MethodCallEvaluator.Evaluate in C:\\repo\\MethodCallEvaluator.cs:line 46'
		);
		assert.deepStrictEqual(frames, [
			{ label: 'TextHelper.Greet', file: 'C:\\repo\\TextHelper.strict', line: 5 }
		]);
	});

	test('parseStackFrames reads clickable Strict frames', () => {
		const frames = parseStackFrames(
			'"not" method failed: not true is false\n   at Strict/Boolean.not in C:\\repo\\Boolean.strict:line 4'
		);
		assert.deepStrictEqual(frames, [
			{ label: 'Strict/Boolean.not', file: 'C:\\repo\\Boolean.strict', line: 4 }
		]);
	});

	test('formatFailureOutput includes expression, details and stack', () => {
		const output = formatFailureOutput({
			lineNumber: 1,
			state: 0,
			expression: 'not true is false',
			methodName: 'not',
			details: 'true is false',
			message: '"not" method failed: not true is false',
			stackTrace: 'at Strict/Boolean.not in C:\\repo\\Boolean.strict:line 2'
		});
		assert.ok(output.includes('not true is false'));
		assert.ok(output.includes('not'));
		assert.ok(output.includes('true is false'));
		assert.ok(output.includes('Boolean.strict:line 2'));
	});

	test('formatMethodOutput is only the failure, a passed method without console text logs nothing', () => {
		assert.strictEqual(formatMethodOutput({}), '');
		assert.strictEqual(formatMethodOutput({
			details: '"Hello" is "Hello, yo!"',
			expected: '"Hello, yo!"',
			actual: '"Hello"',
			stackTrace: 'at TextHelper.Greet in C:\\repo\\TextHelper.strict:line 3',
			failed: true
		}), 'Expected: "Hello, yo!"\nActual: "Hello"\n\nat TextHelper.Greet in C:\\repo\\TextHelper.strict:3');
	});

	test('formatErrorSummary is a short human name, not a type path', () => {
		assert.strictEqual(
			formatErrorSummary(
				'Cannot call body on trait method: TextWriter.Write is a trait method and has no implementation'
			),
			'Cannot call body on trait method'
		);
		assert.strictEqual(formatErrorSummary('Strict/TextWriter.Write'), 'Strict/TextWriter.Write');
		assert.strictEqual(formatErrorSummary('NameNotFound: LoadedUnitData used in ./WebWars/Scene.strict:8\n' +
			'NameNotFound: SpellData used in ./WebWars/Scene.strict:49'), 'LoadedUnitData used in ./WebWars/Scene.strict:8');
		assert.strictEqual(formatErrorSummary(undefined), undefined);
	});

	test('unprintedOutput prints a crash once, what a type printed once per file and every failed comparison', () => {
		const printed = new Set<string>();
		const crash = { failed: true, message: 'NameNotFound: NavigationMap used in ./Games/LevelProcessor.strict:3' };
		const logged = { consoleOutput: 'computing' };
		const comparison = { failed: true, expected: 'true', actual: 'false' };
		assert.deepStrictEqual([[crash, 'A'], [crash, 'B'], [logged, 'A'], [logged, 'A'], [logged, 'B'], [comparison, 'A'],
			[comparison, 'A']].map(([output, file]) => unprintedOutput(output as MethodOutput, file as string, printed) !== undefined),
			[true, false, true, false, true, true, true]);
	});

	test('methodLine shows how a method did and its time', () => {
		assert.deepStrictEqual([methodLine(false, 0.3), methodLine(true, undefined)], ['✓ 0.3ms', '✗ cached']);
	});

	test('formatMethodOutput shows console text when the test printed something', () => {
		assert.strictEqual(formatMethodOutput({ consoleOutput: 'Hello, World!\nHello, Strict!' }),
			'Hello, World!\nHello, Strict!');
	});

	test('parseDiscrepancy reads actual is expected', () => {
		assert.deepStrictEqual(parseDiscrepancy('"Hello" is "Hello, yo!"'), {
			actual: '"Hello"',
			expected: '"Hello, yo!"'
		});
		assert.strictEqual(parseDiscrepancy(undefined), undefined);
	});
});

suite('scrunch coverage', () => {
	test('TextHelper: checkmark on Greet, dots on tests and impl, never on members', () => {
		const methods = discoverStrictTests([
			'has value Text',
			'Greet Text',
			'\tTextHelper("World").Greet is "Hello, World!"',
			'\tTextHelper("Strict").Greet is "Hello, Strict!"',
			'\t"Hello, " + value + "!"'
		].join('\n'));
		const results = new Map<number, TestRunnerNotification>([
			[2, {
				lineNumber: 2, state: 1, expression: 'TextHelper("World").Greet is "Hello, World!"',
				methodName: 'Greet', durationMs: 0.0004
			}],
			[3, {
				lineNumber: 3, state: 1, expression: 'TextHelper("Strict").Greet is "Hello, Strict!"',
				methodName: 'Greet', durationMs: 0.0005
			}]
		]);
		const marks = lineCoverageMarks(methods, results, new Set());
		assert.strictEqual(marks.find((mark) => mark.lineNumber === 0), undefined);
		const methodLine = marks.find((mark) => mark.lineNumber === 1);
		assert.strictEqual(methodLine?.kind, 'status');
		assert.strictEqual(methodLine?.failed, false);
		const firstTest = marks.find((mark) => mark.lineNumber === 2);
		assert.strictEqual(firstTest?.kind, 'test');
		assert.ok(formatCoverageHover(firstTest!).includes('<1us'));
		assert.ok(!formatCoverageHover(firstTest!).includes('Click to run'));
		const impl = marks.find((mark) => mark.lineNumber === 4);
		assert.strictEqual(impl?.kind, 'coverage');
		assert.strictEqual(impl?.callCount, 2);
		const implHover = formatCoverageHover(impl!);
		assert.ok(implHover.includes('Called: 2 times so far'));
		assert.ok(implHover.includes('<1us') || implHover.includes('us'));
	});

	test('failed is-check paints the test line red, not the implementation', () => {
		const methods = discoverStrictTests([
			'Greet Text',
			'\tTextHelper("World").Greet is "Hello, World!"',
			'\t"Hello, " + value + "!"'
		].join('\n'));
		const results = new Map<number, TestRunnerNotification>([
			[1, {
				lineNumber: 1, state: 0, expression: 'TextHelper("World").Greet is "Hello, World!"',
				methodName: 'Greet', details: '"Hello" is "Hello, World!"',
				expected: '"Hello, World!"', actual: '"Hello"'
			}]
		]);
		const marks = lineCoverageMarks(methods, results, new Set());
		assert.strictEqual(marks.find((mark) => mark.lineNumber === 0)?.kind, 'status');
		assert.strictEqual(marks.find((mark) => mark.lineNumber === 0)?.failed, true);
		assert.strictEqual(marks.find((mark) => mark.lineNumber === 1)?.failed, true);
		assert.strictEqual(marks.find((mark) => mark.lineNumber === 1)?.kind, 'test');
		assert.strictEqual(marks.find((mark) => mark.lineNumber === 2)?.failed, false);
		assert.strictEqual(marks.find((mark) => mark.lineNumber === 2)?.kind, 'coverage');
		assert.strictEqual(formatInlineFailure(marks.find((mark) => mark.lineNumber === 1)!),
			'expected "Hello, World!"  got "Hello"');
	});

	test('a crash paints the lines of its stack red and leaves the rest of the method unpainted', () => {
		const methods = discoverStrictTests(['has number', 'Value Number', '\tCrashing(3).Value is 4', '\tlet list = (1, 2)',
			'\tlet bad = list(number)', '\tlet result = bad + 1', '\tresult'].join('\n'));
		const marks = (failure: Partial<TestRunnerNotification>) => lineCoverageMarks(methods, new Map([[2, { lineNumber: 2,
			state: 0, expression: 'Crashing(3).Value is 4', methodName: 'Value', typeName: 'Crashing', ...failure }]]), new Set());
		assert.deepStrictEqual(marks({ actual: 'Error: Value', stackTrace: 'at Crashing.Value in Crashing.strict:line 5\n' +
			'at Crashing.Value in Crashing.strict:line 6\nat Crashing.$Tests in Crashing.strict:line 3' }).map((mark) =>
			[mark.lineNumber, mark.failed]), [[1, true], [2, true], [3, false], [4, true], [5, true]]);
		const beforeRunning = marks({ message: 'NameNotFound: LoadedUnitData used in ./WebWars/Scene.strict:8' });
		assert.deepStrictEqual(beforeRunning.map((mark) => [mark.lineNumber, mark.failed]), [[1, true], [2, true]]);
		assert.strictEqual(formatCoverageHover(beforeRunning[1]), 'NameNotFound: LoadedUnitData used in ./WebWars/Scene.strict:8');
	});

	test('line counts of a coverage run leave never executed lines unpainted and tell the time of slow lines', () => {
		const methods = discoverStrictTests(['has number', 'Slow Number', '\tSlow(2).Slow is 4', '\tif number > 5', '\t\treturn 0',
			'\tnumber * 2'].join('\n'));
		const results = new Map<number, TestRunnerNotification>([[2, { lineNumber: 2, state: 1, expression: 'Slow(2).Slow is 4',
			methodName: 'Slow', durationMs: 30 }]]);
		const counts = new Map([[3, 1, 0.01, 0.01], [4, 0, 0, 0], [5, 340, 25, 2]].map(([line, executions, ms, selfMs]) =>
			[line, { file: 'Slow.strict', line, executions, ms, selfMs }]));
		const marks = lineCoverageMarks(methods, results, new Set(), counts);
		assert.strictEqual(marks.find((mark) => mark.lineNumber === 4), undefined);
		assert.deepStrictEqual([3, 5].map((line) => formatInlineSlow(marks.find((mark) => mark.lineNumber === line)!, 10)),
			[undefined, 'slow: 25ms (self 2.0ms, 340 times)']);
		assert.ok(formatCoverageHover(marks.find((mark) => mark.lineNumber === 3)!).includes('Executed: 1 time'));
	});

	test('line counts of a coverage run never hide the lines of a Run program, tests do not call it', () => {
		const methods = discoverStrictTests(['has logger', 'Run', '\tlogger.Log("Hi")'].join('\n'));
		const results = new Map<number, TestRunnerNotification>([[1, { lineNumber: 1, state: 1, methodName: 'Run' }]]);
		const counts = new Map([[2, { file: 'Hi.strict', line: 2, executions: 0, ms: 0, selfMs: 0 }]]);
		assert.ok(lineCoverageMarks(methods, results, new Set(), counts).some((mark) => mark.lineNumber === 2));
	});

	test('unrun manual Run is not painted from parse errors', () => {
		const methods = discoverStrictTests([
			'has logger',
			'Run',
			'\tconstant worldHelper = TextHelper("World")'
		].join('\n'));
		const marks = lineCoverageMarks(methods, new Map(), new Set([2]));
		assert.strictEqual(marks.find((mark) => mark.lineNumber === 1), undefined);
	});
});

suite('scrunch cache', () => {
	test('isStrictBinaryPath only matches .strictbinary', () => {
		assert.strictEqual(isStrictBinaryPath('C:\\repo\\TextHelper.strictbinary'), true);
		assert.strictEqual(isStrictBinaryPath('/tmp/Foo.STRICTBINARY'), true);
		assert.strictEqual(isStrictBinaryPath('C:\\repo\\TextHelper.strict'), false);
		assert.strictEqual(isStrictBinaryPath('C:\\repo\\strict-language-0.1.0.vsix'), false);
	});
});
