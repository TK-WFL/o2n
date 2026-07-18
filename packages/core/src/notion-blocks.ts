const MAX_PAYLOAD_BYTES = 450_000; // §4.2の500KB上限にマージンを取る
const MAX_BLOCKS_PER_CHUNK = 900; // 1000ブロック上限にマージン

export function buildTitleProperty(text: string): { title: Array<{ text: { content: string } }> } {
  return { title: [{ text: { content: text } }] };
}

/**
 * §7.1 page_treeモード: frontmatterをページ本文冒頭のcalloutとして保持する
 */
export function buildFrontmatterMetaCallout(frontmatter: Record<string, unknown>): string {
  const keys = Object.keys(frontmatter);
  if (keys.length === 0) return '';
  const lines = keys.map((k) => {
    const v = frontmatter[k];
    const rendered = Array.isArray(v) ? v.join(', ') : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
    return `${k}: ${rendered}`;
  });
  // §16検証済み（2026-07-19）: callout内の複数行は\nではなく<br>で区切る必要がある。
  // \nのままだと</callout>が意図しない位置に挿入され、calloutが途中で閉じてしまう。
  return `<callout icon="ℹ️" color="gray_bg">${lines.join('<br>')}</callout>\n\n`;
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf-8');
}

/**
 * §4.2 のペイロード制限（1000ブロック・500KB）に対応するため、markdownを
 * 段落境界（空行）で分割する。1個目はPOST /v1/pages用、以降はPATCH .../markdown
 * の insert_content(position: end) で追記する。
 */
export function splitMarkdownForPayload(markdown: string): string[] {
  if (byteLength(markdown) <= MAX_PAYLOAD_BYTES) return [markdown];

  const paragraphs = markdown.split(/\n\n/);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentBytes = 0;
  let currentBlocks = 0;

  for (const para of paragraphs) {
    const paraBytes = byteLength(para) + 2;
    if (
      current.length > 0 &&
      (currentBytes + paraBytes > MAX_PAYLOAD_BYTES || currentBlocks + 1 > MAX_BLOCKS_PER_CHUNK)
    ) {
      chunks.push(current.join('\n\n'));
      current = [];
      currentBytes = 0;
      currentBlocks = 0;
    }
    current.push(para);
    currentBytes += paraBytes;
    currentBlocks += 1;
  }
  if (current.length > 0) chunks.push(current.join('\n\n'));
  return chunks;
}

export function shouldUseAsyncWrite(markdown: string): boolean {
  return byteLength(markdown) > MAX_PAYLOAD_BYTES * 2;
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'mkv']);

export type AttachmentBlockType = 'image' | 'pdf' | 'audio' | 'video' | 'file';

export function attachmentBlockType(extension: string): AttachmentBlockType {
  const ext = extension.toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (VIDEO_EXT.has(ext)) return 'video';
  return 'file';
}

export function buildAttachmentBlock(fileUploadId: string, extension: string): Record<string, unknown> {
  const type = attachmentBlockType(extension);
  return {
    object: 'block',
    type,
    [type]: {
      type: 'file_upload',
      file_upload: { id: fileUploadId },
    },
  };
}

export function buildPlaceholderParagraphBlock(placeholder: string): Record<string, unknown> {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: placeholder } }] },
  };
}
