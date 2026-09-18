# YouTube Audio Stream Probe

公開YouTube動画について、`yt-dlp`や`youtube-dl`系ライブラリを使わず、YouTube.js (`youtubei.js`) でaudio-onlyストリームを解決できるか調べるローカル検証CLIです。

これはダウンロードサービスではありません。次の3段階を分けて記録し、失敗箇所を特定するための診断ツールです。

1. InnerTubeから期限付き`googlevideo.com` URLを取得できたか
2. そのURLから実際にバイトを読めたか
3. FFmpegで先頭10秒をWAVへ変換できたか

非公開、年齢制限、メンバー限定、地域制限などのアクセス制御を迂回する機能はありません。CLIはCookie、Googleログイン、PO Tokenを使用しません。Render診断には任意のPO Token実験モードがあります。自分が利用権限を持つ動画、または検証利用が許可された公開動画だけで使用してください。YouTubeの利用規約や権利者の条件にも従ってください。

## 必要環境

- Node.js 20以上
- FFmpeg（`ffmpeg`コマンドにPATHが通っていること）

```powershell
npm install
npm test
```

## 実行

自動フォールバックは`ANDROID_VR`、`IOS`、`WEB`の順で、全工程に初めて成功した時点で停止します。

```powershell
npm run probe -- "https://www.youtube.com/watch?v=VIDEO_ID"
```

クライアントごとの結果を比較する場合はカンマ区切りで指定します。この場合は成功しても全クライアントを試します。

```powershell
npm run probe -- "https://youtu.be/VIDEO_ID" --clients ANDROID_VR,IOS,WEB
```

複数動画も一度に渡せます。

```powershell
npm run probe -- VIDEO_ID_1 VIDEO_ID_2 VIDEO_ID_3 --clients ANDROID_VR,IOS
```

主なオプションは`npm run probe -- --help`で確認できます。

## 出力

`output/`に以下を生成します。

- `<videoId>_<client>_10s.wav`: 成功した10秒WAV（PCM 16-bit、44.1kHz、stereo）
- `probe-<timestamp>.json`: 全工程の詳細と成功率

JSONでは次の値を別々に確認してください。

- `metadataSuccess`: InnerTube応答を取得できた
- `streamUrlSuccess`: audio-onlyの直URLを解決できた
- `googlevideoSuccess`: URLから実データを読めた
- `ffmpegSuccess`: WAV変換に成功した
- `playability`: `OK`、`LOGIN_REQUIRED`、`UNPLAYABLE`など
- `formats`: audio-only format一覧
- `selectedFormat`: 選択したitag、MIME、codec、bitrate等
- `streamExpiry`: URLの期限と残り秒数
- `error.code`: 分類した失敗理由

検証目的のため、JSONには期限付きストリームURL全体が入ります。共有前に削除してください。URLは通常、取得元IP等の条件に結び付く一時URLであり、恒久保存には使えません。

## InnerTubeクライアント

`ANDROID_VR`、`IOS`などは、YouTube内部APIへ申告するクライアント種別です。クライアントごとに返るformatや必要なトークンが異なる場合があります。特定クライアントが常に成功する保証はないため、本ツールは固定せず実測します。

## エラーの読み方

- `NO_AUDIO_FORMAT`: metadataは取れたがaudio-only formatがない
- `NO_URL`: formatはあるが直URLを解決できない
- `SIGNATURE_DECIPHER`: Player JavaScriptの署名処理に失敗
- `PO_TOKEN_REQUIRED`: Proof of Origin Tokenが必要な可能性
- `HTTP_403`: 直URLは得たがGoogleVideoが拒否
- `LOGIN_REQUIRED` / `UNPLAYABLE`: YouTube側の再生可否判定
- `TIMEOUT`: HTTPまたはFFmpegが時間内に完了しない
- `FFMPEG_ERROR`: URL入力または変換処理に失敗

## ローカルと公開サーバーの差

ローカルPCで成功しても、RenderやVPSなどのデータセンターIPでは`googlevideo.com`側が403を返すことがあります。また、URL解決時と音声取得時で送信元IPやネットワーク経路が変わる構成では失敗しやすくなります。

Pythonアプリへ組み込む場合は、まず本CLIを`subprocess`で呼び出してJSONを受け取る構成が最小です。ただし公開版では、URLをPythonへ返して別ホストから取得するより、Node側とFFmpegを同じ実行環境・同じネットワーク出口に置く方が検証条件を保ちやすくなります。

一部のGoogleVideo URLは、FFmpegがURLを直接開くと403でも、YouTube.js相当のHTTPヘッダーとRangeリクエストなら取得できます。そのため本CLIは一時ファイルへ全体保存せず、Node.jsでRange取得した先頭部分をFFmpegの標準入力へストリームします。

YouTube.jsは非公式のInnerTubeクライアントで、YouTubeの仕様変更により突然動かなくなる可能性があります。依存バージョンは`18.0.0`に固定しています。

## Render検証サービス

現在の`Dockerfile`は、Cloudflareとの分業検証に使う軽量Node.jsサービスです。起動時の重いマトリクス検証は既定で実行しません。`RUN_STARTUP_VALIDATION=true`を明示した場合だけ、固定3動画を複数のInnerTubeクライアントで検証します。`TEST_CLIENTS`環境変数をカンマ区切りで設定すると対象を変更できます。

既定の`SESSION_MODE=dedicated`では、クライアントごとに専用Session、User-Agent、Visitor Dataを作ります。比較用の`SESSION_MODE=override`では、共通WEB Sessionにリクエスト単位のclient指定を適用します。`GENERATE_SESSION_LOCALLY=true`を指定すると、YouTubeからSession dataを取得せずローカル生成する条件も比較できます。

- `/health`: 実行状況
- `/report`: 期限付きストリームURLを除いた検証結果
- `POST /api/decipher`: Cloudflare側で取得したGoogleVideo URLの`n`値だけをPlayer JavaScriptで変換
- `/`: 簡易ステータス画面

RenderではDocker Web Serviceとしてデプロイしてください。`render.yaml`からBlueprintとして作成することもできます。`RUN_STARTUP_VALIDATION=true`の場合、検証はデプロイごとに一度実行され、結果はインスタンスのメモリに保持されます。

`DECIPHER_TOKEN`を設定すると、`/api/decipher`は同じ値の`Authorization: Bearer ...`を要求します。本番では必ずCloudflare WorkerとRenderの双方に共有Secretとして設定してください。GoogleのCookieやアカウント情報ではありません。

## Render統合サービス

`Dockerfile.integrated`は、MR処理用PythonアプリとYouTube内部処理用Node.jsを1つのRenderサービスへまとめる本番候補です。Nodeの重い処理は常駐させず、署名済みの`/api/pot`または`/api/decipher`要求を受けた時だけ子プロセスで起動し、処理後に終了します。要求は1件ずつ実行されるため、MR解析と複数のNode処理が同時にメモリを消費しにくい構成です。

Renderの新規Docker Web Serviceでは、リポジトリルートを指定し、Dockerfile Pathを`Dockerfile.integrated`、Health Check Pathを`/health`にします。最低限、次のSecretを設定します。

- `YT_AUDIO_WORKER_TOKEN`: Cloudflare Workerの`WORKER_TOKEN`と同じ値
- `MEDIA_SIGNING_KEY`: 十分に長いランダム値

`INTEGRATED_NODE_GATEWAY_URL`、低メモリ設定、ポート設定はDockerfileに安全な既定値があります。ローカル静的UIから試験する間は、`FRONTEND_ORIGINS`に`http://127.0.0.1:4173,http://localhost:4173`を設定します。

新サービスの`/health`で`node_gateway.status`が`ok`になり、実動画を複数回処理できるまでは既存のPythonサービスとNodeサービスを停止しないでください。Cloudflare Workerの`RENDER_DECIPHER_URL`を新サービスの`/api/decipher`へ切り替えて安定性を確認した後、旧サービスをSuspendします。

追加の診断用環境変数:

- `PO_TOKEN_MODE=webpo`: `bgutils-js`で同一IPのWeb PO Tokenを生成し、GoogleVideo URLへ付与
- `SESSION_TOKEN_URL=http://127.0.0.1:8080/token`: 同一コンテナのChromium trusted-session generatorからPO TokenとVisitor Dataを取得

これらは検証用です。Render SingaporeではどちらもPlayer段階の`LOGIN_REQUIRED`を解消できませんでした。

## Cloudflare Edge分業プローブ

`scripts/cloudflare-playground-probe.mjs`は、アカウント不要のCloudflare Workers Playgroundに一時Workerを作成し、watch HTML取得、Renderでの`n`変換、同じCloudflare出口からのGoogleVideo Range取得を検証します。

```powershell
node scripts/cloudflare-playground-probe.mjs VIDEO_ID https://YOUR-RENDER-SERVICE/api/decipher 1 OPTIONAL_SHARED_TOKEN
```

固定公開動画では、Cloudflare watch応答が`OK`だった試行はすべてHTTP 206の音声取得まで完走しました。ただしCloudflare出口によって`LOGIN_REQUIRED`または429になる試行があり、同じWorker内の再試行やYouTubeホスト・InnerTubeクライアント変更では解消しませんでした。詳しい実測値は`VALIDATION.md`に記録しています。

## 地域分散Durable Object

`cloudflare-worker/`に、本番候補となるCoordinator Workerと地域固定Durable Objectを実装しています。Coordinatorは`apac-ne`、`apac-se`、`weur`、`enam`を順に試し、最初に成功した音声レスポンスをストリームします。視聴ページ取得とGoogleVideo取得を同じDurable Objectで行うため、期限付きURLを別のネットワーク出口へ持ち出しません。

```powershell
npm run worker:check
npm run worker:dev
```

ブラウザへ共有Secretを置かないため、公開時はPythonバックエンドからWorkerの`/audio`を呼びます。利用者側の操作は従来どおりYouTube URLの貼り付けだけです。詳しい設定は`cloudflare-worker/README.md`を参照してください。

匿名一時配置での実測では、Coordinator経由の3試行すべてがHTTP 206の音声取得まで成功し、`apac-se`と`weur`が成功経路として使われました。

恒久配置後の最終試験でも`apac-se`経由でHTTP 206、`audio/mp4`、itag 140の取得に成功しています。公開Workerのヘルスチェックは `https://yt-audio-regional-resolver.youtube-audio-stream-probe.workers.dev/health` です。

## ブラウザ側取得の実証

`browser-probe/`は、Chromium拡張のService WorkerからGoogleVideoをRange取得できるかを確認する最小ハーネスです。別途[LuanRT/ytc-bridge](https://github.com/LuanRT/ytc-bridge)をビルドして未パック拡張として読み込み、次を実行します。

```powershell
node browser-probe/server.js
```

拡張を入れたブラウザで`http://127.0.0.1:18181`を開くと、YouTube.jsのブラウザ版が固定公開動画のaudio-only URLをブラウザ内で解決し、先頭8KiBを拡張経由で取得します。Node側は静的ファイル配信と結果受信だけで、YouTubeへの解決要求は行いません。実測では無改造の`ytc-bridge` 1.2.0と`ANDROID_VR`でplayability `OK`、HTTP 206、8192 bytes、`audio/mp4`、itag 140として成功しました。

本番統合では、期限付きURLをRenderへ送るのではなく、拡張が音声バイトを取得してRenderへアップロードします。これによりYouTube/GoogleVideoへの接続はユーザー側ネットワークで完結し、RenderはMR処理だけを担当できます。

ただし、この方式はブラウザ拡張を導入できないiPhoneユーザーや「URLを貼るだけ」という本アプリの製品要件には適合しません。現在は比較対象となる技術実証として残しています。
