# 実装中の質問・仕様書からの逸脱点

仕様書§0の指示に基づき、実装中に生じた不明点・判断・仕様書との差分をここに集約する。

## 1. Notion SDKを使わず fetch ベースの自前HTTPクライアントを実装した

**該当**: `packages/core/src/notion-client.ts`

仕様書§3は `@notionhq/client` の使用を前提とし、「markdown系メソッド（`pages.retrieveMarkdown` /
`pages.updateMarkdown` 等）に対応」と書かれているが、本セッションはネットワークアクセスがなく
実際のSDKの型・メソッド名を確認できなかった。§0の指示（「SDKが未対応の場合はraw `client.request()` で
直接実装」）に従い、SDKには依存せず`fetch`を直接使うHTTPクライアントとして実装した。
エンドポイント・ヘッダー（`Notion-Version: 2026-03-11`）・リクエストボディは仕様書§4.1に準拠している。

`package.json`には引き続き`@notionhq/client`を依存関係として残しているが、現状コードからは未使用。
実際のワークスペースで検証後、SDKのmarkdown系メソッドが使えると判明すれば置き換えを検討する。

## 2. リンク/添付プレースホルダーの形式を変更した

**該当**: `packages/core/src/converter.ts`

仕様書§5 F4は `⟦o2n:link:リンク先相対パス⟧` という単一の相対パス埋め込み形式を示しているが、
以下のケースをこの形式だけでは表現できない:

- 同一ノートへのエイリアス違いリンク（`[[Note|表示名A]]` と `[[Note|表示名B]]` が同じページ内に複数回出現する場合）
- 見出しリンク（`[[Note#見出し]]`）の降格時の表示テキスト（`Note > 見出し`）

これらは「リンク先パス」だけでなく「そのリンク固有の表示テキスト」も保持する必要があるため、
実装では `⟦o2n:link:N⟧` / `⟦o2n:file:N⟧`（Nはノート内の出現順連番、ノートごとにリセット）を
プレースホルダーとし、実際のリンク先パス・表示テキスト・フォールバックテキストは
`ConvertNoteResult.pendingLinks` / `pendingFiles`（構造化データ）で別途保持する設計にした。
一意性・Pass2での置換ロジックという要件自体は満たしている。

## 3. `state.json` に `folders` キーを追加した

**該当**: `packages/core/src/types.ts`, `packages/core/src/state.ts`

仕様書§5 F5のstate.jsonスキーマ例には `notes` と `files` のみが示されているが、これは「例」であり
（`state.jsonスキーマ例:` という見出し）、フォルダ自体の状態（page_treeモードの親ページID、
databaseモードのDB ID・data source ID）を永続化する仕組みが無いとPass1の途中再開時に
フォルダ（親ページ/DB）を二重作成してしまう。そのため `folders: Record<string, FolderState>` を
仕様の許容範囲として追加した。既存の（folders無し）state.jsonを読み込んだ場合は空オブジェクトとして
扱われ後方互換になっている（`state.ts` `StateStore.load`参照）。

## 4. MCPの `start_migration` に `plan` パラメータが無い点の解釈

**該当**: `packages/mcp-server/src/index.ts`

仕様書§9の表では `start_migration` の入力は `vaultPath, parentPageId, dryRun` のみで、計画ファイルへの
参照が無い。`scan_vault → get_plan → update_plan → start_migration` という対話フローから、
`get_plan`/`update_plan` が `.o2n/plan.json` を暗黙に読み書きし、`start_migration` はその
既存計画ファイルを読み込んで実行する設計と解釈した（`plan-store.ts` の `loadOrCreatePlan`）。
計画が存在しない場合は `get_plan` 相当のデフォルト自動生成を `start_migration` 内でも行うようにしている。

## 5. マルチパートファイルアップロードの完了フローは簡略化（単発アップロードは実ワークスペースで検証済み）

**該当**: `packages/core/src/migrator.ts` `uploadFile`

単発アップロード（20MiB以下）は実ワークスペースで検証済み。`createFileUpload`時に`content_type`を
明示しないと、送信時に「作成時に決定された元のcontent typeと一致しない」400エラーになることが判明し、
拡張子からMIMEタイプを推定して明示するよう修正した。また、作成直後（数百ms以内）に送信すると同エラーが
発生するケースがあり、1回リトライすることで回避している。

マルチパート（20MiB超）の完了フローは「各パートを `POST /v1/file_uploads/:id/send` に順次送信する」
という一般的なパターンで実装したが、実ワークスペースでは未検証（テストファイルが小さいため）。
実際のAPIが「全パート送信後に別途completeエンドポイントを呼ぶ」等の追加ステップを要求する場合は
修正が必要。

## 6. コードブロック内のwikilink/highlight等は変換対象外にした

**該当**: `packages/core/src/converter.ts` `splitCodeFences`

仕様書には明記が無いが、フェンス付きコードブロック（\`\`\`...\`\`\`）内のテキストは
wikilink変換・ハイライト降格・コメント削除・脚注展開の対象から除外した（コードの中身を
誤って書き換えないため）。dataview/mermaidコードブロックの「そのまま保持」という挙動とも整合する。

## 7. インラインコード（バッククォート1つ）内は変換対象から除外していない

**該当**: `packages/core/src/converter.ts`

フェンス付きコードブロックとは異なり、`` `[[Note]]` `` のようなインラインコード内のwikilink等は
現状変換されてしまう（除外していない）。稀なケースと判断し実装コストとのバランスでv1では対応を見送った。
今後の改善候補。

## 8. `PATCH /v1/pages/:id/markdown` の実際のボディ形式（実ワークスペースで検証済み）

**該当**: `packages/core/src/notion-client.ts` `MarkdownUpdateBody`

当初 `{ content_updates: [{ type, old_str, new_str, ... }] }` という形式を想定していたが、実際は
操作全体を表す`type`をトップレベルに置き、対応するキーの中にネストする形式だった:

```json
{ "type": "update_content", "update_content": { "content_updates": [{ "old_str": "...", "new_str": "..." }] } }
```

`insert_content`/`replace_content`も同様の構造（`content`フィールド名、`position`のオブジェクト形式等）。
1回のPATCHで送れる操作は単一の種類のみ。

## 9. `POST /v1/databases` の実際のリクエスト形式（実ワークスペースで検証済み）

**該当**: `packages/core/src/notion-db.ts` `createDatabaseForFolder`

- `parent`に`type: 'page_id'`の明示が必須（省略すると400）
- `properties`はトップレベルではなく`initial_data_source.properties`配下に置く必要がある
- データベース行ページ作成時、`parent`に`type: 'data_source_id'`の明示も必須
- レスポンスのdata source idは`data_sources[0].id`で取得できる（想定どおり）

## 10. `PATCH /v1/blocks/:id/children` の `after` パラメータは廃止済み（実ワークスペースで検証済み）

**該当**: `packages/core/src/notion-client.ts` `appendBlockChildren`

`after`パラメータは廃止されており指定すると400になる。代わりに
`position: { type: 'after_block', after_block: { id } }`を使う。

## 11. ハイライトはネイティブの `<span color="...">` に変換する（実ワークスペースで検証済み）

**該当**: `packages/core/src/converter.ts` `convertHighlights`

`<span color="yellow_bg">text</span>`はrich_textのcolor annotationとして正しく保存されることを
実ワークスペースで確認した。当初は太字への降格を想定していたが、不要な情報劣化だったため
ネイティブハイライトに変換するよう変更した。数式（`$...$`/`$$...$$`）はそのまま渡すだけで
正しくequationオブジェクトとして保存されることも確認済み。

## 12. 添付プレースホルダーはブロックタイプを限定せず検索する（実ワークスペースで検証済み）

**該当**: `packages/core/src/migrator.ts` Pass 3

添付プレースホルダーが箇条書き行にある場合、Notionは`paragraph`ではなく`bulleted_list_item`として
ブロック化する。ブロックタイプを限定せず、プレースホルダー文字列を含むブロックを探すようにしている。

## 13. dry-run実行はstate.jsonへの書き込みを一切行わない

**該当**: `packages/core/src/state.ts` `StateStore`

dry-run実行後にstate.jsonへ書き込みが残っていると、直後の本実行が「既に作成済み」と誤判定し
実際のAPI呼び出しをスキップしてしまう不具合が実ワークスペースで見つかった。`StateStore`に
`readOnly`モードを追加し、dry-run時は既存state.jsonの読み込み（進捗表示用）のみ行い、書き込みは
一切行わないようにした。

## 14. Pass2（リンク解決）の失敗はノートを`failed`にせず`created`のまま保持する

**該当**: `packages/core/src/migrator.ts` Pass 2

Pass2が失敗した際にノート状態を`failed`にすると、resume時にPass1が「未作成」と誤判定し、
既にNotion上に作成済みのページを重複作成してしまう不具合が実ワークスペースで見つかった。
Pass2失敗時は`created`のまま保持し、次回resumeでPass2のみ再試行されるようにしている。
