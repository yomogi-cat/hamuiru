// switchbot.gs: SwitchBot API v1.1 との通信（HMAC-SHA256署名認証・リトライ付きfetch）。
// プラグミニの現在電力値・当日累計電力量の取得を担当する。

const SWITCHBOT_BASE_URL_ = 'https://api.switch-bot.com/v1.1';

/**
 * SwitchBot API v1.1 の認証ヘッダーを生成する。
 * 仕様: sign = Base64(HMAC-SHA256(secret, token + t + nonce)) を大文字化。
 * t はエポックミリ秒、nonce はUUID。
 */
function buildSwitchBotHeaders_(config) {
  const t = Date.now().toString();
  const nonce = Utilities.getUuid();
  const raw = config.switchbotToken + t + nonce;
  // Utilities.computeHmacSha256Signature(値, 鍵) の順序に注意
  const signatureBytes = Utilities.computeHmacSha256Signature(raw, config.switchbotSecret);
  const sign = Utilities.base64Encode(signatureBytes).toUpperCase();
  return {
    'Authorization': config.switchbotToken,
    'sign': sign,
    't': t,
    'nonce': nonce,
    'Content-Type': 'application/json',
  };
}

/**
 * SwitchBot APIへのGETリクエスト。HTTPエラー・タイムアウト時は5秒待って1回だけリトライする。
 * @param {string} path 例: '/devices'
 * @return {Object} パース済みレスポンスボディ
 */
function fetchSwitchBot_(path, config) {
  const url = SWITCHBOT_BASE_URL_ + path;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) Utilities.sleep(5000);
    try {
      const response = UrlFetchApp.fetch(url, {
        method: 'get',
        headers: buildSwitchBotHeaders_(config),
        muteHttpExceptions: true,
      });
      const code = response.getResponseCode();
      if (code !== 200) {
        lastError = new Error('SwitchBot API HTTPエラー: ' + code + ' ' + response.getContentText());
        continue;
      }
      return JSON.parse(response.getContentText());
    } catch (err) {
      // ネットワーク例外・タイムアウトなど
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * デバイス一覧をログに出力する（初回セットアップ用）。
 * 表示された Plug Mini の deviceId をスクリプトプロパティ PLUG_DEVICE_ID に登録すること。
 * ※ この関数は PLUG_DEVICE_ID / LINE_* 未設定でも動くよう、トークンのみ直接参照する。
 */
function listDevices() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('SWITCHBOT_TOKEN');
  const secret = props.getProperty('SWITCHBOT_SECRET');
  if (!token || !secret) {
    throw new Error('スクリプトプロパティが未設定です: SWITCHBOT_TOKEN, SWITCHBOT_SECRET のいずれかまたは両方');
  }
  const body = fetchSwitchBot_('/devices', {
    switchbotToken: token.trim(),
    switchbotSecret: secret.trim(),
  });
  if (body.statusCode !== 100) {
    throw new Error('SwitchBot APIエラー: statusCode=' + body.statusCode + ' message=' + body.message);
  }
  (body.body.deviceList || []).forEach((d) => {
    console.log(d.deviceName + ' | ' + d.deviceType + ' | deviceId: ' + d.deviceId);
  });
}

/**
 * プラグミニの現在状態を取得する。
 * SwitchBot APIはHTTP 200でもボディ内 statusCode で失敗を返すため、100以外は例外にする。
 *
 * electricityOfDay は値の意味が特定できていないため、判定には一切使わず
 * ログに参考値として記録するだけにしている。実測で確認した挙動:
 *   - 日付をまたがずに減少（リセット）することがある（例: 10:09 に 379 → 50）
 *   - 単位が不明。「分」とすると経過時間を超えて増加し、「kWh / Wh」とすると
 *     同時刻の power_w と桁が合わない
 * この列を根拠に判定を組んではいけない。
 *
 * @return {{weight: number, electricityOfDay: number}}
 *   weight=現在の負荷電力(W)、electricityOfDay=APIの生値（意味未特定・判定には使わない）
 */
function getPlugStatus_() {
  const config = getConfig_();
  const body = fetchSwitchBot_('/devices/' + config.plugDeviceId + '/status', config);
  if (body.statusCode !== 100) {
    throw new Error('SwitchBot APIエラー: statusCode=' + body.statusCode + ' message=' + body.message);
  }
  return {
    weight: Number(body.body.weight) || 0,
    electricityOfDay: Number(body.body.electricityOfDay) || 0,
  };
}
