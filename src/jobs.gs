// jobs.gs: トリガーから実行される3ジョブ（電力記録・朝の生存判定・週次サマリー）。
// 想定外エラーはLINEに概要を通知する（ただしLINE送信自体の失敗はログのみ）。

const LOG_SHEET_NAME_ = 'log';
const LOG_KEEP_DAYS_ = 30;

/**
 * ログ用シートを取得する。存在しなければ見出し行付きで作成する。
 * ※ このスクリプトはスプレッドシートにバインドされている前提（拡張機能 → Apps Script から作成）。
 */
function getLogSheet_() {
  const spreadsheet = SpreadsheetApp.getActive();
  if (!spreadsheet) {
    throw new Error('スプレッドシートが見つかりません。このスクリプトはスプレッドシートの「拡張機能 → Apps Script」から作成してください');
  }
  let sheet = spreadsheet.getSheetByName(LOG_SHEET_NAME_);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(LOG_SHEET_NAME_);
    sheet.appendRow(['timestamp', 'power_w', 'daily_kwh']);
  }
  return sheet;
}

/**
 * ログの全データ行（見出し除外）を返す。
 * @return {Array<Array>} [timestamp: Date, power_w: number, daily_kwh: number][]
 */
function getLogRows_() {
  const sheet = getLogSheet_();
  return sheet.getDataRange().getValues()
    .slice(1)
    .filter((row) => row[0] instanceof Date);
}

/**
 * ジョブ内の想定外エラーをLINEへ通知する。通知ループを避けるため、
 * pushLine_ の失敗は例外にならずログに残るのみ。
 */
function notifyJobError_(jobName, err) {
  console.error(jobName + ' でエラー: ' + err + (err && err.stack ? '\n' + err.stack : ''));
  pushLine_('⚠️【システムエラー】' + jobName + ' の実行中にエラーが発生しました。\n' +
    '概要: ' + String(err).slice(0, 200) + '\n' +
    'GASエディタの実行ログを確認してください。');
}

/**
 * 【トリガー: 30分ごと】プラグの電力値を取得し、シート log に追記する。
 */
function collectPower() {
  try {
    const status = getPlugStatus_();
    getLogSheet_().appendRow([new Date(), status.weight, status.electricityOfDay]);
  } catch (err) {
    notifyJobError_('collectPower（電力記録）', err);
  }
}

/**
 * 【トリガー: 毎朝】当日0:00以降のログを走査して生存判定する。
 * - ログ0件            → システム異常としてLINE通知（回線断・停電・GAS障害の切り分け文言付き）
 * - 使用形跡なし        → 見守りアラートをLINE通知（①電話 → ②訪問の手順文言付き）
 * - 使用形跡あり        → 何もしない（正常時は静かに）
 *
 * 判定時刻はトリガー設定側で決める（観察期間のログから決定する）。通知文の時間帯は
 * 実行時刻から生成するため、トリガー時刻を変えてもコードの修正は不要。
 */
function morningCheck() {
  try {
    const config = getConfig_();
    // スクリプトのタイムゾーンは Asia/Tokyo のため、当日0:00 = JSTの0:00になる
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const todayRows = getLogRows_().filter((row) => row[0] >= todayStart);

    if (todayRows.length === 0) {
      pushLine_('⚠️【システム異常】今日の電力データが1件も記録できていません。\n' +
        '見守り判定ができない状態です。次を確認してください:\n' +
        '① 祖母宅のWi-Fiルーターとプラグの電源（回線断・停電の可能性）\n' +
        '② SwitchBotアプリでプラグがオンラインか\n' +
        '③ GASエディタの実行ログにエラーが出ていないか');
      return;
    }

    const used = todayRows.some((row) => Number(row[1]) >= config.powerThreshold);
    if (!used) {
      const nowLabel = Utilities.formatDate(now, 'Asia/Tokyo', 'HH:mm');
      pushLine_('🔔【見守りアラート】今朝はまだ' + config.applianceName +
        'の使用が確認できていません（0:00〜' + nowLabel + '）。\n' +
        '念のため様子を確認してください。\n' +
        '対応手順: ①まず電話をかける → ②30分以内に連絡がつかなければ訪問する');
    }
    // 使用形跡あり: 正常のため通知しない
  } catch (err) {
    notifyJobError_('morningCheck（朝の生存判定）', err);
  }
}

/**
 * 【トリガー: 毎週日曜20時】直近7日で使用を確認できた日数を集計して1通送信し、
 * 30日より古いログ行を削除する。
 */
function weeklySummary() {
  try {
    const config = getConfig_();
    const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const usedDays = new Set(
      getLogRows_()
        .filter((row) => row[0] >= from && Number(row[1]) >= config.powerThreshold)
        .map((row) => Utilities.formatDate(row[0], 'Asia/Tokyo', 'yyyy-MM-dd'))
    );

    pushLine_('📋【週次レポート】この1週間、7日中 ' + usedDays.size + '日 で' +
      config.applianceName + 'の使用を確認しました。見守りシステムは正常に稼働しています。');

    pruneOldRows_();
  } catch (err) {
    notifyJobError_('weeklySummary（週次サマリー）', err);
  }
}

/**
 * 30日より古いログ行を削除する（ログの肥大化防止）。
 * ログは時系列順に追記される前提で、先頭から連続する古い行のみ削除する。
 */
function pruneOldRows_() {
  const sheet = getLogSheet_();
  const limit = new Date(Date.now() - LOG_KEEP_DAYS_ * 24 * 60 * 60 * 1000);
  const values = sheet.getDataRange().getValues();
  let deleteCount = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] instanceof Date && values[i][0] < limit) {
      deleteCount++;
    } else {
      break;
    }
  }
  if (deleteCount > 0) {
    sheet.deleteRows(2, deleteCount);
    console.log('古いログを ' + deleteCount + ' 行削除しました');
  }
}
