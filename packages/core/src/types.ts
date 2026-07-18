// 仕様書 §5, §7 に基づく型定義

export interface WikiLink {
  /** リンク元ノートの相対パス */
  sourcePath: string;
  /** [[ノート]] や [[ノート|表示名]] の "ノート" 部分（生の表記） */
  target: string;
  /** 見出しアンカー [[ノート#見出し]] */
  heading?: string;
  /** ブロック参照 [[ノート#^id]] */
  blockId?: string;
  /** [[ノート|表示名]] の表示名 */
  alias?: string;
  /** ![[...]] の埋め込みか */
  isEmbed: boolean;
  /** 生のマッチ文字列（本文中の置換に使う） */
  raw: string;
}

export interface AttachmentRef {
  /** 参照元ノートの相対パス */
  sourcePath: string;
  /** 添付ファイルの相対パス（vaultルートから解決済み。未解決ならnull） */
  targetPath: string | null;
  /** リンク内の生表記 */
  raw: string;
  /** 拡張子 */
  extension: string;
}

export interface NoteResolutionWarning {
  sourcePath: string;
  linkText: string;
  reason: 'ambiguous' | 'not_found';
  candidates?: string[];
}

export interface NoteRecord {
  /** vaultルートからの相対パス（POSIX区切り） */
  path: string;
  /** frontmatter（gray-matterのdata） */
  frontmatter: Record<string, unknown>;
  /** frontmatterを除いた本文 */
  content: string;
  /** ファイルサイズ（バイト） */
  sizeBytes: number;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface VaultInventory {
  vaultPath: string;
  notes: NoteRecord[];
  attachments: AttachmentRef[];
  wikiLinks: WikiLink[];
  skipped: SkippedFile[];
  warnings: NoteResolutionWarning[];
  /** フォルダパス→直下ノートパス一覧 */
  folderTree: Record<string, string[]>;
  /** frontmatterキーの出現回数 */
  frontmatterKeyStats: Record<string, number>;
}

export type FolderMode = 'page_tree' | 'database';

export interface FolderPlan {
  folderPath: string;
  mode: FolderMode;
  /** database モード時の提案理由（自動提案の場合） */
  suggestionReason?: string;
}

export interface FrontmatterMapping {
  key: string;
  notionPropertyType:
    | 'title'
    | 'rich_text'
    | 'number'
    | 'checkbox'
    | 'date'
    | 'multi_select'
    | 'url';
}

export interface MigrationPlan {
  version: 1;
  vaultPath: string;
  parentPageId: string;
  folders: FolderPlan[];
  frontmatterMappings: Record<string, FrontmatterMapping[]>;
  skipList: string[];
}

export type NoteStatus =
  | 'pending'
  | 'created'
  | 'linked'
  | 'attached'
  | 'done'
  | 'failed'
  | 'skipped';

export interface NoteState {
  status: NoteStatus;
  pageId?: string;
  pageUrl?: string;
  contentHash?: string;
  error?: string;
}

export type FileStatus = 'pending' | 'uploaded' | 'attached' | 'failed' | 'skipped';

export interface FileState {
  status: FileStatus;
  fileUploadId?: string;
  error?: string;
}

export type FolderStatus = 'pending' | 'created' | 'failed';

export interface FolderState {
  status: FolderStatus;
  kind: 'page' | 'database';
  notionId: string;
  /** databaseの場合のdata source id（§16-4: 正確な構造は要検証） */
  dataSourceId?: string;
  error?: string;
}

export interface StateFile {
  version: 1;
  parentPageId: string;
  notes: Record<string, NoteState>;
  files: Record<string, FileState>;
  /**
   * 仕様書§5 F5のstate.jsonスキーマ例には無いキー。
   * page_treeモードのフォルダ=親ページ、databaseモードのフォルダ=DBのID管理に必要なため追加。
   * 差分はdocs/questions.mdに記録。
   */
  folders: Record<string, FolderState>;
}

export interface ReportEntry {
  category:
    | 'skipped'
    | 'unresolved_link'
    | 'oversized_file'
    | 'downgraded'
    | 'warning';
  path: string;
  message: string;
}

export interface MigrationReport {
  successCount: number;
  entries: ReportEntry[];
}

export interface ConversionResult {
  markdown: string;
  entries: ReportEntry[];
}
