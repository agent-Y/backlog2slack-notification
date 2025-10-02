/**
 * Backlogの通知を取得してSlackへ流すGoogle Apps Script（シンプル版）
 *
 * ▼準備
 * 1) スクリプト プロパティに以下を保存（エディタ左の設定→スクリプト プロパティ）
 *    - BACKLOG_SPACE: 例 "yourspace"（https://yourspace.backlog.com のサブドメイン）
 *    - BACKLOG_API_KEY: BacklogのAPIキー（絶対にコード直書きしない）
 *    - SLACK_WEBHOOK_URL: SlackのIncoming Webhook URL
 * 2) トリガー: 実行関数 run を「時間主導型」で 5〜15分毎に設定
 */

const SCRIPT_PROPS = PropertiesService.getScriptProperties();
const LAST_SEEN_ID_KEY = 'BACKLOG_LAST_SEEN_NOTIFICATION_ID';

function run() {
  const space = mustGetProp('BACKLOG_SPACE');
  const apiKey = mustGetProp('BACKLOG_API_KEY');
  const webhook = mustGetProp('SLACK_WEBHOOK_URL');

  const lastSeenId = Number(SCRIPT_PROPS.getProperty(LAST_SEEN_ID_KEY) || 0);
  const { newNotifications, maxId } = fetchNewNotifications({ space, apiKey, lastSeenId });

  if (newNotifications.length > 0) {
    newNotifications.sort((a, b) => a.id - b.id);
    newNotifications.forEach(n => {
      const payload = buildSlackPayload(n, space);
      postToSlack(webhook, payload);
    });
  } else {
    Logger.log('新着通知なし（送信なし）');
  }

  if (maxId > lastSeenId) {
    SCRIPT_PROPS.setProperty(LAST_SEEN_ID_KEY, String(maxId));
  }
}

/** 必須プロパティの取得（なければエラー） */
function mustGetProp(key) {
  const v = SCRIPT_PROPS.getProperty(key);
  if (!v) throw new Error(`スクリプトプロパティ ${key} が設定されていません`);
  return v;
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
