import { connect } from "net";
import path = require("path");
import { Range, Uri, window as Window, TextEditorDecorationType} from 'vscode';
import {
  LanguageClient,
  StreamInfo,
  CancellationStrategy,
  integer,
} from "vscode-languageclient/node";

let client: LanguageClient;
export function activate() {
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
  let green = Uri.parse('https://www.clipartmax.com/png/middle/1-14437_green-smiley-face-clip-art-thumbs-up-emoji-green.png'); //use actual icons
  let red = Uri.parse('https://www.clipartmax.com/png/small/438-4384778_emoji-anger-red-face.png'); //use actual icons
  let decorationTypes = new Map<integer, TextEditorDecorationType>();
  client.onNotification('testRunnerNotification', (testMessage: any) => {
    var image = testMessage.state === 0 ? red : green;
    var position = new Range(testMessage.lineNumber, 0, testMessage.lineNumber, 0);
    let decorationType = Window.createTextEditorDecorationType({
      gutterIconPath: image,
      gutterIconSize: 'contain'
    });
    const editor = Window.activeTextEditor;
    if (editor !== undefined) {
      var possibleDecoration = decorationTypes.get(testMessage.lineNumber);
      if (possibleDecoration === undefined) {
        decorationTypes.set(testMessage.lineNumber, decorationType);
        editor.setDecorations(decorationType, [{
          range: position
        }]);
      }
      else {
        editor.setDecorations(possibleDecoration, []);
        decorationTypes.delete(testMessage.lineNumber);
        editor.setDecorations(decorationType, [{ range: position }]);
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