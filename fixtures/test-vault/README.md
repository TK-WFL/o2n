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

**20MiB超ファイルについて**: リポジトリを肥大化させないため、20MiB超のダミーファイルはコミットせず、
`packages/core/src/__tests__/` 内のテストが実行時に一時ディレクトリへ動的生成する
（`fixtures/test-vault` を汚さない）。
