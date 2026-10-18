import * as assert from 'assert';
import {
	formatCoverageHover, formatInlineFailure, formatInlineSlow, formatInlineValue, lineCoverageMarks, LineCoverageMark, remember,
	slowestTests, TimingHistory
} from '../../scrunchModel';
import { discoverStrictTests } from '../../scrunchDiscover';

suite('decorations', () => {
	test('coverage hover is duration, not a run-tests prompt', () => {
		const mark: LineCoverageMark = {
			lineNumber: 2,
			failed: false,
			kind: 'coverage',
			tests: [],
			durationMs: 0.04
		};
		const hover = formatCoverageHover(mark);
		assert.strictEqual(hover, '40us');
		assert.ok(!hover.includes('Click to run'));
		assert.ok(!hover.includes('right click'));
	});

	test('failed status hover shows the human error, not a type path', () => {
		const hover = formatCoverageHover({
			lineNumber: 1,
			failed: true,
			kind: 'status',
			tests: [],
			message: 'Cannot call body on trait method: TextWriter.Write is a trait method and has no implementation'
		});
		assert.ok(hover.includes('Cannot call body on trait method'));
		assert.ok(!hover.includes('Click to run'));
	});

	test('slow marker on tests and method headers from the threshold on, never on failures or implementation lines', () => {
		const timed = { lineNumber: 2, state: 1, durationMs: 238 };
		const mark = (lineNumber: number, kind: 'status' | 'coverage', durationMs: number, failed = false): LineCoverageMark =>
			({ lineNumber, failed, kind, tests: [timed], durationMs });
		assert.strictEqual(formatInlineSlow(mark(2, 'coverage', 238), 10), 'slow: 238ms');
		assert.strictEqual(formatInlineSlow(mark(1, 'status', 238), 10), 'slow: 238ms');
		assert.strictEqual(formatInlineSlow(mark(3, 'coverage', 238), 10), undefined);
		assert.strictEqual(formatInlineSlow(mark(2, 'coverage', 9.9), 10), undefined);
		assert.strictEqual(formatInlineSlow(mark(2, 'coverage', 238, true), 10), undefined);
	});

	test('inline value is how often a line ran unless once outside loops and ifs, with a value the code does not show, no true result', () => {
		const value = (hits: number, line: string, name?: string, assigned?: string) =>
			formatInlineValue({ file: 'A.strict', line: 3, hits, name, value: assigned }, line);
		assert.deepStrictEqual([value(6, '\tmutable first = numbers.First', 'first', '1'),
			value(6, '\tmutable first = 1', 'first', '1'), value(1, '\t\treturn "Fizz"'), value(1, '\tnumber to Text'),
			value(1, '\tif number % 3 is 0'), value(1, '\tlet next = Next(2)', 'next', '3'), value(1, '\ta + b', '5 + 3', '8'),
			value(1, '\tover or ready', 'false or true', 'true'), value(1, '\tlet ended = over', 'ended', 'true'), value(11, '\tfor 19')],
			['6 times, first = 1', '6 times', '1 time', '', '1 time', 'next = 3', '5 + 3 = 8', '', 'ended = true', '11 times']);
	});

	test('inline values that differ between hits follow the count, cut after 100 characters', () => {
		const value = (each: string) => formatInlineValue({ file: 'A.strict', line: 3, hits: 7, each },
			'\tlet ended = packed.Fits(upcoming) is false');
		assert.deepStrictEqual([value('false, true, true'), value('BlockGrid((0, 0, '.repeat(10))],
			['7 times: false, true, true', `7 times: ${'BlockGrid((0, 0, '.repeat(10)}`.slice(0, 100) + '…']);
	});
	test('expression traces show constructor values and whether nested returns ran', () => {
		assert.strictEqual(formatInlineValue({ file: 'AtlasRegion.strict', line: 15, hits: 13,
			name: 'Size(metrics(6), metrics(7))', value: 'Size(Width = 140, Height = 140)' },
			'\tSize(metrics(6), metrics(7))'), '13 times: Size(Width = 140, Height = 140)');
		const methods = discoverStrictTests('Valid Boolean\n\tSample.Valid\n\tif width < 0\n\t\treturn false\n\ttrue');
		const marks = lineCoverageMarks(methods, new Map([[1, { lineNumber: 1, state: 1, methodName: 'Valid' }]]), new Set(),
			new Map(), new Map([[2, { file: 'Region.strict', line: 2, hits: 12 }]]));
		const returned = marks.find((mark) => mark.lineNumber === 3)?.value;
		assert.ok(returned);
		assert.strictEqual(formatInlineValue(returned, '\t\treturn false'), '0 times');
		assert.strictEqual(formatInlineValue({ file: 'Region.strict', line: 3, hits: 2, name: 'false', value: 'false' },
			'\t\treturn false'), '2 times: false');
	});

	test('hover shows all values of a line, also those cut after it', () => {
		const each = 'BlockGrid((0, 0, '.repeat(10);
		assert.strictEqual(formatCoverageHover({ lineNumber: 3, failed: false, kind: 'coverage', tests: [],
			value: { file: 'A.strict', line: 3, hits: 7, each } }), `Ran 7 times: ${each}`);
	});

	test('slow marker tells the time before a slowdown', () => {
		assert.strictEqual(formatInlineSlow({ lineNumber: 2, failed: false, kind: 'coverage',
			tests: [{ lineNumber: 2, state: 1 }], durationMs: 238, previousMs: 12 }, 10), 'slow: 238ms (was 12ms)');
	});

	test('remember gives a cached pass its last time and marks a run more than twice as slow from the threshold on', () => {
		const history: TimingHistory = {};
		const pass = (durationMs?: number, cached?: boolean) => ({ lineNumber: 2, state: 1, durationMs, cached });
		assert.strictEqual(remember(history, 'a', pass(4), 10).previousMs, undefined);
		assert.strictEqual(remember(history, 'a', pass(undefined, true), 10).durationMs, 4);
		assert.strictEqual(remember(history, 'a', pass(9), 10).previousMs, undefined);
		assert.strictEqual(remember(history, 'a', pass(30), 10).previousMs, 9);
		assert.strictEqual(remember(history, 'a', pass(undefined), 10).durationMs, undefined);
		assert.strictEqual(history.a, 30);
	});

	test('remember keeps the native times of coverage runs out of the history of the times Strict usually takes', () => {
		const history: TimingHistory = { a: 30 };
		assert.strictEqual(remember(history, 'a', { lineNumber: 2, state: 1, durationMs: 1, native: true }, 0).durationMs, 1);
		assert.strictEqual(history.a, 30);
	});

	test('slowestTests sorts timed results by duration and leaves out untimed ones', () => {
		const result = (lineNumber: number, durationMs?: number) => ({ lineNumber, state: 1, durationMs });
		assert.deepStrictEqual(slowestTests([result(1, 0.2), result(2), result(3, 238), result(4, 12)], 2).map((test) =>
			test.lineNumber), [3, 4]);
	});

	test('inline failure is only the discrepancy', () => {
		assert.strictEqual(formatInlineFailure({
			expected: '"Hello, yo!"',
			actual: '"Hello"'
		}), 'expected "Hello, yo!"  got "Hello"');
	});
});
