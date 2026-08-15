export type TestRunnerNotification = {
	lineNumber: number;
	state: number;
	uri?: string;
	expression?: string;
	methodName?: string;
	typeName?: string;
	message?: string;
	details?: string;
	durationMs?: number;
	stackTrace?: string;
	cached?: boolean;
};

export type StackFrame = {
	label: string;
	file: string;
	line: number;
};

export function formatDuration(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined || Number.isNaN(durationMs) || durationMs <= 0) {
		return undefined;
	}
	if (durationMs < 0.1) {
		return `${Math.max(1, Math.round(durationMs * 1000))}us`;
	}
	if (durationMs < 10) {
		return `${durationMs.toFixed(1)}ms`;
	}
	if (durationMs < 1000) {
		return `${Math.round(durationMs)}ms`;
	}
	return `${(durationMs / 1000).toFixed(1)}s`;
}

export function parseStackFrames(text: string | undefined): StackFrame[] {
	if (!text) {
		return [];
	}
	const frames: StackFrame[] = [];
	const pattern = /at (.+?) in (.+):line (\d+)/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		frames.push({
			label: match[1].trim(),
			file: match[2].trim(),
			line: Number(match[3])
		});
	}
	return frames;
}

export function formatFailureOutput(message: TestRunnerNotification): string {
	const lines: string[] = [];
	if (message.expression) {
		lines.push(message.expression);
	}
	const owner = [message.typeName, message.methodName].filter(Boolean).join('.');
	if (owner) {
		lines.push(owner);
	}
	if (message.details) {
		lines.push(message.details);
	}
	if (message.message && message.message !== message.details) {
		lines.push(message.message);
	}
	const stack = message.stackTrace || message.message;
	const frames = parseStackFrames(stack);
	if (frames.length > 0) {
		lines.push('');
		lines.push('Stack');
		for (const frame of frames) {
			lines.push(`at ${frame.label} in ${frame.file}:line ${frame.line}`);
		}
	} else if (message.stackTrace) {
		lines.push('');
		lines.push(message.stackTrace);
	}
	return lines.join('\n');
}

export function formatTestHover(message: TestRunnerNotification): string {
	const passed = message.state !== 0;
	const expression = message.expression?.trim();
	const duration = message.cached ? 'cached' : formatDuration(message.durationMs);
	const title = expression ? `${passed ? 'Passed' : 'Failed'} \`${expression}\`` : (passed ? 'Passed' : 'Failed');
	const lines = [duration ? `${title}  ${duration}` : title];
	if (message.methodName) {
		lines.push(message.methodName);
	}
	if (!passed && message.details) {
		lines.push(message.details);
	}
	if (!passed && message.message && message.message !== message.details) {
		lines.push(message.message);
	}
	return lines.join('\n');
}

export function formatSingleTestOutput(message: TestRunnerNotification): string {
	const passed = message.state !== 0;
	const duration = message.cached ? 'cached' : formatDuration(message.durationMs);
	if (passed) {
		const lines = [message.expression, [message.typeName, message.methodName].filter(Boolean).join('.')].
			filter((line) => line && line.length > 0) as string[];
		lines.push(duration ? `passed  ${duration}` : 'passed');
		return lines.join('\n');
	}
	const body = formatFailureOutput(message);
	return duration ? `${body}\nfailed  ${duration}` : `${body}\nfailed`;
}

export function formatLineTests(tests: TestRunnerNotification[]): string {
	if (tests.length === 0) {
		return 'No tests covered this line';
	}
	return tests.map((test) => {
		const passed = test.state !== 0;
		const duration = test.cached ? 'cached' : formatDuration(test.durationMs);
		const status = passed ? 'passed' : 'failed';
		const expression = test.expression?.trim() || `line ${test.lineNumber + 1}`;
		const suffix = duration ? `  ${duration}` : '';
		return `${status}  ${expression}${suffix}`;
	}).join('\n');
}
