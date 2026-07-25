# アーキテクチャ

## 全体構成

```mermaid
flowchart TD
    subgraph home["祖母宅"]
        pot["見守り対象の家電<br>(例: テレビ)"] --- plug["SwitchBot プラグミニ<br>(電力計測)"]
        plug --- router["Wi-Fiルーター<br>(2.4GHz)"]
    end

    router --> sbcloud["SwitchBot クラウド"]

    subgraph gcp["Google（無料枠）"]
        gas["Google Apps Script"]
        sheet[("スプレッドシート<br>シート: log<br>timestamp / power_w / daily_kwh")]
        props["スクリプトプロパティ<br>(トークン類・しきい値)"]
        gas --- props
        gas -- "追記 / 走査 / 古い行の削除" --> sheet
    end

    sbcloud -- "GET /v1.1/devices/{id}/status<br>HMAC-SHA256署名認証" --> gas
    gas -- "POST /v2/bot/message/push" --> line["LINE Messaging API"]
    line --> group["家族LINEグループ<br>(母・叔母・孫)"]
    group -- "Webhook (groupId取得時のみ)" --> gas
```

## 定期ジョブ

| 関数 | トリガー | 役割 |
|---|---|---|
| `collectPower` | 10分ごと | プラグの電力値を取得し `log` シートへ追記。朝の時間帯に初めて使用を確認したら家族へ1通通知（**本命の通知**） |
| `morningCheck` | 毎日 `NOTIFY_TO_HOUR` と同時刻（観察期間のログから決定。初期値 10〜11時） | 当日0:00以降のログを走査し、使用が確認できなければアラート（**セーフティネット**） |
| `weeklySummary` | 日曜 20〜21時 | 週次サマリーを1通送信し、30日超の古いログを削除 |

観察期間中は `OBSERVATION_MODE=true` を設定し、`collectPower` のみを登録する。しきい値と通知時間帯を実測で決めたうえでフラグを外し、残り2件を追加する（[README](../README.md#観察期間--しきい値と判定時刻を実測で決める) 参照）。

## 通知の設計

ハートビート型（通知＝正常）とデッドマンスイッチ型（沈黙＝正常）を組み合わせている。

| # | 通知 | 役割 | 出るタイミング |
|---|---|---|---|
| 1 | 朝の使用確認 | 本命 | `collectPower` が朝の時間帯に初めてしきい値超えを観測したとき（1日1通） |
| 2 | 見守りアラート | セーフティネット | `morningCheck` の時点で当日の使用形跡がないとき |
| 3 | システム異常 | 死活監視 | `morningCheck` の時点で当日のログが0件のとき |
| 4 | 週次サマリー | 死活監視 | 日曜20時 |

1だけでは「毎朝の通知が来ないことに家族が気づけない」ため、2で補っている。逆に2だけ（デッドマンスイッチ単独）では、家電を使わない日に必ず誤報が出る。両者を併用することで、誤報を抑えながら見落としも防ぐ設計にしている。

## シーケンス: 電力記録と朝の使用確認通知（collectPower・10分ごと）

```mermaid
sequenceDiagram
    participant T as 時間主導トリガー
    participant G as GAS (collectPower)
    participant S as SwitchBot API v1.1
    participant L as スプレッドシート(log)
    participant N as LINEグループ

    T->>G: 10分ごとに起動
    G->>G: 署名生成<br>sign = Base64(HMAC-SHA256(secret, token+t+nonce)).toUpperCase()
    G->>S: GET /devices/{deviceId}/status<br>(Authorization, sign, t, nonce)
    alt HTTPエラー / タイムアウト
        G->>G: 5秒待機
        G->>S: リトライ（1回のみ）
    end
    S-->>G: 200 OK { statusCode: 100, body: { weight, electricityOfDay } }
    Note over G: statusCode ≠ 100 なら例外<br>（HTTP 200でもAPI失敗があり得る）
    G->>L: appendRow([now, weight, electricityOfDay])

    alt weight ≥ POWER_THRESHOLD かつ<br>NOTIFY_FROM_HOUR ≤ 時 < NOTIFY_TO_HOUR かつ<br>当日未通知 かつ OBSERVATION_MODE=false
        G->>N: ☀️ 今朝 HH:mm に{家電}の使用を確認しました
        Note over G: 送信成功時のみ<br>LAST_ON_NOTIFIED_DATE を更新<br>（失敗時は次のポーリングで再試行）
    else それ以外
        Note over G,N: 通知しない
    end
```

朝の使用確認通知は「立ち上がりの検知」ではなく「**当日の通知時間帯に初めてしきい値を超えた観測**」で判定している。直前の行と比較する方式にしないのは、ログの欠測やポーリングの取りこぼしに影響されないようにするため。日付をまたいだ判定は `LAST_ON_NOTIFIED_DATE` の一致比較だけで済む。

## シーケンス: セーフティネット（morningCheck・毎朝）

```mermaid
sequenceDiagram
    participant T as 時間主導トリガー
    participant G as GAS (morningCheck)
    participant L as スプレッドシート(log)
    participant N as LINEグループ

    T->>G: NOTIFY_TO_HOUR と同時刻に起動
    G->>L: 当日0:00(JST)以降の行を走査
    L-->>G: 当日のログ行

    alt ログが0件
        G->>N: ⚠️ システム異常<br>(回線断・停電・GAS障害の切り分け文言)
    else power_w ≥ POWER_THRESHOLD の行が0件
        G->>N: 🔔 見守りアラート<br>(APPLIANCE_NAME + 実行時刻から文面生成)<br>(①電話 → ②訪問 の対応手順)
    else 使用形跡あり
        Note over G,N: 朝の使用確認通知が既に出ているため<br>ここでは通知しない
    end
```

## シーケンス: groupId取得（初回セットアップ時のみ）

```mermaid
sequenceDiagram
    participant F as 家族（グループで発言）
    participant P as LINEプラットフォーム
    participant G as GAS Webアプリ (doPost)

    Note over P,G: 事前にWebアプリをデプロイし<br>URLをWebhook URLに設定
    P->>G: POST（検証リクエスト: events=[]）
    G-->>P: 200 { status: "ok" }
    F->>P: グループで発言
    P->>G: POST（messageイベント: source.groupId あり）
    G->>G: console.log("groupId: Cxxxx...")
    G-->>P: 200 { status: "ok" }
    Note over G: ログのgroupIdを<br>スクリプトプロパティ LINE_GROUP_ID に登録
```

## エラーハンドリング方針

- **SwitchBot API**: HTTPエラー・タイムアウトは5秒間隔で1回だけリトライ。HTTP 200でもボディの `statusCode` が 100 以外なら失敗として例外を投げる。
- **各ジョブ**: 全体を try/catch で囲み、想定外エラーはエラー概要をLINEに通知する。
- **LINE送信自体の失敗**: 通知ループを避けるため例外にせず、実行ログに残すのみ（`muteHttpExceptions: true` + try/catch）。
- **設定不備**: `validateConfig_()` が不足しているスクリプトプロパティ名を列挙して例外を投げるため、セットアップ漏れが実行ログから即座に分かる。`POWER_THRESHOLD` は必須プロパティとして扱い、値が正の数でない場合も例外にする。

## しきい値と通知時間帯の決定方針

`POWER_THRESHOLD` と通知時間帯は、コード側にもドキュメント側にも「推奨値」を持たせない設計にしている。見守り対象の家電と本人の生活パターンに完全に依存し、汎用的な正解が存在しないためである。

そのため `POWER_THRESHOLD` はデフォルト値を持たない必須プロパティとした。既定値があると「設定しなくても動く」と誤読され、本人の生活に合っていないしきい値のまま静かに稼働し続けてしまう。未設定なら `collectPower` を含む全ジョブが起動直後に例外で止まり、セットアップ漏れが必ず表面化する。

`NOTIFY_FROM_HOUR` / `NOTIFY_TO_HOUR` には既定値（5〜11時）を持たせている。しきい値と違い、外れていても「通知が来ない」という安全側の失敗になり、`morningCheck` のアラートで拾えるためである。ただし観察期間のログから調整することを前提としている。

`morningCheck` の判定時刻はトリガー設定のみで決まる。`NOTIFY_TO_HOUR` と同じ時刻に揃える必要があり、ずれると「朝の通知も来ないがアラートも出ない」空白時間が生じる。見守りアラートの文面に含める時間帯表記は実行時刻（`Utilities.formatDate`）から生成するため、トリガー時刻を変更してもコードは修正不要。

対象家電の名称は `APPLIANCE_NAME`（任意、省略時 `家電`）で通知文に差し込む。家電を差し替えてもコード変更が不要な構成にしている。

## 観察期間の通知抑止

`collectPower` が朝の使用確認通知も担当するため、観察期間中にトリガーを登録すると暫定しきい値のまま通知が飛んでしまう。これを避けるため `OBSERVATION_MODE`（`true` のとき全通知を抑止）を用意している。3ジョブすべてが起動直後にこのフラグを確認する。

トリガーを登録しないことで通知を止める方式にはしていない。`collectPower` は観察期間中も回し続ける必要があるためである。

## デプロイとトリガー登録

コードの反映は `clasp push`、Webアプリの公開は `clasp deploy` で行う。Webアプリの実行ユーザーとアクセス権は `appsscript.json` の `webapp` セクション（`USER_DEPLOYING` / `ANYONE_ANONYMOUS`）で管理しており、エディタUIでの設定を不要にしている。

一方でトリガー登録は clasp では行えない。UIでの手作業に頼ると設定ミスが起きるため、`setup.gs` に登録用の関数を置き、エディタから手動実行する運用にしている。

| 関数 | 用途 |
|---|---|
| `setupObservationTriggers` | 観察期間用。`collectPower` のみ登録。`OBSERVATION_MODE` が `true` でなければ実行を拒否する |
| `setupTriggers` | 本運用用。3件を登録。`OBSERVATION_MODE` が `true` なら実行を拒否する |
| `showTriggers` | 登録済みトリガーの一覧表示 |
| `deleteAllTriggers` | このプロジェクトのトリガーを全削除 |

この方式にしている理由は3つある。

1. **`morningCheck` の時刻を `NOTIFY_TO_HOUR` から導出できる** — 前述の「揃えないと空白時間が生じる」制約を、手作業ではなくコードで保証する
2. **`OBSERVATION_MODE` の付け外し忘れを構造的に防げる** — 両関数がフラグの状態を検査して実行を拒否する
3. **設定不備をセットアップ時点で発見できる** — 両関数が先に `getConfig_()` を呼ぶ。プロパティ不足を実行時に見つけると、`notifyJobError_` が10分ごとにLINE通知を送り続けてしまう

いずれの関数も既存トリガーを削除してから登録するため、何度実行しても重複しない。

## データ保持

`log` シートは30日分のみ保持し、`weeklySummary` 実行時に30日より古い行を先頭から削除する。判定に必要なのは当日分（morningCheck）と直近7日分（weeklySummary）のみなので、30日あれば障害調査にも十分な余裕がある。
