import * as assert from 'assert';
import { isCacheFresh, isStrictBinaryPath, siblingBinaryPath } from '../../scrunchCache';
import { discoverStrictTests, isRunnableHeader, typeNameFromPath } from '../../scrunchDiscover';
import {
	enrichNotification,
	formatCoverageHover,
	formatInlineFailure,
	isManualMethod,
	lineCoverageMarks,
	methodForLine,
	methodsWithTests,
	shouldExecuteManual,
	shouldShowInlineValue,
	visibleMethods
} from '../../scrunchModel';
import {
	formatDuration,
	formatErrorSummary,
	formatFailureOutput,
	formatMethodOutput,
	parseDiscrepancy,
	parseStackFrames,
	TestRunnerNotification
} from '../../testResults';

suite('scrunch discover', () => {
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
		const source = ['has logger', 'constant Pi = 3', 'Run', '\t5 is 5'].join('\n');
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

	test('formatMethodOutput is stats, not the test expression', () => {
		const passed = formatMethodOutput({
			durationMs: 0.012,
			lastRunAt: '2026-08-16T12:00:00.000Z',
			methodsCalled: 1,
			linesCalled: 3,
			callCount: 2
		});
		assert.ok(!passed.includes('TextHelper("World").Greet'));
		assert.ok(!passed.includes('passed'));
		assert.ok(!passed.includes('older results'));
		assert.ok(passed.includes('12us'));
		assert.ok(passed.includes('Methods called: 1'));
		assert.ok(passed.includes('Lines called: 3'));
		assert.ok(passed.includes('Called: 2 times'));
		assert.ok(passed.includes('Last run:'));
		const failed = formatMethodOutput({
			durationMs: 0.8,
			lastRunAt: '2026-08-16T12:00:00.000Z',
			details: '"Hello" is "Hello, yo!"',
			expected: '"Hello, yo!"',
			actual: '"Hello"',
			stackTrace: 'at TextHelper.Greet in C:\\repo\\TextHelper.strict:line 3',
			failed: true
		});
		assert.ok(!failed.includes('TextHelper("yo").Greet is'));
		assert.ok(failed.includes('Expected: "Hello, yo!"'));
		assert.ok(failed.includes('Actual: "Hello"'));
		assert.ok(failed.includes('TextHelper.strict:line 3'));
		assert.ok(failed.includes('0.8ms'));
	});

	test('formatErrorSummary is a short human name, not a type path', () => {
		assert.strictEqual(
			formatErrorSummary(
				'Cannot call body on trait method: TextWriter.Write is a trait method and has no implementation'
			),
			'Cannot call body on trait method'
		);
		assert.strictEqual(formatErrorSummary('Strict/TextWriter.Write'), 'Strict/TextWriter.Write');
		assert.strictEqual(formatErrorSummary(undefined), undefined);
	});

	test('formatMethodOutput shows console text when the test printed something', () => {
		const text = formatMethodOutput({
			durationMs: 1.5,
			lastRunAt: '2026-08-16T12:00:00.000Z',
			consoleOutput: 'Hello, World!\nHello, Strict!'
		});
		assert.ok(text.startsWith('Hello, World!'));
		assert.ok(text.includes('Hello, Strict!'));
		assert.ok(text.includes('1.2ms') || text.includes('1.5ms'));
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
		assert.strictEqual(firstTest?.kind, 'coverage');
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
		assert.strictEqual(marks.find((mark) => mark.lineNumber === 1)?.kind, 'coverage');
		assert.strictEqual(marks.find((mark) => mark.lineNumber === 2)?.failed, false);
		assert.strictEqual(marks.find((mark) => mark.lineNumber === 2)?.kind, 'coverage');
		assert.strictEqual(formatInlineFailure(marks.find((mark) => mark.lineNumber === 1)!),
			'expected "Hello, World!"  got "Hello"');
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

	test('shouldShowInlineValue drops true and echoed source', () => {
		assert.strictEqual(shouldShowInlineValue('\tvalue then false else true', 'true'), false);
		assert.strictEqual(shouldShowInlineValue('\t5 + 5', '10'), true);
		assert.strictEqual(shouldShowInlineValue('\t"Hello, " + value + "!"', '"Hello, " + value + "!"'), false);
	});
});

suite('scrunch cache', () => {
	test('siblingBinaryPath swaps the extension', () => {
		assert.strictEqual(siblingBinaryPath('C:\\repo\\Sum.strict'), 'C:\\repo\\Sum.strictbinary');
		assert.strictEqual(siblingBinaryPath('/tmp/Foo.STRICT'), '/tmp/Foo.strictbinary');
	});

	test('isCacheFresh requires a binary at least as new as source', () => {
		assert.strictEqual(isCacheFresh(100, undefined), false);
		assert.strictEqual(isCacheFresh(100, 99), false);
		assert.strictEqual(isCacheFresh(100, 100), true);
		assert.strictEqual(isCacheFresh(100, 150), true);
	});

	test('isStrictBinaryPath only matches .strictbinary', () => {
		assert.strictEqual(isStrictBinaryPath('C:\\repo\\TextHelper.strictbinary'), true);
		assert.strictEqual(isStrictBinaryPath('/tmp/Foo.STRICTBINARY'), true);
		assert.strictEqual(isStrictBinaryPath('C:\\repo\\TextHelper.strict'), false);
		assert.strictEqual(isStrictBinaryPath('C:\\repo\\strict-language-0.1.0.vsix'), false);
	});
});
