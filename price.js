/* Price a round: the value engine, the strict gate and the weekly cap for the match-result market,
   a port of src/market/value.py and src/staking/gates.py (Python is the record; this is the preview). */
(function () {
  'use strict';
  var PR = {};
  PR.fractionalToDecimal = function (s) {
    if (s === null || s === undefined) return null;
    s = String(s).trim().toUpperCase();
    if (!s) return null;
    if (s === 'EVS' || s === 'EVENS') return 2.0;
    var m = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
    if (m) { var d = parseFloat(m[2]); return d > 0 ? Math.round((1 + parseFloat(m[1]) / d) * 10000) / 10000 : null; }
    if (/^\d+(\.\d+)?$/.test(s)) { var v = parseFloat(s); return v >= 1 ? v : null; }
    return null;
  };
  PR.pyNum = function (x) { return Number.isInteger(x) ? x.toFixed(1) : String(x); };   /* Python prints 8.0, JS prints 8 */
  PR.round = function (x, d) { var f = Math.pow(10, d); return Math.round((x + Number.EPSILON) * f) / f; };
  PR.devig = function (p) { var imp = { home: 1 / p.home, draw: 1 / p.draw, away: 1 / p.away }; var t = imp.home + imp.draw + imp.away;
    return { home: imp.home / t, draw: imp.draw / t, away: imp.away / t }; };
  PR.OUT = ['home', 'draw', 'away'];
  PR.LABEL = { home: 'Home', draw: 'Draw', away: 'Away' };
  PR.skipPrice = function (p) { return Math.ceil(100 / p) / 100; };
  PR.prohibited = function (fx, sel, never) {
    never = (never || []).map(function (s) { return String(s).toLowerCase(); });
    if (!never.length) return false;
    var sides = sel === 'draw' ? [fx.home, fx.away] : [sel === 'home' ? fx.away : fx.home];
    return sides.some(function (s) { return s && never.indexOf(String(s).toLowerCase()) >= 0; });
  };
  /* value.evaluate for a Sky Bet price with lambda 0 (rugby competitions blend nothing to market) */
  PR.value = function (fx, sky) {
    var model = fx.model || {};
    var rated = PR.OUT.every(function (k) { return model[k] !== null && model[k] !== undefined; });
    var priced = !!sky && PR.OUT.every(function (k) { return sky[k]; });
    var out = { rated: rated, sky_priced: priced, outcomes: null, best: null, sky_devigged: priced ? PR.devig(sky) : null };
    if (!rated || !priced) return out;
    var dev = out.sky_devigged, outcomes = {};
    PR.OUT.forEach(function (k) {
      var p = Number(model[k]);
      outcomes[k] = { p_model: p, p_final: PR.round(p, 4), odds: Number(sky[k]), edge_pp: PR.round(100 * (p - dev[k]), 2), ev: PR.round(p * Number(sky[k]) - 1, 4) };
    });
    out.outcomes = outcomes;
    out.best = PR.OUT.reduce(function (b, k) { return b === null || outcomes[k].edge_pp > outcomes[b].edge_pp ? k : b; }, null);
    return out;
  };
  /* gates.strict_gate */
  PR.gate = function (fx, val, st, remaining) {
    var NEAR = 3.0;
    if (!val.rated) return { verdict: 'NO_BET', selection: null, kind: 'unrated', reason: 'unrated side: ' + (fx.unrated || 'no model probabilities'), stake: 0 };
    if (!val.sky_priced) return { verdict: 'NO_BET', selection: null, kind: 'unpriced', reason: 'Sky Bet has not priced this fixture', stake: 0 };
    var best = null, checksBest = null;
    PR.OUT.forEach(function (k) {
      var row = val.outcomes[k];
      var checks = { edge_min: row.edge_pp >= st.edge_min_pp, edge_max: row.edge_pp <= st.max_edge_pp, odds_max: row.odds <= st.max_odds,
        ev_positive: row.ev > st.min_ev, not_prohibited: !PR.prohibited(fx, k, st.never_bet_against), weekly_cap: remaining >= 0.005 };
      if (best === null || row.edge_pp > val.outcomes[best].edge_pp) { best = k; checksBest = checks; }
    });
    var row = val.outcomes[best], checks = checksBest;
    var all = Object.keys(checks).every(function (c) { return checks[c]; });
    var base = { selection: best, odds: row.odds, edge_pp: row.edge_pp, ev: row.ev, checks: checks };
    if (all) {
      var amount = PR.round(Math.min(st.stake, st.cap_single, Math.max(0, remaining)), 2);
      if (amount <= 0) return Object.assign(base, { verdict: 'NO_BET', kind: 'cap_exhausted', reason: 'weekly cap reached', stake: 0 });
      return Object.assign(base, { verdict: 'STRICT_BET', kind: 'strict_bet', stake: amount, skip_if_sky_below: PR.skipPrice(row.p_final),
        reason: 'edge ' + row.edge_pp.toFixed(1) + 'pp at Sky Bet ' + row.odds + ', EV ' + (row.ev >= 0 ? '+' : '') + row.ev.toFixed(3) });
    }
    var kind, reason;
    if (checks.edge_min && !checks.edge_max) { kind = 'cap_kill'; reason = 'edge ' + row.edge_pp.toFixed(1) + 'pp exceeds max_edge_pp ' + PR.pyNum(st.max_edge_pp); }
    else if (!checks.not_prohibited) { kind = 'prohibited'; reason = 'never a bet against a protected side'; }
    else if (!checks.weekly_cap) { kind = 'cap_exhausted'; reason = 'weekly cap reached'; }
    else if (row.edge_pp >= NEAR) { var failed = Object.keys(checks).filter(function (c) { return !checks[c]; }); kind = 'near_miss'; reason = 'edge ' + row.edge_pp.toFixed(1) + 'pp; failed ' + failed.join(', '); }
    else { kind = 'no_edge'; reason = 'best edge ' + row.edge_pp.toFixed(1) + 'pp on ' + best; }
    return Object.assign(base, { verdict: 'NO_BET', kind: kind, reason: reason, stake: 0 });
  };
  PR.isoWeek = function (ts) {
    var d = new Date(ts); d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    var day = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() + 4 - day);
    var y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    var w = Math.ceil((((d - y0) / 86400000) + 1) / 7);
    return d.getUTCFullYear() + '-W' + (w < 10 ? '0' : '') + w;
  };
  /* the round: fixtures in kick-off order, each strict bet consuming the week's cap, as verdicts.evaluate_fixtures does */
  PR.priceRound = function (data, prices, now) {
    var st = data.staking, committed = Object.assign({}, data.committed_by_week || {}), out = [];
    var fixtures = data.fixtures.slice().sort(function (a, b) { return (a.kickoff_utc || '').localeCompare(b.kickoff_utc || '') || a.fixture_id.localeCompare(b.fixture_id); });
    fixtures.forEach(function (fx) {
      var sky = prices[fx.fixture_id] ? prices[fx.fixture_id].h2h : null;
      var started = now && fx.kickoff_utc && new Date(fx.kickoff_utc) <= now;
      var val = PR.value(fx, sky), week = PR.isoWeek(fx.kickoff_utc || now || new Date());
      if (!(week in committed)) committed[week] = 0;
      var v;
      if (started) v = { verdict: 'NO_BET', selection: null, kind: 'kicked_off', reason: 'kicked off; not priced', stake: 0 };
      else v = PR.gate(fx, val, st, st.cap_weekly - committed[week]);
      if (v.verdict === 'STRICT_BET') committed[week] = PR.round(committed[week] + v.stake, 2);
      out.push({ fixture_id: fx.fixture_id, week: week, value: val, verdict: v, remaining_after: PR.round(st.cap_weekly - committed[week], 2) });
    });
    return { results: out, committed_by_week: committed };
  };
  PR.phi = function (z) { /* standard normal cdf, Abramowitz-Stegun 7.1.26 via erf */
    var t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2), x = Math.abs(z) / Math.SQRT2;
    var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    var erf = z < 0 ? -y : y; return 0.5 * (1 + erf); };
  PR.lineProb = function (mu, sigma, line) { return 1 - PR.phi((-line - mu) / sigma); };
  PR.overProb = function (mean, sigma, line) { return 1 - PR.phi((line - mean) / sigma); };
  PR.formatLines = function (retrievedAt, prices, url, bookmaker) {
    var out = ['retrieved_at ' + retrievedAt, 'bookmaker ' + (bookmaker || 'skybet'), 'url ' + url];
    Object.keys(prices).sort().forEach(function (fid) {
      var p = prices[fid]; if (!p || !p.h2h) return;
      var line = fid + ' h2h ' + p.h2h.home + ' ' + p.h2h.draw + ' ' + p.h2h.away;
      if (p.handicap) line += ' hcp ' + p.handicap.home_line + ' ' + p.handicap.home_price + ' ' + p.handicap.away_line + ' ' + p.handicap.away_price;
      if (p.total) line += ' tot ' + p.total.line + ' ' + p.total.over_price + ' ' + p.total.under_price;
      out.push(line);
    });
    return out.join('\n');
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = PR;
  if (typeof window !== 'undefined') window.PriceRound = PR;
})();

/* ---- the page: one competition's odds box, the cap shared across the rugby pages ---- */
(function () {
  if (typeof document === 'undefined' || !document.getElementById('pr-data')) return;
  var PR = window.PriceRound, data = JSON.parse(document.getElementById('pr-data').textContent);
  var host = document.getElementById('pr-fixtures'); if (!host) return;
  var KEY = 'pll-price-round-' + (data.run.as_of || '') + '-r' + (data.run.number || '');
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } }
  var saved = load();
  var mine = data.fixtures.filter(function (f) { return f.competition === data.show; });
  var mineIds = {}; mine.forEach(function (f) { mineIds[f.fixture_id] = true; });
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function pct(v) { return v === null || v === undefined ? '–' : (100 * v).toFixed(1) + '%'; }
  function fair(v) { return v ? (1 / v).toFixed(2) : '–'; }
  function inp(fid, name, ph, val) { return '<input data-fid="' + esc(fid) + '" data-k="' + name + '" inputmode="decimal" placeholder="' + ph + '" value="' + esc(val || '') + '">'; }
  function prefill(fx) {
    var s = saved[fx.fixture_id] || {};
    if (!s.home && fx.stored && fx.stored.sky && fx.stored.flag === 'skybet') s = { home: fx.stored.sky.home, draw: fx.stored.sky.draw, away: fx.stored.sky.away,
      hl: (fx.stored.markets && fx.stored.markets.handicap || {}).home_line, hp: (fx.stored.markets && fx.stored.markets.handicap || {}).home_price,
      al: (fx.stored.markets && fx.stored.markets.handicap || {}).away_line, ap: (fx.stored.markets && fx.stored.markets.handicap || {}).away_price,
      tl: (fx.stored.markets && fx.stored.markets.total || {}).line, to: (fx.stored.markets && fx.stored.markets.total || {}).over_price, tu: (fx.stored.markets && fx.stored.markets.total || {}).under_price };
    return s;
  }
  var html = '<div class="grid">';
  mine.forEach(function (fx) {
    var s = prefill(fx), m = fx.model || {}, mg = fx.margin || {}, tt = fx.total || {};
    var who = (mg.mean || 0) >= 0 ? fx.home : fx.away;
    var view = mg.mean !== undefined ? esc(who) + ' by ' + Math.abs(mg.mean || 0).toFixed(1) + ' · total ' + (tt.mean || 0).toFixed(0) : '';
    html += '<div class="card pr-fx" id="fx-' + esc(fx.fixture_id) + '"><div class="pr-head"><span class="pr-teams">' + esc(fx.home) + ' <span class="dim">v</span> ' + esc(fx.away) + '</span><span class="ko">' + esc(fx.kickoff_label) + '</span></div>';
    html += '<div class="probs"><div><div class="lbl">Home</div><div class="v">' + pct(m.home) + '</div><div class="o">fair ' + fair(m.home) + '</div></div>' +
      '<div><div class="lbl">Draw</div><div class="v">' + pct(m.draw) + '</div><div class="o">fair ' + fair(m.draw) + '</div></div>' +
      '<div><div class="lbl">Away</div><div class="v">' + pct(m.away) + '</div><div class="o">fair ' + fair(m.away) + '</div></div></div>';
    html += '<div class="dim pr-view">' + view + '</div>';
    if (fx.unrated) { html += '<div class="verdict">NO BET <span class="dim">unrated: ' + esc(fx.unrated) + '</span></div></div>'; return; }
    html += '<div class="pr-row"><label>Sky Bet match result</label>' + inp(fx.fixture_id, 'home', 'home', s.home) + inp(fx.fixture_id, 'draw', 'draw', s.draw) + inp(fx.fixture_id, 'away', 'away', s.away) + '</div>';
    html += '<div class="pr-row pr-opt"><label>Handicap (home line, price · away line, price)</label>' + inp(fx.fixture_id, 'hl', '-4', s.hl) + inp(fx.fixture_id, 'hp', '10/11', s.hp) + inp(fx.fixture_id, 'al', '+4', s.al) + inp(fx.fixture_id, 'ap', '10/11', s.ap) + '</div>';
    html += '<div class="pr-row pr-opt"><label>Total points (line, over, under)</label>' + inp(fx.fixture_id, 'tl', '46.5', s.tl) + inp(fx.fixture_id, 'to', '10/11', s.to) + inp(fx.fixture_id, 'tu', '10/11', s.tu) + '</div>';
    html += '<div class="pr-lines dim"></div><div class="verdict pr-verdict">NO BET <span class="dim">enter the three match-result prices</span></div></div>';
  });
  host.innerHTML = html + '</div>';
  var PRICE = /^(\d+(?:\.\d+)?\/\d+(?:\.\d+)?|EVS|EVENS|\d+\.\d+|\d{1,3})$/i;
  /* the paste box: a line names both sides (any known spelling) followed by three prices, or is one of the lab's own snapshot lines */
  function applyPaste(text) {
    var filled = 0, unmatched = [];
    String(text || '').split(/\r?\n/).forEach(function (raw) {
      var line = raw.trim(); if (!line) return;
      var low = line.toLowerCase(), fx = null, rest = null;
      var snap = line.match(/^(\S+-(?:PREM|URC|ECC))\s+h2h\s+(\S+)\s+(\S+)\s+(\S+)/);
      if (snap) { fx = mine.filter(function (f) { return f.fixture_id === snap[1]; })[0]; rest = [snap[2], snap[3], snap[4]]; }
      else {
        var find = function (names) { return names.slice().sort(function (x, y) { return y.length - x.length; }).filter(function (n) { return low.indexOf(n) >= 0; })[0]; };
        var firstWord = function (names) { var w = names[0].split(' ')[0]; return w.length >= 4 && low.indexOf(w) >= 0 ? w : null; };   /* the canonical name's first word: "Racing" for Racing 92 */
        mine.forEach(function (f) {
          if (fx) return;
          var h = find(f.home_names), a = find(f.away_names);
          if (h && !a) a = firstWord(f.away_names);
          if (a && !h) h = firstWord(f.home_names);
          if (h && a) { var tail = low.slice(Math.max(low.indexOf(h) + h.length, low.indexOf(a) + a.length)); fx = f; rest = tail.split(/[\s,;|]+/).filter(function (t) { return PRICE.test(t); }); }
        });
      }
      if (!fx || !rest || rest.length < 3) { unmatched.push(line.slice(0, 40)); return; }
      ['home', 'draw', 'away'].forEach(function (k, i) { var el = host.querySelector('input[data-fid="' + fx.fixture_id + '"][data-k="' + k + '"]'); if (el) el.value = rest[i].toUpperCase().replace('EVENS', 'EVS'); });
      filled += 1;
    });
    return { filled: filled, unmatched: unmatched };
  }
  function read() {
    var vals = {};
    host.querySelectorAll('input[data-fid]').forEach(function (i) { (vals[i.dataset.fid] = vals[i.dataset.fid] || {})[i.dataset.k] = i.value.trim(); });
    return vals;
  }
  function toPrices(vals) {
    var prices = {}, problems = [];
    Object.keys(vals).forEach(function (fid) {
      var v = vals[fid] || {}, h = PR.fractionalToDecimal(v.home), d = PR.fractionalToDecimal(v.draw), a = PR.fractionalToDecimal(v.away);
      if (!v.home && !v.draw && !v.away) return;
      if (!(h && d && a)) { if (mineIds[fid]) problems.push(fid + ': needs all three match-result prices'); return; }
      var p = { h2h: { home: h, draw: d, away: a }, handicap: null, total: null };
      if (v.hl || v.hp || v.al || v.ap) {
        var hp = PR.fractionalToDecimal(v.hp), ap = PR.fractionalToDecimal(v.ap);
        if (v.hl && hp && v.al && ap && /^[+-]?\d+(\.\d+)?$/.test(v.hl) && /^[+-]?\d+(\.\d+)?$/.test(v.al)) p.handicap = { home_line: v.hl, home_price: hp, away_line: v.al, away_price: ap };
        else if (mineIds[fid]) problems.push(fid + ': handicap needs both lines and both prices (left out)');
      }
      if (v.tl || v.to || v.tu) {
        var to = PR.fractionalToDecimal(v.to), tu = PR.fractionalToDecimal(v.tu);
        if (v.tl && to && tu && /^\d+(\.\d+)?$/.test(v.tl)) p.total = { line: v.tl, over_price: to, under_price: tu };
        else if (mineIds[fid]) problems.push(fid + ': total needs the line and both prices (left out)');
      }
      prices[fid] = p;
    });
    return { prices: prices, problems: problems };
  }
  function linesInfo(fx, p) {
    if (!p || !fx.margin || !fx.total) return '';
    var s = [];
    if (p.handicap) { var L = parseFloat(p.handicap.home_line); var pc = PR.lineProb(fx.margin.mean, fx.margin.sigma, L);
      s.push('model: ' + esc(fx.home) + ' ' + p.handicap.home_line + ' covers ' + pct(pc) + ' (fair ' + fair(pc) + ' v Sky ' + p.handicap.home_price + '); ' + esc(fx.away) + ' ' + p.handicap.away_line + ' covers ' + pct(1 - pc) + ' (fair ' + fair(1 - pc) + ' v ' + p.handicap.away_price + ')'); }
    if (p.total) { var T = parseFloat(p.total.line); var po = PR.overProb(fx.total.mean, fx.total.sigma, T);
      s.push('model: over ' + p.total.line + ' ' + pct(po) + ' (fair ' + fair(po) + ' v ' + p.total.over_price + '), under ' + pct(1 - po) + ' (fair ' + fair(1 - po) + ' v ' + p.total.under_price + ')'); }
    return s.join('<br>') + (s.length ? '<br><span class="dim">informational only: the strict rule prices the match result</span>' : '');
  }
  function verdictHtml(r, fx) {
    var v = r.verdict;
    if (v.verdict === 'STRICT_BET') return '<div class="verdict strict"><b>STRICT BET</b> ' + PR.LABEL[v.selection] + ' (' + esc(v.selection === 'home' ? fx.home : v.selection === 'away' ? fx.away : 'draw') + ') @ ' + v.odds + ' £' + v.stake.toFixed(2) + ' · edge ' + v.edge_pp.toFixed(1) + 'pp · EV ' + v.ev.toFixed(3) + ' · skip below ' + v.skip_if_sky_below.toFixed(2) + '</div>';
    if (v.kind === 'cap_kill') return '<div class="verdict kill"><b>CAP KILL</b> ' + esc(v.reason) + '</div>';
    var detail = v.edge_pp !== undefined ? ' <span class="tag">' + PR.LABEL[v.selection] + ' ' + (v.edge_pp >= 0 ? '+' : '') + v.edge_pp.toFixed(1) + 'pp @ ' + v.odds + '</span>' : '';
    return '<div class="verdict"><b>NO BET</b> <span class="dim">' + esc(v.reason) + '</span>' + detail + '</div>';
  }
  var issueA = document.getElementById('pr-issue'), note = document.getElementById('pr-note'), paste = document.getElementById('pr-paste');
  function run(persist) {
    var here = read();
    var all = load();                                  // prices typed on the other rugby pages, same browser
    Object.keys(all).forEach(function (fid) { if (mineIds[fid]) delete all[fid]; });
    Object.keys(here).forEach(function (fid) { all[fid] = here[fid]; });
    try { if (persist) localStorage.setItem(KEY, JSON.stringify(all)); } catch (e) {}
    var tp = toPrices(all), now = new Date();
    var res = PR.priceRound(data, tp.prices, now);
    var bets = [], others = 0, priced = 0;
    res.results.forEach(function (r) {
      var fx = data.fixtures.filter(function (f) { return f.fixture_id === r.fixture_id; })[0];
      if (!mineIds[r.fixture_id]) { if (r.verdict.verdict === 'STRICT_BET') others += 1; return; }
      var card = document.getElementById('fx-' + r.fixture_id); if (!card) return;
      var vb = card.querySelector('.pr-verdict'), lb = card.querySelector('.pr-lines');
      if (!tp.prices[r.fixture_id]) { if (vb) vb.innerHTML = 'NO BET <span class="dim">' + (r.verdict.kind === 'kicked_off' ? 'kicked off' : 'no prices entered') + '</span>'; if (lb) lb.innerHTML = ''; card.classList.remove('betcard'); return; }
      priced += 1;
      if (vb) vb.outerHTML = verdictHtml(r, fx).replace('class="verdict', 'class="verdict pr-verdict');
      if (lb) lb.innerHTML = linesInfo(fx, tp.prices[r.fixture_id]);
      card.classList.toggle('betcard', r.verdict.verdict === 'STRICT_BET');
      if (r.verdict.verdict === 'STRICT_BET') bets.push({ fx: fx, v: r.verdict, week: r.week });
    });
    var sm = document.getElementById('pr-summary');
    var roundWeeks = {}; data.fixtures.forEach(function (f) { roundWeeks[PR.isoWeek(f.kickoff_utc || now)] = true; });
    var capLine = 'Weekly cap: ' + Object.keys(res.committed_by_week).filter(function (w) { return roundWeeks[w]; }).sort().map(function (w) { return w + ' £' + res.committed_by_week[w].toFixed(2) + ' of £' + data.staking.cap_weekly.toFixed(2); }).join(', ') + (others ? ' (includes ' + others + ' bet' + (others > 1 ? 's' : '') + ' priced on the other rugby pages)' : '') + '.';
    if (bets.length) {
      sm.className = 'card'; sm.innerHTML = '<h3 style="margin-top:0">Bets to place (' + bets.length + ')</h3>' + bets.map(function (b) {
        return '<div class="verdict strict"><b>£' + b.v.stake.toFixed(2) + '</b> ' + esc(b.v.selection === 'draw' ? 'Draw' : (b.v.selection === 'home' ? b.fx.home : b.fx.away)) + (b.v.selection === 'draw' ? '' : ' to win') + ' · ' + esc(b.fx.home) + ' v ' + esc(b.fx.away) + ' (' + esc(b.fx.kickoff_label) + ') @ ' + b.v.odds + ' · skip if Sky is below ' + b.v.skip_if_sky_below.toFixed(2) + ' · edge ' + b.v.edge_pp.toFixed(1) + 'pp</div>'; }).join('') +
        '<p class="dim">' + capLine + ' Place bets manually; skip any whose live Sky price is below its skip price.</p>';
    } else {
      sm.className = 'card nobet'; sm.innerHTML = '<div class="nobet-big">NO BET</div><div class="nobet-sub">' + (priced ? priced + ' fixture' + (priced > 1 ? 's' : '') + ' priced, none clears the strict rule' : 'no prices entered yet') + '</div><p class="dim" style="margin:12px 0 0">' + capLine + '</p>';
    }
    note.textContent = tp.problems.length ? tp.problems.join(' · ') : '';
    var when = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
    var text = PR.formatLines(when, tp.prices, data.issue.url, 'skybet');
    var title = data.issue.title_prefix + ' ' + when.slice(0, 10);
    var body = 'Sky Bet prices typed on the rugby pages at ' + when + '. One line per fixture; the lab records a snapshot per line and runs the engine.\n\n```\n' + text + '\n```\n';
    issueA.href = 'https://github.com/' + data.issue.repo + '/issues/new?title=' + encodeURIComponent(title) + '&labels=' + encodeURIComponent(data.issue.label) + '&body=' + encodeURIComponent(body);
    var any = Object.keys(tp.prices).length > 0;
    issueA.classList.toggle('pr-disabled', !any);
    return text;
  }
  function generate() {
    var r = applyPaste(paste.value);
    run(true);
    if (r.filled || r.unmatched.length) note.textContent = (r.filled ? r.filled + ' fixture' + (r.filled > 1 ? 's' : '') + ' filled from the box' : '') + (r.unmatched.length ? (r.filled ? '; ' : '') + 'not matched: ' + r.unmatched.join(' | ') : '') + (note.textContent ? ' · ' + note.textContent : '');
  }
  document.getElementById('pr-run').addEventListener('click', generate);
  paste.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) generate(); });
  document.getElementById('pr-copy').addEventListener('click', function () {
    var text = run(true);
    var done = function () { note.textContent = 'snapshot copied'; };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { window.prompt('Copy the snapshot', text); });
    else window.prompt('Copy the snapshot', text);
  });
  document.getElementById('pr-clear').addEventListener('click', function () {
    host.querySelectorAll('input[data-fid]').forEach(function (i) { i.value = ''; }); paste.value = ''; run(true);
  });
  issueA.addEventListener('click', function (ev) { if (issueA.classList.contains('pr-disabled')) { ev.preventDefault(); note.textContent = 'enter at least one fixture\'s prices first'; } else run(true); });
  host.addEventListener('input', function () { run(true); });
  run(false);
})();
