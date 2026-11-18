import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compilerFile, normalizeFsPath } from './paths';
import { discoverStrictTests, isSlowHeader, typeNameFromPath } from './scrunchDiscover';
import { TestRunnerNotification } from './testResults';

export type StrictRun = { exitCode: number; output: string; durationMs: number };
export type RunOptions = { signal?: AbortSignal; timeoutMs?: number; cwd?: string; input?: string };
export type CheckIssue = { file: string; line: number; rule: string; target: string };
export type LineCount = { file: string; line: number; executions: number; ms: number; selfMs: number };
/** How often a line ran in `strict test <file> <root> values` with what it calculated when that was the same on every hit
 * (`sum = 5 + 3 = 8` is name sum, value `5 + 3 = 8`), else each, its values per hit (`false, true, ...`). */
export type LineValue = { file: string; line: number; hits: number; name?: string; value?: string; each?: string };

const defaultTimeoutMs = 60000;
const upToDateLine = /^Tests up to date: /m;
/** Ends a test run, `Tests up to date: A.strict (...) < A.test.exe (...)` when its native tests passed and nothing changed. */
const summaryLine = /^((All tests passed|\d+ (tests )?failed) in |Tests up to date: )/m;
const builtLine = /^Built .+\.test(\.exe)?(, unchanged)?$/;
const lineCount = /^Line (.+?\.strict):(\d+) executed (\d+) times in (\d+(?:\.\d+)?) ms \(self (-?\d+(?:\.\d+)?) ms\)$/;
const valueLine = /^Value (.+?\.strict):line (\d+) hit (\d+) times(?:(, each: (.*))|: (.+?) = (.*))?$/;
const testLine = /^Test (passed|failed): (.*) in (\S+?)(?: at .+?:line (\d+))?(?: took \d+ ms on the VM, .*)?$/;
const stackLine = /^\s+(at .+ in .+:line \d+|\.\.\. \(skipped \d+ lines\))$/;
const issuePattern = /^(.+?\.strict):line (\d+): (\w+): (.*)$/;
const errorLocation = /^\w+: .* in (.+?\.strict):(?:line )?(\d+)/m;
const timedOutLine = /^Timed out after \S+ s$/m;
const overBudget = 'TestDurationMustNotExceedHundredMilliseconds';
export const testDuration = / \((\d+(?:\.\d+)?) ms\)$/;

/** How many `strict test` processes run at once: configured (0 is half the cores) while VS Code is focused, else one, so
 * changes made elsewhere (agents, git) do not take over the computer. */
export function testProcesses(focused: boolean, configured: number, cores: number): number {
	return !focused ? 1 : configured > 0 ? configured : Math.max(1, Math.floor(cores / 2));
}

/** Runs root/strict in options.cwd, the project folder of the file it gets (see projectFolder), else in root. */
export function runStrict(root: string, args: string[], options: RunOptions = {}): Promise<StrictRun> {
	return runProcess(path.join(root, compilerFile), args, options.cwd ?? root, options);
}

const ignoring = new Map<string, Promise<Set<string>>>();

/** Untracked files and folders git ignores in folder, normalized for isIgnoredBy, else in the repositories directly in it, never
 * folder itself (opened on purpose), calls while one runs for folder share it. */
export function gitIgnored(folder: string): Promise<Set<string>> {
	const running = ignoring.get(folder) ?? listIgnored(folder).finally(() => ignoring.delete(folder));
	ignoring.set(folder, running);
	return running;
}

async function listIgnored(folder: string): Promise<Set<string>> {
	const run = await runProcess('git', ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], folder);
	if (run.exitCode !== 0) {
		const repositories = (await fs.promises.readdir(folder).catch(() => [])).filter((name) =>
			fs.existsSync(path.join(folder, name, '.git')));
		const sets = await Promise.all(repositories.map((name) => gitIgnored(path.join(folder, name))));
		return new Set(sets.flatMap((set) => [...set]));
	}
	return new Set(run.output.split('\0').filter((entry) => entry && entry !== './').map((entry) =>
		normalizeFsPath(path.resolve(folder, entry))));
}

/** Runs file in cwd with options.input as its standard input, killed with the processes it started when signal aborts or
 * after the timeout. */
export function runProcess(file: string, args: string[], cwd: string, options: RunOptions = {}): Promise<StrictRun> {
	const started = performance.now();
	return new Promise((resolve) => {
		const child = startProcess(file, args, cwd);
		let stdout = '';
		let stderr = '';
		let failure = '';
		const stop = (reason: string) => {
			failure = reason;
			stopProcess(child);
		};
		const timeout = options.timeoutMs ?? defaultTimeoutMs;
		const timer = timeout > 0 ? setTimeout(() => stop(`Timed out after ${timeout / 1000} s`), timeout) : undefined;
		const aborted = () => stop('Stopped');
		options.signal?.addEventListener('abort', aborted, { once: true });
		if (options.signal?.aborted) {
			aborted();
		}
		child.stdout?.setEncoding('utf8').on('data', (text: string) => stdout += text);
		child.stderr?.setEncoding('utf8').on('data', (text: string) => stderr += text);
		child.on('error', (error) => failure = error.message);
		if (options.input !== undefined) {
			child.stdin?.end(options.input);
		}
		child.on('close', (code) => {
			clearTimeout(timer);
			options.signal?.removeEventListener('abort', aborted);
			resolve({ exitCode: failure || code === null ? -1 : code, output: stdout + stderr + failure,
				durationMs: performance.now() - started });
		});
	});
}

/** file started in cwd below normal priority (many tests at once must not slow VS Code) as the leader of the processes it
 * starts (elsewhere than Windows), for stopProcess. */
export function startProcess(file: string, args: string[], cwd: string, env?: Record<string, string>): ChildProcess {
	const child = spawn(file, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, detached: process.platform !== 'win32' });
	try {
		if (child.pid !== undefined) {
			os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
		}
	} catch {
		// it already ended, the close event reports that
	}
	return child;
}

/** Kills child started by startProcess unless it ended, with the processes it started: killing only child leaves them running. */
export function stopProcess(child: ChildProcess): void {
	if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	if (process.platform === 'win32') {
		spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }).on('error', () => child.kill());
	} else {
		process.kill(-child.pid);
	}
}

/** Why `strict test` printed no summary: the error it reports with its location or its timeout, else what it printed and its
 * exit code. Nothing crashed when it stopped at a test over its time budget, that test failed. */
export function crashText(run: StrictRun): string | undefined {
	const printed = printedText(run.output);
	return summaryLine.test(run.output) || isStoppedByBudget(run.output) ? undefined
		: errorLocation.test(printed) || timedOutLine.test(printed) ? printed
			: `${printed ? printed + '\n' : ''}Strict crashed with exit code ${run.exitCode}`;
}

/** Strict ends a run without its summary when a unit test runs over its time budget, the tests after it did not run. */
function isStoppedByBudget(output: string): boolean {
	const lines = output.split(/\r?\n/);
	const last = lines.length - 1 - [...lines].reverse().findIndex((line) => testLine.test(line.replace(testDuration, '')));
	return !summaryLine.test(output) && last < lines.length && lines[last].startsWith('Test failed: ') &&
		(lines[last + 1] ?? '').startsWith(`  got: ${overBudget}`);
}

/** What Strict printed besides test results with their stacks, its summary, builds and line counts. */
function printedText(output: string): string {
	return output.split(/\r?\n/).map((line) => line.replace(testDuration, '')).filter((line) => line.trim() &&
		!testLine.test(line) && !line.startsWith('  got: ') && !stackLine.test(line) && !summaryLine.test(line) &&
		!builtLine.test(line) && !lineCount.test(line)).join('\n');
}

/** File and zero based line of the error Strict reports, like `ParsingFailed: ... in Examples/Bad.strict:5` or
 * `ResultMustBeUsed: ... in Queue.strict:line 66`, relative to root, the folder strict ran in. */
export function crashLocation(output: string, root: string): { file: string; line: number } | undefined {
	const match = errorLocation.exec(output);
	return match ? { file: path.resolve(root, match[1]), line: Number(match[2]) - 1 } : undefined;
}

/** A problem shown as the next one to fix: an error stopping all tests of a file, a failed test or a `strict check` issue. */
export type Problem = { file: string; line: number; message: string; kind: 'crash' | 'test' | 'check' };
const problemOrder: Problem['kind'][] = ['crash', 'test', 'check'];

/** The problem to fix next outside focus, the file in front of the user: errors stopping tests first, then failed tests, then
 * check issues, each by file and line. */
export function nextProblem(problems: Problem[], focus: string | undefined): Problem | undefined {
	return problems.filter((problem) => !focus || normalizeFsPath(problem.file) !== normalizeFsPath(focus)).sort((first, second) =>
		problemOrder.indexOf(first.kind) - problemOrder.indexOf(second.kind) || first.file.localeCompare(second.file) ||
		first.line - second.line)[0];
}

/** Entries of queue (files to test, folders to check) in the order they may start: focus, the file in front of the user, and the
 * check of its folder first, only them while focus is red (untested or with problems), so its results come first and alone. */
export function focusedQueue(queue: string[], focus: string | undefined, isRed: boolean): string[] {
	if (!focus) {
		return queue;
	}
	const own = [normalizeFsPath(focus), normalizeFsPath(path.dirname(focus))];
	const first = own.flatMap((key) => queue.filter((entry) => normalizeFsPath(entry) === key));
	return isRed ? first : [...first, ...queue.filter((entry) => !own.includes(normalizeFsPath(entry)))];
}

/** One result per test line Strict printed (a slow test printed as passed and then as failed for taking too long failed), every
 * discovered test when it only printed a cached pass or crashed, slow and native ones only when native tests are up to date. */
export function testResults(source: string, uri: string, run: StrictRun): TestRunnerNotification[] {
	const lines = run.output.split(/\r?\n/).map((line) => line.replace(testDuration, ''));
	const crash = crashText(run);
	const timedOut = timedOutLine.exec(run.output)?.[0];
	const isStopped = isStoppedByBudget(run.output);
	const consoleOutput = crash === undefined && printedText(run.output) || undefined;
	const printed = run.output.split(/\r?\n/).flatMap((line, index) => {
		const match = testLine.exec(lines[index]);
		const duration = testDuration.exec(line)?.[1];
		const actual = match?.[1] === 'failed' ? /^ {2}got: (.*)$/.exec(lines[index + 1] ?? '')?.[1] : undefined;
		const stack = actual === undefined ? [] : lines.slice(index + 2);
		const stackEnd = stack.findIndex((next) => !stackLine.test(next));
		return match ? [{ index, failed: match[1] === 'failed', expression: match[2], method: match[3],
			line: match[4] ? Number(match[4]) - 1 : undefined, durationMs: duration === undefined ? undefined : Number(duration),
			actual, stackTrace: stack.slice(0, stackEnd < 0 ? undefined : stackEnd).map((next) => next.trim()).join('\n') || undefined }]
			: [];
	});
	const isCached = crash === undefined && printed.length === 0;
	const last = printed[printed.length - 1];
	const result = (expression: string, lineNumber: number, methodName: string, found?: typeof printed[number]):
		TestRunnerNotification => {
		const crashed = !found && crash !== undefined;
		const comparison = expression.lastIndexOf(' is ');
		const isOverBudget = found?.actual?.includes(overBudget);
		const expected = found?.actual === undefined || isOverBudget ? undefined : comparison < 0 ? 'true'
			: expression.slice(comparison + 4);
		return {
			lineNumber, state: crashed || found?.failed ? 0 : 1, uri, methodName, expression, expected, actual: found?.actual,
			consoleOutput, cached: isCached || undefined, durationMs: found?.durationMs, stackTrace: found?.stackTrace,
			message: crashed ? crash : !found?.failed ? undefined : found.actual === undefined ? lines[found.index]
				: isOverBudget ? `${found.actual}${isStopped && found === last ? ', the tests after it did not run' : ''}`
					: `Expected ${expected}, got ${found.actual}`
		};
	};
	const reported = new Set<typeof printed[number]>();
	const methods = discoverStrictTests(source).filter((method) => !isSlowHeader(method.header) ||
		upToDateLine.test(run.output) || printed.some((test) => test.method === method.name));
	let isTimeoutReported = false;
	const discovered = methods.flatMap((method) => method.tests.flatMap((test) => {
		const all = printed.filter((candidate) => candidate.line !== undefined ? candidate.line === test.lineNumber
			: candidate.expression === test.expression && candidate.method === method.name);
		const found = all.find((candidate) => candidate.failed) ?? all[0];
		if (found) {
			all.forEach((candidate) => reported.add(candidate));
			found.durationMs ??= all[0].durationMs;
			return [result(test.expression, test.lineNumber, method.name, found)];
		}
		if (timedOut && !isTimeoutReported) {
			isTimeoutReported = true;
			return [{ ...result(test.expression, test.lineNumber, method.name), state: 0,
				message: `${timedOut} in ${test.expression} (line ${test.lineNumber + 1}), later tests did not run` }];
		}
		return !isTimeoutReported && (isCached || crash !== undefined) ? [result(test.expression, test.lineNumber, method.name)] : [];
	}));
	const reportedLines = new Set([...reported].map((test) => test.line));
	return discovered.concat(printed.filter((test) => !reported.has(test) && (test.line === undefined || !reportedLines.has(test.line)))
		.map((test) => result(test.expression, test.line ?? methods.find((method) => method.name === test.method)?.lineNumber ?? 0,
			test.method, test)));
}

/** Issues printed by `strict check` as `file:line N: Rule: target`, line is zero based. */
export function checkIssues(output: string, root: string): CheckIssue[] {
	return output.split(/\r?\n/).flatMap((line) => {
		const match = issuePattern.exec(line);
		return match ? [{ file: path.resolve(root, match[1]), line: Number(match[2]) - 1, rule: match[3], target: match[4] }] : [];
	});
}

/** Lines `strict test <file> lines` printed as `Line Foo.strict:12 executed 340 times in 1.25 ms (self 0.40 ms)`, ms includes
 * the called methods, selfMs not, line is zero based. */
export function lineCounts(output: string, root: string): LineCount[] {
	return output.split(/\r?\n/).flatMap((line) => {
		const match = lineCount.exec(line);
		return match ? [{ file: path.resolve(root, match[1]), line: Number(match[2]) - 1, executions: Number(match[3]),
			ms: Number(match[4]), selfMs: Math.max(0, Number(match[5])) }] : [];
	});
}

export function lineValues(output: string, root: string): LineValue[] {
	return output.split(/\r?\n/).flatMap((line) => {
		const match = valueLine.exec(line);
		return match ? [{ file: path.resolve(root, match[1]), line: Number(match[2]) - 1, hits: Number(match[3]),
			name: match[4] ? undefined : match[6], value: match[4] ? undefined : match[7], each: match[4] ? match[5] : undefined }] : [];
	});
}

// Type mentions approximate dependencies; common names add false matches, and long chains cost O(n²).
export function dependents(changed: string, sources: Map<string, string>): string[] {
	let remaining = [...sources].filter(([file]) => file !== changed);
	const affected = [changed];
	for (let index = 0; index < affected.length && remaining.length > 0; index++) {
		const name = new RegExp(`\\b${typeNameFromPath(affected[index])}\\b`);
		const hits = remaining.filter(([, text]) => name.test(text));
		remaining = remaining.filter((entry) => !hits.includes(entry));
		affected.push(...hits.map(([file]) => file));
	}
	return affected.slice(1);
}

/** Whether a folder of file, a path relative to the workspace, is one of folders (strict.onDemandFolders). */
export function isOnDemand(file: string, folders: string[]): boolean {
	return path.dirname(file).split(/[\\/]/).some((folder) => folders.includes(folder));
}
