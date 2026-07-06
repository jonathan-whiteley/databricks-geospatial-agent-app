/**
 * geniePanel.jsx
 * Live Ask Genie right-rail panel.
 * Calls POST /api/genie/ask and POST /api/action; threads conversation_id
 * across turns; renders text, navy SQL block, dynamic results table,
 * and lightning callout per the clover-app design spec.
 */

import { useRef, useState, useEffect, useCallback } from 'react';
import { postGenieAsk, postAction } from './api.js';

// Default question auto-run on mount
const DEFAULT_QUESTION = 'Show a ranked table of understaffed stores with their scheduled hours, recommended hours, and added hours needed.';

// Chip definitions: label + natural-language question sent to Genie
const CHIPS = [
  { key: 'laborHours', label: 'Suggest labor hours',        question: 'Show a table of recommended labor hours per store for tomorrow, sized to the 165 visits per labor-hour target.' },
  { key: 'drops',      label: 'Sudden traffic drops',       question: 'Show a table of stores with the largest week-over-week foot-traffic drops.' },
  { key: 'peaks',      label: 'Peak-hour gaps',             question: 'Show a table of daypart coverage gaps across the fleet.' },
  { key: 'vsTraffic',  label: 'Staffing vs. foot traffic',  question: 'Show a fleet staffing summary table with store counts and average labor gap by staffing status.' },
  { key: 'proximity',  label: 'Nearest stores (ST_)',       question: 'Which stores are closest to each other?' },
];

// Max table rows to render
const MAX_ROWS = 8;

// ---------- Sub-components ----------

function TypingIndicator() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--db-ink-muted)', font: '500 12px var(--font-sans)' }}>
      <img src="/assets/genie-icon-full-color.svg" style={{ width: 16, height: 16 }} alt="" />
      Genie is analyzing...
    </div>
  );
}

// Render the inline **bold** subset Genie returns. Even segments are plain
// text, odd segments are bold.
function renderInline(text) {
  return text.split(/\*\*(.+?)\*\*/g).map((seg, i) =>
    i % 2 === 1 ? <b key={i}>{seg}</b> : seg
  );
}

// Lightweight renderer for the small markdown subset Genie returns:
// **bold**, "- " / "* " bullet lines, and paragraph line breaks.
function FormattedText({ text, color }) {
  const lines = (text || '').split('\n');
  const blocks = [];
  let bullets = null;
  const flush = () => { if (bullets) { blocks.push(bullets); bullets = null; } };
  lines.forEach((raw) => {
    const line = raw.trimEnd();
    const m = line.match(/^\s*[-*]\s+(.*)$/);
    if (m) {
      if (!bullets) bullets = { type: 'ul', items: [] };
      bullets.items.push(m[1]);
    } else {
      flush();
      if (line.trim() !== '') blocks.push({ type: 'p', text: line });
    }
  });
  flush();
  return (
    <div style={{ font: '400 13px/1.5 var(--font-sans)', color }}>
      {blocks.map((b, i) =>
        b.type === 'ul' ? (
          <ul key={i} style={{ margin: '4px 0', paddingLeft: 18 }}>
            {b.items.map((it, j) => <li key={j} style={{ marginBottom: 2 }}>{renderInline(it)}</li>)}
          </ul>
        ) : (
          <p key={i} style={{ margin: i === 0 ? 0 : '6px 0 0' }}>{renderInline(b.text)}</p>
        )
      )}
    </div>
  );
}

function GenieMessage({ msg }) {
  const isGenie = msg.role === 'genie';
  const wrapStyle = { alignSelf: isGenie ? 'stretch' : 'flex-end', maxWidth: isGenie ? '100%' : '88%' };
  const bubbleStyle = isGenie
    ? { background: 'var(--db-oat-light)', border: '1px solid var(--db-line)', borderRadius: '4px 12px 12px 12px', padding: '11px 13px' }
    : { background: 'var(--db-navy)', borderRadius: '12px 12px 4px 12px', padding: '9px 13px' };
  const textColor = isGenie ? 'var(--db-ink)' : '#fff';

  // Normalize dynamic columns+rows into the static table shape the markup expects.
  // msg.table may be:
  //   (a) already shaped: { h0, hrest, rows }  (from static GENIE_SEED or post-process)
  //   (b) dynamic from live API: built in sendMessage from { columns, rows }
  const table = msg.table || null;

  return (
    <div className="cv-msg" style={wrapStyle}>
      {isGenie && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
          <img src="/assets/genie-icon-full-color.svg" style={{ width: 18, height: 18 }} alt="" />
          <span style={{ font: '700 11px var(--font-sans)', color: 'var(--db-navy)' }}>Genie</span>
        </div>
      )}
      <div style={bubbleStyle}>
        <FormattedText text={msg.text} color={textColor} />

        {/* Navy SQL block */}
        {msg.sql && (
          <div style={{ marginTop: 9, background: 'var(--db-navy)', borderRadius: 8, padding: '9px 11px', overflowX: 'auto' }}>
            <div style={{ font: '600 9px var(--font-sans)', letterSpacing: '.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,.4)', marginBottom: 5 }}>Generated SQL</div>
            <pre style={{ margin: 0, font: '400 11px/1.5 var(--font-mono)', color: '#d7e0e2', whiteSpace: 'pre' }}>{msg.sql}</pre>
          </div>
        )}

        {/* Results table */}
        {table && (
          <div style={{ marginTop: 9, border: '1px solid var(--db-line)', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ display: 'flex', background: 'var(--db-oat-medium)', padding: '6px 9px', gap: 6 }}>
              <span style={{ flex: 1.5, minWidth: 0, font: '700 10px var(--font-sans)', color: 'var(--db-ink-soft)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{table.h0}</span>
              {table.hrest.map((h, idx) => (
                <span key={idx} style={{ flex: 1, minWidth: 0, textAlign: 'right', font: '700 10px var(--font-sans)', color: 'var(--db-ink-soft)', textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h}</span>
              ))}
            </div>
            {table.rows.map((row, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '7px 9px', background: i % 2 ? '#fff' : '#faf9f7' }}>
                <span style={{ flex: 1.5, minWidth: 0, font: '600 12px var(--font-sans)', color: 'var(--db-navy)', display: 'flex', alignItems: 'center', gap: 5 }}>
                  {row.dot && <span style={{ flex: '0 0 6px', height: 6, borderRadius: '50%', background: row.dot, display: 'inline-block' }}></span>}
                  <span style={{ minWidth: 0 }}>{row.name}</span>
                </span>
                {row.vals.map((v, j) => (
                  <span key={j} style={{ flex: 1, minWidth: 0, textAlign: 'right', font: '500 12px var(--font-mono)', color: 'var(--db-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v}</span>
                ))}
              </div>
            ))}
          </div>
        )}

        {/* Lightning callout */}
        {msg.callout && (
          <div style={{ marginTop: 9, display: 'flex', gap: 8, padding: '9px 11px', borderRadius: 8, background: msg.callout.bg || '#FFF1EE', borderLeft: `3px solid ${msg.callout.bar || '#FF3621'}` }}>
            <span style={{ fontSize: 13 }}>{msg.callout.icon}</span>
            <div style={{ font: '500 12px/1.45 var(--font-sans)', color: 'var(--db-ink)' }}>
              <b style={{ color: msg.callout.bar || '#FF3621' }}>{msg.callout.label} </b>{msg.callout.text}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Table builder helpers ----------

// Round to 1 decimal, strip trailing ".0".
function _round1(n) {
  const s = n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

// Convert snake_case / lower to Title Case. If the string already looks
// presentational (has a space or an uppercase letter) leave it alone.
// Also strips a trailing "_id" segment before prettifying.
function _prettyHeader(name) {
  if (/[A-Z ]/.test(name)) return name;
  const stripped = name.replace(/_id$/i, '');
  return stripped
    .split(/[_\s]+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

const STATUS_COLORS = {
  understaffed: '#FF3621',
  overstaffed: '#FFAB00',
  balanced: '#00A972',
};
// Short labels so the status cell stays narrow and columns stay aligned.
const STATUS_LABELS = {
  understaffed: 'UNDER',
  overstaffed: 'OVER',
  balanced: 'BALANCED',
};
const NEUTRAL_DOT = '#618794';

// Derive dot color from a row's status value (string).
function _statusColor(val) {
  if (val == null) return NEUTRAL_DOT;
  return STATUS_COLORS[String(val).toLowerCase().trim()] || NEUTRAL_DOT;
}

// Format a single cell value given the original (pre-prettify) column name.
function _formatValue(origHeader, value) {
  if (value == null || value === undefined) return '';
  const h = String(origHeader);
  const isNumericStr = typeof value === 'string' && /^[+-]?\d+(\.\d+)?$/.test(value.trim());
  if (typeof value === 'string' && !isNumericStr) {
    // Already a string - map bare status words to short labels, return as-is otherwise.
    const lower = value.toLowerCase().trim();
    if (STATUS_LABELS[lower]) return STATUS_LABELS[lower];
    return value;
  }
  const n = parseFloat(value);
  if (isNaN(n)) return String(value);

  const hl = h.toLowerCase();
  // Hours-like columns
  if (/hour|sched|ideal|\bh\b|labor|gap\b|rec\b|add\b/i.test(h)) {
    const base = _round1(n) + 'h';
    if (/gap|add|delta|change|diff/i.test(h)) {
      if (n > 0) return '+' + base;
      if (n < 0) return base; // toFixed already includes the minus
      return base;
    }
    return base;
  }
  // Percent-like columns
  if (/pct|percent|rate|delta|share/i.test(h)) {
    const base = _round1(n) + '%';
    if (/delta|gap|change|diff/i.test(h)) {
      if (n > 0) return '+' + base;
    }
    return base;
  }
  // Count-like columns
  if (/visit|count|traffic|visitors|hours?_total/i.test(h)) {
    return Math.round(n).toLocaleString('en-US');
  }
  // Default numeric
  return _round1(n);
}

// ---------- Table builder from live API columns+rows ----------

/**
 * Build the table shape { h0, hrest, rows } from the raw API response.
 * Grain-adaptive: hides id columns, picks a label column, colors status dots,
 * and formats values per header heuristics.
 * columns: string[] (column names)
 * rows: any[][] (value lists)
 */
function buildTable(columns, rows) {
  if (!columns || !columns.length || !rows || !rows.length) return null;

  // Rule 1: hide id columns (match /^id$|_id$/i).
  // Exception: keep first column if ALL are ids so table is not empty.
  const idRe = /^id$|_id$/i;
  let displayIdx = columns.map((c, i) => i).filter(i => !idRe.test(columns[i]));
  if (displayIdx.length === 0) displayIdx = [0];

  // Rule 2: pick the label column - first displayed non-numeric column,
  // preferring one whose name matches a "name-like" pattern.
  const nameLikeRe = /name|store|daypart|label|title|zip|neighborhood|category/i;
  const capped = rows.slice(0, MAX_ROWS);

  function isNonNumericCol(ci) {
    return capped.some(r => {
      const v = r[ci];
      if (v == null) return false;
      if (typeof v === 'number') return false;
      return isNaN(Number(v));
    });
  }

  const nonNumericDisplayed = displayIdx.filter(i => isNonNumericCol(i));
  let labelIdx;
  if (nonNumericDisplayed.length > 0) {
    const preferred = nonNumericDisplayed.find(i => nameLikeRe.test(columns[i]));
    labelIdx = preferred !== undefined ? preferred : nonNumericDisplayed[0];
  } else {
    labelIdx = displayIdx[0];
  }

  // Rule 3: find the status column for dot coloring.
  const statusRe = /status/i;
  const statusValues = new Set(['understaffed', 'overstaffed', 'balanced']);
  let statusIdx = null;
  for (const ci of displayIdx) {
    if (statusRe.test(columns[ci])) { statusIdx = ci; break; }
    const hasStatusVal = capped.some(r => {
      const v = r[ci];
      return v != null && statusValues.has(String(v).toLowerCase().trim());
    });
    if (hasStatusVal) { statusIdx = ci; break; }
  }

  // Rule 4: prettify headers.
  const h0 = _prettyHeader(columns[labelIdx]);
  const valueIdx = displayIdx.filter(i => i !== labelIdx);
  const hrest = valueIdx.map(i => _prettyHeader(columns[i]));

  // Build rows.
  const tableRows = capped.map(r => {
    const dotVal = statusIdx !== null ? r[statusIdx] : null;
    return {
      name: String(r[labelIdx] ?? ''),
      vals: valueIdx.map(i => _formatValue(columns[i], r[i])),
      dot: _statusColor(dotVal),
    };
  });

  return { h0, hrest, rows: tableRows };
}

// ---------- Main GeniePanel ----------

export default function GeniePanel({ onClose, seedQuestion }) {
  const scrollRef = useRef(null);
  const [messages, setMessages] = useState([]);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const [conversationId, setConversationId] = useState(null);
  // Ref mirror of conversationId - always up to date regardless of render timing
  const conversationIdRef = useRef(null);
  // In-flight guard - prevents overlapping concurrent sends
  const sendingRef = useRef(false);
  // Track if the auto-run default has been sent
  const autoSentRef = useRef(false);

  const sendMessage = useCallback(async (question, _unused, isAuto) => {
    const q = question.trim();
    if (!q) return;

    // In-flight guard: reject overlapping sends
    if (sendingRef.current) return;
    sendingRef.current = true;

    // Read conversation id from ref - always current, never a stale closure
    const usedConvId = conversationIdRef.current;

    // Append user bubble (skip for auto-run to avoid cluttering the panel on load)
    if (!isAuto) {
      setMessages(prev => [...prev, { role: 'user', text: q }]);
    }
    setTyping(true);

    try {
      const res = await postGenieAsk(q, usedConvId);
      // Thread the conversation - update both ref (for immediate next-turn use) and state (for rendering)
      const newConvId = res.conversation_id || usedConvId;
      conversationIdRef.current = newConvId;
      setConversationId(newConvId);

      const text = res.text || '';
      const sql = res.sql || null;
      const columns = res.columns || [];
      const rows = res.rows || [];

      const hasData = columns.length > 0 && rows.length > 0;
      const table = hasData ? buildTable(columns, rows) : null;

      // Start building the genie message
      const genieMsg = { role: 'genie', text, sql, table };

      // Call /api/action only when we have sql or data
      if (sql || hasData) {
        try {
          const actionRes = await postAction(q, sql || '', rows.slice(0, MAX_ROWS));
          const actionText = (actionRes && actionRes.action) ? actionRes.action : null;
          if (actionText) {
            genieMsg.callout = {
              icon: '⚡',
              label: 'Action:',
              text: actionText,
              bg: '#FFF1EE',
              bar: '#FF3621',
            };
          }
        } catch (_) {
          // Action call failure is non-fatal; omit callout
        }
      }

      setMessages(prev => [...prev, genieMsg]);
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'genie',
        text: 'Sorry, I could not reach the data space right now. Please try again in a moment.',
      }]);
    } finally {
      setTyping(false);
      sendingRef.current = false;
    }
  }, []); // stable - reads refs, not state closures

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (scrollRef.current) {
      setTimeout(() => { scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, 50);
    }
  }, [messages, typing]);

  // Auto-run the default question on first mount
  useEffect(() => {
    if (autoSentRef.current) return;
    autoSentRef.current = true;
    sendMessage(DEFAULT_QUESTION, null, true /* isAuto */);
  }, [sendMessage]); // sendMessage is stable (useCallback with empty deps)

  // Handle seedQuestion from drill-down "Ask Genie how to staff this store"
  // seedQuestion is { q, ts } so the same store re-clicked always fires
  useEffect(() => {
    if (!seedQuestion || !seedQuestion.q) return;
    sendMessage(seedQuestion.q);
  }, [seedQuestion, sendMessage]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleSendDraft() {
    const q = draft.trim();
    if (!q) return;
    setDraft('');
    sendMessage(q);
  }

  function handleChip(question) {
    sendMessage(question);
  }

  // ---------- Render ----------
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, background: '#fff', borderRadius: 14, overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--db-line)', background: 'linear-gradient(180deg,#fff,#fbfaf8)' }}>
        <img src="/assets/genie-icon-full-color.svg" style={{ width: 26, height: 26, display: 'block' }} alt="Genie" />
        <div style={{ flex: 1 }}>
          <div style={{ font: '700 14px var(--font-sans)', color: 'var(--db-navy)' }}>Ask Genie</div>
          <div style={{ font: '500 11px var(--font-sans)', color: 'var(--db-ink-muted)' }}>Store Operations - <span style={{ color: 'var(--db-coral)' }}>Labor</span></div>
        </div>
        <span style={{ font: '400 10px var(--font-mono)', color: 'var(--db-ink-muted)', border: '1px solid var(--db-line)', borderRadius: 6, padding: '3px 7px' }}>space: store_ops</span>
        <button
          onClick={onClose}
          title="Hide Ask Genie"
          style={{ border: 'none', background: 'var(--db-oat-medium)', color: 'var(--db-ink-soft)', width: 24, height: 24, borderRadius: 7, cursor: 'pointer', fontSize: 13, lineHeight: 1, flexShrink: 0 }}
        >&#x2715;</button>
      </div>

      {/* Message scroll area */}
      <div
        ref={scrollRef}
        className="lf"
        style={{ flex: 1, minHeight: 120, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        {messages.map((msg, i) => <GenieMessage key={i} msg={msg} />)}
        {typing && <TypingIndicator />}
      </div>

      {/* Input area */}
      <div style={{ padding: '10px 12px', borderTop: '1px solid var(--db-line)', background: 'var(--db-oat-light)' }}>
        <div className="lf" style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 8 }}>
          {CHIPS.map(c => (
            <button
              key={c.key}
              onClick={() => handleChip(c.question)}
              disabled={typing}
              style={{ flex: '0 0 auto', whiteSpace: 'nowrap', border: '1px solid var(--db-line)', background: '#fff', color: 'var(--db-navy)', borderRadius: 999, padding: '6px 12px', font: '500 11px var(--font-sans)', cursor: typing ? 'not-allowed' : 'pointer', opacity: typing ? 0.45 : 1 }}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, background: '#fff', border: '1px solid var(--db-gray-300)', borderRadius: 10, padding: '6px 6px 6px 12px' }}>
          <input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !typing && handleSendDraft()}
            disabled={typing}
            placeholder="Ask about labor, staffing, foot traffic..."
            style={{ flex: 1, border: 'none', outline: 'none', font: '400 13px var(--font-sans)', color: 'var(--db-ink)', background: 'transparent', height: 28, opacity: typing ? 0.55 : 1 }}
          />
          <button
            onClick={handleSendDraft}
            disabled={typing}
            style={{ flex: '0 0 auto', border: 'none', background: 'var(--db-lava)', color: '#fff', width: 30, height: 30, borderRadius: 8, cursor: typing ? 'not-allowed' : 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: typing ? 0.45 : 1 }}
          >
            {'↑'}
          </button>
        </div>
        <div style={{ marginTop: 6, font: '400 10px var(--font-sans)', color: 'var(--db-ink-muted)', textAlign: 'center' }}>
          Powered by Genie - querying clover.retail_analytics live.
        </div>
      </div>
    </div>
  );
}
