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
	previousMs?: number;
	stackTrace?: string;
	cached?: boolean;
	/** From the native build of a coverage run, faster than usual, so its time is not remembered. */
	native?: boolean;
	consoleOutput?: string;
	expected?: string;
	actual?: string;
};

export type MethodOutput = {
	consoleOutput?: string;
	details?: string;
	expected?: string;
	actual?: string;
	stackTrace?: string;
	message?: string;
	failed?: boolean;
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

/** One line per method shown after its header in the editor, a cached result has no time. */
export function methodLine(failed: boolean, durationMs: number | undefined): string {
	return `${failed ? '✗' : '✓'} ${formatDuration(durationMs) ?? 'cached'}`;
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
	const cut = text.indexOf(': ');
	if (cut > 0 && cut < 48) {
		return text.slice(0, cut);
	}
	return text.length > 72 ? `${text.slice(0, 69)}...` : text;
}

/** formatMethodOutput of a method of file unless printed has it: a crash once for all files (every type using the broken one
 * stops with it), what a type printed once per file, every failed comparison. */
export function unprintedOutput(output: MethodOutput, file: string, printed: Set<string>,
	where?: (file: string) => string): string | undefined {
	const text = formatMethodOutput(output, where);
	const key = output.expected !== undefined ? undefined : output.failed ? text : `${file}\n${text}`;
	if (!text || key !== undefined && printed.has(key)) {
		return undefined;
	}
	if (key !== undefined) {
		printed.add(key);
	}
	return text;
}

/** What the tests of a method printed and why they failed, nothing for a silent pass (durations are in the Testing view),
 * stack frames as `where(file):line` links. */
export function formatMethodOutput(output: MethodOutput, where = (file: string) => file): string {
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
				lines.push(`at ${frame.label} in ${where(frame.file)}:${frame.line}`);
			}
		} else if (output.stackTrace) {
			lines.push('');
			lines.push(output.stackTrace);
		}
	}
	return lines.join('\n').trim();
}
