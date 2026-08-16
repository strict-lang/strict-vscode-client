import { DiscoveredMethod, DiscoveredTest } from './scrunchDiscover';
import { formatDuration, formatErrorSummary, parseDiscrepancy, TestRunnerNotification } from './testResults';

export type LineCoverageMark = {
	lineNumber: number;
	failed: boolean;
	kind: 'status' | 'coverage';
	tests: TestRunnerNotification[];
	callCount?: number;
	durationMs?: number;
	expected?: string;
	actual?: string;
	message?: string;
};

export function methodsWithTests(methods: DiscoveredMethod[]): DiscoveredMethod[] {
	return methods.filter((method) => method.tests.length > 0);
}

export function visibleMethods(methods: DiscoveredMethod[]): DiscoveredMethod[] {
	return methods.filter((method) => method.tests.length > 0 || method.runnable);
}

export function isManualMethod(method: DiscoveredMethod): boolean {
	return method.tests.length === 0 && method.runnable;
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
	errorLines: Set<number>
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
			paint(marks, test.lineNumber, 'coverage', lineTests,
				(own ? own.state === 0 : failed) || errorLines.has(test.lineNumber), {
					durationMs: durationOrTiny(own?.durationMs ?? totalDuration(lineTests), lineTests),
					expected: discrepancy?.expected,
					actual: discrepancy?.actual
				});
		}
		for (const line of method.implementation) {
			paint(marks, line.lineNumber, 'coverage', covering, errorLines.has(line.lineNumber), {
				durationMs: durationOrTiny(totalDuration(covering), covering),
				callCount: covering.length
			});
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
	if (mark.callCount && mark.callCount > 0 && mark.kind === 'coverage') {
		lines.push(`Called: ${mark.callCount} time${mark.callCount === 1 ? '' : 's'} so far`);
	}
	const failure = formatInlineFailure(mark);
	if (failure) {
		lines.push(failure);
	} else if (mark.failed && mark.message) {
		lines.push(formatErrorSummary(mark.message) ?? mark.message);
	}
	return lines.join('\n');
}

export function formatInlineFailure(mark: Pick<LineCoverageMark, 'expected' | 'actual'>): string | undefined {
	if (!mark.expected || !mark.actual || mark.expected === mark.actual) {
		return undefined;
	}
	return `expected ${mark.expected}  got ${mark.actual}`;
}

export function shouldShowInlineValue(lineText: string, value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed || trimmed === 'true' || trimmed === 'false') {
		return false;
	}
	return trimmed !== lineText.trim();
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

function durationOrTiny(durationMs: number | undefined, tests: TestRunnerNotification[]): number | undefined {
	if (durationMs !== undefined) {
		return durationMs;
	}
	return tests.some((test) => !test.cached) ? 0 : undefined;
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
	kind: 'status' | 'coverage',
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
	existing.callCount = extra.callCount ?? existing.callCount;
	existing.expected = extra.expected ?? existing.expected;
	existing.actual = extra.actual ?? existing.actual;
	existing.message = extra.message ?? existing.message;
	for (const test of tests) {
		if (!existing.tests.some((item) => item.lineNumber === test.lineNumber &&
			item.expression === test.expression)) {
			existing.tests.push(test);
		}
	}
}
