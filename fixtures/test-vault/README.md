# test-vault

§12（仕様書テスト計画）で挙げられた全構文を網羅するテスト用vault。

含まれるもの:
- wikilink・エイリアス・見出しリンク・ブロック参照・ノート埋め込み（`Note A.md`, `Folder1/Note B.md`）
- 画像・PDF埋め込み（`Attachments/image.png`, `Attachments/document.pdf`）
- callout全type（`Callouts.md`）
- dataview・mermaidコードブロック（`Note A.md`）
- canvas（`Canvas/diagram.canvas`、スキップ対象）
- 同名ノート2組（`Folder1/Same Name.md`, `Folder2/Same Name.md`）
- 日本語ファイル名（`日本語フォルダ/日本語ノート.md`）
- 絵文字入りファイル名（`絵文字🎉ノート.md`）
- frontmatter全型・2000文字超の値（`FrontmatterAllTypes.md`）
- DB化提案条件を満たすフォルダ（`DatabaseFolder/`: 3ノート共通で status/priority/due の3キー保持）
- `.obsidian/` `.trash/` （スキャン除外確認用）
- `Phase2/`（2026-09 の仕様追随・機能追加の検証用）:
  - callout 全種別・別名と折りたたみ `[!note]-`（`Callouts2.md`）
  - Obsidian 1.14 の色付きハイライト（`Highlights.md`）
  - frontmatter `aliases` によるリンク解決（`Aliased.md` ← `AliasLinker.md`）
  - h5/h6 の降格（`Headings.md`）、タスク拡張状態（`Tasks.md`）、インラインコード保護（`InlineCode.md`）
  - ノート埋め込みのインライン展開（`EmbedHost.md` → `EmbedTarget.md`、`plan --embed-mode inline` で確認）
  - 100 ブロック超＋ネストしたリスト内の添付（`LongNote.md`）
  - Excalidraw（書き出し画像あり `Drawing.excalidraw.md`、なし `Lonely.excalidraw.md`）、Bases（`Tasks.base`）

**20MiB超ファイル（マルチパート）について**: リポジトリを肥大化させないため、20MiB超のダミーファイルは
コミットしない。マルチパート経路のテストは `packages/core/src/__tests__/migrator.test.ts` が
`multipartPartSizeBytes` オプションでパートサイズを1 KiBに縮小し、一時ディレクトリに生成した数KiBの
ファイルで「分割送信 → `/complete`」の流れを検証している（`fixtures/test-vault` を汚さない）。
- `Phase3/`（v0.3.1 の不具合修正の検証用）:
  - 画像埋め込みの幅指定 `![[img|alt|300]]`、表内の `[[T\|alias]]`、md リンクの `.md#見出し` / `.MD` / 添付リンク（`Embeds2.md`）
  - callout 内コードブロック・ネストした callout・コードをまたぐ `%%` コメント（`CalloutCode.md`）
  - 大文字小文字違いの wikilink（`CaseLink.md`）
  - 非 YAML frontmatter は skipped になり vault 全体は止まらない（`BadFrontmatter.md`）
- `Phase4/`（v0.4.1 の検証用）: 直下にノートの無い中間フォルダ（`Deep/`）、数値の `title`、HTML コメント、山括弧パス・タイトル付き画像、インライン脚注、同じノート内リンク、ブロック ID、リスト内 callout（`Edge.md`）
- `Phase5/`（v0.5.0 の検証用）: ページメンション・表示名付きリンク・他ノート／同じノート内の見出しリンク、Markdown 形式でだけ参照される画像と CSV 添付（`Links.md`）
- `Phase6/Dataview/`（v0.6.0 の検証用）: frontmatter は `status` だけで、`priority::` `owner::` `[due:: …]` の Dataview インラインフィールドを持つ 3 ノート（DB 化が提案され、プロパティになる）
