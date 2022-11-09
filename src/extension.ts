import { connect } from "net";
import * as vscode from 'vscode';
import { window as Window } from 'vscode';


import {
  LanguageClient,
  StreamInfo,
  CancellationStrategy
} from "vscode-languageclient/node";

let client: LanguageClient;

export function activate(context: vscode.ExtensionContext) {
  const connectFunc = () => {
    return new Promise<StreamInfo>((resolve) => {
      function tryConnect() {
        const socket = connect(`\\\\.\\pipe\\Strict.LanguageServer`);
        socket.on("connect", () => {
          resolve({ writer: socket, reader: socket });
        });
        socket.on("error", (e) => {
          setTimeout(tryConnect, 5000);
        });
      }
      tryConnect();
    });
  };

  client = new LanguageClient("strict", connectFunc, {
    documentSelector: [
      {
        language: "strict",
      },
      {
        pattern: "**/*.strict",
      },
    ],
    progressOnInitialization: true,
    connectionOptions: {
      maxRestartCount: 10,
      cancellationStrategy: CancellationStrategy.Message,
    },
    middleware: {
      executeCommand: async (command, args, next) => {
        const choices: string[] = [];
        const quickPick = Window.createQuickPick();
        quickPick.title = 'Enter methodcall :';
        quickPick.items = choices.map(choice => ({ label: choice }));
        quickPick.onDidChangeValue(() => {
          if (!choices.includes(quickPick.value)) { 
            quickPick.items = [quickPick.value, ...choices].map(label => ({ label })); 
          }
        });

        quickPick.onDidAccept(() => {
          const selection = quickPick.activeItems[0];
          args = args.slice(0);
          args.push(selection);
          args.push(Window.activeTextEditor?.document.uri.fsPath);
          quickPick.hide();
          return next(command, args);
        });
        quickPick.show();
      }
    }
  });
  client.registerProposedFeatures();
  client.start();

}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}