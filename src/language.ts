import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { copiedFrom, existingCalls, implementationCandidates, passingBodies, pendingTests, withImplementation } from './implementations';
import { normalizeFsPath, strictDocumentSelector } from './paths';
import {
	callBefore, chainBefore, Entry, isNamed, keywords, membersOf, parseType, resolve, Scope, scopeAt, StrictMethod, StrictType,
	strictFiles, typeNamed
} from './strictIndex';

export const alreadyExists = 'MethodAlreadyExists';
const rescanMs = 30000;
const checkDelayMs = 1000;
const cachedRuns = 100;
type Found = { entries: Entry[]; type?: StrictType; line?: number; text?: string };

/** Completion, hover, go to definition, signature help and symbols from the parsed .strict files of the workspace and of
 * the Strict folder; suggests implementations and reports methods that already exist, both verified with `strict test`. */
export class StrictLanguage implements vscode.Disposable {
	private readonly parsed = new Map<string, { modified: number; type: StrictType }>();
	private readonly existing = vscode.languages.createDiagnosticCollection('strict existing');
	private readonly runs = new Map<string, Promise<string[]>>();
	private readonly timers = new Map<string, NodeJS.Timeout>();
	private readonly disposables: vscode.Disposable[];
	private all: StrictType[] = [];
	private scanned = 0;

	constructor(private readonly root: () => string | undefined) {
		const watcher = vscode.workspace.createFileSystemWatcher('**/*.strict');
		const rescan = () => this.scanned = 0;
		this.disposables = [watcher, watcher.onDidCreate(rescan), watcher.onDidChange(rescan), watcher.onDidDelete(rescan),
			this.existing,
			vscode.languages.registerCompletionItemProvider(strictDocumentSelector,
				{ provideCompletionItems: (document, position) => this.complete(document, position) }, '.'),
			vscode.languages.registerHoverProvider(strictDocumentSelector,
				{ provideHover: (document, position) => this.hover(document, position) }),
			vscode.languages.registerDefinitionProvider(strictDocumentSelector,
				{ provideDefinition: (document, position) => this.definition(document, position) }),
			vscode.languages.registerSignatureHelpProvider(strictDocumentSelector,
				{ provideSignatureHelp: (document, position) => this.signature(document, position) }, '(', ','),
			vscode.languages.registerDocumentSymbolProvider(strictDocumentSelector,
				{ provideDocumentSymbols: (document) => symbols(document) }),
			vscode.languages.registerWorkspaceSymbolProvider({ provideWorkspaceSymbols: (query) => this.workspaceSymbols(query) }),
			vscode.languages.registerInlineCompletionItemProvider(strictDocumentSelector,
				{ provideInlineCompletionItems: (document, position, _context, token) => this.suggest(document, position, token) }),
			vscode.workspace.onDidOpenTextDocument((document) => this.scheduleCheck(document)),
			vscode.workspace.onDidChangeTextDocument((event) => this.scheduleCheck(event.document)),
			vscode.workspace.onDidCloseTextDocument((document) => this.existing.delete(document.uri))
		];
		vscode.workspace.textDocuments.forEach((document) => this.scheduleCheck(document));
	}

	public dispose(): void {
		this.timers.forEach((timer) => clearTimeout(timer));
		this.disposables.forEach((disposable) => disposable.dispose());
	}

	// ponytail: synchronous walk of the workspace and Strict folders, slow for huge workspaces; upgrade: workspace.findFiles
	private allTypes(): StrictType[] {
		if (Date.now() - this.scanned > rescanMs) {
			const root = this.root();
			const folders = [...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath), ...(root ? [root] : [])];
			const files = new Map([...new Set(folders.map(path.normalize))].flatMap(strictFiles).map((file) =>
				[normalizeFsPath(file), file]));
			this.all = [...files.values()].flatMap((file) => this.parsedType(file) ?? []);
			this.scanned = Date.now();
		}
		return this.all;
	}

	private types(document: vscode.TextDocument): { own: StrictType; types: StrictType[] } {
		const own = parseType(document.fileName, document.getText());
		return { own, types: [own, ...this.allTypes().filter((type) => normalizeFsPath(type.file) !== normalizeFsPath(own.file))] };
	}

	private parsedType(file: string): StrictType | undefined {
		try {
			const modified = fs.statSync(file).mtimeMs;
			const cached = this.parsed.get(file);
			if (cached?.modified !== modified) {
				this.parsed.set(file, { modified, type: parseType(file, fs.readFileSync(file, 'utf8')) });
			}
			return this.parsed.get(file)!.type;
		} catch {
			return undefined;
		}
	}

	private scope(document: vscode.TextDocument, line: number): Scope {
		const { own, types } = this.types(document);
		return scopeAt(types, own, document.getText().split(/\r?\n/), line);
	}

	private complete(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
		const scope = this.scope(document, position.line);
		const before = document.lineAt(position.line).text.slice(0, position.character).replace(/\w*$/, '');
		if (before.endsWith('.')) {
			const receiver = resolve(chainBefore(before.slice(0, -1)), scope);
			return receiver ? unique(membersOf(receiver, scope.types)).map((entry) => entryItem(entry, receiver.isType))
				: anyMethodItems(scope.types);
		}
		const root = this.root();
		const typeItems = unique(scope.types.map((type) => ({ owner: type, name: type.name }))).map((entry) =>
			item(entry.name, vscode.CompletionItemKind.Class, relativeFile(entry.owner.file, root), '2'));
		if (before === 'has ') {
			return unique(scope.types.map((type) => ({ owner: type, name: type.name[0].toLowerCase() + type.name.slice(1) })))
				.map((entry) => item(entry.name, vscode.CompletionItemKind.Field, `has ${entry.name} (${entry.owner.name})`, '1'));
		}
		if (!/^\s/.test(before)) {
			return [...['has', 'constant', 'mutable'].map((name) => item(name, vscode.CompletionItemKind.Keyword, '', '0')), ...typeItems];
		}
		const ownMembers = membersOf({ type: scope.own }, scope.types).filter((entry) => entry.owner === scope.own);
		return [
			...(scope.method?.parameters ?? []).map((parameter) =>
				item(parameter.name, vscode.CompletionItemKind.Variable, `${parameter.name} ${parameter.type}`, '0')),
			...[...scope.locals.keys()].map((name) => item(name, vscode.CompletionItemKind.Variable, 'local', '0')),
			...ownMembers.map((entry) => entryItem(entry)),
			...['value', 'index', ...keywords].map((name) => item(name, vscode.CompletionItemKind.Keyword, '', '3')),
			...typeItems
		];
	}

	private find(document: vscode.TextDocument, position: vscode.Position): (Found & { range: vscode.Range }) | undefined {
		const range = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
		if (!range) {
			return undefined;
		}
		const word = document.getText(range);
		const scope = this.scope(document, position.line);
		const before = document.lineAt(position.line).text.slice(0, range.start.character);
		if (before.endsWith('.')) {
			const receiver = resolve(chainBefore(before.slice(0, -1)), scope);
			const entries = (receiver ? membersOf(receiver, scope.types) : scope.types.flatMap((type) => membersOf({ type }, [])))
				.filter((entry) => entry.name === word);
			return { range, entries: entries.filter((entry, index) => entries.findIndex((other) =>
				other.owner === entry.owner) === index).slice(0, 10) };
		}
		const parameter = scope.method?.parameters.find((candidate) => candidate.name === word);
		const local = scope.locals.get(word);
		const lines = document.getText().split(/\r?\n/);
		const localLine = local && scope.method ? lines.findIndex((text, index) => index > scope.method!.line &&
			new RegExp(`^\\t+(let|constant|mutable|for) ${word}\\b`).test(text)) : -1;
		if (parameter || local) {
			return { range, entries: [], line: parameter ? scope.method!.line : localLine,
				text: parameter ? `${word} ${parameter.type}` : `${word} = ${local!.expression}` };
		}
		const entries = membersOf({ type: scope.own }, scope.types).filter((entry) => entry.name === word);
		return entries.length > 0 ? { range, entries } : { range, entries: [], type: typeNamed(word, scope.types)?.type };
	}

	private hover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
		const found = this.find(document, position);
		const markdown = new vscode.MarkdownString();
		if (found?.text) {
			markdown.appendCodeblock(found.text, 'strict');
		}
		for (const entry of found?.entries ?? []) {
			appendEntry(markdown, entry);
		}
		if (found?.type) {
			markdown.appendCodeblock([...found.type.members.map((member) => member.text),
				...found.type.methods.map((method) => method.header)].join('\n'), 'strict');
			markdown.appendMarkdown(link(found.type.file, 0));
		}
		return markdown.value ? new vscode.Hover(markdown, found!.range) : undefined;
	}

	private definition(document: vscode.TextDocument, position: vscode.Position): vscode.Location[] {
		const found = this.find(document, position);
		return [
			...(found?.line !== undefined && found.line >= 0 ? [new vscode.Location(document.uri, new vscode.Position(found.line, 0))] : []),
			...(found?.entries ?? []).map((entry) => new vscode.Location(vscode.Uri.file(entry.owner.file),
				new vscode.Position(entry.method?.line ?? entry.member!.line, 0))),
			...(found?.type ? [new vscode.Location(vscode.Uri.file(found.type.file), new vscode.Position(0, 0))] : [])
		];
	}

	private signature(document: vscode.TextDocument, position: vscode.Position): vscode.SignatureHelp | undefined {
		const call = callBefore(document.lineAt(position.line).text.slice(0, position.character));
		if (!call) {
			return undefined;
		}
		const scope = this.scope(document, position.line);
		const dot = call.callee.lastIndexOf('.');
		const name = call.callee.slice(dot + 1);
		const receiver = dot > 0 ? resolve(call.callee.slice(0, dot), scope) : { type: scope.own };
		const type = dot < 0 ? typeNamed(name, scope.types)?.type : undefined;
		const methods = type ? constructors(type) : (receiver ? membersOf(receiver, scope.types)
			: scope.types.flatMap((candidate) => membersOf({ type: candidate }, []))).flatMap((entry) =>
			entry.name === name && entry.method ? [entry.method] : []).slice(0, 10);
		const help = new vscode.SignatureHelp();
		help.signatures = methods.map((method) => {
			const signature = new vscode.SignatureInformation(method.header, testsMarkdown(method));
			signature.parameters = method.parameters.map((parameter) => {
				const start = method.header.indexOf(parameter.name, method.header.indexOf('('));
				return new vscode.ParameterInformation([start, start + parameter.name.length]);
			});
			return signature;
		});
		help.activeParameter = call.argument;
		return help.signatures.length > 0 ? help : undefined;
	}

	private workspaceSymbols(query: string): vscode.SymbolInformation[] {
		const lower = query.toLowerCase();
		const matches = (name: string) => [...name.toLowerCase()].reduce((found, character) =>
			found + (character === lower[found] ? 1 : 0), 0) === lower.length;
		return this.allTypes().flatMap((type) => [
			new vscode.SymbolInformation(type.name, vscode.SymbolKind.Class, '', location(type.file, 0)),
			...type.methods.map((method) => new vscode.SymbolInformation(method.name, vscode.SymbolKind.Method, type.name,
				location(type.file, method.line)))
		]).filter((symbol) => matches(symbol.name)).slice(0, 1000);
	}

	private async suggest(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken):
		Promise<vscode.InlineCompletionItem[]> {
		const indent = document.lineAt(position.line).text;
		const root = this.root();
		if (!root || document.uri.scheme !== 'file' || !/^\t?$/.test(indent)) {
			return [];
		}
		const { own, types } = this.types(document);
		const method = own.methods.find((candidate) => candidate.line < position.line && position.line <= candidate.endLine);
		if (!method || !pendingTests(method)) {
			return [];
		}
		const passing = await this.passing(root, document, method, implementationCandidates(method, own, types));
		return token.isCancellationRequested ? [] : passing.map((body) =>
			new vscode.InlineCompletionItem(`\t${body}`, new vscode.Range(position.line, 0, position.line, indent.length)));
	}

	/** Bodies passing all tests of method, cached while the rest of the file stays the same. */
	private passing(root: string, document: vscode.TextDocument, method: StrictMethod, bodies: string[]): Promise<string[]> {
		const source = document.getText();
		const key = `${withImplementation(source, method, '')}\n${bodies.join('\n')}`;
		if (!this.runs.has(key)) {
			const run = passingBodies(root, document.fileName, source, method, bodies);
			run.catch(() => this.runs.delete(key));
			this.runs.set(key, run);
			if (this.runs.size > cachedRuns) {
				this.runs.delete(this.runs.keys().next().value!);
			}
		}
		return this.runs.get(key)!;
	}

	private scheduleCheck(document: vscode.TextDocument): void {
		const key = document.uri.toString();
		if (document.languageId === 'strict' && document.uri.scheme === 'file') {
			clearTimeout(this.timers.get(key));
			this.timers.set(key, setTimeout(() => void this.check(document), checkDelayMs));
		}
	}

	/** Reports methods an existing method passes all tests of, or that copy one, verified like the suggestions. */
	private async check(document: vscode.TextDocument): Promise<void> {
		const root = this.root();
		const version = document.version;
		if (!root || document.isClosed) {
			return;
		}
		const { own, types } = this.types(document);
		const diagnostics: vscode.Diagnostic[] = [];
		for (const method of own.methods.filter((candidate) => isNamed(candidate.name) && candidate.name !== 'Run' &&
			candidate.implementation.length > 0 && !pendingTests(candidate))) {
			const calls = method.tests.length > 0 ? existingCalls(method, own, types) : [];
			const passing = calls.length > 0 ? await this.passing(root, document, method, calls.map((existing) => existing.call!)) : [];
			const verified = calls.find((existing) => passing.includes(existing.call!));
			const copy = verified ?? copiedFrom(method, own, types);
			const tests = method.tests.length === 1 ? 'the test' : `all ${method.tests.length} tests`;
			if (copy) {
				diagnostics.push(existingDiagnostic(method, copy.owner, copy.method, verified
					? `\`${verified.call}\` passes ${tests} of ${method.name}, use it instead`
					: `${method.name} copies it, use it instead`));
			}
		}
		if (document.version === version && !document.isClosed) {
			this.existing.set(document.uri, diagnostics);
		}
	}
}

function existingDiagnostic(method: StrictMethod, owner: StrictType, existing: StrictMethod, detail: string): vscode.Diagnostic {
	const diagnostic = new vscode.Diagnostic(new vscode.Range(method.line, 0, method.line, method.header.length),
		`${owner.name}.${existing.name} already exists: ${detail}`, vscode.DiagnosticSeverity.Error);
	diagnostic.code = alreadyExists;
	diagnostic.source = 'strict';
	diagnostic.relatedInformation = [new vscode.DiagnosticRelatedInformation(location(owner.file, existing.line),
		`${owner.name}.${existing.header}`)];
	return diagnostic;
}

function symbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
	const type = parseType(document.fileName, document.getText());
	const lineRange = (line: number, endLine = line) => new vscode.Range(line, 0, endLine, document.lineAt(endLine).text.length);
	return [
		...type.members.map((member) => new vscode.DocumentSymbol(member.name, member.type, member.text.startsWith('constant ')
			? vscode.SymbolKind.Constant : vscode.SymbolKind.Field, lineRange(member.line), lineRange(member.line))),
		...type.methods.map((method) => new vscode.DocumentSymbol(method.name, method.header.slice(method.name.length).trim(),
			vscode.SymbolKind.Method, lineRange(method.line, method.endLine), lineRange(method.line)))
	];
}

function constructors(type: StrictType): StrictMethod[] {
	const from = type.methods.filter((method) => method.name === 'from');
	const members = type.members.filter((member) => !member.text.startsWith('constant '));
	return from.length > 0 ? from.map((method) => ({ ...method, header: type.name + method.header.slice(4) })) : [{
		name: type.name, header: `${type.name}(${members.map((member) => member.name).join(', ')})`, line: 0, endLine: 0,
		parameters: members.map((member) => ({ name: member.name, type: member.type, optional: false })), returns: type.name,
		tests: [], implementation: []
	}];
}

function unique<T extends { name: string }>(entries: T[]): T[] {
	const names = new Set<string>();
	return entries.filter((entry) => !names.has(entry.name) && names.add(entry.name));
}

function item(label: string, kind: vscode.CompletionItemKind, detail: string, sort: string): vscode.CompletionItem {
	const completion = new vscode.CompletionItem(label, kind);
	completion.detail = detail;
	completion.sortText = sort + label;
	return completion;
}

function entryItem(entry: Entry, isType = false): vscode.CompletionItem {
	const isConstant = entry.member?.text.startsWith('constant ');
	const completion = item(entry.name, entry.method ? vscode.CompletionItemKind.Method : isConstant
		? vscode.CompletionItemKind.Constant : vscode.CompletionItemKind.Field, `${entry.owner.name}.${entry.method?.header ??
		entry.member!.text.replace(/^\w+ /, '')}`, isType && isConstant ? '0' : '1');
	const required = entry.method?.parameters.filter((parameter) => !parameter.optional) ?? [];
	if (required.length > 0) {
		completion.insertText = new vscode.SnippetString(`${entry.name}(${required.map((parameter, index) =>
			`\${${index + 1}:${parameter.name}}`).join(', ')})`);
		completion.command = { command: 'editor.action.triggerParameterHints', title: 'Parameters' };
	}
	completion.documentation = appendEntry(new vscode.MarkdownString(), entry);
	return completion;
}

function anyMethodItems(types: StrictType[]): vscode.CompletionItem[] {
	const owners = new Map<string, Entry[]>();
	for (const entry of types.flatMap((type) => membersOf({ type }, []).filter((candidate) => candidate.method))) {
		owners.set(entry.name, [...owners.get(entry.name) ?? [], entry]);
	}
	return [...owners.values()].map((entries) => {
		const completion = entryItem(entries[0]);
		completion.detail = entries.map((entry) => entry.owner.name).join(', ');
		return completion;
	});
}

function appendEntry(markdown: vscode.MarkdownString, entry: Entry): vscode.MarkdownString {
	markdown.appendCodeblock(entry.method ? [entry.method.header, ...entry.method.tests.map((test) => `\t${test}`)].join('\n')
		: entry.member!.text, 'strict');
	return markdown.appendMarkdown(link(entry.owner.file, entry.method?.line ?? entry.member!.line));
}

function testsMarkdown(method: StrictMethod): vscode.MarkdownString | undefined {
	return method.tests.length > 0 ? new vscode.MarkdownString().appendCodeblock(method.tests.join('\n'), 'strict') : undefined;
}

function link(file: string, line: number): string {
	return `[${path.basename(file)}:${line + 1}](${vscode.Uri.file(file).with({ fragment: `L${line + 1}` })})\n\n`;
}

function location(file: string, line: number): vscode.Location {
	return new vscode.Location(vscode.Uri.file(file), new vscode.Position(line, 0));
}

function relativeFile(file: string, root: string | undefined): string {
	const relative = root ? path.relative(root, file) : file;
	return relative.startsWith('..') ? file : relative.replace(/\\/g, '/');
}
