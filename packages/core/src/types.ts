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
  /**
   * Excalidraw プラグインの図面ノート（frontmatter `excalidraw-plugin`）。図面本体は JSON で
   * 変換できないため、同名の書き出し画像（.png/.svg）があれば content をその埋め込みに
   * 置き換えている。Pass1 でレポートするための印（#78）。
   */
  excalidraw?: { exportedImage: string };
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
  /**
   * ノート埋め込み `![[Note]]` の扱い（#80）。省略時は 'link'（リンクに降格）。
   * 'inline' は埋め込み先の本文をその場に展開する（Notion 上では同期されない複製になる）。
   */
  embedMode?: 'link' | 'inline';
}

export type NoteStatus =
  | 'pending'
  | 'created'
  | 'linked'
  | 'attached'
  | 'done'
  | 'failed'
  | 'skipped';

export interface DeferredLink {
  targetPath: string;
  /** Notion 上に残っている元の表記（ブロック内でこの文字列を探して置き換える） */
  text: string;
  displayText: string;
}

export interface NoteState {
  status: NoteStatus;
  pageId?: string;
  pageUrl?: string;
  contentHash?: string;
  error?: string;
  /**
   * 貼り付け済みの添付プレースホルダー一覧。同じ添付を複数箇所で参照する場合、
   * 箇所ごとに個別のプレースホルダー文字列を持つ。resume時に「既にこの箇所は
   * 貼り付け済み」と判定するために使う（実ワークスペースで発覚した不具合:
   * 'done'ノートをresumeすると、既に置換・削除済みのプレースホルダーを
   * Pass3が再度探しに行き、見つからないことを誤って警告していた）。
   */
  attachedPlaceholders?: string[];
  /**
   * リンク先ノートが vault にあるのにページ作成に失敗していたため、元の表記（`[[X]]`）のまま残したリンク（#139）。
   * 後の実行でリンク先のページができたら、ブロック単位でリンクに書き換える
   */
  deferredLinks?: DeferredLink[];
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
  version: 1 | 2;
  parentPageId: string;
  canonicalVaultPath?: string;
  planHash?: string;
  notionWorkspaceId?: string;
  notionBotId?: string;
  signature?: string;
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
    | 'warning'
    /** 移行全体を途中で中断した（例: Notion Free プランのブロック上限）。path は中断時点のノート */
    | 'aborted';
  path: string;
  message: string;
}

export interface MigrationRunMeta {
  startedAt: number;
  finishedAt: number;
  /** Notion API 呼び出し回数（dry-run は呼ばずに数えた回数） */
  apiCalls: number;
  dryRun: boolean;
  /** 実行前のノート状態（差分表示用）。contentHash があれば「同じページを更新した」も検出できる */
  before: Record<string, NoteStatus | { status: NoteStatus; contentHash?: string }>;
}

export interface MigrationReport {
  successCount: number;
  entries: ReportEntry[];
  run?: MigrationRunMeta;
}

export interface ConversionResult {
  markdown: string;
  entries: ReportEntry[];
}
