/**
 * Humanize PascalCase / camelCase error codes: EmptyLineIsNotAllowed → "Empty line is not allowed"
 */
export function humanizePascalCase(name: string): string {
	if (!name) {
		return name;
	}
	const words: string[] = [];
	let start = 0;
	for (let i = 1; i < name.length; i++) {
		const previous = name[i - 1];
		const current = name[i];
		const next = i + 1 < name.length ? name[i + 1] : '';
		const splitBeforeCurrent =
			isUpper(current) &&
			(isLower(previous) || (isLower(next) && isUpper(previous)));
		if (splitBeforeCurrent) {
			words.push(name.slice(start, i));
			start = i;
		}
	}
	words.push(name.slice(start));
	return words
		.map((word, index) => {
			const lower = word.toLowerCase();
			if (index === 0) {
				return lower.charAt(0).toUpperCase() + lower.slice(1);
			}
			return lower;
		})
		.join(' ');
}

function isUpper(char: string): boolean {
	return char >= 'A' && char <= 'Z';
}

function isLower(char: string): boolean {
	return char >= 'a' && char <= 'z';
}

function stripTypePrefix(text: string): string {
	const colon = text.indexOf(':');
	if (colon <= 0 || text.slice(0, colon).includes(' ')) {
		return text;
	}
	const after = text.slice(colon + 1).trim();
	return after && !after.startsWith('at ') ? after : '';
}

function isStackLocationLine(line: string): boolean {
	return line.startsWith('at ') && line.includes(':line ');
}

function isInstructionOrSourceDump(line: string): boolean {
	return (
		line.startsWith('Instructions ') ||
		line.startsWith('>>>') ||
		/^\d+:/.test(line) ||
		/^>>>?\s+\d+:/.test(line)
	);
}

export function extractDiagnosticDetail(message: string): string {
	if (!message) {
		return '';
	}
	const atIndex = message.indexOf('\n   at ');
	const withoutStack = (atIndex >= 0 ? message.slice(0, atIndex) : message).trim();
	const useful: string[] = [];
	for (const rawLine of withoutStack.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		if (isStackLocationLine(line)) {
			if (useful.length === 0) {
				return '';
			}
			continue;
		}
		if (line.includes(':line ')) {
			break;
		}
		if (isInstructionOrSourceDump(line)) {
			break;
		}
		const cleaned = stripTypePrefix(line);
		if (cleaned) {
			useful.push(cleaned);
		}
	}
	return useful.join('\n');
}

export function formatDiagnosticMessage(code: string | undefined, message: string): string {
	const humanized = code ? humanizePascalCase(String(code)) : '';
	const detail = extractDiagnosticDetail(message);
	let body: string;
	if (!humanized) {
		body = detail || message;
	} else if (!detail || detail.toLowerCase() === humanized.toLowerCase()) {
		body = humanized;
	} else if (detail.toLowerCase().startsWith(`${humanized.toLowerCase()}:`)) {
		body = detail;
	} else {
		body = `${humanized}: ${detail}`;
	}
	const stack = extractStackText(message);
	const hasReason = Boolean(detail && detail.toLowerCase() !== humanized.toLowerCase());
	const executionFailed = /ExecutionFailed$/i.test(String(code ?? ''));
	if (!stack || body.includes(stack) || (!hasReason && !executionFailed)) {
		return body;
	}
	return `${body}\n${stack}`;
}

export function extractStackText(message: string): string {
	if (!message) {
		return '';
	}
	const frames: string[] = [];
	const pattern = /at (.+?) in (.+):line (\d+)/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(message)) !== null) {
		frames.push(`at ${match[1].trim()} in ${match[2].trim()}:line ${match[3]}`);
	}
	return frames.join('\n');
}
