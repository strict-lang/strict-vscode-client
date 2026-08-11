"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const assert = __importStar(require("assert"));
const vscode = __importStar(require("vscode"));
const paths_1 = require("../../paths");
suite('Extension Test Suite', () => {
    test('extension contributes strict language', async () => {
        const extension = vscode.extensions.getExtension('strict-lang.strict-language');
        assert.ok(extension, 'strict-lang.strict-language extension should be present');
        await extension.activate();
        const languages = await vscode.languages.getLanguages();
        assert.ok(languages.includes('strict'));
    });
    test('pipe name matches language server', () => {
        assert.strictEqual(paths_1.languageServerPipeName, 'Strict.LanguageServer');
    });
    test('run file args keep cli launch prefix', () => {
        const result = (0, paths_1.buildRunFileArgs)({ command: 'dotnet', args: ['C:\\Strict.dll'], displayName: 'Strict.dll' }, 'C:\\code\\Sum.strict');
        assert.deepStrictEqual(result.args, ['C:\\Strict.dll', 'C:\\code\\Sum.strict']);
    });
    test('language server resolver returns undefined for empty roots', () => {
        const launch = (0, paths_1.resolveLanguageServerLaunch)({
            workspaceFolders: [],
            pathEnv: ''
        });
        assert.strictEqual(launch, undefined);
    });
});
//# sourceMappingURL=extension.test.js.map