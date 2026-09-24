/**
 * 添付ファイルの種別判定を scanner / converter / migrator で共有する（#145）。
 */

export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'avif', 'heic', 'tif', 'tiff']);
export const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac']);
export const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'mkv', 'ogv', '3gp']);

/**
 * 表示系の添付（画像・PDF・音声・動画）。`![[x.png]]` の埋め込みはファイルが見つからなくても添付として扱い、
 * 見つからない旨を報告する
 */
export const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, 'pdf', ...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS]);

/** ノートや Obsidian 固有の定義ファイル。添付としてはアップロードしない */
export const NON_FILE_EXTENSIONS = new Set(['md', 'canvas', 'base', 'excalidraw']);

export function extensionOf(target: string): string {
  const base = target.split('/').pop() ?? target;
  return base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
}

/** 添付としてアップロードしうる拡張子か（ノート・Obsidian 定義ファイル以外の拡張子付きファイル） */
export function isFileExtension(ext: string): boolean {
  return ext !== '' && !NON_FILE_EXTENSIONS.has(ext);
}

const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heic: 'image/heic',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  ogv: 'video/ogg',
  '3gp': 'video/3gpp',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  txt: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  zip: 'application/zip',
  gz: 'application/gzip',
  epub: 'application/epub+zip',
};

/**
 * アップロード時の content type。実ワークスペースで確認（2026-09-24）: Notion は docx/xlsx/pptx/zip/csv/txt/
 * json/epub/heic/avif 等を受け付け、対応していない拡張子は作成時点で 400 を返す（アップロード失敗として報告される）
 */
export function mimeTypeFor(filename: string): string {
  return MIME_TYPES[extensionOf(filename)] ?? 'application/octet-stream';
}
