import { NotionApiError, type NotionApi } from './notion-client.js';
import type { NoteState, StateFile, VaultInventory } from './types.js';

/** `o2n verify`（浅い検証）: state.json とvaultの突き合わせ結果 */
export interface VerifySummary {
  vaultNoteCount: number;
  trackedNoteCount: number;
  counts: Record<NoteState['status'], number>;
  /** vaultにあるがstateに記録の無いノート */
  untracked: string[];
}

export function summarizeState(state: StateFile, inventory: VaultInventory): VerifySummary {
  const counts: VerifySummary['counts'] = { pending: 0, created: 0, linked: 0, attached: 0, done: 0, failed: 0, skipped: 0 };
  for (const s of Object.values(state.notes)) counts[s.status] = (counts[s.status] ?? 0) + 1;
  const untracked = inventory.notes.filter((n) => !state.notes[n.path]).map((n) => n.path);
  return { vaultNoteCount: inventory.notes.length, trackedNoteCount: Object.keys(state.notes).length, counts, untracked };
}

export type DeepVerifyIssueKind =
  /** ページが存在しない（完全削除・アクセス権の喪失） */
  | 'page_missing'
  /** ページがゴミ箱にある */
  | 'page_in_trash'
  /** 本文に未解決のプレースホルダー（⟦o2n-…⟧）が残っている */
  | 'placeholder_left'
  /** 添付ブロック数が state の貼り付け済み件数より少ない */
  | 'attachment_shortfall'
  /** 取得自体に失敗（レート制限枯渇など） */
  | 'fetch_error';

export interface DeepVerifyIssue {
  path: string;
  pageId: string;
  kind: DeepVerifyIssueKind;
  message: string;
}

export interface DeepVerifyResult {
  /** 検査対象になった（status=done かつ pageId あり）ノート数 */
  checked: number;
  issues: DeepVerifyIssue[];
}

const PLACEHOLDER_RE = /⟦o2n-(?:link|file)-\d+⟧/g;
/** enhanced markdown 上で添付ブロックとして現れる記法 */
const ATTACHMENT_BLOCK_RE = /!\[[^\]\n]*\]\(|<(?:file|pdf|video|audio)\s/g;

/**
 * `o2n verify --deep`（#81）: state で done になっているノートについて Notion の実ページを
 * 取得し、以下を検査する（1ノート2リクエスト: GET /pages/:id と GET /pages/:id/markdown）。
 * (a) ページが存在し、ゴミ箱に入っていない（404 → page_missing、in_trash → page_in_trash。
 *     実ワークスペースで確認: ゴミ箱のページでも markdown エンドポイントは 200 を返すため、
 *     in_trash は GET /pages で判定する必要がある）
 * (b) 未解決の ⟦o2n-…⟧ プレースホルダーが本文に残っていない
 * (c) 添付ブロック数が state の attachedPlaceholders 件数以上ある（外部画像は増える方向にしか
 *     働かないので「少ない」場合のみ問題にする）
 * 読み取りのみで Notion 側を変更しない。
 */
export async function deepVerifyNotes(
  api: NotionApi,
  state: StateFile,
  opts: { onProgress?: (done: number, total: number, notePath: string) => void } = {},
): Promise<DeepVerifyResult> {
  const targets = Object.entries(state.notes).filter(([, s]) => s.status === 'done' && s.pageId);
  const issues: DeepVerifyIssue[] = [];
  let done = 0;
  for (const [notePath, s] of targets) {
    const pageId = s.pageId!;
    try {
      const meta = await api.getPage(pageId);
      if (meta.in_trash) {
        issues.push({ path: notePath, pageId, kind: 'page_in_trash', message: 'Notion 上でページがゴミ箱に入っています' });
        done += 1;
        opts.onProgress?.(done, targets.length, notePath);
        continue;
      }
      const page = await api.getPageMarkdown(pageId);
      const md = page.markdown ?? '';
      const left = md.match(PLACEHOLDER_RE) ?? [];
      if (left.length > 0) {
        issues.push({ path: notePath, pageId, kind: 'placeholder_left', message: `未解決のプレースホルダーが${left.length}件残っています: ${[...new Set(left)].slice(0, 3).join(', ')}` });
      }
      const expected = s.attachedPlaceholders?.length ?? 0;
      if (expected > 0) {
        const found = (md.match(ATTACHMENT_BLOCK_RE) ?? []).length;
        if (found < expected) {
          issues.push({ path: notePath, pageId, kind: 'attachment_shortfall', message: `添付ブロックが ${expected} 件あるはずですが ${found} 件しか見つかりません` });
        }
      }
    } catch (err) {
      if (err instanceof NotionApiError && err.status === 404) {
        issues.push({ path: notePath, pageId, kind: 'page_missing', message: 'Notion 上にページが見つかりません（完全削除またはアクセス権の喪失）' });
      } else {
        issues.push({ path: notePath, pageId, kind: 'fetch_error', message: `取得に失敗: ${String(err)}` });
      }
    }
    done += 1;
    opts.onProgress?.(done, targets.length, notePath);
  }
  return { checked: targets.length, issues };
}
