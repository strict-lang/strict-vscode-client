import * as assert from 'assert';
import {
	formatCoverageHover, formatInlineFailure, formatInlineSlow, LineCoverageMark, remember, slowestTests, TimingHistory
} from '../../scrunchModel';

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
