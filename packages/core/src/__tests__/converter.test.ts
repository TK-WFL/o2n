import { describe, expect, it } from 'vitest';
import { convertNote, type ConverterContext } from '../converter.js';

function ctx(overrides: Partial<ConverterContext> = {}): ConverterContext {
  return {
    sourcePath: 'source.md',
    resolveNoteLink: () => 'Target.md',
    resolveAttachment: () => 'Attachments/image.png',
    ...overrides,
  };
}

describe('convertNote §6 変換表', () => {
  it('[[ノート]] はプレースホルダーに変換され pendingLinks に記録される', () => {
    const result = convertNote('[[Note B]]', ctx());
    expect(result.markdown).toMatch(/⟦o2n-link-0⟧/);
    expect(result.pendingLinks).toHaveLength(1);
    expect(result.pendingLinks[0]?.targetPath).toBe('Target.md');
    expect(result.pendingLinks[0]?.displayText).toBe('Note B');
  });

  it('[[ノート｜表示名]] は表示名を保持する', () => {
    const result = convertNote('[[Note B|表示名]]', ctx());
    expect(result.pendingLinks[0]?.displayText).toBe('表示名');
  });

  it('[[ノート#見出し]] はページ先頭リンクに降格しレポートされる', () => {
    const result = convertNote('[[Note B#見出し1]]', ctx());
    expect(result.pendingLinks[0]?.displayText).toBe('Note B > 見出し1');
    expect(result.entries.some((e) => e.category === 'downgraded' && e.message.includes('見出しリンク'))).toBe(true);
  });

  it('[[ノート#^ブロックID]] はページ先頭リンクに降格しレポートされる', () => {
    const result = convertNote('[[Note B#^block1]]', ctx());
    expect(result.entries.some((e) => e.category === 'downgraded' && e.message.includes('ブロック参照'))).toBe(true);
  });

  it('![[image.png]] は添付プレースホルダーになる', () => {
    const result = convertNote('![[image.png]]', ctx());
    expect(result.markdown).toMatch(/⟦o2n-file-0⟧/);
    expect(result.pendingFiles).toHaveLength(1);
  });

  it('![[document.pdf]] は添付プレースホルダーになる', () => {
    const result = convertNote('![[document.pdf]]', ctx({ resolveAttachment: () => 'Attachments/document.pdf' }));
    expect(result.pendingFiles[0]?.targetPath).toBe('Attachments/document.pdf');
  });

  it('![[ノート]]（ノート埋め込み）はプレーンなリンクに降格する（calloutは使わない、ブロック要素がインラインに出ると壊れるため）', () => {
    const result = convertNote('![[Note B]]', ctx());
    expect(result.markdown).not.toContain('<callout');
    expect(result.pendingLinks[0]?.displayText).toBe('埋め込み: Note B');
    expect(result.entries.some((e) => e.message.includes('ノート埋め込み'))).toBe(true);
  });

  it('未解決の[[ノート]]は元表記のフォールバックを持つ', () => {
    const result = convertNote('[[Missing Note]]', ctx({ resolveNoteLink: () => null }));
    expect(result.pendingLinks[0]?.fallbackText).toBe('[[Missing Note]]');
    expect(result.entries.some((e) => e.category === 'unresolved_link')).toBe(true);
  });

  it('callout(note)を変換する', () => {
    const result = convertNote('> [!note] タイトル\n> 本文行', ctx());
    expect(result.markdown).toBe('<callout icon="💡" color="blue_bg">**タイトル**<br>本文行</callout>');
  });

  it('callout(warning/tip/info/danger)のicon/colorが正しい', () => {
    expect(convertNote('> [!warning] T\n> b', ctx()).markdown).toContain('icon="⚠️" color="orange_bg"');
    expect(convertNote('> [!tip] T\n> b', ctx()).markdown).toContain('icon="💡" color="green_bg"');
    expect(convertNote('> [!info] T\n> b', ctx()).markdown).toContain('icon="ℹ️" color="gray_bg"');
    expect(convertNote('> [!danger] T\n> b', ctx()).markdown).toContain('icon="⛔" color="red_bg"');
  });

  it('未知のcallout種別はデフォルト(ℹ️/gray)に変換されレポートされる', () => {
    const result = convertNote('> [!custom] T\n> b', ctx());
    expect(result.markdown).toContain('icon="ℹ️" color="gray_bg"');
    expect(result.entries.some((e) => e.message.includes('未知のcallout種別'))).toBe(true);
  });

  it('タスクリストはそのまま', () => {
    const md = '- [ ] todo\n- [x] done';
    expect(convertNote(md, ctx()).markdown).toBe(md);
  });

  it('==ハイライト== はネイティブハイライト(span color)に変換される', () => {
    const result = convertNote('==重要==', ctx());
    expect(result.markdown).toBe('<span color="yellow_bg">重要</span>');
  });

  it('%%コメント%% は削除されレポートされる', () => {
    const result = convertNote('前%%消える%%後', ctx());
    expect(result.markdown).toBe('前後');
    expect(result.entries.some((e) => e.message.includes('コメント'))).toBe(true);
  });

  it('インラインタグ #tag はそのまま', () => {
    expect(convertNote('#important です', ctx()).markdown).toBe('#important です');
  });

  it('数式はそのまま', () => {
    const md = '$E = mc^2$ と $$x^2$$';
    expect(convertNote(md, ctx()).markdown).toBe(md);
  });

  it('mermaidコードブロックはそのまま', () => {
    const md = '```mermaid\ngraph TD\n  A --> B\n```';
    expect(convertNote(md, ctx()).markdown).toBe(md);
  });

  it('dataviewコードブロックはそのまま保持されレポートされる', () => {
    const md = '```dataview\nLIST FROM #test\n```';
    const result = convertNote(md, ctx());
    expect(result.markdown).toBe(md);
    expect(result.entries.some((e) => e.message.includes('dataview'))).toBe(true);
  });

  it('脚注は文末に展開されレポートされる', () => {
    const md = '本文[^1]です。\n\n[^1]: 脚注の内容';
    const result = convertNote(md, ctx());
    expect(result.markdown).toContain('本文 (脚注の内容)です。');
    expect(result.entries.some((e) => e.message.includes('脚注'))).toBe(true);
  });

  it('Markdownテーブルはそのまま', () => {
    const md = '| a | b |\n| --- | --- |\n| 1 | 2 |';
    expect(convertNote(md, ctx()).markdown).toBe(md);
  });

  it('HTMLタグは原則そのまま', () => {
    const md = '<iframe src="https://example.com"></iframe>';
    expect(convertNote(md, ctx()).markdown).toBe(md);
  });

  it('相対パス画像 ![alt](assets/img.png) は画像ブロック化される', () => {
    const result = convertNote('![alt](Attachments/image.png)', ctx());
    expect(result.pendingFiles).toHaveLength(1);
    expect(result.markdown).toMatch(/⟦o2n-file-0⟧/);
  });

  it('外部URL画像はそのまま（ダウンロードしない）', () => {
    const md = '![alt](https://example.com/image.png)';
    expect(convertNote(md, ctx()).markdown).toBe(md);
  });

  it('md形式内部リンク [text](note.md) はwikilinkと同じ解決フローに乗る', () => {
    const result = convertNote('[Note Bへ](Folder1/Note%20B.md)', ctx());
    expect(result.pendingLinks).toHaveLength(1);
    expect(result.pendingLinks[0]?.targetPath).toBe('Target.md');
  });

  it('⟦o2n- を含む本文はエスケープされ復元フラグが立つ', () => {
    const result = convertNote('既存の⟦o2n-something⟧テキスト', ctx());
    expect(result.needsEscapeRestore).toBe(true);
    expect(result.markdown).not.toContain('⟦o2n-something⟧');
  });

  it('通常の本文はエスケープ復元不要', () => {
    const result = convertNote('普通のテキスト', ctx());
    expect(result.needsEscapeRestore).toBe(false);
  });
});
