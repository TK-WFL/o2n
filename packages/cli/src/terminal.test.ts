import { describe, expect, it } from 'vitest';
import { safeJson, safeLine, safeText } from './terminal.js';

const ESC = '\u001b';
const BEL = '\u0007';

describe('端末に出す文字列の制御文字を取り除く（#250）', () => {
  it('safeLine は C0・DEL・C1 を改行とタブも含めて取り除く', () => {
    expect(safeLine(`a${ESC}[31mb`)).toBe('a[31mb');
    expect(safeLine(`${ESC}]0;title${BEL}name.md`)).toBe(']0;titlename.md');
    expect(safeLine('a\u009b2Jb\u009d52;c;AAAA\u009cc')).toBe('a2Jb52;c;AAAAc');
    expect(safeLine('a\rb\nc\td\be\u007ff\u0000g')).toBe('abcdefg');
  });

  it('safeText は改行とタブだけを残す', () => {
    expect(safeText(`# 見出し\n\t項目${ESC}[2K\r上書き\u009b1A`)).toBe('# 見出し\n\t項目[2K上書き1A');
  });

  it('日本語、絵文字、結合文字、ノーブレークスペースはそのまま', () => {
    const text = '日本語のノート 📝 が é a b ｶﾞ';
    expect(safeLine(text)).toBe(text);
    expect(safeText(text)).toBe(text);
  });

  it('文字列以外が来ても落ちない', () => {
    expect(safeLine(42 as unknown as string)).toBe('42');
    expect(safeText(undefined as unknown as string)).toBe('undefined');
  });

  it('safeJson は DEL と C1 を \\uXXXX にし、パースした結果は変えない', () => {
    const value = { [`k\u009b31m`]: `v${ESC}[0m\u007f\u0085`, list: ['\u009d0;t\u009c', '日本語\n'] };
    const json = safeJson(value);
    expect(json).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(json).toContain('\\u009b');
    expect(JSON.parse(json)).toEqual(value);
  });
});
