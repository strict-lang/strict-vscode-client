import { spawn } from 'child_process';
import * as path from 'path';
import { compilerFile, normalizeFsPath } from './paths';
import { discoverStrictTests, typeNameFromPath } from './scrunchDiscover';
import { TestRunnerNotification } from './testResults';

export type StrictRun = { exitCode: number; output: string; durationMs: number; times?: number[] };
export type CheckIssue = { file: string; line: number; rule: string; target: string };

const timeoutMs = 60000;
const summaryLine = /^(All tests passed|\d+ (tests )?failed) in /m;
const failureLine = /^Test failed: (.*) in (\S+?)(?: at .+:line (\d+))?$/;
const passedLine = /^Test passed: .* at .+:line (\d+)$/;
const issuePattern = /^(.+?\.strict):line (\d+): (\w+): (.*)$/;
const errorLocation = /^\w+: .* in (.+?\.strict):(\d+)/m;
export const testDuration = / \((\d+(?:\.\d+)?) ms\)$/;

/** Runs root/strict with root as working directory, root arguments are always ".". */
export function runStrict(root: string, args: string[]): Promise<StrictRun> {
	return runProcess(path.join(root, compilerFile), args, root);
}

/** Runs file, times[i] is when output line i arrived in ms since the start (stdout streams while tests run). */
export function runProcess(file: string, args: string[], cwd: string): Promise<StrictRun> {
	const started = performance.now();
	return new Promise((resolve) => {
		const child = spawn(file, args, { cwd, windowsHide: true });
		const times: number[] = [];
		let stdout = '';
		let stderr = '';
		let failure = '';
		const timer = setTimeout(() => {
			failure = `Timed out after ${timeoutMs / 1000} s`;
			child.kill();
		}, timeoutMs);
		child.stdout.setEncoding('utf8').on('data', (text: string) => {
			const now = performance.now() - started;
			stdout += text;
			for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) {
				times.push(now);
			}
		});
		child.stderr.setEncoding('utf8').on('data', (text: string) => stderr += text);
		child.on('error', (error) => failure = error.message);
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({ exitCode: failure || code === null ? -1 : code, output: stdout + stderr + failure,
				durationMs: performance.now() - started, times });
		});
	});
}

export function crashText(run: StrictRun): string | undefined {
	return summaryLine.test(run.output)
		? undefined
		: `Strict crashed with exit code ${run.exitCode}${run.output.trim() ? '\n' + run.output.trim() : ''}`;
}

/** Zero based line of the error Strict reports for file, like `ParsingFailed: ... in Examples/Bad.strict:5`. */
export function crashLine(output: string, file: string, root: string): number | undefined {
	const match = errorLocation.exec(output);
	return match && normalizeFsPath(path.resolve(root, match[1])) === normalizeFsPath(file) ? Number(match[2]) - 1 : undefined;
}

/** One result per discovered test line from `strict test` output. */
export function testResults(source: string, uri: string, run: StrictRun): TestRunnerNotification[] {
	const printed = run.output.split(/\r?\n/).map((line) => testDuration.exec(line)?.[1]);
	const lines = run.output.split(/\r?\n/).map((line) => line.replace(testDuration, ''));
	const crash = crashText(run);
	const consoleOutput = lines.filter((line) => line && !/^Test (passed|failed): /.test(line) &&
		!line.startsWith('  got: ') && !summaryLine.test(line)).join('\n') || undefined;
	const testLines = lines.flatMap((line, index) => /^Test (passed|failed): /.test(line) ? [index] : []);
	// ponytail: without a printed duration a test takes the gap since the previous test line, the first one also compiled
	const durationOf = (index: number) => {
		const previous = testLines[testLines.indexOf(index) - 1];
		return printed[index] !== undefined ? Number(printed[index]) : index >= 0 && previous !== undefined &&
			run.times?.[index] !== undefined ? run.times[index] - run.times[previous] : undefined;
	};
	const passed = new Map(lines.flatMap((line, index) => {
		const match = passedLine.exec(line);
		return match ? [[Number(match[1]) - 1, index]] : [];
	}));
	const failures = lines.flatMap((line, index) => {
		const match = failureLine.exec(line);
		return match ? [{ index, expression: match[1], method: match[2], line: match[3] ? Number(match[3]) - 1 : undefined }] : [];
	});
	const reported = new Set<number>();
	const methods = discoverStrictTests(source);
	const results = methods.flatMap((method) => method.tests.map((test): TestRunnerNotification => {
		const failed = failures.find((failure) => failure.line !== undefined ? failure.line === test.lineNumber
			: failure.expression === test.expression && failure.method === method.name)?.index ?? -1;
		reported.add(failed);
		const actual = failed >= 0 ? /^ {2}got: (.*)$/.exec(lines[failed + 1] ?? '')?.[1] : undefined;
		const expected = actual === undefined ? undefined : test.expression.slice(test.expression.lastIndexOf(' is ') + 4);
		const crashed = crash !== undefined && failed < 0 && !passed.has(test.lineNumber);
		return {
			lineNumber: test.lineNumber, state: crashed || failed >= 0 ? 0 : 1, uri, methodName: method.name,
			expression: test.expression, expected, actual, consoleOutput,
			durationMs: durationOf(failed >= 0 ? failed : passed.get(test.lineNumber) ?? -1),
			message: crashed ? crash : failed < 0 ? undefined : actual === undefined ? lines[failed] : `Expected ${expected}, got ${actual}`
		};
	}));
	const unmatched = failures.filter((failure) => !reported.has(failure.index));
	return results.concat(unmatched.map((failure) => {
		const lineNumber = failure.line ?? methods.find((method) => method.name === failure.method)?.lineNumber ?? 0;
		return { lineNumber, state: 0, uri, methodName: failure.method, message: lines[failure.index], consoleOutput };
	}));
}

/** Issues printed by `strict check` as `file:line N: Rule: target`, line is zero based. */
export function checkIssues(output: string, root: string): CheckIssue[] {
	return output.split(/\r?\n/).flatMap((line) => {
		const match = issuePattern.exec(line);
		return match ? [{ file: path.resolve(root, match[1]), line: Number(match[2]) - 1, rule: match[3], target: match[4] }] : [];
	});
}

// ponytail: impact by type name mentions, over-approximates common names like Type, O(n²) on long chains; upgrade: dependencies from Strict
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
