import { describe, expect, it } from 'vitest';
import { convertNote, extractSection, type ConverterContext } from '../converter.js';

/** vault をメモリ上に用意し、inline モードの ConverterContext を作る */
function vault(notes: Record<string, string>) {
  const paths = Object.keys(notes);
  const resolve = (target: string) => paths.find((p) => p === `${target}.md` || p.endsWith(`/${target}.md`)) ?? null;
  const ctxFor = (sourcePath: string): ConverterContext => ({
    sourcePath,
    resolveNoteLink: resolve,
    resolveAttachment: (t) => (t.endsWith('.png') ? `Attachments/${t}` : null),
    embedMode: 'inline',
    readNote: (p) => notes[p] ?? null,
    contextFor: ctxFor,
  });
  return ctxFor;
}

describe('extractSection', () => {
  const md = '# Top\nintro\n\n## A\na1\n\n### A-1\na1-1\n\n## B\nb1\n\n```\n## not heading\n```\n\n## C\nc1';
  it('見出しから次の同レベル以上の見出し直前までを切り出す（下位見出しは含む）', () => {
    expect(extractSection(md, 'A')).toBe('## A\na1\n\n### A-1\na1-1\n');
    expect(extractSection(md, 'A-1')).toBe('### A-1\na1-1\n');
  });
  it('コードブロック内の # 行は見出し扱いしない／末尾の見出しは文末まで／大文字小文字を無視', () => {
    expect(extractSection(md, 'B')).toBe('## B\nb1\n\n```\n## not heading\n```\n');
    expect(extractSection(md, 'c')).toBe('## C\nc1');
  });
  it('見つからなければ null', () => {
    expect(extractSection(md, 'Z')).toBeNull();
  });
});

describe('![[Note]] のインライン展開（#80）', () => {
  it('既定（link）では従来通りリンクに降格する', () => {
    const ctxFor = vault({ 'A.md': '![[B]]', 'B.md': 'bbb' });
    const ctx = { ...ctxFor('A.md'), embedMode: 'link' as const };
    const r = convertNote('![[B]]', ctx);
    expect(r.markdown).toBe('⟦o2n-link-0⟧');
    expect(r.entries.some((e) => e.message.includes('リンクに降格'))).toBe(true);
  });

  it('inline では埋め込み先の変換済み本文が caption callout ＋ 本文 ＋ 区切り線として展開される', () => {
    const ctxFor = vault({ 'A.md': '', 'B.md': '# B\n\n==hi== と [[C]]\n', 'C.md': 'c' });
    const r = convertNote('前\n\n![[B]]\n\n後', ctxFor('A.md'));
    expect(r.markdown).toBe(
      '前\n\n<callout icon="📎" color="gray_bg">**埋め込み: ⟦o2n-link-1⟧**</callout>\n# B\n\n<span color="yellow_bg">hi</span> と ⟦o2n-link-0⟧\n\n---\n\n\n後',
    );
    // 埋め込み先内のリンク（C）と caption のリンク（B）が呼び出し元の pendingLinks に積まれる
    expect(r.pendingLinks.map((l) => l.targetPath)).toEqual(['C.md', 'B.md']);
    expect(r.entries.some((e) => e.category === 'downgraded' && e.message.includes('インライン展開'))).toBe(true);
    expect(r.entries.some((e) => e.message.includes('リンクに降格'))).toBe(false);
  });

  it('![[Note#見出し]] は該当セクションだけを展開する', () => {
    const ctxFor = vault({ 'A.md': '', 'B.md': '# B\n\n## S1\ns1\n\n## S2\ns2\n' });
    const r = convertNote('![[B#S2]]', ctxFor('A.md'));
    expect(r.markdown).toContain('## S2\ns2');
    expect(r.markdown).not.toContain('s1');
    expect(r.pendingLinks[0]?.displayText).toBe('B#S2');
  });

  it('見出しが見つからなければ警告してリンクに降格する', () => {
    const ctxFor = vault({ 'A.md': '', 'B.md': '# B\nbody' });
    const r = convertNote('![[B#Nope]]', ctxFor('A.md'));
    expect(r.markdown).toBe('⟦o2n-link-0⟧');
    expect(r.entries.some((e) => e.category === 'warning' && e.message.includes('見出しが見つからない'))).toBe(true);
  });

  it('ブロック参照の埋め込み ![[Note#^id]] はリンクに降格する', () => {
    const ctxFor = vault({ 'A.md': '', 'B.md': 'x ^id' });
    const r = convertNote('![[B#^id]]', ctxFor('A.md'));
    expect(r.markdown).toBe('⟦o2n-link-0⟧');
    expect(r.entries.some((e) => e.message.includes('ブロック参照の埋め込み'))).toBe(true);
  });

  it('循環（A→B→A）は検出して警告し、2周目はリンクに降格する', () => {
    const ctxFor = vault({ 'A.md': 'a ![[B]]', 'B.md': 'b ![[A]]' });
    const r = convertNote('a ![[B]]', ctxFor('A.md'));
    // B は展開されるが、B の中の ![[A]] はリンク
    expect(r.markdown).toContain('b ⟦o2n-link-0⟧');
    expect(r.entries.some((e) => e.category === 'warning' && e.message.includes('循環'))).toBe(true);
    expect(r.markdown.split('埋め込み:').length - 1).toBe(1);
  });

  it('深さは 2 まで（A→B→C は展開、C→D はリンク）', () => {
    const ctxFor = vault({ 'A.md': '', 'B.md': 'b ![[C]]', 'C.md': 'c ![[D]]', 'D.md': 'd' });
    const r = convertNote('![[B]]', ctxFor('A.md'));
    expect(r.markdown).toContain('c ⟦o2n-link-');
    expect(r.markdown).not.toContain('\nd\n');
    expect(r.entries.some((e) => e.message.includes('深さ'))).toBe(true);
  });

  it('埋め込み先の添付は呼び出し元の pendingFiles に積まれ、プレースホルダー番号は重複しない', () => {
    const ctxFor = vault({ 'A.md': '', 'B.md': '![[b.png]]' });
    const r = convertNote('![[a.png]]\n\n![[B]]\n\n![[c.png]]', ctxFor('A.md'));
    expect(r.pendingFiles.map((f) => f.placeholder)).toEqual(['⟦o2n-file-0⟧', '⟦o2n-file-1⟧', '⟦o2n-file-2⟧']);
    expect(r.pendingFiles.map((f) => f.targetPath)).toEqual(['Attachments/a.png', 'Attachments/b.png', 'Attachments/c.png']);
    for (const f of r.pendingFiles) expect(r.markdown).toContain(f.placeholder);
  });

  it('埋め込み先が未解決なら従来通り unresolved_link', () => {
    const ctxFor = vault({ 'A.md': '' });
    const r = convertNote('![[Nope]]', ctxFor('A.md'));
    expect(r.markdown).toBe('埋め込み: Nope');
    expect(r.entries.some((e) => e.category === 'unresolved_link')).toBe(true);
  });

  it('コードブロック内の ![[Note]] は展開しない', () => {
    const ctxFor = vault({ 'A.md': '', 'B.md': 'b' });
    const r = convertNote('```\n![[B]]\n```', ctxFor('A.md'));
    expect(r.markdown).toBe('```\n![[B]]\n```');
  });
});
