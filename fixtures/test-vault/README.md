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

**20MiB超ファイル（マルチパート）について**: リポジトリを肥大化させないため、20MiB超のダミーファイルは
コミットしない。マルチパート経路のテストは `packages/core/src/__tests__/migrator.test.ts` が
`multipartPartSizeBytes` オプションでパートサイズを1 KiBに縮小し、一時ディレクトリに生成した数KiBの
ファイルで「分割送信 → `/complete`」の流れを検証している（`fixtures/test-vault` を汚さない）。
