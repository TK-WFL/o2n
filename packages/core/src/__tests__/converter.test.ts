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

  it.each([
    ['note', '💡', 'blue_bg'],
    ['abstract', '📋', 'blue_bg'],
    ['summary', '📋', 'blue_bg'],
    ['tldr', '📋', 'blue_bg'],
    ['info', 'ℹ️', 'gray_bg'],
    ['todo', '☑️', 'blue_bg'],
    ['tip', '🔥', 'green_bg'],
    ['hint', '🔥', 'green_bg'],
    ['important', '🔥', 'green_bg'],
    ['success', '✅', 'green_bg'],
    ['check', '✅', 'green_bg'],
    ['done', '✅', 'green_bg'],
    ['question', '❓', 'yellow_bg'],
    ['help', '❓', 'yellow_bg'],
    ['faq', '❓', 'yellow_bg'],
    ['warning', '⚠️', 'orange_bg'],
    ['caution', '⚠️', 'orange_bg'],
    ['attention', '⚠️', 'orange_bg'],
    ['failure', '❌', 'red_bg'],
    ['fail', '❌', 'red_bg'],
    ['missing', '❌', 'red_bg'],
    ['danger', '⚡', 'red_bg'],
    ['error', '⚡', 'red_bg'],
    ['bug', '🐛', 'red_bg'],
    ['example', '📝', 'purple_bg'],
    ['quote', '💬', 'gray_bg'],
    ['cite', '💬', 'gray_bg'],
  ])('callout(%s) は Obsidian 公式の全種別・別名に対応し、downgraded にならない', (type, icon, color) => {
    const result = convertNote(`> [!${type}] T\n> b`, ctx());
    expect(result.markdown).toContain(`icon="${icon}" color="${color}"`);
    expect(result.entries.some((e) => e.message.includes('未知のcallout種別'))).toBe(false);
  });

  it('callout 種別は大文字小文字を区別しない', () => {
    expect(convertNote('> [!WARNING] T\n> b', ctx()).markdown).toContain('icon="⚠️" color="orange_bg"');
    expect(convertNote('> [!Tip] T\n> b', ctx()).markdown).toContain('icon="🔥" color="green_bg"');
  });

  it('タイトル省略時は種別名（先頭大文字）がタイトルになる', () => {
    expect(convertNote('> [!faq]\n> b', ctx()).markdown).toContain('**Faq**<br>b');
  });

  it('折りたたみ callout（[!type]-）は Notion のトグル（複数行 <details>）に変換され、本文は callout として保持される', () => {
    const result = convertNote('> [!note]- 折りたたみ\n> 本文1\n> 本文2', ctx());
    expect(result.markdown).toBe(
      '<details>\n<summary>**折りたたみ**</summary>\n<callout icon="💡" color="blue_bg">本文1<br>本文2</callout>\n</details>',
    );
    expect(result.entries.some((e) => e.category === 'downgraded')).toBe(false);
  });

  it('折りたたみ callout の本文が無い場合は summary のみのトグルになる', () => {
    expect(convertNote('> [!note]- タイトルだけ', ctx()).markdown).toBe('<details>\n<summary>**タイトルだけ**</summary>\n</details>');
  });

  it('既定で開く callout（[!type]+）は通常の callout のまま', () => {
    expect(convertNote('> [!note]+ 開いている\n> 本文', ctx()).markdown).toBe('<callout icon="💡" color="blue_bg">**開いている**<br>本文</callout>');
  });

  it('折りたたみ callout の前後の行は影響を受けない', () => {
    const result = convertNote('前\n> [!warning]- W\n> b\n後', ctx());
    expect(result.markdown).toBe('前\n<details>\n<summary>**W**</summary>\n<callout icon="⚠️" color="orange_bg">b</callout>\n</details>\n後');
  });

  it('h5/h6 は h4 に正規化され、1ノート1件の downgraded として報告される（#73）', () => {
    const result = convertNote('# h1\n\n#### h4\n\n##### h5\n\n###### h6\n\n#######not heading\n', ctx());
    expect(result.markdown).toBe('# h1\n\n#### h4\n\n#### h5\n\n#### h6\n\n#######not heading\n');
    const downgraded = result.entries.filter((e) => e.category === 'downgraded' && e.message.includes('見出しレベル5〜6'));
    expect(downgraded).toHaveLength(1);
    expect(downgraded[0]!.message).toContain('2箇所');
  });

  it('コードブロック内の ##### は見出しとして扱わない', () => {
    const result = convertNote('```\n##### not heading\n```\n', ctx());
    expect(result.markdown).toContain('##### not heading');
    expect(result.entries.some((e) => e.message.includes('見出しレベル5〜6'))).toBe(false);
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

  it.each([
    ['🔴', 'red_bg'],
    ['🟠', 'orange_bg'],
    ['🟡', 'yellow_bg'],
    ['🟢', 'green_bg'],
    ['🔵', 'blue_bg'],
    ['🟣', 'purple_bg'],
  ])('Obsidian 1.14 の色付きハイライト ==%s text== は %s になり絵文字は除かれる', (emoji, color) => {
    expect(convertNote(`==${emoji}重要==`, ctx()).markdown).toBe(`<span color="${color}">重要</span>`);
    // 絵文字と本文の間の空白1つも除く
    expect(convertNote(`==${emoji} 重要==`, ctx()).markdown).toBe(`<span color="${color}">重要</span>`);
  });

  it('先頭以外の色絵文字はそのまま本文に残る', () => {
    expect(convertNote('==重要🔴==', ctx()).markdown).toBe('<span color="yellow_bg">重要🔴</span>');
  });

  it('色絵文字だけのハイライトは変換せず元のまま残す', () => {
    expect(convertNote('==🔴==', ctx()).markdown).toBe('==🔴==');
  });

  it('1行に複数の色付きハイライトがあっても個別に変換される', () => {
    expect(convertNote('==🟢A== と ==🔵B==', ctx()).markdown).toBe('<span color="green_bg">A</span> と <span color="blue_bg">B</span>');
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

describe('wikilink解析のReDoS耐性（セキュリティ回帰テスト）', () => {
  it(']]で閉じない[の大量反復を与えても短時間で処理を終える', () => {
    // CodeQL js/polynomial-redos 指摘の再現入力。文字クラスから `[` を除外する前は
    // 50,000反復で約10秒かかっていた（二次オーダーのバックトラック）。
    const evil = '[[' + '[["'.repeat(50_000);
    const started = Date.now();
    convertNote(evil, ctx());
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('|の大量反復を与えても短時間で処理を終える', () => {
    const evil = '[[' + 'a|'.repeat(50_000);
    const started = Date.now();
    convertNote(evil, ctx());
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('md形式リンク・画像・脚注の記法でも[の大量反復で遅延しない', () => {
    // CodeQLは未検出だったが、実測でWIKILINK_REと同種のReDoSがあった3箇所の回帰テスト。
    // MD_LINK_RE / MD_IMAGE_RE / 脚注参照は、いずれも修正前は2〜3秒かかっていた。
    const inputs = [
      '[' + '[a'.repeat(50_000),
      '![' + '![a'.repeat(50_000),
      '[^' + '[^a'.repeat(50_000),
    ];
    for (const evil of inputs) {
      const started = Date.now();
      convertNote(evil, ctx());
      expect(Date.now() - started).toBeLessThan(1_000);
    }
  });
});
