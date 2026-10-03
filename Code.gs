/**
 * TimeTree -> Google カレンダー 一方向同期 (GAS)
 *
 * スクリプトプロパティ:
 *   TT_EMAIL        TimeTree のメールアドレス
 *   TT_PASSWORD     TimeTree のパスワード
 *   TT_CALENDAR     同期する TimeTree カレンダー名 (省略時は最初のカレンダー)
 *   GCAL_ID         同期先Googleカレンダー ID (省略時は「TimeTree」という名前のカレンダーを自動作成)
 *
 * 注意: TimeTree の公式APIは終了済み。ここで使うのは非公式のWeb用APIなので、
 * 仕様変更で突然動かなくなる可能性がある。
 */

const TT_BASE = 'https://timetreeapp.com';
const MARK = 'ttSync'; // 同期で作ったイベントの目印
const TT_UA = 'Mozilla/5.0';

function sync() {
  const props = PropertiesService.getScriptProperties();
  const cookie = ttLogin_(props.getProperty('TT_EMAIL'), props.getProperty('TT_PASSWORD'));
  const calId = ttPickCalendar_(cookie, props.getProperty('TT_CALENDAR'));
  const events = ttFetchEvents_(cookie, calId).filter(function (e) { return e.category !== 2; }); // 2 = Keep(メモ)は除外
  const gcal = gcalId_(props);

  // 既存(同期で作成済み)のGoogle側イベントを ttId -> event で引けるようにする
  const existing = {};
  let pageToken;
  do {
    const res = Calendar.Events.list(gcal, {
      privateExtendedProperty: MARK + '=1',
      showDeleted: false,
      maxResults: 2500,
      pageToken: pageToken,
    });
    (res.items || []).forEach(function (ev) {
      existing[ev.extendedProperties.private.ttId] = ev;
    });
    pageToken = res.nextPageToken;
  } while (pageToken);

  const seen = {};
  let created = 0, updated = 0, removed = 0;
  const deadline = Date.now() + 5 * 60 * 1000; // GASは1回6分まで。超えそうなら止めて次回に続きをやる
  let timedOut = false;

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.deleted_at) continue;
    if (Date.now() > deadline) { timedOut = true; break; }
    const body = toGoogleEvent_(e);
    seen[e.id] = true;
    const cur = existing[e.id];
    if (!cur) {
      withRetry_(function () { return Calendar.Events.insert(body, gcal); });
      created++;
    } else if (changed_(cur, body)) {
      withRetry_(function () { return Calendar.Events.patch(body, gcal, cur.id); });
      updated++;
    }
  }

  // TimeTree 側で消えたものはGoogle側も消す(同期で作ったものだけ)。途中で止めた回は誤削除を避けるためスキップ
  if (!timedOut) {
    Object.keys(existing).forEach(function (ttId) {
      if (!seen[ttId]) {
        withRetry_(function () { return Calendar.Events.remove(gcal, existing[ttId].id); });
        removed++;
      }
    });
  } else {
    console.log('時間切れのため途中で停止。次回の実行で続きから同期します');
  }

  console.log('created=' + created + ' updated=' + updated + ' removed=' + removed + ' total=' + events.length);
}

/** 書き込み回数制限(Rate Limit等)に当たったら間隔を空けて再試行する。成功時も少し待って連打を避ける */
function withRetry_(fn) {
  let wait = 1000;
  for (let i = 0; i < 6; i++) {
    try {
      const r = fn();
      Utilities.sleep(300);
      return r;
    } catch (err) {
      if (!/rate limit|quota|backend error|try again/i.test(String(err)) || i === 5) throw err;
      Utilities.sleep(wait);
      wait *= 2;
    }
  }
}

/** 15分ごとの定期実行を設定する(1回だけ実行すればOK) */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sync').timeBased().everyMinutes(15).create();
}

// ---------- TimeTree ----------

function ttLogin_(email, password) {
  if (!email || !password) throw new Error('TT_EMAIL / TT_PASSWORD をスクリプトプロパティに設定してください');
  const res = UrlFetchApp.fetch(TT_BASE + '/api/v1/auth/email/signin', {
    method: 'put',
    contentType: 'application/json',
    headers: { 'X-TimeTreeA': 'web/2.1.0/ja', 'User-Agent': TT_UA },
    payload: JSON.stringify({ uid: email, password: password, uuid: Utilities.getUuid().replace(/-/g, '') }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('TimeTree ログイン失敗: ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  }
  const raw = res.getAllHeaders()['Set-Cookie'];
  const cookies = Array.isArray(raw) ? raw : [raw];
  const sess = cookies.map(function (c) { return String(c).split(';')[0]; })
    .filter(function (c) { return c.indexOf('_session_id=') === 0; })[0];
  if (!sess) throw new Error('TimeTree セッションCookieが取得できませんでした');
  return sess;
}

function ttGet_(cookie, path) {
  const res = UrlFetchApp.fetch(TT_BASE + path, {
    headers: { Cookie: cookie, 'X-TimeTreeA': 'web/2.1.0/ja', 'User-Agent': TT_UA },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('TimeTree API失敗 ' + path + ': ' + res.getResponseCode());
  }
  return JSON.parse(res.getContentText());
}

function ttPickCalendar_(cookie, name) {
  const cals = ttGet_(cookie, '/api/v2/calendars?since=0').calendars.filter(function (c) { return !c.deactivated_at; });
  if (!cals.length) throw new Error('TimeTree にカレンダーがありません');
  const hit = name ? cals.filter(function (c) { return c.name === name; })[0] : cals[0];
  if (!hit) throw new Error('カレンダー "' + name + '" が見つかりません。候補: ' + cals.map(function (c) { return c.name; }).join(', '));
  return hit.id;
}

function ttFetchEvents_(cookie, calId) {
  const all = [];
  let since = 0;
  for (let i = 0; i < 50; i++) { // 暴走防止
    const r = ttGet_(cookie, '/api/v1/calendar/' + calId + '/events/sync?since=' + since);
    Array.prototype.push.apply(all, r.events || []);
    if (!r.chunk) break;
    since = r.since;
  }
  return all;
}

// ---------- Google ----------

function gcalId_(props) {
  let id = props.getProperty('GCAL_ID');
  if (id) return id;
  const found = CalendarApp.getCalendarsByName('TimeTree')[0] || CalendarApp.createCalendar('TimeTree');
  id = found.getId();
  props.setProperty('GCAL_ID', id);
  return id;
}

function ymd_(ms) {
  return Utilities.formatDate(new Date(ms), 'UTC', 'yyyy-MM-dd');
}

function toGoogleEvent_(e) {
  const body = {
    summary: e.title || '(無題)',
    location: e.location || '',
    description: [e.note, e.url].filter(Boolean).join('\n\n'),
    extendedProperties: { private: { ttId: String(e.id), [MARK]: '1' } },
  };
  if (e.all_day) {
    // TimeTree の終日は終了日を含む。Google は終了日を含まない(翌日)。
    const s = e.start_at;
    const en = Math.max(e.end_at || s, s) + 24 * 3600 * 1000;
    body.start = { date: ymd_(s) };
    body.end = { date: ymd_(en) };
  } else {
    const stz = e.start_timezone || 'Asia/Tokyo';
    const etz = e.end_timezone || stz;
    body.start = { dateTime: new Date(e.start_at).toISOString(), timeZone: stz };
    body.end = { dateTime: new Date(e.end_at || e.start_at).toISOString(), timeZone: etz };
  }
  if (e.recurrences && e.recurrences.length) {
    // 繰り返しは RRULE/EXDATE をそのまま渡す。繰り返し予定は start に timeZone が必須。
    body.recurrence = e.recurrences;
    if (e.all_day) {
      body.start.timeZone = 'Asia/Tokyo';
      body.end.timeZone = 'Asia/Tokyo';
    }
  }
  return body;
}

function changed_(cur, body) {
  const pick = function (x) {
    return JSON.stringify([
      x.summary || '', x.location || '', x.description || '',
      x.start.date || new Date(x.start.dateTime).getTime(),
      x.end.date || new Date(x.end.dateTime).getTime(),
      x.recurrence || [],
    ]);
  };
  return pick(cur) !== pick(body);
}
