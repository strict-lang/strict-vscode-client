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

export function extractDiagnosticDetail(message: string): string {
	if (!message) {
		return '';
	}
	const atIndex = message.indexOf('\n   at ');
	const detail = (atIndex >= 0 ? message.slice(0, atIndex) : message).trim();
	// Drop raw exception type prefix if present: "EmptyLineIsNotAllowed: ..."
	const colon = detail.indexOf(':');
	if (colon > 0 && !detail.slice(0, colon).includes(' ')) {
		const after = detail.slice(colon + 1).trim();
		// Ignore stack-location-only remnants
		if (!after || after.startsWith('at ') || after.includes(':line ')) {
			return '';
		}
		return after;
	}
	if (detail.startsWith('at ') || detail.includes(':line ')) {
		return '';
	}
	return detail;
}

export function formatDiagnosticMessage(code: string | undefined, message: string): string {
	const humanized = code ? humanizePascalCase(String(code)) : '';
	const detail = extractDiagnosticDetail(message);
	if (humanized && detail && detail.toLowerCase() !== humanized.toLowerCase()) {
		return `${humanized}: ${detail}`;
	}
	if (humanized) {
		return humanized;
	}
	return detail || message;
}
