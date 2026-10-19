import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { StrictLanguage } from './language';
import {
	callers, calls, Hit, implementationsOf, nameError, references, renameEdits, Source, Target, targetAt, typeAt
} from './navigationModel';
import { normalizeFsPath, strictDocumentSelector } from './paths';
import { typeNameFromPath } from './scrunchDiscover';
import { keywords, StrictMethod } from './strictIndex';

/** Find All References, Rename, Go to Type Definition, Go to Implementation and Call Hierarchy over the index of language. */
export function registerNavigation(language: StrictLanguage): vscode.Disposable[] {
	const at = (document: vscode.TextDocument, position: vscode.Position) =>
		targetAt(sourceOf(document), language.allTypes(), position.line, position.character);
	return [
		vscode.languages.registerReferenceProvider(strictDocumentSelector, {
			provideReferences: (document, position) => {
				const target = document.uri.scheme === 'file' ? at(document, position) : undefined;
				return target ? references(target, sources(language), language.allTypes()).map((hit) =>
					new vscode.Location(vscode.Uri.file(hit.file), range(hit))) : [];
			}
		}),
		vscode.languages.registerRenameProvider(strictDocumentSelector, {
			prepareRename: (document, position) => {
				const target = renamable(language, document, at(document, position));
				const start = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/)!.start;
				return { range: new vscode.Range(start, start.translate(0, target.name.length)), placeholder: target.name };
			},
			provideRenameEdits: (document, position, name) => {
				const target = renamable(language, document, at(document, position));
				const types = language.allTypes();
				const error = nameError(target, name, types);
				if (error) {
					throw new Error(error);
				}
				const edit = new vscode.WorkspaceEdit();
				// Type names lack package identity; exclude external files to avoid renaming unrelated types.
				const changes = renameEdits(target, name, references(target, sources(language), types)).filter((change) =>
					editable(change.file, document));
				for (const change of changes) {
					edit.replace(vscode.Uri.file(change.file), new vscode.Range(change.line, change.character, change.line,
						change.character + change.length), change.text);
				}
				if (target.isType) {
					const file = target.owner.file;
					edit.renameFile(vscode.Uri.file(file), vscode.Uri.file(path.join(path.dirname(file), `${name}.strict`)));
					edit.deleteFile(vscode.Uri.file(file.replace(/\.strict$/, '.strictbinary')), { ignoreIfNotExists: true });
				}
				return edit;
			}
		}),
		vscode.languages.registerTypeDefinitionProvider(strictDocumentSelector, {
			provideTypeDefinition: (document, position) => {
				const word = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
				const type = word && typeAt(sourceOf(document), language.allTypes(), position.line, word.end.character);
				return type && new vscode.Location(vscode.Uri.file(type.file), new vscode.Position(0, 0));
			}
		}),
		vscode.languages.registerImplementationProvider(strictDocumentSelector, {
			provideImplementation: (document, position) => {
				const target = at(document, position);
				return target ? implementationsOf(target, language.allTypes()).map((found) =>
					new vscode.Location(vscode.Uri.file(found.file), new vscode.Position(found.line, 0))) : [];
			}
		}),
		vscode.languages.registerCallHierarchyProvider(strictDocumentSelector, {
			prepareCallHierarchy: (document, position) => {
				const target = at(document, position);
				const method = target && !target.isType && !target.method
					? target.owner.methods.find((candidate) => candidate.name === target.name) : undefined;
				return method && callItem(target!.owner.file, method);
			},
			provideCallHierarchyIncomingCalls: (item) => {
				const source = read(item.uri.fsPath);
				const target = source && targetAt(source, language.allTypes(), item.selectionRange.start.line, 0);
				return target ? callers(references(target, sources(language), language.allTypes())).map((hits) =>
					new vscode.CallHierarchyIncomingCall(callItem(hits[0].file, hits[0].method, hits[0].isTest),
						hits.map(range))) : [];
			},
			provideCallHierarchyOutgoingCalls: (item) => {
				const source = read(item.uri.fsPath);
				return source ? calls(source, item.selectionRange.start.line, language.allTypes()).map((call) =>
					new vscode.CallHierarchyOutgoingCall(callItem(call.entry.owner.file, call.entry.method),
						call.hits.map(range))) : [];
			}
		})
	];
}

/** Target unless it is a keyword, an operator, a base type, member or method of Strict or outside the workspace. */
function renamable(language: StrictLanguage, document: vscode.TextDocument, target: Target | undefined): Target {
	if (!target || keywords.has(target.name) || document.uri.scheme !== 'file') {
		throw new Error('Only types, members, methods, parameters and locals of saved files can be renamed, not keywords, ' +
			'value, index or operators');
	}
	const root = language.root();
	if (!target.method && root && normalizeFsPath(path.dirname(target.owner.file)) === normalizeFsPath(root)) {
		throw new Error(`${target.owner.name} is a base type of Strict`);
	}
	if (!editable(target.owner.file, document)) {
		throw new Error(`Open the folder of ${target.owner.name} to rename in it`);
	}
	return target;
}

/** Files of the workspace and the document renamed in, a namesake elsewhere stays. */
function editable(file: string, document: vscode.TextDocument): boolean {
	return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file)) !== undefined ||
		normalizeFsPath(file) === normalizeFsPath(document.fileName);
}

function sourceOf(document: vscode.TextDocument): Source {
	return { file: document.fileName, text: document.getText() };
}

/** Text of file from its open document (not untitled ones or git revisions), else from disk. */
export function textOf(file: string): string | undefined {
	const open = vscode.workspace.textDocuments.find((document) => document.uri.scheme === 'file' &&
		normalizeFsPath(document.fileName) === normalizeFsPath(file));
	try {
		return open?.getText() ?? fs.readFileSync(file, 'utf8');
	} catch {
		return undefined;
	}
}

function read(file: string): Source | undefined {
	const text = textOf(file);
	return text === undefined ? undefined : { file, text };
}

// Reads indexed files per request; open documents use in-memory text.
function sources(language: StrictLanguage): Source[] {
	const files = [...language.allTypes().map((type) => type.file), ...vscode.workspace.textDocuments.filter((document) =>
		document.languageId === 'strict' && document.uri.scheme === 'file').map((document) => document.fileName)];
	return [...new Map(files.map((file) => [normalizeFsPath(file), file])).values()].flatMap((file) => read(file) ?? []);
}

function range(hit: Hit): vscode.Range {
	return new vscode.Range(hit.line, hit.character, hit.line, hit.character + hit.word.length);
}

/** A method (or the members of a type when there is none), its tests marked in the detail. */
function callItem(file: string, method?: StrictMethod, isTest = false): vscode.CallHierarchyItem {
	const line = method?.line ?? 0;
	const type = typeNameFromPath(file);
	const name = method?.name ?? type;
	return new vscode.CallHierarchyItem(method ? vscode.SymbolKind.Method : vscode.SymbolKind.Class, name,
		isTest ? `${type} tests` : type, vscode.Uri.file(file), new vscode.Range(line, 0, (method?.endLine ?? line) + 1, 0),
		new vscode.Range(line, 0, line, method ? name.length : 0));
}
