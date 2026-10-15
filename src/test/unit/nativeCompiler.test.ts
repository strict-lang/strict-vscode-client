import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	checkIssues, crashLine, crashText, dependents, gitIgnored, lineCounts, runProcess, testResults
} from '../../nativeCompiler';
import { isIgnoredBy } from '../../paths';

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
			output: 'Test failed: Adder.Add(1, 2) is 4 in Add\n  got: 3\n' +
				'Test passed: Adder.Add(2, 2) is 4 in Add at Adder.strict:line 4 (0.01 ms)\n1 tests failed in Adder.strict\n'
		});
		assert.deepStrictEqual(results.map((result) => [result.lineNumber, result.state]), [[2, 0], [3, 1]]);
		assert.strictEqual(results[0].expected, '4');
		assert.strictEqual(results[0].actual, '3');
		assert.strictEqual(results[0].methodName, 'Add');
	});

	test('testResults maps a failure with its location to the test on that line', () => {
		const results = testResults(adder, 'file:///Adder.strict', {
			exitCode: 1, durationMs: 30,
			output: 'Test passed: Adder.Add(1, 2) is 4 in Add at Adder.strict:line 3 (0.01 ms)\n' +
				'Test failed: Adder.Add(2, 2) is 4 in Add at Adder.strict:line 4\n  got: 5\n1 tests failed in Adder.strict\n'
		});
		assert.deepStrictEqual(results.map((result) => [result.lineNumber, result.state]), [[2, 1], [3, 0]]);
		assert.strictEqual(results[1].actual, '5');
		assert.strictEqual(results[1].consoleOutput, undefined);
	});

	test('testResults report only the lines Strict printed, a line it did not print is no test', () => {
		const results = testResults(adder, 'file:///Adder.strict', {
			exitCode: 0, durationMs: 30,
			output: 'Test passed: Adder.Add(1, 2) is 4 in Add at Adder.strict:line 3 (0.02 ms)\nAll tests passed in Adder.strict\n'
		});
		assert.deepStrictEqual(results.map((result) => [result.lineNumber, result.state, result.durationMs]), [[2, 1, 0.02]]);
	});

	test('testResults pass every discovered test of a cached type, Strict printed only its summary', () => {
		const results = testResults(adder, 'file:///Adder.strict', { exitCode: 0, durationMs: 30, output: 'All tests passed in Adder.strict\n' });
		assert.deepStrictEqual(results.map((result) => [result.lineNumber, result.state, result.cached]), [[2, 1, true], [3, 1, true]]);
	});

	test('testResults of a lines run are no crash, its build and line counts are no console output', () => {
		const results = testResults(adder, 'file:///Adder.strict', { exitCode: 0, durationMs: 900, output: 'Built ./Adder.test.exe\n' +
			'Test passed: Adder.Add(1, 2) is 4 in Add at Adder.strict:line 3 (0.02 ms)\n' +
			'Line Adder.strict:5 executed 1 times in 0.01 ms (self 0.01 ms)\nAll tests passed in Adder.strict\n' });
		assert.deepStrictEqual(results.map((result) => [result.lineNumber, result.state, result.consoleOutput, result.message]),
			[[2, 1, undefined, undefined]]);
	});

	test('lineCounts are how often and how long each line ran, zero based', () => {
		assert.deepStrictEqual(lineCounts('Built ./A.test.exe\nLine Examples/A.strict:8 executed 4 times in 1.25 ms (self 0.40 ms)\r\n' +
			'Line Number.strict:40 executed 0 times in 0.00 ms (self -0.00 ms)\n', 'C:\\Strict'), [
			{ file: path.resolve('C:\\Strict', 'Examples/A.strict'), line: 7, executions: 4, ms: 1.25, selfMs: 0.4 },
			{ file: path.resolve('C:\\Strict', 'Number.strict'), line: 39, executions: 0, ms: 0, selfMs: 0 }]);
	});

	test('runProcess returns the output and exit code', async () => {
		const run = await runProcess(process.execPath,
			['-e', 'console.log("first"); setTimeout(() => console.log("second"), 60)'], os.tmpdir());
		assert.strictEqual(run.exitCode, 0);
		assert.deepStrictEqual(run.output.split(/\r?\n/).filter(Boolean), ['first', 'second']);
	});

	test('runProcess writes input to the standard input of the process', async () =>
		assert.strictEqual((await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], os.tmpdir(),
			{ input: 'has number\n' })).output, 'has number\n'));

	test('runProcess stops the process when its signal aborts', async () => {
		const abort = new AbortController();
		setTimeout(() => abort.abort(), 50);
		const run = await runProcess(process.execPath, ['-e', 'setTimeout(() => console.log("late"), 5000)'], os.tmpdir(),
			{ signal: abort.signal });
		assert.strictEqual(run.exitCode, -1);
		assert.ok(run.durationMs < 3000 && !run.output.includes('late'), run.output);
	});

	test('runProcess also stops the processes it started when its signal aborts', async () => {
		const abort = new AbortController();
		setTimeout(() => abort.abort(), 500);
		const run = await runProcess(process.execPath, ['-e', 'console.log(require("child_process").spawn(process.execPath, ' +
			'["-e", "setTimeout(() => {}, 9000)"], { stdio: "ignore", detached: process.platform === "win32" }).pid); ' +
			'setTimeout(() => {}, 9000)'], os.tmpdir(),
			{ signal: abort.signal });
		const isRunning = () => {
			try {
				return process.kill(Number(run.output.split(/\r?\n/)[0]), 0);
			} catch {
				return false;
			}
		};
		for (let waited = 0; isRunning() && waited < 3000; waited += 100) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(!isRunning(), run.output);
	});

	test('gitIgnored lists what git ignores in a folder or its repositories, isIgnoredBy also their content', async () => {
		const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-git-'));
		const repository = path.join(parent, 'Repository');
		fs.mkdirSync(repository);
		try {
			await runProcess('git', ['init', '-q'], repository);
			fs.writeFileSync(path.join(repository, '.gitignore'), 'artifacts/\nCopy.strict\n');
			for (const file of ['artifacts/Repros/Probe.strict', 'Games/Copy.strict', 'Games/Scene.strict']) {
				fs.mkdirSync(path.dirname(path.join(repository, file)), { recursive: true });
				fs.writeFileSync(path.join(repository, file), '');
			}
			const ignored = await gitIgnored(repository);
			assert.deepStrictEqual(['artifacts/Repros/Probe.strict', 'artifacts/New.strict', 'Games/Copy.strict', 'Games/Scene.strict']
				.map((file) => isIgnoredBy(path.join(repository, file), ignored)), [true, true, true, false]);
			assert.deepStrictEqual([...await gitIgnored(parent)].sort(), [...ignored].sort());
			assert.deepStrictEqual([...await gitIgnored(path.join(parent, 'NotCloned'))], []);
			const runs = [gitIgnored(repository), gitIgnored(repository)];
			await Promise.all(runs);
			assert.strictEqual(runs[0], runs[1], 'calls in flight share one git run');
		} finally {
			fs.rmSync(parent, { recursive: true, force: true });
		}
	});

	test('testResults expect true of a failed test without is', () => {
		const results = testResults(['has number', 'Falls Boolean', '\tPhysics(1).Falls', '\tnumber > 0'].join('\n'),
			'file:///Physics.strict', { exitCode: 1, durationMs: 30, output: 'Test failed: Physics(1).Falls in Falls at ' +
				'Physics.strict:line 3\n  got: false\n1 tests failed in Physics.strict\n' });
		assert.deepStrictEqual([results[0].expected, results[0].message], ['true', 'Expected true, got false']);
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

	test('testResults fails every test once with the error that stopped Strict, not again as console output', () => {
		const error = 'NameNotFound: LoadedUnitData used in ./WebWars/Scene.strict:8';
		const results = testResults(adder, 'file:///Adder.strict', { exitCode: 1, durationMs: 30, output: error + '\n' });
		assert.deepStrictEqual(results.map((result) => [result.state, result.message, result.consoleOutput]),
			[[0, error, undefined], [0, error, undefined]]);
	});

	test('testResults keeps the stack Strict prints after got with its failed test', () => {
		const results = testResults(adder, 'file:///Adder.strict', {
			exitCode: 1, durationMs: 30, output: 'Test failed: Adder.Add(1, 2) is 4 in Add at Adder.strict:line 3 (0.02 ms)\n' +
				'  got: Error: Add\n\tat Adder.Add in Adder.strict:line 5\n\tat Adder.$Tests in Adder.strict:line 3\n' +
				'1 tests failed in Adder.strict\n'
		});
		assert.deepStrictEqual([results[0].actual, results[0].stackTrace, results[0].consoleOutput],
			['Error: Add', 'at Adder.Add in Adder.strict:line 5\nat Adder.$Tests in Adder.strict:line 3', undefined]);
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

	test('crashText is the error Strict reports with its location, only real crashes name the exit code', () => {
		assert.strictEqual(crashText({ exitCode: 1, durationMs: 9, output: 'EmptyLineInsideMethod: Twice in ./A.strict:3\n' }),
			'EmptyLineInsideMethod: Twice in ./A.strict:3');
		assert.strictEqual(crashText({ exitCode: 139, durationMs: 9, output: '' }), 'Strict crashed with exit code 139');
		assert.strictEqual(crashText({ exitCode: 1, durationMs: 9, output: 'Unsupported native call DefaultProbe.Run\n' }),
			'Unsupported native call DefaultProbe.Run\nStrict crashed with exit code 1');
		assert.strictEqual(crashText({ exitCode: 0, durationMs: 9, output: 'All tests passed in A.strict' }), undefined);
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
});
