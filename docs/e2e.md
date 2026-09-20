# 手動E2E手順書

実ワークスペース・実`NOTION_TOKEN`を使った検証手順。人間が実行すること
（本リポジトリの自動テストはすべてモック/dry-runで完結しており、実API呼び出しはこの手順でのみ発生する）。

## 事前準備

1. Notionでinternal integrationを作成し、シークレットを取得する
   （[https://www.notion.so/my-integrations](https://www.notion.so/my-integrations)）。
2. 移行先にする親ページを1つ用意し、作成したintegrationをそのページに接続（Connect）する。
3. 親ページのIDを控える（ページURL末尾の32文字）。
4. 環境変数を設定する:
   ```bash
   export NOTION_TOKEN=ntn_xxxxxxxx
   ```
5. `npm install && npm run build` を実行し、ビルド済みCLIを使えるようにする。

## 手順

### 1. dry-runで計画を確認する

```bash
node packages/cli/dist/index.js scan fixtures/test-vault
node packages/cli/dist/index.js plan fixtures/test-vault --parent <親ページID>
node packages/cli/dist/index.js migrate fixtures/test-vault --plan fixtures/test-vault/.o2n/plan.json --dry-run
```

- 書き込みAPIが1回も呼ばれないこと（Notion側に何も作成されないこと）を目視で確認する。

### 2. 実行する

```bash
node packages/cli/dist/index.js migrate fixtures/test-vault --plan fixtures/test-vault/.o2n/plan.json
```

確認項目:
- [ ] フォルダ構造どおりにNotionページ（またはDB）が作成される
- [ ] `Note A.md` の各種wikilink（通常/エイリアス/見出し/ブロック参照/埋め込み）が期待どおり変換される
- [ ] `Attachments/image.png`, `Attachments/document.pdf` がページ内の元の位置に表示される
- [ ] `Callouts.md` の各calloutが期待するicon/colorで表示される
- [ ] `DatabaseFolder/` がデータベースとして作成され、`status`/`priority`/`due` がプロパティになる
- [ ] `日本語フォルダ/日本語ノート.md`, `絵文字🎉ノート.md` が正しく移行される
- [ ] `Canvas/diagram.canvas` がスキップされ、レポートに記録される

### 3. 中断・再開のテスト

1. 大きめのvault（または`fixtures/test-vault`をコピーして水増ししたもの）で移行を開始する。
2. 移行途中（Pass1完了前）に `Ctrl+C` でプロセスを強制終了する。
3. 再実行する:
   ```bash
   node packages/cli/dist/index.js resume fixtures/test-vault
   ```
4. 確認項目:
   - [ ] 既に作成済みのページが二重作成されない
   - [ ] 未完了だったノートのみ処理が継続される
   - [ ] 最終的に全件 `done` になる

### 4. 429リトライのテスト（可能であれば）

- 短時間に大量のノートを含むvaultを移行し、429が発生してもバックオフの上で完走することを確認する
  （429を狙って人工的に発生させることは通常困難なため、大規模vaultでの自然発生を観察する）。

### 5. 検証・レポート確認

```bash
node packages/cli/dist/index.js verify fixtures/test-vault
node packages/cli/dist/index.js report fixtures/test-vault
```

### 6. 未確定事項の検証

実ワークスペースで確認済み・未確認の事項は `docs/questions.md` に集約している（以前 `README.md` に
あった「§16 未確定事項」セクションは同ファイルへ統合済み）。新たに挙動を確認した場合は
`docs/questions.md` に追記すること。現時点で実ワークスペース未確認の項目:

- マルチパートアップロード（20 MiB 超）の実機確認（`/complete` 呼び出しは #65 で実装済み）
- 見出し h5/h6 が Notion 側でどう扱われるか（#73）
- `<details>` 内に `<callout>` を入れられるか（#75）

### 7. MCPサーバーの動作確認

Claude Desktop の設定ファイルに以下を追加し、再起動する:

```json
{
  "mcpServers": {
    "o2n": {
      "command": "node",
      "args": ["<このリポジトリの絶対パス>/packages/mcp-server/dist/index.js"],
      "env": { "NOTION_TOKEN": "ntn_xxxxxxxx" }
    }
  }
}
```

確認項目:
- [ ] `scan_vault` → `get_plan` → `update_plan` → `start_migration` → `migration_status` →
      `get_report` の一連の対話が完了する
- [ ] `start_migration` を呼ぶ前にClaudeがユーザーへ確認を取ること
