import { describe, expect, it } from 'vitest';
import {
  MAX_PAYLOAD_BYTES,
  attachmentBlockType,
  buildFrontmatterMetaCallout,
  shouldUseAsyncWrite,
  splitMarkdownForPayload,
  splitMarkdownUnits,
} from '../notion-blocks.js';

/** MAX_PAYLOAD_BYTES を確実に超える段落列（各段落 ~1KB） */
function paragraphs(n: number, prefix = 'p'): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${i} ${'x'.repeat(1000)}`).join('\n\n');
}

describe('splitMarkdownUnits', () => {
  it('全ユニットを連結すると元の markdown に完全一致する（空行の数や末尾改行も保持）', () => {
    const md = 'a\n\n\nb\n- c\n- d\n\n```ts\nx\n\ny\n```\n\n| h |\n|---|\n| v |\n<callout icon="i" color="gray_bg">a\nb</callout>\n\ntail';
    expect(splitMarkdownUnits(md).join('')).toBe(md);
    expect(splitMarkdownUnits('').join('')).toBe('');
    expect(splitMarkdownUnits('\n\nx\n').join('')).toBe('\n\nx\n');
  });

  it('コードブロック内の空行では分割しない', () => {
    const md = 'before\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nafter';
    const units = splitMarkdownUnits(md);
    const code = units.find((u) => u.startsWith('```js'));
    expect(code).toBe('```js\nconst a = 1;\n\nconst b = 2;\n```\n\n');
  });

  it('~~~ フェンスと、``` を含むコードブロック（より長い ```` で囲む）も 1 ユニットになる', () => {
    const md = '~~~\na\n\nb\n~~~\n\n````md\n```\ninner\n```\n````\n';
    const units = splitMarkdownUnits(md).filter((u) => u.trim() !== '');
    expect(units).toHaveLength(2);
    expect(units[1]).toBe('````md\n```\ninner\n```\n````\n');
  });

  it('複数行の <callout> と表は 1 ユニットになる', () => {
    const md = '<callout icon="ℹ️" color="gray_bg">k: v<br>\n\nx</callout>\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nend';
    const units = splitMarkdownUnits(md);
    expect(units[0]).toBe('<callout icon="ℹ️" color="gray_bg">k: v<br>\n\nx</callout>\n\n');
    expect(units[1]).toBe('| a | b |\n|---|---|\n| 1 | 2 |\n\n');
  });
});

describe('splitMarkdownForPayload（#68）', () => {
  it('上限以下なら分割しない', () => {
    expect(splitMarkdownForPayload('# small')).toEqual(['# small']);
  });

  it('上限超は複数チャンクに分かれ、各チャンクは上限以下、連結すると元に戻る', () => {
    const md = paragraphs(600);
    const chunks = splitMarkdownForPayload(md);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(Buffer.byteLength(c, 'utf-8')).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(chunks.join('')).toBe(md);
  });

  it('コードブロックの内部（空行を含む）が別チャンクに割れない', () => {
    // 上限直前にコードブロックを置き、旧実装なら内部の空行で割れる配置にする
    const head = paragraphs(440);
    const code = '```python\n' + Array.from({ length: 30 }, (_, i) => `line ${i} ${'y'.repeat(500)}\n\n`).join('') + '```';
    const md = `${head}\n\n${code}\n\n${paragraphs(50, 'q')}`;
    const chunks = splitMarkdownForPayload(md);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(md);
    const withCode = chunks.filter((c) => c.includes('```python'));
    expect(withCode).toHaveLength(1);
    expect(withCode[0]).toContain(`${code}`);
    // フェンスの開閉が同一チャンク内で対になっている
    for (const c of chunks) expect((c.match(/^```/gm) ?? []).length % 2).toBe(0);
  });

  it('表と <callout> も分割位置をまたがない', () => {
    const table = Array.from({ length: 200 }, (_, i) => `| ${i} | ${'t'.repeat(300)} |`).join('\n');
    const callout = '<callout icon="ℹ️" color="gray_bg">' + 'k: v<br>'.repeat(10000) + '</callout>';
    const md = `${paragraphs(430)}\n\n| a | b |\n|---|---|\n${table}\n\n${callout}\n\n${paragraphs(40, 'z')}`;
    const chunks = splitMarkdownForPayload(md);
    expect(chunks.join('')).toBe(md);
    expect(chunks.filter((c) => c.includes('|---|')).length).toBe(1);
    expect(chunks.filter((c) => c.includes('<callout')).length).toBe(1);
    expect(chunks.filter((c) => c.includes('</callout>')).length).toBe(1);
  });

  it('単一ユニットが上限を超える場合は強制分割し onOversizedUnit で知らせる', () => {
    const huge = '```\n' + 'z'.repeat(MAX_PAYLOAD_BYTES + 10_000).replace(/(.{100})/g, '$1\n') + '```';
    const md = `intro\n\n${huge}\n\noutro`;
    const warnings: string[] = [];
    const chunks = splitMarkdownForPayload(md, { onOversizedUnit: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('強制分割');
    expect(chunks.join('')).toBe(md);
    for (const c of chunks) expect(Buffer.byteLength(c, 'utf-8')).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  it('ブロック数上限（900）でも分割し、ネストした項目は親と同じチャンクに残る', () => {
    // 1行1ブロックの箇条書き 2000 行（各 900 行目前後に子項目を置く）＋バイト上限超の段落
    const list = Array.from({ length: 2000 }, (_, i) => (i % 899 === 0 && i > 0 ? `  - child of ${i - 1}` : `- item ${i}`)).join('\n');
    const md = `${list}\n\n${'x'.repeat(MAX_PAYLOAD_BYTES)}`;
    const chunks = splitMarkdownForPayload(md);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    expect(chunks.join('')).toBe(md);
    for (const c of chunks) {
      expect(c.split('\n').filter((l) => l.startsWith('- ')).length).toBeLessThanOrEqual(900);
      // チャンク先頭がインデント行（親から切り離された子項目）になっていない
      expect(/^\s/.test(c)).toBe(false);
    }
  });
});

describe('shouldUseAsyncWrite', () => {
  it('チャンクサイズ以下では false（非同期書き込みは未実装のため意図的に到達しない）', () => {
    expect(shouldUseAsyncWrite('x'.repeat(MAX_PAYLOAD_BYTES))).toBe(false);
    expect(shouldUseAsyncWrite('x'.repeat(MAX_PAYLOAD_BYTES * 2 + 1))).toBe(true);
  });
});

describe('buildFrontmatterMetaCallout', () => {
  it('空なら空文字', () => {
    expect(buildFrontmatterMetaCallout({})).toBe('');
  });
  it('Date は YYYY-MM-DD、配列はカンマ区切り、object は JSON、行は <br> 区切り', () => {
    const md = buildFrontmatterMetaCallout({
      d: new Date('2026-01-02T03:04:05Z'),
      tags: ['a', 'b'],
      nested: { k: 1 },
      s: 'str',
      n: 3,
    });
    expect(md).toBe('<callout icon="ℹ️" color="gray_bg">d: 2026-01-02<br>tags: a, b<br>nested: {"k":1}<br>s: str<br>n: 3</callout>\n\n');
  });
});

describe('attachmentBlockType', () => {
  it.each([
    ['png', 'image'], ['JPG', 'image'], ['svg', 'image'],
    ['pdf', 'pdf'], ['mp3', 'audio'], ['m4a', 'audio'],
    ['mp4', 'video'], ['mov', 'video'], ['zip', 'file'], ['', 'file'],
  ])('%s → %s', (ext, expected) => {
    expect(attachmentBlockType(ext)).toBe(expected);
  });
});
