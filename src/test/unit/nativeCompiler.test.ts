import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkIssues, crashLine, dependents, runProcess, testResults } from '../../nativeCompiler';
import { hasFreshBinary } from '../../scrunchCache';

const adder = [
	'has logger',
	'Add(first Number, second Number) Number',
	'\tAdder.Add(1, 2) is 4',
	'\tAdder.Add(2, 2) is 4',
	'\tfirst + second'
].join('\n');

suite('native compiler', () => {
	test('testResults marks the failing is-test with expected and actual, the others pass', () => {
		const results = testResults(adder, 'file:///Adder.strict', {
			exitCode: 1, durationMs: 30,
			output: 'Test failed: Adder.Add(1, 2) is 4 in Add\n  got: 3\n1 tests failed in Adder.strict\n'
		});
		assert.deepStrictEqual(results.map((result) => [result.lineNumber, result.state]), [[2, 0], [3, 1]]);
		assert.strictEqual(results[0].expected, '4');
		assert.strictEqual(results[0].actual, '3');
		assert.strictEqual(results[0].methodName, 'Add');
	});

	test('testResults maps a failure with its location to the test on that line', () => {
		const results = testResults(adder, 'file:///Adder.strict', {
			exitCode: 1, durationMs: 30,
			output: 'Test failed: Adder.Add(2, 2) is 4 in Add at Adder.strict:line 4\n  got: 5\n1 tests failed in Adder.strict\n'
		});
		assert.deepStrictEqual(results.map((result) => [result.lineNumber, result.state]), [[2, 1], [3, 0]]);
		assert.strictEqual(results[1].actual, '5');
		assert.strictEqual(results[1].consoleOutput, undefined);
	});

	test('runProcess streams the output and times every line', async () => {
		const run = await runProcess(process.execPath,
			['-e', 'console.log("first"); setTimeout(() => console.log("second"), 60)'], os.tmpdir());
		assert.strictEqual(run.exitCode, 0);
		assert.deepStrictEqual(run.output.split(/\r?\n/).filter(Boolean), ['first', 'second']);
		assert.ok(run.times!.length >= 2 && run.times![1] - run.times![0] >= 40, String(run.times));
	});

	test('testResults time a test by the gap to the previous test line, the first one also compiled', () => {
		const results = testResults(adder, 'file:///Adder.strict', {
			exitCode: 0, durationMs: 160, times: [34, 153.5, 153.6],
			output: 'Test passed: Adder.Add(1, 2) is 4 in Add at Adder.strict:line 3\n' +
				'Test passed: Adder.Add(2, 2) is 4 in Add at Adder.strict:line 4\nAll tests passed in Adder.strict\n'
		});
		assert.deepStrictEqual(results.map((result) => result.durationMs), [undefined, 119.5]);
	});

	test('testResults take the duration Strict prints after a test', () => {
		const results = testResults(adder, 'file:///Adder.strict', {
			exitCode: 1, durationMs: 40,
			output: 'Test passed: Adder.Add(1, 2) is 4 in Add at Adder.strict:line 3 (0.02 ms)\n' +
				'Test failed: Adder.Add(2, 2) is 4 in Add at Adder.strict:line 4 (12.5 ms)\n  got: 5\n1 tests failed in Adder.strict\n'
		});
		assert.deepStrictEqual(results.map((result) => [result.state, result.durationMs]), [[1, 0.02], [0, 12.5]]);
		assert.strictEqual(results[1].actual, '5');
	});

	test('testResults fails every test with the exit code when Strict crashed before its summary', () => {
		const results = testResults(adder, 'file:///Adder.strict', { exitCode: 3221225477, durationMs: 30, output: '' });
		assert.deepStrictEqual(results.map((result) => result.state), [0, 0]);
		assert.ok(results[0].message?.includes('3221225477'));
	});

	test('testResults keeps the tests that passed before Strict crashed', () => {
		const results = testResults(adder, 'file:///Adder.strict', {
			exitCode: 3221225477, durationMs: 30, output: 'Test passed: Adder.Add(1, 2) is 4 in Add at Adder.strict:line 3\n'
		});
		assert.deepStrictEqual(results.map((result) => result.state), [1, 0]);
		assert.strictEqual(results[0].message, undefined);
		assert.strictEqual(results[0].consoleOutput, undefined);
		assert.ok(results[1].message?.includes('3221225477'));
	});

	test('crashLine is the zero based line of an error Strict reports in the tested file', () => {
		const file = path.resolve('C:\\Strict', 'Examples', 'Bad.strict');
		assert.strictEqual(crashLine('ParsingFailed: number +* minimum in Examples/Bad.strict:5', file, 'C:\\Strict'), 4);
		assert.strictEqual(crashLine(`TypeNotFound: Foo used in ${file}:4 is not in this folder`, file, 'C:\\Strict'), 3);
		assert.strictEqual(crashLine('MethodNotFound: Number.Foo used in Examples/Other.strict:2', file, 'C:\\Strict'), undefined);
	});

	test('checkIssues reads file, zero based line, rule and target of each issue line', () => {
		const issues = checkIssues([
			'Examples\\Bad.strict:line 4: ExtraWhitespacesFoundAtBeginningOfLine: indent with tabs',
			'Examples/Bad.strict:line 1: UnusedMemberMustBeRemoved: logger',
			'Validation issues: 2'
		].join('\n'), 'C:\\Strict');
		assert.deepStrictEqual(issues.map((issue) => [issue.line, issue.rule, issue.target]), [
			[3, 'ExtraWhitespacesFoundAtBeginningOfLine', 'indent with tabs'],
			[0, 'UnusedMemberMustBeRemoved', 'logger']
		]);
		assert.strictEqual(issues[0].file, path.resolve('C:\\Strict', 'Examples', 'Bad.strict'));
	});

	test('dependents follow type names transitively and skip unrelated files', () => {
		const sources = new Map([
			['C:/Strict/Number.strict', 'has value'],
			['C:/Strict/Counter.strict', 'has number Number'],
			['C:/Strict/Examples/Clock.strict', 'has counter Counter'],
			['C:/Strict/Examples/Hello.strict', 'Run\n\tlogger.Log("Hi")']
		]);
		assert.deepStrictEqual(dependents('C:/Strict/Number.strict', sources),
			['C:/Strict/Counter.strict', 'C:/Strict/Examples/Clock.strict']);
	});

	test('hasFreshBinary only when the .strictbinary is not older than its source', () => {
		const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-binary-'));
		const source = path.join(folder, 'Adder.strict');
		const binary = path.join(folder, 'Adder.strictbinary');
		fs.writeFileSync(source, adder);
		assert.strictEqual(hasFreshBinary(source), false);
		fs.writeFileSync(binary, '');
		fs.utimesSync(binary, 1000, 1000);
		assert.strictEqual(hasFreshBinary(source), false);
		fs.utimesSync(source, 1000, 1000);
		assert.strictEqual(hasFreshBinary(source), true);
		fs.rmSync(folder, { recursive: true });
	});
});
