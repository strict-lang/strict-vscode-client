import * as assert from 'assert';
import { isCacheFresh, siblingBinaryPath } from '../../scrunchCache';
import { discoverStrictTests, typeNameFromPath } from '../../scrunchDiscover';
import {
	lineCoverageMarks,
	methodsWithTests
} from '../../scrunchModel';
import {
	formatDuration,
	formatFailureOutput,
	formatLineTests,
	formatSingleTestOutput,
	formatTestHover,
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
		const visible = methodsWithTests(discoverStrictTests(source));
		assert.deepStrictEqual(visible.map((method) => method.name), ['Greet']);
	});
});

suite('scrunch format', () => {
	test('formatDuration uses microseconds for sub-ms runs', () => {
		assert.strictEqual(formatDuration(undefined), undefined);
		assert.strictEqual(formatDuration(0.04), '40us');
		assert.strictEqual(formatDuration(0.8), '800us');
		assert.strictEqual(formatDuration(1.24), '1.2ms');
		assert.strictEqual(formatDuration(18), '18ms');
		assert.strictEqual(formatDuration(1500), '1.5s');
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

	test('formatTestHover includes duration', () => {
		const message: TestRunnerNotification = {
			lineNumber: 1,
			state: 1,
			expression: 'not true is false',
			methodName: 'not',
			durationMs: 0.8
		};
		assert.ok(formatTestHover(message).includes('800us'));
	});

	test('formatSingleTestOutput is just that test and its result', () => {
		const passed = formatSingleTestOutput({
			lineNumber: 2,
			state: 1,
			expression: 'TextHelper("World").Greet is "Hello, World!"',
			methodName: 'Greet',
			typeName: 'TextHelper',
			durationMs: 0.012
		});
		assert.ok(passed.includes('TextHelper("World").Greet is "Hello, World!"'));
		assert.ok(passed.includes('passed'));
		assert.ok(passed.includes('12us'));
		assert.ok(!passed.includes('older results'));
		const failed = formatSingleTestOutput({
			lineNumber: 1,
			state: 0,
			expression: 'not true is false',
			methodName: 'not',
			details: 'true is false',
			message: '"not" method failed: not true is false',
			stackTrace: 'at Strict/Boolean.not in C:\\repo\\Boolean.strict:line 4'
		});
		assert.ok(failed.includes('failed'));
		assert.ok(failed.includes('true is false'));
		assert.ok(failed.includes('Boolean.strict:line 4'));
	});

	test('formatLineTests lists every test that covered the line', () => {
		const text = formatLineTests([
			{
				lineNumber: 2,
				state: 1,
				expression: 'TextHelper("World").Greet is "Hello, World!"',
				methodName: 'Greet',
				durationMs: 0.02
			},
			{
				lineNumber: 3,
				state: 1,
				expression: 'TextHelper("Strict").Greet is "Hello, Strict!"',
				methodName: 'Greet',
				durationMs: 0.03
			}
		]);
		assert.ok(text.includes('TextHelper("World").Greet is "Hello, World!"'));
		assert.ok(text.includes('TextHelper("Strict").Greet is "Hello, Strict!"'));
		assert.ok(text.includes('20us'));
	});

	test('formatTestHover marks cached passes', () => {
		const hover = formatTestHover({
			lineNumber: 1,
			state: 1,
			expression: '5 is 5',
			methodName: 'Run',
			cached: true
		});
		assert.ok(hover.includes('cached'));
	});
});

suite('scrunch coverage', () => {
	test('marks implementation lines from the tests that called them', () => {
		const methods = discoverStrictTests([
			'Greet Text',
			'\tTextHelper("World").Greet is "Hello, World!"',
			'\tTextHelper("Strict").Greet is "Hello, Strict!"',
			'\t"Hello, " + value + "!"'
		].join('\n'));
		const results = new Map<number, TestRunnerNotification>([
			[1, {
				lineNumber: 1, state: 1, expression: 'TextHelper("World").Greet is "Hello, World!"',
				methodName: 'Greet', durationMs: 0.02
			}],
			[2, {
				lineNumber: 2, state: 1, expression: 'TextHelper("Strict").Greet is "Hello, Strict!"',
				methodName: 'Greet', durationMs: 0.03
			}]
		]);
		const marks = lineCoverageMarks(methods, results, new Set());
		const impl = marks.find((mark) => mark.lineNumber === 3);
		assert.ok(impl);
		assert.strictEqual(impl?.failed, false);
		assert.strictEqual(impl?.tests.length, 2);
		const methodLine = marks.find((mark) => mark.lineNumber === 0);
		assert.ok(methodLine);
		assert.strictEqual(methodLine?.failed, false);
	});

	test('failed test paints the test line and implementation red', () => {
		const methods = discoverStrictTests([
			'Greet Text',
			'\tTextHelper("World").Greet is "Hello, World!"',
			'\t"Hello, " + value + "!"'
		].join('\n'));
		const results = new Map<number, TestRunnerNotification>([
			[1, {
				lineNumber: 1, state: 0, expression: 'TextHelper("World").Greet is "Hello, World!"',
				methodName: 'Greet', details: '"Hello, World!" is "nope"'
			}]
		]);
		const marks = lineCoverageMarks(methods, results, new Set());
		assert.strictEqual(marks.find((mark) => mark.lineNumber === 1)?.failed, true);
		assert.strictEqual(marks.find((mark) => mark.lineNumber === 2)?.failed, true);
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
});
