import * as vscode from 'vscode';
import { runMethods } from './tasks';

/** Run, Run with Arguments… and Build Native above each Run method without tests, Run only when it needs no arguments. */
export function registerRunLenses(): vscode.Disposable {
	return vscode.languages.registerCodeLensProvider({ language: 'strict', scheme: 'file' }, {
		provideCodeLenses: (document) => runMethods(document.getText()).flatMap((method) => {
			const lens = (title: string, command: string) => new vscode.CodeLens(new vscode.Range(method.lineNumber, 0,
				method.lineNumber, 0), { title, command: `strict-vscode-client.${command}`, arguments: [document.uri] });
			return [...(method.runnable ? [lens('Run', 'runFile')] : []), lens('Run with Arguments…', 'run'),
				lens('Build Native', 'buildNative')];
		})
	});
}
