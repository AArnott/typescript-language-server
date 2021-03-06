/*
 * Copyright (C) 2017, 2018 TypeFox and others.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as lsp from 'vscode-languageserver';
import * as tsp from 'typescript/lib/protocol';
import * as fs from 'fs-extra';
import * as commandExists from 'command-exists';

import { CommandTypes, EventTypes } from './tsp-command-types';

import { Logger, PrefixingLogger } from './logger';
import { TspClient } from './tsp-client';

import { LspClient } from './lsp-client';
import { DiagnosticEventQueue } from './diagnostic-queue';
import { findPathToModule } from './modules-resolver';
import {
    toDocumentHighlight, asRange, asTagsDocumentation,
    uriToPath, toSymbolKind, toLocation, toPosition,
    pathToUri, toTextEdit, toMarkDown, toTextDocumentEdit,
    toFileRangeRequestArgs
} from './protocol-translation';
import { getTsserverExecutable } from './utils';
import { LspDocument } from './document';
import { asCompletionItem, TSCompletionItem, asResolvedCompletionItem } from './completion';
import { asSignatureHelp } from './hover';
import { Commands } from './commands';
import { provideQuickFix } from './quickfix';
import { provideRefactors } from './refactor';
import { provideOrganizeImports } from './organize-imports';

export interface IServerOptions {
    logger: Logger
    tsserverPath?: string;
    tsserverLogFile?: string;
    tsserverLogVerbosity?: string;
    lspClient: LspClient;
}

export class LspServer {

    private initializeParams: lsp.InitializeParams;
    private initializeResult: lsp.InitializeResult;
    private tspClient: TspClient;
    private openedDocumentUris: Map<string, LspDocument> = new Map<string, LspDocument>();
    private diagnosticQueue: DiagnosticEventQueue;
    private logger: Logger;

    constructor(private options: IServerOptions) {
        this.logger = new PrefixingLogger(options.logger, '[lspserver]')
        this.diagnosticQueue = new DiagnosticEventQueue(
            diagnostics => this.options.lspClient.publishDiagnostics(diagnostics),
            this.logger);
    }

    closeAll(): void {
        for (const [uri, doc] of this.openedDocumentUris) {
            this.didCloseTextDocument({
                textDocument: {
                    uri,
                    languageId: doc.languageId,
                    version: doc.version,
                    text: doc.getText()
                }
            });
        }
    }

    protected findTsserverPath(): string {
        if (this.options.tsserverPath) {
            return this.options.tsserverPath;
        }
        // 1) look into node_modules of workspace root
        let executable = findPathToModule(this.rootPath(), `.bin/${getTsserverExecutable()}`)
        if (executable) {
            return executable;
        }
        // 2) use globally installed tsserver
        if (commandExists.sync(getTsserverExecutable())) {
            return getTsserverExecutable();
        }
        // 3) look into node_modules of typescript-language-server
        const bundled = findPathToModule(__dirname, `.bin/${getTsserverExecutable()}`);
        if (!bundled) {
            throw Error(`Couldn't find '${getTsserverExecutable()}' executable`)
        }
        return bundled;
    }

    async initialize(params: lsp.InitializeParams): Promise<lsp.InitializeResult> {
        this.logger.log('initialize', params);
        this.initializeParams = params;

        const tsserverPath = this.findTsserverPath();
        this.tspClient = new TspClient({
            tsserverPath,
            logFile: this.options.tsserverLogFile,
            logVerbosity: this.options.tsserverLogVerbosity,
            logger: this.options.logger,
            onEvent: this.onTsEvent.bind(this)
        });

        this.tspClient.start();
        this.tspClient.request(CommandTypes.Configure, {
            preferences: {
                allowTextChangesInNewFiles: true
            }
        });

        this.initializeResult = {
            capabilities: {
                textDocumentSync: lsp.TextDocumentSyncKind.Incremental,
                completionProvider: {
                    triggerCharacters: ['.', '"', '\'', '/', '@', '<'],
                    resolveProvider: true
                },
                codeActionProvider: true,
                definitionProvider: true,
                documentFormattingProvider: true,
                documentHighlightProvider: true,
                documentSymbolProvider: true,
                executeCommandProvider: {
                    commands: [
                        Commands.APPLY_WORKSPACE_EDIT,
                        Commands.APPLY_CODE_ACTION,
                        Commands.APPLY_REFACTORING,
                        Commands.ORGANIZE_IMPORTS
                    ]
                },
                hoverProvider: true,
                renameProvider: true,
                referencesProvider: true,
                signatureHelpProvider: {
                    triggerCharacters: ['(', ',', '<']
                },
                workspaceSymbolProvider: true,
                implementationProvider: true,
                typeDefinitionProvider: true,
                foldingRangeProvider: true
            }
        };

        this.logger.log('onInitialize result', this.initializeResult);
        return this.initializeResult;
    }

    protected diagnosticsTokenSource: lsp.CancellationTokenSource | undefined;
    protected interuptDiagnostics<R>(f: () => R): R {
        if (!this.diagnosticsTokenSource) {
            return f();
        }
        this.cancelDiagnostics();
        const result = f();
        this.requestDiagnostics();
        return result;
    }
    async requestDiagnostics(): Promise<tsp.RequestCompletedEvent> {
        this.cancelDiagnostics();
        const geterrTokenSource = new lsp.CancellationTokenSource();
        this.diagnosticsTokenSource = geterrTokenSource;

        const files: string[] = []
        // sort by least recently usage
        const orderedUris = [...this.openedDocumentUris.entries()].sort((a, b) => a[1].lastAccessed - b[1].lastAccessed).map(e => e[0]);
        for (const uri of orderedUris) {
            files.push(uriToPath(uri)!);
        }
        const args: tsp.GeterrRequestArgs = {
            delay: 0,
            files: files
        };
        try {
            return await this.tspClient.request(CommandTypes.Geterr, args, this.diagnosticsTokenSource.token);
        } finally {
            if (this.diagnosticsTokenSource === geterrTokenSource) {
                this.diagnosticsTokenSource = undefined;
            }
        }
    }
    protected cancelDiagnostics(): void {
        if (this.diagnosticsTokenSource) {
            this.diagnosticsTokenSource.cancel();
            this.diagnosticsTokenSource = undefined;
        }
    }

    didOpenTextDocument(params: lsp.DidOpenTextDocumentParams): void {
        const file = uriToPath(params.textDocument.uri);
        this.logger.log('onDidOpenTextDocument', params, file);
        if (!file) {
            return;
        }
        if (this.openedDocumentUris.get(params.textDocument.uri) !== undefined) {
            this.logger.log(`Cannot open already opened doc '${params.textDocument.uri}'.`);
            this.didChangeTextDocument({
                textDocument: params.textDocument,
                contentChanges: [
                    {
                        text: params.textDocument.text
                    }
                ]
            })
        } else {
            this.tspClient.notify(CommandTypes.Open, {
                file,
                fileContent: params.textDocument.text,
                scriptKindName: this.getScriptKindName(params.textDocument.languageId),
                projectRootPath: this.rootPath()
            });
            this.openedDocumentUris.set(params.textDocument.uri, new LspDocument(params.textDocument));
            this.requestDiagnostics();
        }
    }

    protected getScriptKindName(languageId: string): tsp.ScriptKindName | undefined {
        switch (languageId) {
            case 'typescript': return 'TS';
            case 'typescriptreact': return 'TSX';
            case 'javascript': return 'JS';
            case 'javascriptreact': return 'JSX';
        }
        return undefined;
    }

    didCloseTextDocument(params: lsp.DidOpenTextDocumentParams): void {
        const file = uriToPath(params.textDocument.uri);
        this.logger.log('onDidCloseTextDocument', params, file);
        if (!file) {
            return;
        }
        this.tspClient.notify(CommandTypes.Close, { file });
        this.openedDocumentUris.delete(params.textDocument.uri)

        // We won't be updating diagnostics anymore for that file, so clear them
        // so we don't leave stale ones.
        this.options.lspClient.publishDiagnostics({
            uri: params.textDocument.uri,
            diagnostics: [],
        });
    }

    didChangeTextDocument(params: lsp.DidChangeTextDocumentParams): void {
        const file = uriToPath(params.textDocument.uri);
        this.logger.log('onDidChangeTextDocument', params, file);
        if (!file) {
            return;
        }

        const document = this.openedDocumentUris.get(params.textDocument.uri);
        if (!document) {
            this.logger.error("Received change on non-opened document " + params.textDocument.uri);
            throw new Error("Received change on non-opened document " + params.textDocument.uri);
        }
        document.markAccessed();

        for (const change of params.contentChanges) {
            let line, offset, endLine, endOffset = 0;
            if (!change.range) {
                line = 1;
                offset = 1;
                const endPos = document.positionAt(document.getText().length);
                endLine = endPos.line + 1;
                endOffset = endPos.character + 1;
            } else {
                line = change.range.start.line + 1;
                offset = change.range.start.character + 1;
                endLine = change.range.end.line + 1;
                endOffset = change.range.end.character + 1;
            }
            this.tspClient.notify(CommandTypes.Change, {
                file,
                line,
                offset,
                endLine,
                endOffset,
                insertString: change.text
            });
        }
        this.requestDiagnostics();
    }

    didSaveTextDocument(params: lsp.DidChangeTextDocumentParams): void {
        // do nothing
    }

    async definition(params: lsp.TextDocumentPositionParams): Promise<lsp.Definition> {
        // TODO: implement version checking and if semver.gte(version, 270) use `definitionAndBoundSpan` instead
        return this.getDefinition({
            type: 'definition',
            params
        });
    }

    async implementation(params: lsp.TextDocumentPositionParams): Promise<lsp.Definition> {
        return this.getDefinition({
            type: 'implementation',
            params
        });
    }

    async typeDefinition(params: lsp.TextDocumentPositionParams): Promise<lsp.Definition> {
        return this.getDefinition({
            type: 'typeDefinition',
            params
        });
    }

    protected async getDefinition({ type, params }: {
        type: 'definition' | 'implementation' | 'typeDefinition',
        params: lsp.TextDocumentPositionParams
    }): Promise<lsp.Definition> {
        const file = uriToPath(params.textDocument.uri);
        this.logger.log(type, params, file);
        if (!file) {
            return [];
        }

        const result = await this.tspClient.request(type as CommandTypes.Definition, {
            file,
            line: params.position.line + 1,
            offset: params.position.character + 1
        });
        return result.body ? result.body.map(fileSpan => toLocation(fileSpan)) : [];
    }

    async documentSymbol(params: lsp.TextDocumentPositionParams): Promise<lsp.SymbolInformation[]> {
        const file = uriToPath(params.textDocument.uri);
        this.logger.log('symbol', params, file);
        if (!file) {
            return [];
        }

        const response = await this.tspClient.request(CommandTypes.NavTree, {
            file
        });
        if (!response.body) {
            return [];
        }
        const result: lsp.SymbolInformation[] = [];
        const collectSymbol: (element: tsp.NavigationTree, parent: string | undefined, acceptor: (sym: lsp.SymbolInformation) => void) => void =
            (element, parent, acceptor) => {
                const start = element.spans[0];
                const end = element.spans[element.spans.length - 1];
                if (start && end) {
                    const symbol = lsp.SymbolInformation.create(
                        element.text,
                        toSymbolKind(element.kind),
                        { start: toPosition(start.start), end: toPosition(end.end) },
                        params.textDocument.uri,
                        parent
                    );
                    acceptor(symbol);
                }
                if (element.childItems) {
                    for (const child of element.childItems) {
                        collectSymbol(child, element.text, acceptor);
                    }
                }
            };
        collectSymbol(response.body, undefined, sym => result.push(sym));
        return result;
    }

    /*
     * implemented based on
     * https://github.com/Microsoft/vscode/blob/master/extensions/typescript-language-features/src/features/completions.ts
     */
    async completion(params: lsp.CompletionParams): Promise<TSCompletionItem[]> {
        const file = uriToPath(params.textDocument.uri);
        this.logger.log('completion', params, file);
        if (!file) {
            return [];
        }

        const document = this.openedDocumentUris.get(params.textDocument.uri);
        if (!document) {
            throw new Error("The document should be opened for completion, file: " + file);
        }

        const result = await this.interuptDiagnostics(() => this.tspClient.request(CommandTypes.Completions, {
            file,
            line: params.position.line + 1,
            offset: params.position.character + 1,
            includeExternalModuleExports: true,
            includeInsertTextCompletions: true
        }));
        const body = result.body || [];
        return body.map(entry => asCompletionItem(entry, file, params.position, document));
    }

    async completionResolve(item: TSCompletionItem): Promise<lsp.CompletionItem> {
        this.logger.log('completion/resolve', item);
        const { body } = await this.interuptDiagnostics(() => this.tspClient.request(CommandTypes.CompletionDetails, item.data));
        const details = body && body.length && body[0];
        if (!details) {
            return item;
        }
        return asResolvedCompletionItem(item, details);
    }

    async hover(params: lsp.TextDocumentPositionParams): Promise<lsp.Hover> {
        const file = uriToPath(params.textDocument.uri);
        this.logger.log('hover', params, file);
        if (!file) {
            return { contents: [] };
        }

        const result = await this.interuptDiagnostics(() => this.getQuickInfo(file, params.position));
        if (!result || !result.body) {
            return { contents: [] };
        }
        const range = asRange(result.body);
        const contents: lsp.MarkedString[] = [
            { language: 'typescript', value: result.body.displayString }
        ];
        const tags = asTagsDocumentation(result.body.tags);
        contents.push(result.body.documentation + (tags ? '\n\n' + tags : ''));
        return {
            contents,
            range
        }
    }
    protected async getQuickInfo(file: string, position: lsp.Position): Promise<tsp.QuickInfoResponse | undefined> {
        try {
            return await this.tspClient.request(CommandTypes.Quickinfo, {
                file,
                line: position.line + 1,
                offset: position.character + 1
            });
        } catch (err) {
            return undefined;
        }
    }

    async rename(params: lsp.RenameParams): Promise<lsp.WorkspaceEdit | undefined> {
        const file = uriToPath(params.textDocument.uri);
        this.logger.log('onRename', params, file);
        if (!file) {
            return undefined;
        }

        const result = await this.tspClient.request(CommandTypes.Rename, {
            file,
            line: params.position.line + 1,
            offset: params.position.character + 1
        });

        if (!result.body || !result.body.info.canRename || result.body.locs.length === 0) {
            return undefined;
        }
        const workspaceEdit = {
            changes: {}
        };
        result.body.locs
            .forEach((spanGroup) => {
                const uri = pathToUri(spanGroup.file),
                    textEdits = workspaceEdit.changes[uri] || (workspaceEdit.changes[uri] = []);

                spanGroup.locs.forEach((textSpan) => {
                    textEdits.push({
                        newText: params.newName,
                        range: {
                            start: toPosition(textSpan.start),
                            end: toPosition(textSpan.end)
                        }
                    });
                });
            });

        return workspaceEdit;
    }

    async references(params: lsp.TextDocumentPositionParams): Promise<lsp.Location[]> {
        const file = uriToPath(params.textDocument.uri);
        this.logger.log('onReferences', params, file);
        if (!file) {
            return [];
        }

        const result = await this.tspClient.request(CommandTypes.References, {
            file,
            line: params.position.line + 1,
            offset: params.position.character + 1
        });
        if (!result.body) {
            return [];
        }
        return result.body.refs
            .map(fileSpan => toLocation(fileSpan));
    }

    async documentFormatting(params: lsp.DocumentFormattingParams): Promise<lsp.TextEdit[]> {
        const file = uriToPath(params.textDocument.uri);
        this.logger.log('documentFormatting', params, file);
        if (!file) {
            return [];
        }

        let opts = <tsp.FormatCodeSettings>{
            ...params.options
        }

        // translate
        if (opts.convertTabsToSpaces === undefined) {
            opts.convertTabsToSpaces = params.options.insertSpaces
        }
        if (opts.indentSize === undefined) {
            opts.indentSize = params.options.tabSize
        }

        try {
            opts = JSON.parse(fs.readFileSync(this.rootPath() + "/tsfmt.json", 'utf-8'));
        } catch (err) {
            this.logger.log("No formatting options found " + err)
        }

        // options are not yet supported in tsserver, but we can send a configure request first
        await this.tspClient.request(CommandTypes.Configure, {
            formatOptions: opts
        });

        const response = await this.tspClient.request(CommandTypes.Format, {
            file,
            line: 1,
            offset: 1,
            endLine: Number.MAX_SAFE_INTEGER,
            endOffset: Number.MAX_SAFE_INTEGER,
            options: opts
        });
        if (response.body) {
            return response.body.map(e => toTextEdit(e));
        }
        return [];
    }

    async signatureHelp(params: lsp.TextDocumentPositionParams): Promise<lsp.SignatureHelp | undefined> {
        const file = uriToPath(params.textDocument.uri);
        this.logger.log('signatureHelp', params, file);
        if (!file) {
            return undefined;
        }

        const response = await await this.interuptDiagnostics(() => this.getSignatureHelp(file, params.position));
        if (!response || !response.body) {
            return undefined;
        }
        const info = response.body;
        return asSignatureHelp(response.body);
    }
    protected async getSignatureHelp(file: string, position: lsp.Position): Promise<tsp.SignatureHelpResponse | undefined> {
        try {
            return await this.tspClient.request(CommandTypes.SignatureHelp, {
                file,
                line: position.line + 1,
                offset: position.character + 1
            });
        } catch (err) {
            return undefined;
        }
    }

    async codeAction(params: lsp.CodeActionParams): Promise<(lsp.Command | lsp.CodeAction)[]> {
        const file = uriToPath(params.textDocument.uri);
        this.logger.log('codeAction', params, file);
        if (!file) {
            return [];
        }
        const args = toFileRangeRequestArgs(file, params.range);
        const codeActions: (lsp.Command | lsp.CodeAction)[] = [];
        const errorCodes = params.context.diagnostics.map(diagnostic => Number(diagnostic.code));
        provideQuickFix(await this.getCodeFixes({ ...args, errorCodes }), codeActions);
        provideRefactors(await this.getRefactors(args), codeActions, args);
        provideOrganizeImports(file, params.context, codeActions);
        return codeActions;
    }
    protected async getCodeFixes(args: tsp.CodeFixRequestArgs): Promise<tsp.GetCodeFixesResponse | undefined> {
        try {
            return await this.tspClient.request(CommandTypes.GetCodeFixes, args);
        } catch (err) {
            return undefined;
        }
    }
    protected async getRefactors(args: tsp.GetApplicableRefactorsRequestArgs): Promise<tsp.GetApplicableRefactorsResponse | undefined> {
        try {
            return await this.tspClient.request(CommandTypes.GetApplicableRefactors, args);
        } catch (err) {
            return undefined;
        }
    }

    async executeCommand(arg: lsp.ExecuteCommandParams): Promise<void> {
        this.logger.log('executeCommand', arg);
        if (arg.command === Commands.APPLY_WORKSPACE_EDIT && arg.arguments) {
            const edit = arg.arguments[0] as lsp.WorkspaceEdit;
            await this.options.lspClient.applyWorkspaceEdit({
                edit
            });
        } else if (arg.command === Commands.APPLY_CODE_ACTION && arg.arguments) {
            const codeAction = arg.arguments[0] as tsp.CodeAction;
            if (!await this.applyFileCodeEdits(codeAction.changes)) {
                return;
            }
            if (codeAction.commands && codeAction.commands.length) {
                for (const command of codeAction.commands) {
                    await this.tspClient.request(CommandTypes.ApplyCodeActionCommand, { command })
                }
            }
        } else if (arg.command === Commands.APPLY_REFACTORING && arg.arguments) {
            const args = arg.arguments[0] as tsp.GetEditsForRefactorRequestArgs;
            const { body } = await this.tspClient.request(CommandTypes.GetEditsForRefactor, args);
            if (!body || !body.edits.length) {
                return;
            }
            for (const edit of body.edits) {
                await fs.ensureFile(edit.fileName);
            }
            if (!await this.applyFileCodeEdits(body.edits)) {
                return;
            }
            const renameLocation = body.renameLocation;
            if (renameLocation) {
                await this.options.lspClient.rename({
                    textDocument: {
                        uri: pathToUri(args.file)
                    },
                    position: toPosition(renameLocation)
                });
            }
        } else if (arg.command === Commands.ORGANIZE_IMPORTS && arg.arguments) {
            const file = arg.arguments[0] as string;
            const { body } = await this.tspClient.request(CommandTypes.OrganizeImports, {
                scope: {
                    type: 'file',
                    args: { file }
                }
            });
            await this.applyFileCodeEdits(body);
        } else {
            this.logger.error(`Unknown command ${arg.command}.`)
        }
    }
    protected async applyFileCodeEdits(edits: ReadonlyArray<tsp.FileCodeEdits>): Promise<boolean> {
        if (!edits.length) {
            return false;
        }
        const changes: { [uri: string]: lsp.TextEdit[] } = {};
        for (const edit of edits) {
            changes[pathToUri(edit.fileName)] = edit.textChanges.map(toTextEdit);
        }
        const { applied } = await this.options.lspClient.applyWorkspaceEdit({
            edit: { changes }
        });
        return applied;
    }

    async documentHighlight(arg: lsp.TextDocumentPositionParams): Promise<lsp.DocumentHighlight[]> {
        const file = uriToPath(arg.textDocument.uri);
        this.logger.log('documentHighlight', arg, file);
        if (!file) {
            return [];
        }
        let response: tsp.DocumentHighlightsResponse;
        try {
            response = await this.tspClient.request(CommandTypes.DocumentHighlights, {
                file,
                line: arg.position.line + 1,
                offset: arg.position.character + 1,
                filesToSearch: [file]
            })
        } catch (err) {
            return [];
        }
        if (!response.body) {
            return []
        }
        const result: lsp.DocumentHighlight[] = [];
        for (const item of response.body) {
            if (item.file === file) {
                const highlights = toDocumentHighlight(item);
                result.push(...highlights)
            }
        }
        return result;
    }

    private rootPath(): string {
        return this.initializeParams.rootUri ? uriToPath(this.initializeParams.rootUri)! : this.initializeParams.rootPath!;
    }

    private lastFileOrDummy(): string {
        for (const uri of this.openedDocumentUris.keys()) {
            return uriToPath(uri)!;
        }
        return this.rootPath();
    }

    async workspaceSymbol(params: lsp.WorkspaceSymbolParams): Promise<lsp.SymbolInformation[]> {
        const result = await this.tspClient.request(CommandTypes.Navto, {
            file: this.lastFileOrDummy(),
            searchValue: params.query
        });
        if (!result.body) {
            return []
        }
        return result.body.map(item => {
            return <lsp.SymbolInformation>{
                location: {
                    uri: pathToUri(item.file),
                    range: {
                        start: toPosition(item.start),
                        end: toPosition(item.end)
                    }
                },
                kind: toSymbolKind(item.kind),
                name: item.name
            };
        });
    }

    /**
     * implemented based on https://github.com/Microsoft/vscode/blob/master/extensions/typescript-language-features/src/features/folding.ts
     */
    async foldingRanges(params: lsp.FoldingRangeRequestParam): Promise<lsp.FoldingRange[] | undefined> {
        const file = uriToPath(params.textDocument.uri);
        this.logger.log('foldingRanges', params, file);
        if (!file) {
            return undefined;
        }

        const document = this.openedDocumentUris.get(params.textDocument.uri);
        if (!document) {
            throw new Error("The document should be opened for foldingRanges', file: " + file);
        }
        const { body } = await this.tspClient.request(CommandTypes.GetOutliningSpans, { file });
        if (!body) {
            return undefined;
        }
        const foldingRanges: lsp.FoldingRange[] = [];
        for (const span of body) {
            const foldingRange = this.asFoldingRange(span, document);
            if (foldingRange) {
                foldingRanges.push(foldingRange);
            }
        }
        return foldingRanges;
    }
    protected asFoldingRange(span: tsp.OutliningSpan, document: LspDocument): lsp.FoldingRange | undefined {
        const range = asRange(span.textSpan);
        const kind = this.asFoldingRangeKind(span);

        // workaround for https://github.com/Microsoft/vscode/issues/49904
        if (span.kind === 'comment') {
            const line = document.getLine(range.start.line);
            if (line.match(/\/\/\s*#endregion/gi)) {
                return undefined;
            }
        }

        const startLine = range.start.line;

        // workaround for https://github.com/Microsoft/vscode/issues/47240
        const endLine = (range.end.character > 0 && document.getText(lsp.Range.create(
            lsp.Position.create(range.end.line, range.end.character - 1),
            range.end
        )) === '}') ? Math.max(range.end.line - 1, range.start.line) : range.end.line;

        return {
            startLine,
            endLine,
            kind
        }
    }
    protected asFoldingRangeKind(span: tsp.OutliningSpan): lsp.FoldingRangeKind | undefined {
        switch (span.kind) {
            case 'comment': return lsp.FoldingRangeKind.Comment;
            case 'region': return lsp.FoldingRangeKind.Region;
            case 'imports': return lsp.FoldingRangeKind.Imports;
            case 'code':
            default: return undefined;
        }
    }

    protected onTsEvent(event: protocol.Event): void {
        if (event.event === EventTypes.SementicDiag ||
            event.event === EventTypes.SyntaxDiag ||
            event.event === EventTypes.SuggestionDiag) {
            this.diagnosticQueue.updateDiagnostics(event.event, event);
        } else {
            this.logger.log("Ignored event", {
                "event": event.event
            });
        }
    }
}
