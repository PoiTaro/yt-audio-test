# YouTube Audio Stream Probe

公開YouTube動画について、`yt-dlp`や`youtube-dl`系ライブラリを使わず、YouTube.js (`youtubei.js`) でaudio-onlyストリームを解決できるか調べるローカル検証CLIです。

これはダウンロードサービスではありません。次の3段階を分けて記録し、失敗箇所を特定するための診断ツールです。

1. InnerTubeから期限付き`googlevideo.com` URLを取得できたか
2. そのURLから実際にバイトを読めたか
3. FFmpegで先頭10秒をWAVへ変換できたか

非公開、年齢制限、メンバー限定、地域制限などのアクセス制御を迂回する機能はありません。Cookie、Googleログイン、PO Tokenも使用しません。自分が利用権限を持つ動画、または検証利用が許可された公開動画だけで使用してください。YouTubeの利用規約や権利者の条件にも従ってください。

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

`Dockerfile`でNode.jsとFFmpegを同じコンテナに入れ、起動後に固定3動画を複数のInnerTubeクライアントで自動検証します。任意URLを受け付ける公開APIはありません。`TEST_CLIENTS`環境変数をカンマ区切りで設定すると対象を変更できます。

既定の`SESSION_MODE=dedicated`では、クライアントごとに専用Session、User-Agent、Visitor Dataを作ります。比較用の`SESSION_MODE=override`では、共通WEB Sessionにリクエスト単位のclient指定を適用します。`GENERATE_SESSION_LOCALLY=true`を指定すると、YouTubeからSession dataを取得せずローカル生成する条件も比較できます。

- `/health`: 実行状況
- `/report`: 期限付きストリームURLを除いた検証結果
- `/`: 簡易ステータス画面

RenderではDocker Web Serviceとしてデプロイしてください。`render.yaml`からBlueprintとして作成することもできます。検証はデプロイごとに一度実行され、結果はインスタンスのメモリに保持されます。
