import * as vscode from 'vscode';

export const headerDecorationType = vscode.window.createTextEditorDecorationType({
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  before: {
    margin: '0 1ch 0 0',
    color: new vscode.ThemeColor('descriptionForeground'),
  },
});

export const fileBannerDecorationType = vscode.window.createTextEditorDecorationType({
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  isWholeLine: false,
  before: {
    margin: '0 0 0 0',
    color: new vscode.ThemeColor('editorCodeLens.foreground'),
    fontStyle: 'italic',
    textDecoration: 'none; font-size: 1.05em; font-weight: 600;',
  },
});

export interface FileBannerItem {
  text: string;
  hover: string;
}

export function applyFileBanner(editor: vscode.TextEditor, banner: FileBannerItem | undefined): void {
  if (!banner || editor.document.lineCount === 0) {
    editor.setDecorations(fileBannerDecorationType, []);
    return;
  }
  const firstLine = editor.document.lineAt(0);
  const col = firstLine.firstNonWhitespaceCharacterIndex;
  const endCol = Math.max(col + 1, Math.min(col + 1, firstLine.text.length));
  const hover = new vscode.MarkdownString(banner.hover);
  hover.isTrusted = { enabledCommands: ['semanticFoldMode.regenerateFileSummary'] };
  hover.supportThemeIcons = true;
  editor.setDecorations(fileBannerDecorationType, [
    {
      range: new vscode.Range(0, col, 0, endCol),
      hoverMessage: hover,
      renderOptions: {
        before: { contentText: `📘 ${banner.text} ` },
      },
    },
  ]);
}

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

    const hover = new vscode.MarkdownString(item.hover);
    hover.isTrusted = { enabledCommands: ['semanticFoldMode.regenerateUnitAt'] };
    hover.supportThemeIcons = true;
    decos.push({
      range: new vscode.Range(item.line, col, item.line, endCol),
      hoverMessage: hover,
      renderOptions: {
        before: { contentText: `⟪ ${item.text} ⟫ ` },
      },
    });
  }

  editor.setDecorations(headerDecorationType, decos);
}
