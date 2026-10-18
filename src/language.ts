import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerTypeFixes } from './codeActions';
import { Evaluator } from './evaluate';
import {
	implementationCandidates, passingBodies, pendingTests, sharedRun, SharedRun
} from './implementations';
import { registerInsight } from './insight';
import { calledMethods, expectedType, fits, typeText } from './insightModel';
import { registerNavigation } from './navigation';
import { compilerFile, normalizeFsPath, strictDocumentSelector } from './paths';
import { registerRefactorings } from './refactoringProviders';
import {
	callBefore, chainBefore, Entry, keywords, localOf, membersOf, parseType, resolve, Scope, scopeAt,
	strictFiles, StrictMethod, StrictParameter, StrictType, typeNamed
} from './strictIndex';

const rescanMs = 30000;
const cachedRuns = 100;
type Found = { entries: Entry[]; type?: StrictType; line?: number; text?: string };

/** Completion, hover, go to definition, signature help and symbols from the parsed .strict files of the workspace and of
 * the Strict folder; selected unfinished methods get suggestions, `strict check` reports duplicate bodies. */
export class StrictLanguage implements vscode.Disposable {
	private readonly parsed = new Map<string, { modified: number; type: StrictType }>();
	private readonly runs = new Map<string, SharedRun>();
	private readonly disposables: vscode.Disposable[];
	private all: StrictType[] = [];
	private scanned = 0;

	constructor(public readonly root: () => string | undefined, private readonly project: (file: string) => string) {
		const watcher = vscode.workspace.createFileSystemWatcher('**/*.strict');
		const rescan = () => this.scanned = 0;
		this.disposables = [watcher, watcher.onDidCreate(rescan), watcher.onDidChange(rescan), watcher.onDidDelete(rescan),
			vscode.languages.registerCompletionItemProvider(strictDocumentSelector, { provideCompletionItems: (document, position,
				_token, context) => this.complete(document, position, context.triggerCharacter) }, '.', ' '),
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
			new Evaluator(root, project, (document, line) => this.scope(document, line)),
			...registerNavigation(this),
			...registerInsight((document) => this.types(document), this.root),
			registerTypeFixes((document) => this.types(document)),
			...registerRefactorings(root, project, (document, line) => this.scope(document, line))
		];
	}

	public dispose(): void {
		this.disposables.forEach((disposable) => disposable.dispose());
	}

	// ponytail: synchronous walk of the workspace and Strict folders, slow for huge workspaces; upgrade: workspace.findFiles
	public allTypes(): StrictType[] {
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

	private scope(document: vscode.TextDocument, line: number, withLine = false): Scope {
		const { own, types } = this.types(document);
		return scopeAt(types, own, document.getText().split(/\r?\n/), line, withLine);
	}

	/** Items of the expected type come first, `has ` completes member names on the space. */
	private complete(document: vscode.TextDocument, position: vscode.Position, trigger?: string): vscode.CompletionItem[] {
		const before = document.lineAt(position.line).text.slice(0, position.character).replace(/\w*$/, '');
		if (trigger === ' ' && before !== 'has ') {
			return [];
		}
		const scope = this.scope(document, position.line);
		const expected = expectedType(before, scope, position.line);
		if (before.endsWith('.')) {
			const chain = chainBefore(before.slice(0, -1));
			const receiver = resolve(chain, scope);
			return receiver ? ranked(unique(membersOf(receiver, scope.types)).map((entry) => entryItem(entry, receiver.isType)),
				`${chain}.`, expected, scope) : anyMethodItems(scope.types);
		}
		const root = this.root();
		const typeItems = unique(scope.types.map((type) => ({ owner: type, name: type.name }))).map((entry) => {
			const completion = item(entry.name, vscode.CompletionItemKind.Class, relativeFile(entry.owner.file, root), '2');
			completion.documentation = appendType(new vscode.MarkdownString(), entry.owner);
			return completion;
		});
		if (before === 'has ') {
			return unique(scope.types.map((type) => ({ owner: type, name: type.name[0].toLowerCase() + type.name.slice(1) })))
				.map((entry) => item(entry.name, vscode.CompletionItemKind.Field, `has ${entry.name} (${entry.owner.name})`, '1'));
		}
		if (!/^\s/.test(before)) {
			const keywordItems = ['has', 'constant', 'mutable'].map((name) => item(name, vscode.CompletionItemKind.Keyword, '', '0'));
			// a method named like a type hides it: Fibonacci(5).Fibonacci calls the method instead of creating a Fibonacci
			return before === '' ? [...keywordItems, item('Get', vscode.CompletionItemKind.Method, 'Get ReturnType', '1')]
				: [...keywordItems, ...typeItems];
		}
		const ownMembers = membersOf({ type: scope.own }, scope.types).filter((entry) => entry.owner === scope.own);
		return ranked([
			...(scope.method?.parameters ?? []).map((parameter) =>
				item(parameter.name, vscode.CompletionItemKind.Variable, `${parameter.name} ${parameter.type}`, '0')),
			...[...scope.locals.keys()].map((name) => item(name, vscode.CompletionItemKind.Variable, 'local', '0')),
			...ownMembers.map((entry) => entryItem(entry)),
			...['value', 'index', 'true', 'false', ...keywords].map((name) => item(name, vscode.CompletionItemKind.Keyword, '', '3')),
			...typeItems
		], '', expected, scope);
	}

	private find(document: vscode.TextDocument, position: vscode.Position): (Found & { range: vscode.Range }) | undefined {
		const range = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
		if (!range) {
			return undefined;
		}
		const word = document.getText(range);
		const scope = this.scope(document, position.line, true);
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
		if (!parameter && !local && scope.method && (word === 'value' || word === 'index')) {
			const type = resolve(word, scope);
			return type && { range, entries: [], text: `${word} ${typeText(type)}` };
		}
		const type = local && resolve(word, scope);
		const lines = document.getText().split(/\r?\n/);
		const localLine = local && scope.method ? lines.findIndex((text, index) => index > scope.method!.line &&
			localOf(text)?.name === word) : -1;
		if (parameter || local) {
			return { range, entries: [], line: parameter ? scope.method!.line : localLine, text: parameter ? `${word} ${parameter.type}`
				: `${word}${type ? ` ${typeText(type)}` : ''} ${local!.keyword === 'for' ? 'in' : '='} ${local!.expression}` };
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
			appendType(markdown, found.type);
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
		const methods = calledMethods(call.callee, this.scope(document, position.line), true).slice(0, 10);
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
		if (!root || document.uri.scheme !== 'file' || !/^\t?$/.test(indent) || !isEnabled('suggestImplementations')) {
			return [];
		}
		const { own, types } = this.types(document);
		const method = own.methods.find((candidate) => candidate.line < position.line && position.line <= candidate.endLine);
		if (!method || !pendingTests(method)) {
			return [];
		}
		const passing = await this.passing(root, document, method, implementationCandidates(method, own, types), token);
		return token.isCancellationRequested ? [] : passing.map((body) =>
			new vscode.InlineCompletionItem(`\t${body}`, new vscode.Range(position.line, 0, position.line, indent.length)));
	}

	/** Bodies passing all tests of method, cached while the rest of the file stays the same, see sharedRun. */
	private passing(root: string, document: vscode.TextDocument, method: StrictMethod, bodies: string[],
		token?: vscode.CancellationToken): Promise<string[]> {
		const source = document.getText();
		const compiler = path.join(root, compilerFile);
		const key = `${compiler}:${fs.statSync(compiler).mtimeMs}:${document.fileName}:${method.line}:${source}:${bodies.join('\n')}`;
		const passing = sharedRun(this.runs, key, () => token?.isCancellationRequested === true,
			(isCancelled) => passingBodies(root, this.project(document.fileName), document.fileName, source, method, bodies,
				isCancelled));
		if (this.runs.size > cachedRuns) {
			this.runs.delete(this.runs.keys().next().value!);
		}
		return passing;
	}

}

function isEnabled(setting: 'suggestImplementations'): boolean {
	return vscode.workspace.getConfiguration('strict').get<boolean>(setting, true);
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
	completion.documentation = appendEntry(new vscode.MarkdownString(), entry);
	return withArguments(completion, entry.name, entry.method?.parameters ?? []);
}

/** Inserts `name(${1:first}, ...)` with the required parameters and shows their signature. */
function withArguments(completion: vscode.CompletionItem, name: string, parameters: StrictParameter[]): vscode.CompletionItem {
	const required = parameters.filter((parameter) => !parameter.optional);
	if (required.length > 0) {
		completion.insertText = new vscode.SnippetString(`${name}(${required.map((parameter, index) =>
			`\${${index + 1}:${parameter.name}}`).join(', ')})`);
		completion.command = { command: 'editor.action.triggerParameterHints', title: 'Parameters' };
	}
	return completion;
}

function ranked(items: vscode.CompletionItem[], prefix: string, expected: string | undefined, scope: Scope):
	vscode.CompletionItem[] {
	items.filter((completion) => fits(`${prefix}${completion.label}`, expected, scope)).forEach((completion) =>
		completion.sortText = `!${completion.sortText}`);
	return items;
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

function appendType(markdown: vscode.MarkdownString, type: StrictType): vscode.MarkdownString {
	markdown.appendCodeblock([...type.members.map((member) => member.text), ...type.methods.map((method) => method.header)]
		.join('\n'), 'strict');
	return markdown.appendMarkdown(link(type.file, 0));
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
