# Local validation result

検証日: 2026-09-18（Asia/Tokyo）

環境:

- Windows
- Node.js 24.19.0
- youtubei.js 18.0.0
- FFmpeg N-118586-g629e8a2425-20250301
- Cookie、ログイン、PO Tokenなし

## 結果

3本の通常公開動画を`ANDROID_VR`と`IOS`でそれぞれ検証しました。

| 工程 | ANDROID_VR | IOS | 合計 |
|---|---:|---:|---:|
| Metadata取得 | 3/3 | 3/3 | 6/6 |
| audio-only直URL取得 | 3/3 | 3/3 | 6/6 |
| GoogleVideo実データ取得 | 3/3 | 3/3 | 6/6 |
| 10秒WAV変換 | 3/3 | 3/3 | 6/6 |

生成した6個のWAVはすべて`ffprobe`で10.000秒、PCM 16-bit、44.1kHz、stereoとして確認できました。

実行コマンド:

```powershell
npm run probe -- M7lc1UVf-VE aqz-KE-bpKQ jNQXAC9IVRw --clients ANDROID_VR,IOS --seconds 10
```

詳細JSON: `output/probe-2026-09-18T00-25-53-021Z.json`

## 実装中に判明した点

同じ期限付きURLでも、64KB〜1MBのRange GETはHTTP 206で成功し、2MBを1回で要求するとHTTP 403になりました。また、この環境ではFFmpegにURLを直接渡す方式もHTTP 403でした。

そのため、現在の実装はNode.jsが最大1MBずつRange取得し、レスポンスを連結してFFmpegの標準入力へ渡します。完全ダウンロードや中間音声ファイルは作りません。この違いを吸収した状態で6/6成功しています。

これはローカル回線での一点観測です。公開サーバーのデータセンターIP、YouTube側の仕様変更、動画ごとの再生条件では結果が変わるため、公開環境でも同じCLIを実行して比較する必要があります。

## Render Singapore検証

検証日: 2026-09-18

Renderの無料Docker Web Serviceへ同じ実装をデプロイし、SingaporeリージョンのデータセンターIPから検証しました。

- サービス: `https://yt-audio-test.onrender.com`
- Node.js 22.23.2 / Linux x64
- Cookie、ログイン、PO Tokenなし
- 対象動画: 3本
- クライアント: `ANDROID_VR`、`IOS`、`WEB`、`MWEB`、`ANDROID`、`TV`

| 工程 | 成功率 |
|---|---:|
| InnerTube応答／metadata | 18/18 (100%) |
| audio-only直URL取得 | 0/18 (0%) |
| GoogleVideo実データ取得 | 0/18 (0%) |
| FFmpeg変換 | 0/18 (0%) |

全18件でplayability statusは`LOGIN_REQUIRED`、理由は「ログインして bot ではないことを確認してください」でした。format一覧や直URLが返る前の段階で止まっているため、GoogleVideo側のHTTP 403やFFmpeg処理が原因ではありません。

今回の条件では、InnerTubeクライアントを切り替えるだけではRenderのデータセンターIP判定を回避できませんでした。ローカルは同じ動画・実装・Cookieなしで成功しているため、主な差は実行元ネットワークです。
