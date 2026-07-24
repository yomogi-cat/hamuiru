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
 * botをグループに招待して誰かが発言すると、実行ログに groupId が出力される。
 * LINEの検証リクエスト（eventsが空配列）にも200を返す。
 */
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const events = data.events || [];
    if (events.length === 0) {
      console.log('doPost: eventsが空です（LINEの検証リクエストの可能性）');
    }
    events.forEach((ev) => {
      if (ev.source && ev.source.groupId) {
        console.log('groupId: ' + ev.source.groupId +
          ' → スクリプトプロパティ LINE_GROUP_ID に登録してください');
      } else if (ev.source) {
        console.log('doPost: groupId以外のsource: ' + JSON.stringify(ev.source));
      }
    });
  } catch (err) {
    console.log('doPost parse error: ' + err);
  }
  // GASのWebアプリは正常returnすればHTTP 200になる
  return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 疎通確認用のテスト送信（セットアップ時に手動実行する）。
 */
function testLine() {
  const ok = pushLine_('✅ テスト通知です。見守りシステムのセットアップ確認中。');
  console.log(ok ? 'テスト送信に成功しました' : 'テスト送信に失敗しました（ログを確認してください）');
}
