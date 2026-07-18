---
title: Note A
tags: [test, sample]
created: 2026-01-01
url: https://example.com
rating: 5
published: true
---

# Note A

これはWikiLinkのテストです。

- 通常リンク: [[Note B]]
- エイリアス付き: [[Note B|表示名]]
- 見出しリンク: [[Note B#見出し1]]
- ブロック参照: [[Note B#^blockid1]]
- ノート埋め込み: ![[Note B]]
- 画像埋め込み: ![[image.png]]
- PDF埋め込み: ![[document.pdf]]
- md形式内部リンク: [Note Bへ](Folder1/Note%20B.md)
- 相対パス画像: ![alt text](Attachments/image.png)
- 外部URL画像: ![external](https://example.com/image.png)

==ハイライトされたテキスト==

%%これはコメントで削除されるはず%%

インラインタグ: #important

脚注のテスト[^1]です。

[^1]: これは脚注の本文です。

数式: $E = mc^2$

```mermaid
graph TD
  A --> B
```

```dataview
LIST FROM #test
```

| 列1 | 列2 |
| --- | --- |
| a | b |

- [ ] 未完了タスク
- [x] 完了タスク
