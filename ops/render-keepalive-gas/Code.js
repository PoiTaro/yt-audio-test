const RENDER_HEALTH_URL = 'https://mr-removal.onrender.com/health';
const KEEP_ALIVE_HANDLER = 'pingRender';
const KEEP_ALIVE_INTERVAL_MINUTES = 5;
const STATUS_PREFIX = 'renderKeepAlive.';

/**
 * Renderのヘルスチェックを呼び、結果をScript Propertiesへ記録する。
 * 時間主導トリガーから5分おきに実行される。
 *
 * @return {{ok: boolean, statusCode: number, elapsedMs: number, checkedAt: string}}
 */
function pingRender() {
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();
  const properties = PropertiesService.getScriptProperties();

  try {
    const response = UrlFetchApp.fetch(RENDER_HEALTH_URL, {
      method: 'get',
      followRedirects: true,
      muteHttpExceptions: true,
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
      },
    });
    const statusCode = response.getResponseCode();
    const elapsedMs = Date.now() - startedAt;
    const body = response.getContentText();
    let health = null;

    try {
      health = JSON.parse(body);
    } catch (parseError) {
      // HTTPステータスと本文の先頭だけを状態として残す。
    }

    const ok = statusCode >= 200 && statusCode < 300 && health?.status === 'ok';
    const result = { ok, statusCode, elapsedMs, checkedAt };

    properties.setProperties({
      [`${STATUS_PREFIX}lastCheckedAt`]: checkedAt,
      [`${STATUS_PREFIX}lastStatusCode`]: String(statusCode),
      [`${STATUS_PREFIX}lastElapsedMs`]: String(elapsedMs),
      [`${STATUS_PREFIX}lastOk`]: String(ok),
      [`${STATUS_PREFIX}lastError`]: ok ? '' : body.slice(0, 500),
    });

    console.log(JSON.stringify(result));
    return result;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    properties.setProperties({
      [`${STATUS_PREFIX}lastCheckedAt`]: checkedAt,
      [`${STATUS_PREFIX}lastElapsedMs`]: String(elapsedMs),
      [`${STATUS_PREFIX}lastOk`]: 'false',
      [`${STATUS_PREFIX}lastError`]: String(error).slice(0, 500),
    });
    console.error(error);
    return {
      ok: false,
      statusCode: 0,
      elapsedMs,
      checkedAt,
      error: String(error).slice(0, 500),
    };
  }
}

/**
 * 既存の同名トリガーを整理してから、5分間隔のトリガーを1つだけ作る。
 * 初回セットアップ時に一度だけ手動実行する。
 */
function setupKeepAlive() {
  removeKeepAliveTriggers_();
  ScriptApp.newTrigger(KEEP_ALIVE_HANDLER)
    .timeBased()
    .everyMinutes(KEEP_ALIVE_INTERVAL_MINUTES)
    .create();

  const initialCheck = pingRender();
  return {
    installed: true,
    intervalMinutes: KEEP_ALIVE_INTERVAL_MINUTES,
    healthUrl: RENDER_HEALTH_URL,
    initialCheck,
  };
}

/**
 * 常時起動を停止する。GASプロジェクト自体や履歴は削除しない。
 */
function disableKeepAlive() {
  const removed = removeKeepAliveTriggers_();
  return { disabled: true, removedTriggers: removed };
}

/**
 * 現在のトリガー数と直近の実行結果を返す。
 */
function getKeepAliveStatus() {
  const properties = PropertiesService.getScriptProperties().getProperties();
  const triggerCount = ScriptApp.getProjectTriggers().filter(
    (trigger) => trigger.getHandlerFunction() === KEEP_ALIVE_HANDLER,
  ).length;

  return {
    enabled: triggerCount > 0,
    triggerCount,
    intervalMinutes: KEEP_ALIVE_INTERVAL_MINUTES,
    healthUrl: RENDER_HEALTH_URL,
    lastCheckedAt: properties[`${STATUS_PREFIX}lastCheckedAt`] || null,
    lastStatusCode: properties[`${STATUS_PREFIX}lastStatusCode`] || null,
    lastElapsedMs: properties[`${STATUS_PREFIX}lastElapsedMs`] || null,
    lastOk: properties[`${STATUS_PREFIX}lastOk`] || null,
    lastError: properties[`${STATUS_PREFIX}lastError`] || null,
  };
}

function removeKeepAliveTriggers_() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach((trigger) => {
    if (trigger.getHandlerFunction() === KEEP_ALIVE_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
      removed += 1;
    }
  });
  return removed;
}
