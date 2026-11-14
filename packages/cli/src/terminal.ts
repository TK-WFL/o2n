/**
 * 端末に出す文字列から制御文字を取り除く（#250）。
 *
 * vault のファイル名・フォルダ名・frontmatter のキー、`.o2n/` 配下のファイル、Notion や認証プロキシの
 * 応答には制御文字を入れられる。そのまま出すと端末がエスケープシーケンスとして解釈し、表示の書き換えや
 * ウィンドウタイトルの変更などに使われる。
 *
 * 取り除くのは C0（U+0000〜U+001F）、DEL（U+007F）、C1（U+0080〜U+009F）。シーケンスの始まり
 * （ESC、CSI、OSC）が消えれば、残りは印字できる文字なので端末は命令として扱わない。
 */

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const CONTROL_EXCEPT_LF_TAB = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * 1 行に収まるはずの値（パス、フォルダ名、キー、名前）用。改行とタブも取り除く。
 * 検証していないファイルから来た値は型どおりとは限らないので、String() を通してから処理する
 */
export function safeLine(value: string): string {
  return String(value).replace(CONTROL, '');
}

/** 複数行になりうる文章（レポート、エラー文）用。改行とタブは残す */
export function safeText(value: string): string {
  return String(value).replace(CONTROL_EXCEPT_LF_TAB, '');
}

/**
 * 端末に出す JSON。JSON.stringify がエスケープするのは U+001F までなので、DEL と C1 も \uXXXX にする。
 * これらの文字は文字列リテラルの中にしか現れないため、パースした結果は変わらない
 */
export function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
