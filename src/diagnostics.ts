import {
	Diagnostic,
	DiagnosticRelatedInformation,
	Disposable,
	languages,
	Location,
	OverviewRulerLane,
	Position,
	Range,
	TextDocument,
	TextEditorDecorationType,
	Uri,
	window,
	workspace
} from 'vscode';
import { formatDiagnosticMessage } from './diagnosticMessages';
import { parseStackFrames } from './testResults';

export {
	extractDiagnosticDetail,
	formatDiagnosticMessage,
	humanizePascalCase
} from './diagnosticMessages';

/** Expand zero-width / hard-to-see ranges so squiggles and overview ruler are visible. */
export function expandDiagnosticRange(range: Range, document: TextDocument | undefined): Range {
	if (!document) {
		if (range.isEmpty) {
			return new Range(range.start.line, 0, range.start.line, Math.max(1, range.end.character));
		}
		return range;
	}
	const line = Math.min(range.start.line, Math.max(0, document.lineCount - 1));
	const text = document.lineAt(line).text;
	if (text.length === 0) {
		if (line + 1 < document.lineCount) {
			return new Range(line, 0, line + 1, 0);
		}
		// Last empty line: keep a one-character virtual range for the squiggle
		return new Range(line, 0, line, 1);
	}
	if (range.isEmpty || range.start.character >= text.length) {
		const start = text.search(/\S/);
		const from = start === -1 ? 0 : start;
		return new Range(line, from, line, text.length);
	}
	return range;
}

export function polishDiagnostic(diagnostic: Diagnostic, uri: Uri): Diagnostic {
	const document = workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString());
	const code = diagnosticCode(diagnostic);
	const polished = new Diagnostic(
		expandDiagnosticRange(diagnostic.range, document),
		formatDiagnosticMessage(code, diagnostic.message),
		diagnostic.severity
	);
	polished.code = diagnostic.code;
	polished.source =
		diagnostic.source === 'Strict.Language' || !diagnostic.source ? 'strict' : diagnostic.source;
	// Unnecessary fades the underline — never keep it on parse errors
	polished.tags = undefined;
	polished.relatedInformation = relatedInformation(diagnostic, uri);
	return polished;
}

function relatedInformation(diagnostic: Diagnostic, uri: Uri): DiagnosticRelatedInformation[] {
	const existing = diagnostic.relatedInformation ?? [];
	const frames = parseStackFrames(diagnostic.message);
	if (frames.length === 0) {
		return existing.length > 0 ? [...existing] : [];
	}
	const extras = frames.map((frame) => {
		let file: Uri;
		try {
			file = Uri.file(frame.file);
		} catch {
			file = uri;
		}
		return new DiagnosticRelatedInformation(
			new Location(file, new Position(Math.max(0, frame.line - 1), 0)),
			frame.label
		);
	});
	return [...existing, ...extras];
}

/**
 * Whole-line error background so empty-line and zero-width diagnostics stay obvious.
 */
export class DiagnosticHighlighter implements Disposable {
	private readonly decorationType: TextEditorDecorationType;
	private readonly disposables: Disposable[] = [];

	constructor() {
		this.decorationType = window.createTextEditorDecorationType({
			isWholeLine: true,
			backgroundColor: 'rgba(255, 0, 0, 0.12)',
			overviewRulerColor: 'rgba(255, 80, 80, 0.8)',
			overviewRulerLane: OverviewRulerLane.Right
		});
		this.disposables.push(
			this.decorationType,
			languages.onDidChangeDiagnostics(() => this.refresh()),
			window.onDidChangeActiveTextEditor(() => this.refresh()),
			workspace.onDidChangeTextDocument((event) => {
				if (event.document.languageId === 'strict') {
					this.refresh();
				}
			})
		);
		this.refresh();
	}

	public dispose(): void {
		for (const item of this.disposables) {
			item.dispose();
		}
	}

	private refresh(): void {
		const editor = window.activeTextEditor;
		if (!editor || editor.document.languageId !== 'strict') {
			return;
		}
		const diagnostics = languages.getDiagnostics(editor.document.uri).filter(
			(item) => item.severity === 0 /* DiagnosticSeverity.Error */
		);
		const ranges = diagnostics.map((item) => {
			const line = item.range.start.line;
			const lineLength = editor.document.lineAt(Math.min(line, editor.document.lineCount - 1)).text
				.length;
			return new Range(line, 0, line, Math.max(lineLength, 1));
		});
		editor.setDecorations(this.decorationType, ranges);
	}
}

/** Convenience for unit tests / local providers reading VS Code diagnostics. */
export function diagnosticCode(diagnostic: Diagnostic): string | undefined {
	if (diagnostic.code === undefined || diagnostic.code === null) {
		return undefined;
	}
	if (typeof diagnostic.code === 'object' && 'value' in diagnostic.code) {
		return String(diagnostic.code.value);
	}
	return String(diagnostic.code);
}
