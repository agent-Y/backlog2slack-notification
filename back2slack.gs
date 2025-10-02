/**
 * Backlogの通知を取得してSlackへ流すGoogle Apps Script（シンプル版）
 *
 * ▼準備
 * 1) スクリプト プロパティを設定（エディタ左の設定→スクリプト プロパティ）
 *    - 複数ワークスペース対応: BACKLOG_CONFIGS にJSON配列を保存
 *      例: [{ "space": "space1", "apiKey": "xxx", "webhook": "https://hooks.slack.com/..." }, ...]
 *      任意で label, storageKey を指定可能
 *    - 旧シングル設定を使う場合（後方互換）:
 *      BACKLOG_SPACE, BACKLOG_API_KEY, SLACK_WEBHOOK_URL を従来どおり設定
 * 2) トリガー: 実行関数 run を「時間主導型」で 5〜15分毎に設定
 */

const SCRIPT_PROPS = PropertiesService.getScriptProperties();
const LAST_SEEN_ID_KEY = 'BACKLOG_LAST_SEEN_NOTIFICATION_ID';
const CONFIGS_PROP_KEY = 'BACKLOG_CONFIGS';

function run() {
  const configs = loadWorkspaceConfigs();
  configs.forEach(processWorkspace);
}

/** 必須プロパティの取得（なければエラー） */
function mustGetProp(key) {
  const v = SCRIPT_PROPS.getProperty(key);
  if (!v) throw new Error(`スクリプトプロパティ ${key} が設定されていません`);
  return v;
}

function loadWorkspaceConfigs() {
  const raw = SCRIPT_PROPS.getProperty(CONFIGS_PROP_KEY);
  if (raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`スクリプトプロパティ ${CONFIGS_PROP_KEY} が不正なJSONです: ${err.message}`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error(`スクリプトプロパティ ${CONFIGS_PROP_KEY} は1件以上の設定を含む配列である必要があります`);
    }
    const configs = parsed.map((cfg, idx) => normalizeConfig(cfg, idx, true));
    ensureUniqueStorageKeys(configs);
    return configs;
  }

  return [normalizeConfig({
    space: mustGetProp('BACKLOG_SPACE'),
    apiKey: mustGetProp('BACKLOG_API_KEY'),
    webhook: mustGetProp('SLACK_WEBHOOK_URL'),
    legacy: true,
  }, 0, false)];
}

function normalizeConfig(rawConfig, index, multiMode) {
  if (!rawConfig || typeof rawConfig !== 'object') {
    throw new Error(`${CONFIGS_PROP_KEY} の要素${index + 1}がオブジェクトではありません`);
  }

  const space = pickString(rawConfig.space);
  const apiKey = pickString(rawConfig.apiKey || rawConfig.api_key);
  const webhook = pickString(rawConfig.webhook || rawConfig.slackWebhook || rawConfig.slack_webhook);

  if (!space) throw new Error(`${CONFIGS_PROP_KEY} の要素${index + 1}に space がありません`);
  if (!apiKey) throw new Error(`${CONFIGS_PROP_KEY} の要素${index + 1}に apiKey がありません`);
  if (!webhook) throw new Error(`${CONFIGS_PROP_KEY} の要素${index + 1}に webhook がありません`);

  const identifierSource = pickString(rawConfig.id || rawConfig.identifier || rawConfig.label || rawConfig.name || rawConfig.space);
  const displayLabel = identifierSource || `workspace-${index + 1}`;
  const customStorageKey = pickString(rawConfig.storageKey);
  const storageCandidate = customStorageKey && customStorageKey.startsWith(LAST_SEEN_ID_KEY)
    ? customStorageKey
    : `${LAST_SEEN_ID_KEY}__${slugForProperty(customStorageKey || identifierSource || `workspace-${index + 1}`)}`;
  const storageBase = rawConfig.legacy ? LAST_SEEN_ID_KEY : storageCandidate;
  const storageKey = multiMode ? storageBase : (rawConfig.legacy ? LAST_SEEN_ID_KEY : storageBase);

  return {
    space,
    apiKey,
    webhook,
    label: displayLabel,
    storageKey,
  };
}

function slugForProperty(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'workspace';
}

function ensureUniqueStorageKeys(configs) {
  const used = {};
  configs.forEach((cfg, idx) => {
    let baseKey = cfg.storageKey && cfg.storageKey.trim();
    if (!baseKey) {
      baseKey = `${LAST_SEEN_ID_KEY}__workspace_${idx + 1}`;
    }
    let candidate = baseKey;
    let suffix = 2;
    while (used[candidate]) {
      candidate = `${baseKey}_${suffix++}`;
    }
    cfg.storageKey = candidate;
    used[candidate] = true;
  });
}

function pickString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function processWorkspace(config) {
  const { space, apiKey, webhook, storageKey, label } = config;
  const lastSeenId = Number(SCRIPT_PROPS.getProperty(storageKey) || 0);
  const { newNotifications, maxId } = fetchNewNotifications({ space, apiKey, lastSeenId });

  if (newNotifications.length > 0) {
    newNotifications.sort((a, b) => a.id - b.id);
    newNotifications.forEach(n => {
      const payload = buildSlackPayload(n, space);
      postToSlack(webhook, payload);
    });
    Logger.log(`[${label}] ${newNotifications.length}件の通知をSlackへ送信`);
  } else {
    Logger.log(`[${label}] 新着通知なし（送信なし）`);
  }

  if (maxId > lastSeenId) {
    SCRIPT_PROPS.setProperty(storageKey, String(maxId));
  }
}

/** Backlog API呼び出し */
function backlogApi(space, apiKey, path, params) {
  const base = `https://${space}.backlog.com/api/v2${path}`;
  const query = Object.entries({ ...params, apiKey })
    .filter(([_, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const url = `${base}?${query}`;
  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    headers: { 'Accept': 'application/json' },
  });
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(`Backlog API error ${code}: ${res.getContentText()}`);
  }
  return JSON.parse(res.getContentText());
}

/** 新規（未読）の通知のみ取得。既知の最大IDより大きいものを対象 */
function fetchNewNotifications({ space, apiKey, lastSeenId }) {
  const newNotifications = [];
  let maxId = lastSeenId;
  let pageCount = 0;
  const PAGE_LIMIT = 10; // セーフティ

  let done = false;
  let minId = undefined;

  while (!done && pageCount < PAGE_LIMIT) {
    const params = { count: 100, order: 'desc' };
    if (minId !== undefined) params.maxId = minId - 1;

    const items = backlogApi(space, apiKey, '/notifications', params);
    pageCount++;

    if (!Array.isArray(items) || items.length === 0) break;

    for (const n of items) {
      if (n.id > maxId) maxId = n.id;
      if (n.id <= lastSeenId) { done = true; break; }
      if (n.alreadyRead) continue;
      newNotifications.push(n);
    }

    const oldest = items[items.length - 1];
    minId = oldest.id;
  }

  return { newNotifications, maxId };
}

/** Slack投稿 */
function postToSlack(webhook, payload) {
  const res = UrlFetchApp.fetch(webhook, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(`Slack webhook error ${code}: ${res.getContentText()}`);
  }
}

/** 通知1件分 → Slack payload */
function buildSlackPayload(n, space) {
  const title = buildNotificationTitle(n);
  const url = buildNotificationUrl(n, space);
  const user = (n && n.createdUser && n.createdUser.name) ? n.createdUser.name : '（不明）';
  const projectName = n && n.project && n.project.name ? n.project.name : '（プロジェクト不明）';
  const ts = n && n.created ? new Date(n.created) : new Date();

  const text = url ? `<${url}|${title}>` : title;
  const snippet = extractContentSnippet(n);

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `Backlog: ${projectName}` } },
    { type: 'section', text: { type: 'mrkdwn', text } },
  ];
  if (snippet) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: snippet } });
  }
  blocks.push({ type: 'context', elements: [
      { type: 'mrkdwn', text: `by *${user}*` },
      { type: 'mrkdwn', text: ` | ${formatDateForSlack(ts)}` }
    ]
  });

  return { text: `[${projectName}] ${title}${url ? `: ${url}` : ''}`, blocks };
}

function extractContentSnippet(n) {
  let raw = '';
  if (n.comment && n.comment.content) raw = n.comment.content;
  else if (n.issue && n.issue.description) raw = n.issue.description;
  else if (n.pullRequest && (n.pullRequest.summary || n.pullRequest.description)) raw = n.pullRequest.summary || n.pullRequest.description || '';
  else if (n.wiki && n.wiki.content) raw = n.wiki.content;
  raw = String(raw || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\r?\n/g, ' ')
    .trim();
  if (!raw) return '';
  const max = 300;
  return raw.length > max ? raw.slice(0, max) + '…' : raw;
}

function buildNotificationTitle(n) {
  if (n.issue && n.issue.issueKey) {
    const key = n.issue.issueKey;
    const summary = n.issue.summary || '';
    if (n.comment) return `#${key} にコメント: ${summary}`;
    return `#${key}: ${summary}`;
  }
  if (n.pullRequest && n.repository) {
    const repo = n.repository.name || '';
    const number = n.pullRequest.number || '';
    const title = n.pullRequest.summary || n.pullRequest.title || '';
    return `PR ${repo}#${number}: ${title}`;
  }
  if (n.wiki) {
    const name = n.wiki.name || 'Wiki';
    return `Wiki更新: ${name}`;
  }
  if (n.reason && n.reason.name) return n.reason.name;
  return 'Backlog通知';
}

function buildNotificationUrl(n, space) {
  if (n.issue && n.issue.issueKey) {
    return `https://${space}.backlog.com/view/${n.issue.issueKey}`;
  }
  if (n.pullRequest && n.repository && n.project) {
    const projectId = n.project.projectKey;
    const repoId = n.repository.id;
    const number = n.pullRequest.number;
    if (projectId && repoId && number !== undefined) {
      return `https://${space}.backlog.com/git/${projectId}/${repoId}/pullRequests/${number}`;
    }
  }
  if (n.wiki && n.wiki.id) {
    return `https://${space}.backlog.com/wiki/${n.wiki.id}`;
  }
  return '';
}

function formatDateForSlack(d) {
  const pad = (n) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function runTest() {
  const webhook = mustGetProp('SLACK_WEBHOOK_URL');
  postToSlack(webhook, makeSimpleTextPayload('test'));
}

function makeSimpleTextPayload(text) {
  return { text, blocks: [ { type: 'section', text: { type: 'mrkdwn', text } } ] };
}
