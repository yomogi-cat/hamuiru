// config.gs: スクリプトプロパティのアクセサを一元化する。
// トークン等のシークレットはすべてスクリプトプロパティに保存し、コードには書かない。

/** 必須スクリプトプロパティの一覧 */
const REQUIRED_PROPERTIES_ = [
  'SWITCHBOT_TOKEN',
  'SWITCHBOT_SECRET',
  'LINE_TOKEN',
  'LINE_GROUP_ID',
  'PLUG_DEVICE_ID',
];

/** POWER_THRESHOLD 未設定時のデフォルト値（W） */
const DEFAULT_POWER_THRESHOLD_ = 500;

/**
 * 必須プロパティがすべて設定されているか検証する。
 * 不足がある場合は、どのプロパティが不足しているかを列挙した例外を投げる。
 */
function validateConfig_() {
  const props = PropertiesService.getScriptProperties();
  const missing = REQUIRED_PROPERTIES_.filter((key) => {
    const value = props.getProperty(key);
    return !value || value.trim() === '';
  });
  if (missing.length > 0) {
    throw new Error(
      'スクリプトプロパティが未設定です: ' + missing.join(', ') +
      '（GASエディタの「プロジェクトの設定 → スクリプトプロパティ」で登録してください）'
    );
  }
}

/**
 * 設定一式を取得する。必須プロパティが不足していれば例外を投げる。
 * @return {{switchbotToken: string, switchbotSecret: string, lineToken: string,
 *           lineGroupId: string, plugDeviceId: string, powerThreshold: number}}
 */
function getConfig_() {
  validateConfig_();
  const props = PropertiesService.getScriptProperties();
  const threshold = Number(props.getProperty('POWER_THRESHOLD'));
  return {
    switchbotToken: props.getProperty('SWITCHBOT_TOKEN').trim(),
    switchbotSecret: props.getProperty('SWITCHBOT_SECRET').trim(),
    lineToken: props.getProperty('LINE_TOKEN').trim(),
    lineGroupId: props.getProperty('LINE_GROUP_ID').trim(),
    plugDeviceId: props.getProperty('PLUG_DEVICE_ID').trim(),
    powerThreshold: isNaN(threshold) || threshold <= 0 ? DEFAULT_POWER_THRESHOLD_ : threshold,
  };
}
