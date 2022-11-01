"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const net_1 = require("net");
const node_1 = require("vscode-languageclient/node");
let client;
function activate() {
    const connectFunc = () => {
        return new Promise((resolve, reject) => {
            function tryConnect() {
                const socket = (0, net_1.connect)(`\\\\.\\pipe\\Strict.LanguageServer`);
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
    client = new node_1.LanguageClient("strict", connectFunc, {
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
            cancellationStrategy: node_1.CancellationStrategy.Message,
        },
    });
    client.registerProposedFeatures();
    client.start();
}
exports.activate = activate;
function deactivate() {
    if (!client) {
        return undefined;
    }
    return client.stop();
}
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map