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

## 5. マルチパートファイルアップロードの完了フローは簡略化

**該当**: `packages/core/src/migrator.ts` `uploadFile`

仕様書§4.1・参考リンクのマルチパートアップロード仕様ページを本セッションでは参照できなかったため、
「各パートを `POST /v1/file_uploads/:id/send` に順次送信する」という一般的なマルチパートアップロードの
パターンで実装した。実際のAPIが「全パート送信後に別途completeエンドポイントを呼ぶ」等の追加ステップを
要求する場合は、この部分の修正が必要（`docs/e2e.md` の検証手順で確認すること）。

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
