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

## 追加のRender検証

専用Sessionをクライアントごとに作成し、15クライアント×3動画の45条件を比較しました。metadata応答は31/45でしたが、直URLは0/45でした。`ANDROID_VR`、`IOS`、`WEB`、`MWEB`、`ANDROID`、`TV`、`VISIONOS`は主に`LOGIN_REQUIRED`、埋め込み系は`UNPLAYABLE`または動画利用不可、Android Music/Studio系はPlayer APIのHTTP 400でした。

YouTubeへSession dataを問い合わせずVisitor Dataをローカル生成する条件を、Singapore、Oregon、Frankfurtで比較しました。

| リージョン | metadata | 直URL | 主結果 |
|---|---:|---:|---|
| Singapore | 12/15 | 0/15 | `LOGIN_REQUIRED` / `UNPLAYABLE` |
| Oregon | 12/15 | 0/15 | `LOGIN_REQUIRED` / `UNPLAYABLE` |
| Frankfurt | 0/15 | 0/15 | Player API HTTP 403 |

リージョン変更、クライアント変更、専用Session、ローカルVisitor Dataだけでは改善しませんでした。

## PO Token検証

`bgutils-js`で同じ実行元IPからWeb PO Tokenを生成し、GoogleVideo URLへ`pot`を付与する実験を追加しました。

- ローカル: MWEBでmetadata、直URL、HTTP 206、FFmpeg 10秒変換まで成功
- Render Singapore: PO Token生成は成功したが、Player応答が`LOGIN_REQUIRED`のまま。直URL生成前で停止

このTokenはGoogleVideo側の検証には使えますが、今回のRender IPで先に発生するPlayerのbot判定は解消しませんでした。

さらに同一コンテナ内でChromiumを起動し、実際の埋め込みPlayer要求から`visitor_data`とセッションPO Tokenを取得するtrusted-session方式を試しました。通常埋め込み、privacy-enhanced埋め込み、watchページの3経路すべてでPlayer要素とPlayer API要求が現れず、Tokenを生成できませんでした。

## ブラウザ拡張経由の検証

`LuanRT/ytc-bridge` 1.2.0（commit `8f53620fb48daf197e04f69a0b5406132eaf6f8e`、無改造）を隔離したEdgeプロファイルへ読み込みました。YouTube.jsのブラウザ版へ拡張の`proxyFetch`を渡し、URL解決から音声取得までブラウザ内で実行しました。

| 項目 | 結果 |
|---|---|
| 拡張検出 | 成功 |
| ブラウザ内InnerTube解決 | 成功（`ANDROID_VR`） |
| playability | `OK` |
| GoogleVideo | HTTP 206 |
| 取得量 | 8192 bytes |
| Content-Type | `audio/mp4` |
| format | itag 140 / `mp4a.40.2` |

この結果から、公開RenderサーバーでYouTube取得を完結させるのではなく、ユーザー側ブラウザ拡張でInnerTube解決・音声取得し、取得済み音声データだけをRenderのMR処理APIへアップロードする構成が実行可能な突破口です。期限付きURLだけをRenderへ渡す方式では、再びRender IPからGoogleVideoへアクセスするため効果がありません。
