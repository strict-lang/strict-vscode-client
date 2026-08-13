import * as assert from 'assert';
import { isCacheFresh, siblingBinaryPath } from '../../scrunchCache';
import { discoverStrictTests } from '../../scrunchDiscover';
import {
	formatDuration,
	formatFailureOutput,
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
});

suite('scrunch format', () => {
	test('formatDuration uses milliseconds', () => {
		assert.strictEqual(formatDuration(undefined), undefined);
		assert.strictEqual(formatDuration(0.04), '<0.1ms');
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
		assert.ok(formatTestHover(message).includes('0.8ms'));
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
