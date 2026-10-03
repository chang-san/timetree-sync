# TimeTree → Google カレンダー同期 (GAS)

TimeTree(家族)の予定を Google カレンダーへ一方向コピーする。Google側に入れば Nest Hub などでそのまま表示できる。

## セットアップ

1. https://script.google.com で新規プロジェクトを作成
2. `Code.gs` の中身を貼り付け。「プロジェクトの設定」で「appsscript.json を表示」をONにして `appsscript.json` も置き換える
   (または左の「サービス」から **Google Calendar API** を追加)
3. 「プロジェクトの設定 → スクリプトプロパティ」に登録
   - `TT_EMAIL` / `TT_PASSWORD` : TimeTreeのメールとパスワード
   - `TT_CALENDAR` : 同期したい TimeTree カレンダー名(省略可)
   - `GCAL_ID` : 同期先(省略すると「TimeTree」カレンダーを自動作成)
4. `sync` を手動実行して権限を承認 → ログで `created=...` を確認
5. `installTrigger` を1回実行(15分ごとに自動同期)

## 注意

- **非公式API**: TimeTree公式APIは2023年末に終了。Web版が使う非公式エンドポイントなので、壊れる可能性あり。
- TimeTreeを**Google/Apple/LINEログイン**で使っている場合、メール+パスワードのログインはできない。TimeTree設定でパスワードを設定するか、同期用の別アカウントをカレンダーに招待すること。
- 同期で作った予定にだけ目印(extendedProperty)を付けており、**その目印付きだけ**を更新・削除する。同じGoogleカレンダーに手で入れた予定は触らない(ただし専用カレンダー推奨)。
- 終日予定の終了日、繰り返し予定(RRULE/EXDATE)の扱いは初回実行時に実際の予定で確認すること。
- 未検証: この環境からTimeTreeに接続できないため、実機テストはまだ。

## GitHub Actions で自動デプロイ

`main` に push すると `clasp push` でGASへ反映される(`.github/workflows/deploy.yml`)。

1. https://script.google.com/home/usersettings で **Google Apps Script API** をオンにする
2. ローカルで一度 `npx @google/clasp@3 login` を実行(ブラウザでGoogle認証) → `~/.clasprc.json` ができる
3. GASプロジェクトの「プロジェクトの設定」から **スクリプトID** をコピー
4. GitHubリポジトリの Settings → Secrets and variables → Actions に登録
   - `CLASPRC_JSON` : `~/.clasprc.json` の中身まるごと
   - `GAS_SCRIPT_ID` : 手順3のスクリプトID
5. 以降は `main` へのpushで自動反映(Actions タブから手動実行も可)

反映されないもの: スクリプトプロパティ(メール/パスワード等)とトリガー。ここは初回に手動で設定する(`installTrigger` を1回実行)。
`CLASPRC_JSON` はGoogleアカウントの権限を持つので、リポジトリはprivateのままにし、他人に見せないこと。
