import { NotionApiError, NotionBlockLimitError } from '@tk_wfl/o2n-core';
import { TokenMissingError } from './token.js';

/** 利用者向けのエラー文。Notion API の典型的な失敗に対処法を添える（#116） */
export function describeError(err: unknown): string {
  if (err instanceof TokenMissingError) return err.message;
  if (err instanceof NotionBlockLimitError) return err.message;
  if (err instanceof NotionApiError) {
    if (err.status === 401) {
      return 'Notion のトークンが無効です（401）。期限切れ・失効・貼り間違いの可能性があります。開発者ポータルでトークンを再発行し、NOTION_TOKEN を設定し直してください。';
    }
    if (err.status === 404) {
      return `${err.message}\n移行先ページが見つかりません。ページIDを確認し、internal integration を使っている場合はそのページを integration に接続（Connect）してください（個人アクセストークンなら接続は不要）。`;
    }
    if (err.status === 429) {
      return `${err.message}\nレート制限に達しました。しばらく待ってから resume するか、O2N_REQUESTS_PER_SECOND を下げてください。`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
