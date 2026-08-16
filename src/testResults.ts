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
	consoleOutput?: string;
	expected?: string;
	actual?: string;
	methodsCalled?: number;
	linesCalled?: number;
	callCount?: number;
	lastRunAt?: string;
};

export type MethodOutput = {
	durationMs?: number;
	lastRunAt?: string;
	methodsCalled?: number;
	linesCalled?: number;
	callCount?: number;
	consoleOutput?: string;
	details?: string;
	expected?: string;
	actual?: string;
	stackTrace?: string;
	message?: string;
	failed?: boolean;
	cached?: boolean;
};

export type StackFrame = {
	label: string;
	file: string;
	line: number;
};

export function formatDuration(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined || Number.isNaN(durationMs)) {
		return undefined;
	}
	if (durationMs < 0.001) {
		return '<1us';
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
		const file = match[2].trim();
		if (!file.toLowerCase().endsWith('.strict')) {
			continue;
		}
		frames.push({
			label: match[1].trim(),
			file,
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

export function parseDiscrepancy(details: string | undefined): { actual: string; expected: string } | undefined {
	if (!details) {
		return undefined;
	}
	const separator = details.lastIndexOf(' is ');
	if (separator < 0) {
		return undefined;
	}
	const actual = details.slice(0, separator).trim();
	const expected = details.slice(separator + 4).trim();
	if (!actual || !expected || actual === expected) {
		return undefined;
	}
	return { actual, expected };
}

export function formatErrorSummary(message: string | undefined): string | undefined {
	if (!message) {
		return undefined;
	}
	const first = message.replace(/\r\n/g, '\n').split('\n').
		map((line) => line.trim()).
		find((line) => line.length > 0 && !line.startsWith('at '));
	if (!first) {
		return undefined;
	}
	const withoutType = first.replace(/^[A-Za-z][\w.+]*:\s+/, '');
	const text = withoutType || first;
	const cut = text.indexOf(':');
	if (cut > 0 && cut < 48) {
		return text.slice(0, cut);
	}
	return text.length > 72 ? `${text.slice(0, 69)}...` : text;
}

export function formatLastRun(lastRunAt: string | undefined): string | undefined {
	if (!lastRunAt) {
		return undefined;
	}
	const date = new Date(lastRunAt);
	if (Number.isNaN(date.getTime())) {
		return lastRunAt;
	}
	return date.toLocaleString();
}

export function formatMethodOutput(output: MethodOutput): string {
	const lines: string[] = [];
	const consoleText = output.consoleOutput?.replace(/\r\n/g, '\n').trim();
	if (consoleText) {
		lines.push(consoleText);
		lines.push('');
	}
	if (output.failed) {
		const expected = output.expected ?? parseDiscrepancy(output.details)?.expected;
		const actual = output.actual ?? parseDiscrepancy(output.details)?.actual;
		if (expected && actual) {
			lines.push(`Expected: ${expected}`);
			lines.push(`Actual: ${actual}`);
		} else if (output.message) {
			lines.push(output.message.replace(/\r\n/g, '\n').trim());
		} else if (output.details) {
			lines.push(output.details);
		}
		const frames = parseStackFrames(output.stackTrace || output.message);
		if (frames.length > 0) {
			lines.push('');
			for (const frame of frames) {
				lines.push(`at ${frame.label} in ${frame.file}:line ${frame.line}`);
			}
		} else if (output.stackTrace) {
			lines.push('');
			lines.push(output.stackTrace);
		}
		lines.push('');
	}
	const duration = output.cached ? 'cached' : formatDuration(output.durationMs);
	if (duration) {
		lines.push(`Duration: ${duration}`);
	}
	const lastRun = formatLastRun(output.lastRunAt);
	if (lastRun) {
		lines.push(`Last run: ${lastRun}`);
	}
	if (output.methodsCalled !== undefined) {
		lines.push(`Methods called: ${output.methodsCalled}`);
	}
	if (output.linesCalled !== undefined) {
		lines.push(`Lines called: ${output.linesCalled}`);
	}
	if (output.callCount !== undefined) {
		lines.push(`Called: ${output.callCount} time${output.callCount === 1 ? '' : 's'}`);
	}
	return lines.join('\n').trim();
}
