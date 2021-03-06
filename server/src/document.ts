/*
 * Copyright (C) 2017, 2018 TypeFox and others.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as lsp from 'vscode-languageserver';

export class LspDocument implements lsp.TextDocument {

    protected readonly document: lsp.TextDocument;
    lastAccessed: number = new Date().getTime();

    constructor(doc: lsp.TextDocumentItem) {
        const { uri, languageId, version, text } = doc;
        this.document = lsp.TextDocument.create(uri, languageId, version, text);
    }

    markAccessed(): void {
        this.lastAccessed = new Date().getTime();
    }

    get uri(): string {
        return this.document.uri;
    }

    get languageId(): string {
        return this.document.languageId;
    }

    get version(): number {
        return this.document.version;
    }

    getText(range?: lsp.Range | undefined): string {
        return this.document.getText(range);
    }

    positionAt(offset: number): lsp.Position {
        return this.document.positionAt(offset);
    }

    offsetAt(position: lsp.Position): number {
        return this.document.offsetAt(position);
    }

    get lineCount(): number {
        return this.document.lineCount;
    }

    getLine(line: number): string {
        const lineRange = this.getLineRange(line);
        return this.getText(lineRange);
    }

    getLineRange(line: number): lsp.Range {
        const lineStart = this.getLineStart(line);
        const lineEnd = this.getLineEnd(line);
        return lsp.Range.create(lineStart, lineEnd);
    }

    getLineEnd(line: number): lsp.Position {
        const nextLineOffset = this.getLineOffset(line + 1);
        return this.positionAt(nextLineOffset - 1);
    }

    getLineOffset(line: number): number {
        const lineStart = this.getLineStart(line);
        return this.offsetAt(lineStart);
    }

    getLineStart(line: number): lsp.Position {
        return lsp.Position.create(line, 0);
    }
}
