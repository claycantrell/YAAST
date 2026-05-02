import * as vscode from 'vscode';

export const headerDecorationType = vscode.window.createTextEditorDecorationType({
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  before: {
    margin: '0 1ch 0 0',
    color: new vscode.ThemeColor('descriptionForeground'),
  },
});

export interface HeaderItem {
  line: number;
  text: string;
  hover: string;
}

export function applyVirtualHeaders(editor: vscode.TextEditor, items: HeaderItem[]): void {
  const decos: vscode.DecorationOptions[] = [];

  for (const item of items) {
    if (item.line < 0 || item.line >= editor.document.lineCount) continue;
    const line = editor.document.lineAt(item.line);
    const col = line.firstNonWhitespaceCharacterIndex;
    const endCol = Math.max(col + 1, Math.min(col + 1, line.text.length));

    decos.push({
      range: new vscode.Range(item.line, col, item.line, endCol),
      hoverMessage: new vscode.MarkdownString(item.hover),
      renderOptions: {
        before: { contentText: `⟪ ${item.text} ⟫ ` },
      },
    });
  }

  editor.setDecorations(headerDecorationType, decos);
}
