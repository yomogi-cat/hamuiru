// setup.gs: セットアップ時にGASエディタから手動実行するワンショット関数群。
// トリガー登録は clasp では行えないため、UIの手作業ではなくここで完結させる。
//
// 手動実行の順序:
//   1. setupObservationTriggers  観察期間の開始（OBSERVATION_MODE=true が必要）
//   2. setupTriggers             本運用の開始（OBSERVATION_MODE を外してから）
// 確認・やり直し用: showTriggers / deleteAllTriggers

/** このプロジェクトがトリガーを登録する対象の関数名 */
const TRIGGER_FUNCTIONS_ = ['collectPower', 'morningCheck', 'weeklySummary'];

/** 電力記録の実行間隔（分）。GASが受け付ける値は 1/5/10/15/30 のいずれか */
const COLLECT_INTERVAL_MINUTES_ = 10;

/** 週次サマリーを送る時刻（時） */
const WEEKLY_SUMMARY_HOUR_ = 20;

/**
 * このプロジェクトが管理する関数のトリガーをすべて削除する（重複登録の防止）。
 * @return {number} 削除した件数
 */
function deleteManagedTriggers_() {
  const targets = ScriptApp.getProjectTriggers()
    .filter((trigger) => TRIGGER_FUNCTIONS_.indexOf(trigger.getHandlerFunction()) >= 0);
  targets.forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  if (targets.length > 0) {
    console.log('既存トリガーを ' + targets.length + '件 削除しました（重複登録の防止）');
  }
  return targets.length;
}

/**
 * 【観察期間用・手動実行】collectPower だけを登録する。
 *
 * collectPower は朝の使用確認通知も担当するため、トリガーを登録しないだけでは
 * 通知を止められない。そのため OBSERVATION_MODE=true を必須とし、暫定しきい値の
 * まま通知が飛ぶことを防ぐ。
 */
function setupObservationTriggers() {
  // ここで getConfig_() を呼ぶのは、設定不備を「10分ごとのエラー通知」ではなく
  // セットアップ時点で発見するため
  const config = getConfig_();
  if (!config.observationMode) {
    throw new Error(
      '観察期間を始めるには、先にスクリプトプロパティ OBSERVATION_MODE=true を設定してください。' +
      '未設定のまま collectPower を回すと、暫定しきい値のまま朝の通知が家族に飛びます'
    );
  }

  deleteManagedTriggers_();
  ScriptApp.newTrigger('collectPower').timeBased()
    .everyMinutes(COLLECT_INTERVAL_MINUTES_).create();

  console.log('観察期間のトリガーを登録しました: collectPower（' +
    COLLECT_INTERVAL_MINUTES_ + '分ごと）。通知はすべて止まっています');
  console.log('1〜2週間ログを溜めたあと、POWER_THRESHOLD / NOTIFY_FROM_HOUR / NOTIFY_TO_HOUR を' +
    '決めて OBSERVATION_MODE を削除し、setupTriggers を実行してください');
  showTriggers();
}

/**
 * 【本運用用・手動実行】3件のトリガーを登録する。
 *
 * morningCheck の時刻は NOTIFY_TO_HOUR から自動で決める。この2つがずれると
 * 「朝の通知も来ないがアラートも出ない」空白時間が生じるため、手で揃えさせずに
 * コード側で保証する。
 */
function setupTriggers() {
  const config = getConfig_();
  if (config.observationMode) {
    throw new Error(
      'OBSERVATION_MODE が true のままです。本運用を開始する前にスクリプトプロパティから' +
      '削除（または false に）してください。true のままだと通知が一切飛ばず、しかも' +
      'このシステムは「通知が来ない」ことを異常のサインにしているため気づけません'
    );
  }

  deleteManagedTriggers_();
  ScriptApp.newTrigger('collectPower').timeBased()
    .everyMinutes(COLLECT_INTERVAL_MINUTES_).create();
  ScriptApp.newTrigger('morningCheck').timeBased()
    .everyDays(1).atHour(config.notifyToHour).create();
  ScriptApp.newTrigger('weeklySummary').timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(WEEKLY_SUMMARY_HOUR_).create();

  console.log('本運用のトリガーを登録しました:');
  console.log('  collectPower  : ' + COLLECT_INTERVAL_MINUTES_ + '分ごと');
  console.log('  morningCheck  : 毎日 ' + config.notifyToHour + '時台' +
    '（NOTIFY_TO_HOUR=' + config.notifyToHour + ' に自動追従）');
  console.log('  weeklySummary : 毎週日曜 ' + WEEKLY_SUMMARY_HOUR_ + '時台');
  console.log('朝の通知は ' + config.notifyFromHour + '時〜' + config.notifyToHour +
    '時の間に ' + config.applianceName + ' の使用を確認したとき、1日1通だけ送られます');
  showTriggers();
}

/**
 * 【確認用・手動実行】登録済みトリガーを一覧表示する。
 */
function showTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  if (triggers.length === 0) {
    console.log('登録済みトリガーはありません');
    return;
  }
  console.log('登録済みトリガー ' + triggers.length + '件:');
  triggers.forEach((trigger) => {
    console.log('  ' + trigger.getHandlerFunction() + ' | ' + trigger.getEventType());
  });
}

/**
 * 【やり直し用・手動実行】このプロジェクトのトリガーをすべて削除する。
 */
function deleteAllTriggers() {
  const count = deleteManagedTriggers_();
  if (count === 0) {
    console.log('削除対象のトリガーはありませんでした');
  }
  showTriggers();
}
