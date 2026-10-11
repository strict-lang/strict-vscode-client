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
exports.activate = activate;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const codeActions_1 = require("./codeActions");
const decorations_1 = require("./decorations");
const diagnostics_1 = require("./diagnostics");
const nativeCompiler_1 = require("./nativeCompiler");
const paths_1 = require("./paths");
const scrunchCache_1 = require("./scrunchCache");
const scrunchDiscover_1 = require("./scrunchDiscover");
const scrunch_1 = require("./scrunch");
const notFound = `Strict not found: build ${paths_1.compilerFile} in the Strict repository next to this extension or set strict.root`;
const parallelRuns = Math.max(1, os.cpus().length - 1);
let output;
let extensionPath;
function activate(context) {
    output = vscode.window.createOutputChannel('Strict');
    extensionPath = context.extensionPath;
    const decorations = new decorations_1.DecorationController(context.extensionPath);
    (0, decorations_1.registerDecorationLifecycle)(context, decorations);
    const tester = new NativeTester((result) => scrunch.applyResult(result));
    const scrunch = (0, scrunch_1.registerScrunch)(decorations, tester);
    if (!strictRoot()) {
        output.appendLine(notFound);
        void vscode.window.showWarningMessage(notFound);
    }
    context.subscriptions.push(output, tester, scrunch, new diagnostics_1.DiagnosticHighlighter(), (0, codeActions_1.registerCodeActionProvider)(), vscode.window.registerFileDecorationProvider({
        provideFileDecoration: (uri) => (0, scrunchCache_1.isStrictBinaryPath)(uri.fsPath)
            ? { color: new vscode.ThemeColor('gitDecoration.ignoredResourceForeground'), tooltip: 'Cached compiled bytecode' }
            : undefined
    }), vscode.tasks.registerTaskProvider('strict', {
        provideTasks: () => [],
        resolveTask: (task) => runTask(task.definition, task.scope)
    }), vscode.commands.registerCommand('strict-vscode-client.runFile', () => runCurrentFile([])), vscode.commands.registerCommand('strict-vscode-client.run', async () => {
        const text = await vscode.window.showInputBox({ prompt: 'Arguments passed to Run', placeHolder: 'e.g. 5 10' });
        if (text !== undefined) {
            await runCurrentFile(text.split(/\s+/).filter(Boolean));
        }
    }), vscode.commands.registerCommand('strict-vscode-client.scrunch.focus', () => scrunch.showInTesting()), vscode.commands.registerCommand('strict-vscode-client.scrunch.showLineTests', () => scrunch.showLineTests()), vscode.commands.registerCommand(decorations_1.showResultCommand, (uri, lineNumber) => scrunch.showResult(uri, lineNumber)), vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('strict')) {
            void scrunch.discoverWorkspace();
        }
    }));
}
function strictRoot() {
    return (0, paths_1.findStrictRoot)(vscode.workspace.getConfiguration('strict').get('root'), vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [], extensionPath);
}
async function runCurrentFile(args) {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || document.languageId !== 'strict') {
        void vscode.window.showErrorMessage('Open a .strict file to run.');
        return;
    }
    if (document.isDirty && !(await document.save())) {
        return;
    }
    const task = runTask({ type: 'strict', file: document.uri.fsPath, args }, vscode.workspace.getWorkspaceFolder(document.uri));
    if (task) {
        await vscode.tasks.executeTask(task);
    }
}
/** `strict` task, also usable in tasks.json: { "type": "strict", "file": "Examples/FizzBuzz.strict", "args": [] } */
function runTask(definition, scope) {
    const root = strictRoot();
    if (!root) {
        void vscode.window.showErrorMessage(notFound);
        return undefined;
    }
    const folder = typeof scope === 'object' ? scope.uri.fsPath : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const file = path.resolve(folder ?? root, String(definition.file));
    return new vscode.Task(definition, scope ?? vscode.TaskScope.Workspace, `Run ${path.basename(file, '.strict')}`, 'Strict', new vscode.ProcessExecution(path.join(root, paths_1.compilerFile), ['run', path.relative(root, file), '.', ...(definition.args ?? [])], { cwd: root }));
}
/** Runs inline tests (`run test`) and validators (`check`) with the newest NativeCompiler, several processes at once. */
class NativeTester {
    constructor(report) {
        this.report = report;
        this.checks = vscode.languages.createDiagnosticCollection('strict');
        this.crashes = vscode.languages.createDiagnosticCollection('strict tests');
        this.files = new Set();
        this.queue = new Set();
        this.running = 0;
        this.usedRoot = '';
    }
    dispose() {
        this.checks.dispose();
        this.crashes.dispose();
    }
    testAll(files) {
        files.forEach((file) => this.files.add(file));
        this.enqueue([...new Set(files.map((file) => path.dirname(file))), ...files]);
    }
    changed(file) {
        this.files.add(file);
        const sources = new Map([...this.files].map((known) => [known, readText(known)]));
        this.enqueue([file, path.dirname(file), ...(0, nativeCompiler_1.dependents)(file, sources)], true);
    }
    deleted(file) {
        this.files.delete(file);
        this.checks.delete(vscode.Uri.file(file));
        this.crashes.delete(vscode.Uri.file(file));
    }
    async run(uri, methodName) {
        const root = strictRoot();
        if (!root || methodName !== 'Run') {
            throw new Error(root ? 'NativeCompiler only runs Run methods' : notFound);
        }
        const result = await (0, nativeCompiler_1.runStrict)(root, ['run', path.relative(root, uri.fsPath), '.']);
        const method = (0, scrunchDiscover_1.discoverStrictTests)(readText(uri.fsPath)).find((item) => item.name === methodName);
        this.report({
            lineNumber: method?.lineNumber ?? 0, state: result.exitCode === 0 ? 1 : 0, uri: uri.toString(), methodName,
            consoleOutput: result.output, durationMs: result.durationMs,
            message: result.exitCode === 0 ? undefined : `Exit code ${result.exitCode}`
        });
    }
    enqueue(entries, first = false) {
        const waiting = first ? [...this.queue] : [];
        if (first) {
            this.queue.clear();
        }
        for (const entry of [...entries, ...waiting]) {
            this.queue.add(entry);
        }
        this.next();
    }
    next() {
        const root = strictRoot();
        if (root && root !== this.usedRoot) {
            this.usedRoot = root;
            output.appendLine(`Using ${path.join(root, paths_1.compilerFile)}`);
        }
        while (root && this.running < parallelRuns && this.queue.size > 0) {
            const entry = this.queue.values().next().value;
            this.queue.delete(entry);
            this.running++;
            void (entry.endsWith('.strict') ? this.test(root, entry) : this.check(root, entry)).finally(() => {
                this.running--;
                this.next();
            });
        }
    }
    async test(root, file) {
        const result = await (0, nativeCompiler_1.runStrict)(root, ['run', 'test', path.relative(root, file), '.']);
        if (!this.files.has(file)) {
            return;
        }
        const uri = vscode.Uri.file(file);
        const source = readText(file);
        const crash = (0, nativeCompiler_1.crashText)(result);
        this.crashes.set(uri, crash ? [new vscode.Diagnostic(lineRange(source, 0), crash, vscode.DiagnosticSeverity.Error)] : []);
        if (crash) {
            output.appendLine(`${file}: ${crash}`);
        }
        for (const notification of (0, nativeCompiler_1.testResults)(source, uri.toString(), result)) {
            this.report(notification);
        }
    }
    async check(root, folder) {
        const relative = path.relative(root, folder);
        const result = await (0, nativeCompiler_1.runStrict)(root, ['check', relative.startsWith('..') || path.isAbsolute(relative) ? folder : relative || '.', '.']);
        if (!/^Validation issues: \d+$/m.test(result.output)) {
            output.appendLine(`Checking ${folder} failed with exit code ${result.exitCode}\n${result.output}`);
            return;
        }
        const issues = (0, nativeCompiler_1.checkIssues)(result.output, root);
        const files = new Map([...this.files].filter((file) => (0, paths_1.normalizeFsPath)(path.dirname(file)) === (0, paths_1.normalizeFsPath)(folder)).
            concat(issues.map((issue) => issue.file)).map((file) => [(0, paths_1.normalizeFsPath)(file), file]));
        for (const [key, file] of files) {
            const source = readText(file);
            this.checks.set(vscode.Uri.file(file), issues.filter((issue) => (0, paths_1.normalizeFsPath)(issue.file) === key).map((issue) => {
                const diagnostic = new vscode.Diagnostic(lineRange(source, (0, nativeCompiler_1.issueLine)(source, issue.target)), issue.message ? `${issue.target}: ${issue.message}` : issue.target, vscode.DiagnosticSeverity.Error);
                diagnostic.code = issue.rule;
                return (0, diagnostics_1.polishDiagnostic)(diagnostic, vscode.Uri.file(file));
            }));
        }
    }
}
function readText(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    }
    catch {
        return '';
    }
}
function lineRange(source, line) {
    return new vscode.Range(line, 0, line, source.split(/\r?\n/)[line]?.length ?? 0);
}
//# sourceMappingURL=extension.js.map