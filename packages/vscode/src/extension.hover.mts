import { YySprite } from '@bscotch/yy';
import vscode from 'vscode';
import { assertUserClaim } from './assert.mjs';
import type { StitchWorkspace } from './extension.workspace.mjs';

export class StitchHoverProvider implements vscode.HoverProvider {
  protected constructor(readonly provider: StitchWorkspace) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const result = await this.provider.query(
      document,
      { kind: 'hover', offset: document.offsetAt(position) },
      token,
    );
    if (!result) return;
    const hoverContents = new vscode.MarkdownString();
    const codeBlocks = new Set(result.code);
    const textBlocks = new Set(result.text);
    for (const name of result.sprites) {
      const sprite = this.provider.getAsset(document, name);
      if (!sprite) continue;
      hoverContents.isTrusted = true;
      assertUserClaim(sprite.dir, 'Sprite must have a directory');
      hoverContents.baseUri = vscode.Uri.file(sprite.dir.absolute);
      hoverContents.supportHtml = true;
      const yy = sprite.yy as YySprite;
      textBlocks.add(
        yy.frames
          .map(
            (frame) =>
              `![Sprite subimage](${vscode.Uri.file(sprite.dir.join(`${frame.name}.png`).absolute)})`,
          )
          .join(''),
      );
    }
    if (!codeBlocks.size && !textBlocks.size) {
      return;
    }
    for (const code of codeBlocks) {
      hoverContents.appendCodeblock(code, 'gml');
    }
    for (const text of textBlocks) {
      hoverContents.appendMarkdown(text + '\n\n');
    }

    // console.log('Hovering over', item);
    return new vscode.Hover(hoverContents);
  }

  static register(provider: StitchWorkspace) {
    return vscode.languages.registerHoverProvider(
      { language: 'gml', scheme: 'file' },
      new StitchHoverProvider(provider),
    );
  }
}
