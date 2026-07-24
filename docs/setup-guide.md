# 祖母見守りシステム 構築手順書

SwitchBotプラグミニ + GAS + LINE Messaging API による「異常時のみLINE家族グループに通知」するデッドマンスイッチ型見守りシステム。

## 全体アーキテクチャ

```
[祖母宅]
電気ポット ─ SwitchBotプラグミニ ─ Wi-Fi（楽天SIM + L11ルーター）
                                        │
                                 SwitchBotクラウド
                                        │ (API v1.1)
[クラウド・無料]                         │
Google Apps Script ──毎30分── 電力値を取得しスプレッドシートに記録
        │
        ├─ 毎朝10:00: 当日の使用形跡チェック → なければアラート
        └─ 毎週日曜20:00: 週次サマリー
                │
                ▼ (LINE Messaging API push)
[家族LINEグループ]  母・叔母・孫 全員に同時通知
```

**設計方針**: 正常時は静かに。異常時（朝までにポット未使用）のみアラート。週1回だけ生存サマリーを流してシステム自体の死活も家族が確認できるようにする。

**月間コスト**: 0円（LINE無料枠 月200通のうち使用は月5〜10通程度 / GAS・スプレッドシート無料）

---

## 買い物リスト

| 品目 | 価格目安 | 備考 |
|---|---|---|
| SwitchBotプラグミニ | 約2,000円 | 電力計測対応モデルであること |
| （祖母宅にWi-Fiがない場合）楽天SIM + 中古L11 | 月3,278円 + 端末数千円 | 2.4GHz帯が使えればなんでも可 |

---

## Phase 1: プラグ設置とアプリ設定（設置当日・約30分）

1. 自分のスマホに **SwitchBotアプリ** をインストールし、アカウント作成
2. 祖母宅で、**電気ポット**（または毎日必ず使う家電）のコンセントにプラグミニを挟む
3. アプリ →「＋」→ プラグミニを追加 → 祖母宅のWi-Fiに接続
   - ⚠️ **2.4GHz帯のみ対応**。L11のSSIDが5GHz/2.4GHz分離されている場合は2.4GHz側を選ぶ
4. 動作確認: ポットで湯を沸かし、アプリの電力表示が跳ね上がる（ポットなら700〜1300W）ことを確認
5. **つなぎの通知設定**（Phase 4完成までの暫定運用）:
   - アプリのオートメーションで「電力が 500W を超えたら → スマホにプッシュ通知」を作成
   - これだけで「今朝ポットが使われた」が毎日わかる状態になる

> メモ: しきい値はポットの実測値に合わせて調整。保温時は数十W、湯沸かし時に大電力になるので、その中間（例: 500W）に設定する。

---

## Phase 2: SwitchBot APIトークン取得（5分）

1. SwitchBotアプリ → プロフィール → 設定
2. 「アプリバージョン」を **10回連続タップ** → 「開発者向けオプション」が出現
3. 開発者向けオプションを開き、**トークン** と **クライアントシークレット** を控える

---

## Phase 3: LINE公式アカウント（bot）作成（15分）

1. [LINE Developers](https://developers.line.biz/) にLINEアカウントでログイン
2. プロバイダーを新規作成（名前は任意。例: `家族見守り`）
3. **Messaging APIチャネル** を作成
   - チャネル名: 例「みまもりくん」（グループでの表示名になる）
4. チャネル作成後、[LINE Official Account Manager](https://manager.line.biz/) を開き、対象アカウントの **設定 → アカウント設定** で:
   - ✅ **「グループ・複数人トークへの参加を許可する」を ON**（デフォルトOFF。最重要）
5. **応答設定** で:
   - 応答メッセージ: **OFF**（自動返信がグループの雑音になるため）
   - Webhook: **ON**
6. LINE Developersコンソールに戻り、Messaging API設定タブで **チャネルアクセストークン（長期）** を発行して控える

---

## Phase 4: GASプロジェクト作成（30分）

### 4-1. プロジェクト準備

1. [Googleスプレッドシート](https://sheets.new) を新規作成。名前: `見守りログ`
2. シート名を `log` に変更し、1行目に見出し: `timestamp` / `power_w` / `daily_kwh`
3. 拡張機能 → Apps Script を開く
4. 後述のコードを `コード.gs` に全量貼り付け
5. プロジェクトの設定（歯車アイコン）→ **スクリプトプロパティ** に以下を登録:

| プロパティ名 | 値 |
|---|---|
| `SWITCHBOT_TOKEN` | Phase 2のトークン |
| `SWITCHBOT_SECRET` | Phase 2のシークレット |
| `LINE_TOKEN` | Phase 3のチャネルアクセストークン |
| `PLUG_DEVICE_ID` | （4-3で取得後に登録） |
| `LINE_GROUP_ID` | （Phase 5で取得後に登録） |
| `POWER_THRESHOLD` | `500`（W。ポットの湯沸かし判定しきい値） |

### 4-2. コード全量

```javascript
// ============================================================
// 見守りシステム: SwitchBotプラグミニ + LINE Messaging API
// ============================================================
const PROPS = PropertiesService.getScriptProperties();
const SB_BASE = 'https://api.switch-bot.com/v1.1';

// ---------- SwitchBot API v1.1 認証ヘッダー ----------
function sbHeaders_() {
  const token = PROPS.getProperty('SWITCHBOT_TOKEN');
  const secret = PROPS.getProperty('SWITCHBOT_SECRET');
  const t = Date.now().toString();
  const nonce = Utilities.getUuid();
  const raw = token + t + nonce;
  const sigBytes = Utilities.computeHmacSha256Signature(raw, secret);
  const sign = Utilities.base64Encode(sigBytes).toUpperCase();
  return {
    'Authorization': token,
    'sign': sign,
    't': t,
    'nonce': nonce,
    'Content-Type': 'application/json'
  };
}

// ---------- 初回のみ実行: デバイスID取得 ----------
function listDevices() {
  const res = UrlFetchApp.fetch(SB_BASE + '/devices', { headers: sbHeaders_() });
  const body = JSON.parse(res.getContentText());
  body.body.deviceList.forEach(d =>
    Logger.log(`${d.deviceName} | ${d.deviceType} | ${d.deviceId}`));
  // → 表示された Plug Mini の deviceId をスクリプトプロパティ
  //   PLUG_DEVICE_ID に登録する
}

// ---------- 毎30分: 電力値を記録 ----------
function collectPower() {
  const deviceId = PROPS.getProperty('PLUG_DEVICE_ID');
  const res = UrlFetchApp.fetch(
    `${SB_BASE}/devices/${deviceId}/status`, { headers: sbHeaders_() });
  const body = JSON.parse(res.getContentText()).body;
  // プラグミニ: weight = 現在の負荷電力(W), electricityOfDay = 当日累計(分単位表記の機種差あり)
  const sheet = SpreadsheetApp.getActive().getSheetByName('log');
  sheet.appendRow([new Date(), body.weight, body.electricityOfDay || '']);
}

// ---------- 毎朝10:00: 生存判定 ----------
function morningCheck() {
  const threshold = Number(PROPS.getProperty('POWER_THRESHOLD') || 500);
  const sheet = SpreadsheetApp.getActive().getSheetByName('log');
  const today0 = new Date();
  today0.setHours(0, 0, 0, 0);

  const rows = sheet.getDataRange().getValues().slice(1); // 見出し除外
  const todayRows = rows.filter(r => r[0] instanceof Date && r[0] >= today0);

  // ケース1: 記録自体がない → システム側の異常
  if (todayRows.length === 0) {
    pushLine_('⚠️【システム異常】今日の電力データが取得できていません。' +
      'Wi-Fiルーターかプラグの電源、GASのエラーを確認してください。');
    return;
  }
  // ケース2: 記録はあるが使用形跡がない → 本来のアラート
  const used = todayRows.some(r => Number(r[1]) >= threshold);
  if (!used) {
    pushLine_('🔔【見守りアラート】今朝はまだ電気ポットの使用が確認できていません' +
      '（0:00〜10:00）。念のため連絡してみてください。\n' +
      '手順: ①母さんが電話 → ②30分以内に連絡つかなければ訪問');
  }
  // 使用形跡あり → 静かに何もしない（正常）
}

// ---------- 毎週日曜20:00: 週次サマリー ----------
function weeklySummary() {
  const threshold = Number(PROPS.getProperty('POWER_THRESHOLD') || 500);
  const sheet = SpreadsheetApp.getActive().getSheetByName('log');
  const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = sheet.getDataRange().getValues().slice(1)
    .filter(r => r[0] instanceof Date && r[0] >= from);

  const days = new Set(
    rows.filter(r => Number(r[1]) >= threshold)
        .map(r => Utilities.formatDate(r[0], 'Asia/Tokyo', 'MM/dd')));

  pushLine_(`📋【週次レポート】この1週間、7日中 ${days.size}日 で` +
    `ポットの使用を確認しました。システムは正常稼働中です。`);

  // ログの肥大化防止: 30日より古い行を削除
  pruneOldRows_(sheet, 30);
}

function pruneOldRows_(sheet, keepDays) {
  const limit = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000);
  const values = sheet.getDataRange().getValues();
  let deleteCount = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] instanceof Date && values[i][0] < limit) deleteCount++;
    else break; // 時系列順なので最初の新しい行で打ち切り
  }
  if (deleteCount > 0) sheet.deleteRows(2, deleteCount);
}

// ---------- LINE push（グループ宛て） ----------
function pushLine_(text) {
  const groupId = PROPS.getProperty('LINE_GROUP_ID');
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    headers: { 'Authorization': 'Bearer ' + PROPS.getProperty('LINE_TOKEN') },
    contentType: 'application/json',
    payload: JSON.stringify({
      to: groupId,
      messages: [{ type: 'text', text: text }]
    }),
    muteHttpExceptions: true
  });
}

// ---------- Webhook受信: groupId取得用 ----------
// Webアプリとしてデプロイし、URLをLINE DevelopersのWebhook URLに設定。
// botをグループに招待するか、グループで誰かが発言すると
// ログ（実行数 → doPost のログ）に groupId が出力される。
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    (data.events || []).forEach(ev => {
      if (ev.source && ev.source.groupId) {
        console.log('groupId: ' + ev.source.groupId);
      }
    });
  } catch (err) {
    console.log('parse error: ' + err);
  }
  return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- 動作テスト用 ----------
function testLine() {
  pushLine_('✅ テスト通知です。見守りシステムのセットアップ中。');
}
```

### 4-3. デバイスID取得

1. エディタで `listDevices` を選択して実行（初回はGoogleの権限承認あり）
2. ログに出た **Plug Mini の deviceId** をスクリプトプロパティ `PLUG_DEVICE_ID` に登録
3. `collectPower` を手動実行し、スプレッドシートに1行追加されることを確認

---

## Phase 5: LINEグループ作成と groupId 取得（15分）

1. GASエディタ → **デプロイ → 新しいデプロイ → ウェブアプリ**
   - 実行ユーザー: 自分 / アクセスできるユーザー: **全員**
   - 発行された URL を控える
2. LINE Developers → Messaging API設定 → **Webhook URL** に貼り付け → 検証 → 「Webhookの利用」ON
3. LINEアプリで家族グループを作成（母・叔母・自分などを招待）
4. グループに **botアカウント（みまもりくん）を招待**
5. グループで誰かが適当に1回発言する
6. GASエディタ → 左メニュー「実行数」→ `doPost` の実行ログを開き、`groupId: Cxxxx...` を確認
7. その値をスクリプトプロパティ `LINE_GROUP_ID` に登録
8. `testLine` を実行 → **グループにテスト通知が届けば成功** 🎉
9. （任意）groupId取得後、Webhookは不要なら LINE Developers 側でOFFにしてよい

---

## Phase 6: トリガー設定（5分）

GASエディタ → 左メニュー「トリガー」→ 以下3件を追加:

| 関数 | 種類 | タイミング |
|---|---|---|
| `collectPower` | 時間主導型 | **30分ごと** |
| `morningCheck` | 時間主導型・日付ベース | **午前10〜11時** |
| `weeklySummary` | 時間主導型・週ベース | **日曜 20〜21時** |

---

## 運用開始チェックリスト

- [ ] ポット湯沸かし時にスプレッドシートの `power_w` がしきい値(500W)を超えている
- [ ] `testLine` でグループ全員に通知が届いた
- [ ] しきい値未満の状態で `morningCheck` を手動実行し、アラートが届くことを確認
- [ ] 家族グループに「アラートが来たら ①母が電話 → ②連絡つかなければ訪問」の申し合わせを固定メッセージ（アナウンス）にしておく
- [ ] 祖母様に「電気の使いすぎを見るための小さい機械」と説明済み
- [ ] プラグを挿すコンセント周りのホコリを掃除した（トラッキング予防）

---

## トラブルシューティング

| 症状 | 原因と対処 |
|---|---|
| プラグがWi-Fiに繋がらない | 5GHz帯に繋ごうとしている。2.4GHz SSIDを選ぶ |
| SwitchBot APIが401/403 | sign生成の問題。トークン/シークレットの前後の空白混入を確認 |
| APIが `Device internal error` | プラグがオフラインの可能性。祖母宅ルーターの再起動 |
| doPostのログにgroupIdが出ない | ①アカウント設定の「グループ参加を許可」がOFF ②Webhook URLが古いデプロイ（デプロイし直したらURLが変わる点に注意） |
| LINE通知が届かない | チャネルアクセストークンの再発行で旧トークンが失効していないか / 無料枠(月200通)超過がないか |
| 毎朝アラートが誤報になる | しきい値が高すぎる。ポット湯沸かし時の実測Wに合わせて`POWER_THRESHOLD`を下げる。または祖母様の生活時間に合わせ`morningCheck`の時刻を後ろ倒し |
| 停電・回線断が心配 | `morningCheck`の「ケース1（データなし）」がシステム異常として検知する。アラート文言どおりルーターとプラグの電源を確認 |

---

## 将来の拡張アイデア

- **センサー追加**: SwitchBot人感センサー(約2,500円)+ハブミニを追加すれば、同じGAS/LINE基盤に「トイレの動体検知」を相乗りできる（判定ロジックのOR条件に足すだけ）
- **火災対策**: SwitchBotスマート煙感知器を追加し、煙検知→同グループに即時通知
- **応答確認**: アラートにLINEの返信を組み合わせ、「誰が対応中か」をbotが復唱する運用
