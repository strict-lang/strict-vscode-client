import { LineCount, LineValue } from './nativeCompiler';
import { DiscoveredMethod, DiscoveredTest, isSlowHeader } from './scrunchDiscover';
import { formatDuration, parseDiscrepancy, parseStackFrames, TestRunnerNotification } from './testResults';

export type LineCoverageMark = {
	lineNumber: number;
	failed: boolean;
	kind: 'status' | 'test' | 'coverage';
	tests: TestRunnerNotification[];
	callCount?: number;
	/** How often and how long the last coverage run executed this line, durationMs is its time then. */
	count?: LineCount;
	durationMs?: number;
	previousMs?: number;
	expected?: string;
	actual?: string;
	message?: string;
	/** The line of the method a failed test crashed in, shown with a big X and its error. */
	crashed?: boolean;
	/** Hit count and assigned value of the line in the last values run. */
	value?: LineValue;
};

export function methodsWithTests(methods: DiscoveredMethod[]): DiscoveredMethod[] {
	return methods.filter((method) => method.tests.length > 0);
}

export function visibleMethods(methods: DiscoveredMethod[]): DiscoveredMethod[] {
	return methods.filter((method) => method.tests.length > 0 || method.runnable);
}

export function isManualMethod(method: DiscoveredMethod): boolean {
	return isSlowHeader(method.header) || method.tests.length === 0 && method.runnable;
}

export function shouldExecuteManual(method: DiscoveredMethod, requestedExplicitly: boolean): boolean {
	return isManualMethod(method) && requestedExplicitly;
}

export function lineBelongsTo(method: DiscoveredMethod, lineNumber: number): boolean {
	if (lineNumber === method.lineNumber) {
		return true;
	}
	return method.tests.some((test) => test.lineNumber === lineNumber) ||
		method.implementation.some((line) => line.lineNumber === lineNumber);
}

export function methodForLine(methods: DiscoveredMethod[], lineNumber: number): DiscoveredMethod | undefined {
	const exact = methods.find((method) => lineBelongsTo(method, lineNumber));
	if (exact) {
		return exact;
	}
	if (lineNumber > 0) {
		return methods.find((method) => lineBelongsTo(method, lineNumber - 1));
	}
	return undefined;
}

export function enrichNotification(
	message: TestRunnerNotification,
	methods: DiscoveredMethod[],
	typeName: string
): TestRunnerNotification {
	const method = methodForLine(methods, message.lineNumber);
	const test = method
		? testAtLine(method, message.lineNumber) ?? testAtLine(method, message.lineNumber - 1)
		: undefined;
	const details = message.details;
	const discrepancy = message.expected && message.actual
		? { expected: message.expected, actual: message.actual }
		: parseDiscrepancy(details);
	return {
		...message,
		typeName: message.typeName || typeName,
		methodName: message.methodName || method?.name,
		expression: message.expression || test?.expression,
		lineNumber: test?.lineNumber ?? message.lineNumber,
		expected: discrepancy?.expected,
		actual: discrepancy?.actual
	};
}

function testAtLine(method: DiscoveredMethod, lineNumber: number): DiscoveredTest | undefined {
	return method.tests.find((test) => test.lineNumber === lineNumber);
}

export function lineCoverageMarks(
	methods: DiscoveredMethod[],
	results: Map<number, TestRunnerNotification>,
	errorLines: Set<number>,
	counts = new Map<number, LineCount>(),
	values?: Map<number, LineValue>
): LineCoverageMark[] {
	const marks = new Map<number, LineCoverageMark>();
	for (const method of visibleMethods(methods)) {
		const tests = coveringTests(method, results);
		const manual = method.tests.length === 0 ? results.get(method.lineNumber) : undefined;
		const ran = tests.length > 0 || Boolean(manual);
		if (isManualMethod(method) && !ran) {
			continue;
		}
		if (!ran && !errorLines.has(method.lineNumber)) {
			continue;
		}
		const failed = (manual ? manual.state === 0 : tests.some((test) => test.state === 0)) ||
			errorLines.has(method.lineNumber);
		const covering = manual ? [manual] : tests;
		paint(marks, method.lineNumber, 'status', covering, failed, {
			durationMs: totalDuration(covering),
			callCount: covering.length,
			message: covering.find((item) => item.message)?.message
		});
		for (const test of method.tests) {
			const own = results.get(test.lineNumber);
			const lineTests = own ? [own] : tests;
			const discrepancy = own ? discrepancyOf(own) : undefined;
			paint(marks, test.lineNumber, 'test', lineTests,
				(own ? own.state === 0 : failed) || errorLines.has(test.lineNumber), {
					durationMs: own?.durationMs ?? totalDuration(lineTests),
					previousMs: own?.previousMs,
					expected: discrepancy?.expected,
					actual: discrepancy?.actual,
					message: own?.message
				});
		}
		const crash = crashOf(method, covering);
		const traced = method.implementation.map((line) => values?.get(line.lineNumber)).find((value) => value !== undefined);
		for (const line of method.implementation) {
			const count = method.tests.length > 0 ? counts.get(line.lineNumber) : undefined;
			const value = values?.get(line.lineNumber) ?? (traced ? { file: traced.file, line: line.lineNumber, hits: 0 } : undefined);
			const isError = errorLines.has(line.lineNumber) || crash.lines.has(line.lineNumber);
			const error = crash.errors.get(line.lineNumber);
			if (value || isError || (count ? count.executions !== 0 : line.lineNumber <= crash.reach)) {
				paint(marks, line.lineNumber, 'coverage', covering, isError || failed, {
					...value ? { value } : {},
					...count ? { durationMs: count.ms, count } : { durationMs: totalDuration(covering), callCount: covering.length },
					...error === undefined ? {} : { crashed: true, message: error }
				});
			}
		}
	}
	for (const line of errorLines) {
		if (!marks.has(line)) {
			marks.set(line, { lineNumber: line, failed: true, kind: 'status', tests: [] });
		}
	}
	return [...marks.values()].sort((left, right) => left.lineNumber - right.lineNumber);
}

export function formatCoverageHover(mark: LineCoverageMark): string {
	const duration = formatDuration(mark.durationMs);
	const lines: string[] = [];
	if (duration) {
		lines.push(duration);
	}
	if (mark.value) {
		const { hits, name, value, each } = mark.value;
		lines.push(`Ran ${times(hits)}${each ? `: ${each}` : value === undefined ? '' : `: ${name} = ${value}`}`);
	} else if (mark.callCount && mark.callCount > 0 && mark.kind === 'coverage') {
		lines.push(`Called: ${times(mark.callCount)} so far`);
	}
	if (mark.count) {
		lines.push(`Executed: ${times(mark.count.executions)}, self ${formatDuration(mark.count.selfMs)}`);
	}
	const failure = formatInlineFailure(mark);
	if (failure) {
		lines.push(failure);
	} else if (mark.failed && mark.message) {
		lines.push(mark.message.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('at ')).join('\n'));
	}
	return lines.join('\n');
}

export function formatInlineFailure(mark: Pick<LineCoverageMark, 'expected' | 'actual' | 'crashed' | 'message'>):
	string | undefined {
	if (mark.crashed) {
		return cut(mark.message?.split(/\r?\n/)[0] ?? 'failed');
	}
	if (!mark.expected || !mark.actual || mark.expected === mark.actual) {
		return undefined;
	}
	return `expected ${mark.expected}  got ${mark.actual}`;
}

/** Duration of a test, or of all tests of a method on its header, from slowMs on. Failures show their discrepancy instead. */
export function formatInlineSlow(mark: LineCoverageMark, slowMs: number): string | undefined {
	const isTimed = mark.kind === 'status' || mark.count !== undefined ||
		mark.tests.some((test) => test.lineNumber === mark.lineNumber);
	const before = mark.previousMs === undefined ? '' : ` (was ${formatDuration(mark.previousMs)})`;
	const executed = mark.count ? ` (self ${formatDuration(mark.count.selfMs)}, ${times(mark.count.executions)})` : '';
	return isTimed && !mark.failed && isSlow({ durationMs: mark.durationMs, cached: mark.tests.some((test) => test.cached) }, slowMs)
		? `slow: ${formatDuration(mark.durationMs)}${before}${executed}` : undefined;
}

/** A cached result did not run now, its remembered time may be from a busy startup and is not shown as slow. */
export function isSlow(result: Pick<TestRunnerNotification, 'durationMs' | 'cached'>, slowMs: number): boolean {
	return !result.cached && (result.durationMs ?? 0) >= slowMs;
}

/** Hit counts and compiler values, with compact results for returns and constructors and per-hit values when they vary. */
export function formatInlineValue(value: LineValue, line: string): string {
	if (value.each) {
		return cut(`${times(value.hits)}: ${value.each}`);
	}
	if (value.value !== undefined && /^\s*(return\b|[A-Z]\w*\()/.test(line)) {
		return cut(`${times(value.hits)}: ${value.value}`);
	}
	const isBranch = /^(\t\t|\t(for|if|else)\b)/.test(line);
	const isTrueExpression = value.value === 'true' && !/^[A-Za-z][\w.]*$/.test(value.name ?? '');
	const shown = value.value === undefined || isTrueExpression || line.includes(`${value.name} = ${value.value}`) ? undefined
		: `${value.name} = ${value.value}`;
	return cut([value.hits !== 1 || isBranch ? times(value.hits) : undefined, shown].filter(Boolean).join(', '));
}

/** text up to 100 characters, the hover shows all of it. */
function cut(text: string): string {
	return text.length > 100 ? text.slice(0, 100) + '…' : text;
}

/** Last measured milliseconds by `file|test expression`. */
export type TimingHistory = Record<string, number>;

/** A cached pass gets the last measured time, a new time (not a native one) is remembered and one over twice the last keeps it as
 * previousMs. */
export function remember(history: TimingHistory, key: string, result: TestRunnerNotification, slowMs: number):
	TestRunnerNotification {
	const last = history[key];
	if (result.cached || result.native || result.durationMs === undefined) {
		return result.cached && last !== undefined ? { ...result, durationMs: last } : result;
	}
	history[key] = result.durationMs;
	return last !== undefined && result.durationMs >= slowMs && result.durationMs > 2 * last ? { ...result, previousMs: last }
		: result;
}

export type MethodSummary = {
	duration: number;
	hasDuration: boolean;
	failed: boolean;
	cached: boolean;
	messages: TestRunnerNotification[];
};

/** Results by the header of their method, overloads like `+(other)` and `+(number)` stay apart. */
export function groupByMethod(byLine: Map<number, TestRunnerNotification>, methods: DiscoveredMethod[]):
	Map<string, MethodSummary> {
	const grouped = new Map<string, MethodSummary>();
	for (const message of byLine.values()) {
		const method = methodOf(methods, message);
		const current = method && (grouped.get(method.header) ??
			{ duration: 0, hasDuration: false, failed: false, cached: true, messages: [] });
		if (method && current) {
			current.duration += message.durationMs ?? 0;
			current.hasDuration ||= message.durationMs !== undefined;
			current.failed ||= message.state === 0;
			current.cached &&= Boolean(message.cached);
			current.messages.push(message);
			grouped.set(method.header, current);
		}
	}
	return grouped;
}

/** The method a result belongs to: the one containing its line when the name fits, else the first of its name. */
export function methodOf(methods: DiscoveredMethod[], message: TestRunnerNotification): DiscoveredMethod | undefined {
	const atLine = methodForLine(methods, message.lineNumber);
	return atLine && (!message.methodName || atLine.name === message.methodName) ? atLine
		: methods.find((method) => method.name === message.methodName);
}

/** Results of Run methods without tests, the other results of a file are replaced by its next `strict test`. */
export function manualResults(byLine: Map<number, TestRunnerNotification>, methods: DiscoveredMethod[]):
	Map<number, TestRunnerNotification> {
	return new Map([...byLine].filter(([, result]) => {
		const method = methodOf(methods, result);
		return method !== undefined && isManualMethod(method);
	}));
}

export function slowestTests(results: TestRunnerNotification[], limit: number): TestRunnerNotification[] {
	return results.filter((result) => result.durationMs !== undefined)
		.sort((left, right) => right.durationMs! - left.durationMs!).slice(0, limit);
}

function coveringTests(
	method: DiscoveredMethod,
	results: Map<number, TestRunnerNotification>
): TestRunnerNotification[] {
	const tests: TestRunnerNotification[] = [];
	for (const test of method.tests) {
		const result = results.get(test.lineNumber);
		if (result) {
			tests.push(result);
		}
	}
	if (tests.length > 0) {
		return tests;
	}
	return [...results.values()].filter((result) => result.methodName === method.name);
}

/** Lines of method on the stacks of its failed tests, errors by the innermost line each crashed in, reach is the last line
 * they got to: all when one returned a value, none when Strict stopped before running them. */
function crashOf(method: DiscoveredMethod, tests: TestRunnerNotification[]):
	{ lines: Set<number>; errors: Map<number, string>; reach: number } {
	const own = new Set(method.implementation.map((line) => line.lineNumber));
	const lines = new Set<number>();
	const errors = new Map<number, string>();
	let reach = -1;
	for (const test of tests) {
		const stack = parseStackFrames(test.stackTrace).filter((frame) => frame.label === `${test.typeName}.${method.name}` &&
			own.has(frame.line - 1)).map((frame) => frame.line - 1);
		stack.forEach((line) => lines.add(line));
		if (stack.length > 0) {
			errors.set(stack[0], test.actual ?? test.message ?? 'failed');
		}
		reach = Math.max(reach, stack.length > 0 ? Math.max(...stack) : test.state !== 0 || test.actual !== undefined ? Infinity : -1);
	}
	return { lines, errors, reach };
}

function times(count: number): string {
	return `${count} time${count === 1 ? '' : 's'}`;
}

function totalDuration(tests: TestRunnerNotification[]): number | undefined {
	let total = 0;
	let seen = false;
	for (const test of tests) {
		if (test.durationMs === undefined || Number.isNaN(test.durationMs)) {
			continue;
		}
		total += test.durationMs;
		seen = true;
	}
	return seen ? total : undefined;
}

function discrepancyOf(test: TestRunnerNotification): { expected: string; actual: string } | undefined {
	if (test.expected && test.actual && test.expected !== test.actual) {
		return { expected: test.expected, actual: test.actual };
	}
	return parseDiscrepancy(test.details);
}

function paint(
	marks: Map<number, LineCoverageMark>,
	lineNumber: number,
	kind: LineCoverageMark['kind'],
	tests: TestRunnerNotification[],
	failed: boolean,
	extra: Partial<LineCoverageMark>
): void {
	const existing = marks.get(lineNumber);
	if (!existing) {
		marks.set(lineNumber, { lineNumber, failed, kind, tests, ...extra });
		return;
	}
	existing.failed = existing.failed || failed;
	if (kind === 'status') {
		existing.kind = 'status';
	}
	existing.durationMs = extra.durationMs ?? existing.durationMs;
	existing.previousMs = extra.previousMs ?? existing.previousMs;
	existing.callCount = extra.callCount ?? existing.callCount;
	existing.expected = extra.expected ?? existing.expected;
	existing.actual = extra.actual ?? existing.actual;
	existing.message = extra.message ?? existing.message;
	existing.crashed = extra.crashed ?? existing.crashed;
	for (const test of tests) {
		if (!existing.tests.some((item) => item.lineNumber === test.lineNumber &&
			item.expression === test.expression)) {
			existing.tests.push(test);
		}
	}
}
