// jobs.gs: トリガーから実行される3ジョブ（電力記録+朝の使用確認通知・不在アラート・週次サマリー）。
// 想定外エラーはLINEに概要を通知する（ただしLINE送信自体の失敗はログのみ）。

const LOG_SHEET_NAME_ = 'log';
const LOG_KEEP_DAYS_ = 30;

/**
 * collectPower の実行間隔（分）。GASが受け付ける値は 1/5/10/15/30 のいずれか。
 * setup.gs のトリガー登録と、深夜帯に期待される記録件数の算出の両方で使う。
 */
const COLLECT_INTERVAL_MINUTES_ = 10;

/**
 * 朝の使用確認通知を送った日付（yyyy-MM-dd）を記録するスクリプトプロパティ名。
 * 手で設定するものではなく、スクリプトが自動で書き込む。
 */
const LAST_ON_NOTIFIED_KEY_ = 'LAST_ON_NOTIFIED_DATE';

/**
 * 試作運用モードで直前に観測したON/OFF状態（'on' / 'off'）を記録する
 * スクリプトプロパティ名。手で設定するものではない。
 */
const LAST_POWER_STATE_KEY_ = 'LAST_POWER_STATE';

/** ジョブごとのエラー通知時刻を記録するスクリプトプロパティ名の接頭辞 */
const ERROR_NOTIFIED_KEY_PREFIX_ = 'LAST_ERROR_NOTIFIED_';

/**
 * 同じジョブのエラー通知を送る最短間隔（分）。
 * collectPower は10分ごとに動くため、間引きがないと障害中に1日144通が飛び、
 * LINEの無料枠（月200通）を1日半で使い切って本来のアラートが送れなくなる。
 */
const ERROR_NOTIFY_INTERVAL_MINUTES_ = 60;

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
    sheet.appendRow(['timestamp', 'power_w', 'electricity_of_day']);
  }
  return sheet;
}

/**
 * ログの全データ行（見出し除外）を返す。
 * 判定に使うのは timestamp と power_w のみ。3列目は参考値（下記コメント参照）。
 * @return {Array<Array>} [timestamp: Date, power_w: number, electricity_of_day: number][]
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
 *
 * 同じジョブのエラー通知は ERROR_NOTIFY_INTERVAL_MINUTES_ に1通までに間引く。
 * SwitchBot APIの障害やプラグのオフラインが続くと、10分ごとに同じ通知が
 * 飛んでLINEの無料枠を焼き切ってしまうため。実行ログには毎回残す。
 *
 * 送信に成功したときだけ時刻を記録するので、LINE側が復旧したタイミングで
 * 1通は必ず届く。
 */
function notifyJobError_(jobName, err) {
  // ログは間引かない。障害の全期間を実行ログで追えるようにする
  console.error(jobName + ' でエラー: ' + err + (err && err.stack ? '\n' + err.stack : ''));

  const props = PropertiesService.getScriptProperties();
  // プロパティ名に使えるようジョブ名から関数名部分だけを取り出す（例: collectPower）
  const key = ERROR_NOTIFIED_KEY_PREFIX_ + jobName.replace(/[^A-Za-z0-9_]/g, '');
  const lastNotifiedAt = Number(props.getProperty(key));
  const now = Date.now();
  if (lastNotifiedAt && now - lastNotifiedAt < ERROR_NOTIFY_INTERVAL_MINUTES_ * 60 * 1000) {
    console.log('同じジョブのエラー通知は' + ERROR_NOTIFY_INTERVAL_MINUTES_ +
      '分に1通までのため、LINEへは送信しません（前回送信: ' +
      Utilities.formatDate(new Date(lastNotifiedAt), 'Asia/Tokyo', 'MM/dd HH:mm') + '）');
    return;
  }

  const sent = pushLine_('⚠️【システムエラー】' + jobName + ' の実行中にエラーが発生しました。\n' +
    '概要: ' + String(err).slice(0, 200) + '\n' +
    'GASエディタの実行ログを確認してください。\n' +
    '（同じエラーの通知は' + ERROR_NOTIFY_INTERVAL_MINUTES_ + '分に1通までに抑えています）');
  if (sent) {
    props.setProperty(key, String(now));
  }
}

/**
 * 【トリガー: 10分ごと】プラグの電力値を取得してシート log に追記し、
 * モードに応じた通知を出す。
 */
function collectPower() {
  try {
    const config = getConfig_();
    const status = getPlugStatus_();
    const now = new Date();
    getLogSheet_().appendRow([now, status.weight, status.electricityOfDay]);
    notifyPowerIfNeeded_(config, status.weight, now);
  } catch (err) {
    notifyJobError_('collectPower（電力記録）', err);
  }
}

/**
 * 記録した電力値に応じて通知を出す。モードによって挙動が変わる。
 * - OBSERVATION_MODE=true : 通知しない（観察期間。ログ収集のみ）
 * - TRIAL_MODE=true       : ON/OFFの変化を都度通知（試作運用。生活パターンの把握）
 * - どちらもなし（本番）   : 朝の時間帯の初回使用を1日1通だけ通知
 *
 * OBSERVATION_MODE を優先するのは、通知を完全に止めたい状態が最も強い意図だから。
 */
function notifyPowerIfNeeded_(config, powerW, now) {
  if (config.observationMode) return;
  if (config.trialMode) {
    notifyStateChangeIfNeeded_(config, powerW, now);
    return;
  }
  notifyFirstUseIfNeeded_(config, powerW, now);
}

/**
 * 【試作運用モード】ON/OFFが切り替わったタイミングで都度通知する。
 *
 * 本番の「朝1通」と違い、生活パターンそのものを家族が把握するためのモード。
 * この通知を数日眺めることで、対象家電が夜間もつけっぱなしになっていないか
 * （＝朝の初回検知が「起きた」を意味するか）を確認できる。OFF通知が来なければ
 * つけっぱなしであり、本番の判定方式を見直す必要があると分かる。
 *
 * 状態は送信の成否に関わらず記録する。朝の使用確認通知（送信成功時のみ記録）と
 * 逆の方針なのは、送れなかった変化を次のポーリングで再通知すると、実際とずれた
 * 時刻の通知が延々と続いてしまうため。
 */
function notifyStateChangeIfNeeded_(config, powerW, now) {
  const props = PropertiesService.getScriptProperties();
  const current = powerW >= config.powerThreshold ? 'on' : 'off';
  const previous = props.getProperty(LAST_POWER_STATE_KEY_);
  if (previous === current) return;

  props.setProperty(LAST_POWER_STATE_KEY_, current);
  if (!previous) {
    console.log('試作運用モード: 初回の状態を ' + current + ' として記録しました（通知はしません）');
    return;
  }

  const timeLabel = Utilities.formatDate(now, 'Asia/Tokyo', 'HH:mm');
  if (current === 'on') {
    pushLine_('🔌 ' + timeLabel + ' ' + config.applianceName + 'がONになりました（' +
      Math.round(powerW) + 'W）');
  } else {
    pushLine_('⚫ ' + timeLabel + ' ' + config.applianceName + 'がOFFになりました');
  }
}

/**
 * 深夜帯（当日0:00〜NOTIFY_FROM_HOUR）に対象家電が消された形跡があるかを判定する。
 *
 * 夜通しつけっぱなしだと、朝の初回検知は「本人が起きた」ことを意味しない。
 * その場合は通知文を差し替えて、家族に「今日は起床の確認ができていない」と伝える。
 *
 * ログの欠測で誤判定しないよう、深夜帯の記録が想定件数の半分未満なら判定しない。
 * 回線断そのものは morningCheck のシステム異常通知が拾う。
 *
 * @return {boolean} 夜通しつけっぱなしだったと判定できる場合のみ true
 */
function wasOnAllNight_(config, now) {
  const nightStart = new Date(now);
  nightStart.setHours(0, 0, 0, 0);
  const nightEnd = new Date(now);
  nightEnd.setHours(config.notifyFromHour, 0, 0, 0);

  const nightRows = getLogRows_()
    .filter((row) => row[0] >= nightStart && row[0] < nightEnd);

  // 10分ごとの記録を前提に、深夜帯に期待される件数の半分は必要とする
  const expected = config.notifyFromHour * 60 / COLLECT_INTERVAL_MINUTES_;
  if (nightRows.length < expected / 2) {
    console.log('深夜帯の記録が ' + nightRows.length + '件（期待 ' + expected +
      '件）しかないため、つけっぱなしの判定は行いません');
    return false;
  }

  return nightRows.every((row) => Number(row[1]) >= config.powerThreshold);
}

/**
 * 朝の時間帯に初めて使用を確認したとき、家族へ1通だけ通知する（本命の通知）。
 * - 当日すでに通知済みなら送らない（つけ消ししても連投しない）
 * - NOTIFY_FROM_HOUR〜NOTIFY_TO_HOUR の範囲外では送らない（深夜通知の防止）
 * - 送信に成功したときだけ日付を記録するため、LINE側の障害時は次のポーリングで再試行される
 * - 観察期間中（OBSERVATION_MODE=true）は送らない
 * - 夜通しつけっぱなしだった場合は通知文を差し替える（下記）
 *
 * つけっぱなしの日に「使用を確認しました」を送ると、起床していないのに正常な通知が
 * 届くことになり、家族はそれに気づけない。同じ1通の枠で別の文面を送ることで、
 * 「この日は起床の確認になっていない」を必ず伝える。追加通知にしないのは、
 * 「使用を確認」と「実は夜通しついていた」が別々に届くと混乱するため。
 */
function notifyFirstUseIfNeeded_(config, powerW, now) {
  if (config.observationMode) return;
  if (powerW < config.powerThreshold) return;

  const hour = now.getHours();
  if (hour < config.notifyFromHour || hour >= config.notifyToHour) return;

  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');
  if (props.getProperty(LAST_ON_NOTIFIED_KEY_) === today) return;

  const timeLabel = Utilities.formatDate(now, 'Asia/Tokyo', 'HH:mm');
  const message = wasOnAllNight_(config, now)
    ? '🌙 今朝 ' + timeLabel + ' の時点で' + config.applianceName +
      'がついていました（昨夜から消されていません）。\n' +
      '消さずに寝た可能性がありますが、念のため様子を確認してください。\n' +
      '※この日は起床の確認ができていません。'
    : '☀️ 今朝 ' + timeLabel + ' に' + config.applianceName + 'の使用を確認しました。';

  const sent = pushLine_(message);
  if (sent) {
    props.setProperty(LAST_ON_NOTIFIED_KEY_, today);
  }
}

/**
 * 【トリガー: 毎朝（NOTIFY_TO_HOUR と同時刻）】朝の使用確認通知が出なかった日を拾う
 * セーフティネット。当日0:00以降のログを走査して判定する。
 * - ログ0件            → システム異常としてLINE通知（回線断・停電・GAS障害の切り分け文言付き）
 * - 使用形跡なし        → 見守りアラートをLINE通知（①電話 → ②訪問の手順文言付き）
 * - 使用形跡あり        → 何もしない（朝の使用確認通知が既に出ているため）
 *
 * 本命は collectPower 内の朝の使用確認通知で、こちらは「毎朝の通知が来ないことに
 * 家族が気づけない」というハートビート方式の弱点を埋めるためにある。
 *
 * 判定時刻はトリガー設定側で決める（観察期間のログから決定する）。通知文の時間帯は
 * 実行時刻から生成するため、トリガー時刻を変えてもコードの修正は不要。
 */
function morningCheck() {
  try {
    const config = getConfig_();
    if (config.observationMode || config.trialMode) {
      console.log('観察期間中または試作運用中のため通知しません' +
        '（OBSERVATION_MODE / TRIAL_MODE を確認してください）');
      return;
    }
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
      pushLine_('🔔【見守りアラート】今朝は' + config.applianceName +
        'の使用を確認できませんでした（0:00〜' + nowLabel + '）。\n' +
        '朝の使用確認の通知も届いていません。\n' +
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
    if (config.observationMode || config.trialMode) {
      console.log('観察期間中または試作運用中のため通知しません' +
        '（OBSERVATION_MODE / TRIAL_MODE を確認してください）');
      return;
    }
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
