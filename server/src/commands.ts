/*
 * Copyright (C) 2018 TypeFox and others.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * **IMPORTANT** this module should not depend on `vscode-languageserver` only protocol and types
 */
import * as lsp from 'vscode-languageserver-protocol';

export namespace Commands {
    export const APPLY_WORKSPACE_EDIT = "_typescript.applyWorkspaceEdit";
    export const APPLY_CODE_ACTION = "_typescript.applyCodeAction";
    export const APPLY_REFACTORING = "_typescript.applyRefactoring";
    export const ORGANIZE_IMPORTS = '_typescript.organizeImports';
    /** Commands below should be implemented by the client */
    export const APPLY_COMPLETION_CODE_ACTION = "_typescript.applyCompletionCodeAction";
    export const SELECT_REFACTORING = '_typescript.selectRefactoring'
}

export namespace TypeScriptRenameRequest {
    export const type = new lsp.RequestType<lsp.TextDocumentPositionParams, any, void, void>("_typescript.rename");
}