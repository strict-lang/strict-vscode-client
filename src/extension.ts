import { connect } from "net";
import { ExtensionContext } from "vscode";

import {
  LanguageClient,
  StreamInfo,
  CancellationStrategy,
} from "vscode-languageclient/node";

let client: LanguageClient;

export function activate() {
  const connectFunc = () => {
    return new Promise<StreamInfo>((resolve, reject) => {
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