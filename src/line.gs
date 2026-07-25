// line.gs: LINE Messaging API によるグループ宛てpush送信と、groupId取得用のWebhook受信。
// 送信失敗は例外にせずログに残すのみ（見守りジョブを通知障害で止めないため）。

const LINE_PUSH_URL_ = 'https://api.line.me/v2/bot/message/push';

/**
 * 家族LINEグループへテキストメッセージを1通送信する。
 * 失敗しても例外は投げず、ログに残すのみ。
 * @param {string} text 送信するメッセージ本文
 * @return {boolean} 送信に成功したか
 */
function pushLine_(text) {
  try {
    const config = getConfig_();
    const response = UrlFetchApp.fetch(LINE_PUSH_URL_, {
      method: 'post',
      headers: { 'Authorization': 'Bearer ' + config.lineToken },
      contentType: 'application/json',
      payload: JSON.stringify({
        to: config.lineGroupId,
        messages: [{ type: 'text', text: text }],
      }),
      muteHttpExceptions: true,
    });
    const code = response.getResponseCode();
    if (code !== 200) {
      console.error('LINE push失敗: HTTP ' + code + ' ' + response.getContentText());
      return false;
    }
    return true;
  } catch (err) {
    console.error('LINE push例外: ' + err);
    return false;
  }
}

/**
 * LINE Webhook受信（groupId取得専用。返信はしない）。
 * WebアプリとしてデプロイしてURLをLINE DevelopersのWebhook URLに設定し、
 * botをグループに招待して誰かが発言すると、groupId がスクリプトプロパティ
 * LINE_GROUP_ID に自動登録される（未設定のときのみ。設定済みならログ出力だけ）。
 * LINEの検証リクエスト（eventsが空配列）にも200を返す。
 */
function doPost(e) {
  try {
    if (!e || !e.postData) {
      console.log('doPost: リクエストデータがありません（エディタからの手動実行では動作確認できません）');
    } else {
      const data = JSON.parse(e.postData.contents);
      const events = data.events || [];
      if (events.length === 0) {
        console.log('doPost: eventsが空です（LINEの検証リクエストの可能性）');
      }
      events.forEach((ev) => {
        if (ev.source && ev.source.groupId) {
          registerGroupId_(ev.source.groupId);
        } else if (ev.source) {
          console.log('doPost: groupId以外のsource: ' + JSON.stringify(ev.source));
        }
      });
    }
  } catch (err) {
    console.log('doPost parse error: ' + err);
  }
  // GASのWebアプリは正常returnすればHTTP 200になる
  return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Webhookで受け取った groupId をスクリプトプロパティ LINE_GROUP_ID に登録する。
 * 既に別の値が登録済みの場合は上書きしない（運用中にbotが別グループへ
 * 招待されても通知先が勝手に変わらないようにするため）。
 * @param {string} groupId Webhookイベントの source.groupId
 */
function registerGroupId_(groupId) {
  const props = PropertiesService.getScriptProperties();
  const current = (props.getProperty('LINE_GROUP_ID') || '').trim();
  if (current === '') {
    props.setProperty('LINE_GROUP_ID', groupId);
    console.log('groupId: ' + groupId + ' → スクリプトプロパティ LINE_GROUP_ID に自動登録しました');
  } else if (current === groupId) {
    console.log('groupId: ' + groupId + '（登録済みの LINE_GROUP_ID と一致）');
  } else {
    console.warn('groupId: ' + groupId + ' は登録済みの LINE_GROUP_ID と異なるため上書きしません。' +
      '通知先を変更する場合はスクリプトプロパティを手動で更新してください');
  }
}

/**
 * 疎通確認用のテスト送信（セットアップ時に手動実行する）。
 */
function testLine() {
  const ok = pushLine_('✅ テスト通知です。見守りシステムのセットアップ確認中。');
  console.log(ok ? 'テスト送信に成功しました' : 'テスト送信に失敗しました（ログを確認してください）');
}

/** サンプル通知の送信を許可するスクリプトプロパティ名 */
const ALLOW_SAMPLE_KEY_ = 'ALLOW_SAMPLE_NOTIFICATIONS';

/** サンプル通知の送信間隔（ミリ秒）。LINE側での表示順が入れ替わらないよう間隔を空ける */
const SAMPLE_SEND_INTERVAL_MS_ = 1500;

/**
 * 【手動実行】全種類の通知をサンプル値で送信する（スクリーンショット用）。
 *
 * 文面は jobs.gs の build*Message_ を使うため、本番で実際に届く通知と完全に一致する。
 * ドキュメントや記事に載せるスクリーンショットが実物とずれないようにするのが目的。
 *
 * ⚠️ 「見守りアラート」など家族を不安にさせる文面を含むため、誤爆防止として
 * スクリプトプロパティ ALLOW_SAMPLE_NOTIFICATIONS=true を必須にしている。
 * 家族グループへ送る場合は事前に一声かけるか、自分だけのグループへ
 * LINE_GROUP_ID を一時的に向けてから実行すること。
 */
function sendSampleNotifications() {
  const config = getConfig_();
  const props = PropertiesService.getScriptProperties();
  const allowed = (props.getProperty(ALLOW_SAMPLE_KEY_) || '').trim().toLowerCase() === 'true';
  if (!allowed) {
    throw new Error(
      'サンプル通知を送るには、スクリプトプロパティ ' + ALLOW_SAMPLE_KEY_ + '=true を設定してください。' +
      '「見守りアラート」など家族を不安にさせる文面を含むため、誤爆防止のフラグを設けています。' +
      '実行前に家族へ一声かけるか、自分だけのグループへ LINE_GROUP_ID を一時的に向けてください' +
      '（送信先: ' + config.lineGroupId + '）'
    );
  }

  const name = config.applianceName;
  const samples = [
    ['試作運用: ON', buildStateChangeMessage_(name, '07:20', true, 62)],
    ['試作運用: OFF', buildStateChangeMessage_(name, '23:40', false, 0)],
    ['朝の使用確認（本命）', buildFirstUseMessage_(name, '07:20')],
    ['夜通しつけっぱなし', buildOnAllNightMessage_(name, '07:20')],
    ['見守りアラート（保険）', buildWatchAlertMessage_(name, '11:00')],
    ['システム異常', buildSystemAnomalyMessage_()],
    ['週次サマリー', buildWeeklySummaryMessage_(name, 7)],
  ];

  let sentCount = 0;
  samples.forEach((sample, index) => {
    if (index > 0) Utilities.sleep(SAMPLE_SEND_INTERVAL_MS_);
    const ok = pushLine_(sample[1]);
    console.log((ok ? '送信: ' : '★失敗: ') + sample[0]);
    if (ok) sentCount++;
  });

  console.log(sentCount + '/' + samples.length + ' 通を送信しました（送信先: ' + config.lineGroupId + '）');
  console.log('スクリーンショットを撮ったら ' + ALLOW_SAMPLE_KEY_ + ' を削除してください');
}
