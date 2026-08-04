/*
 * 0537 P4 — THE REPLY CHANNEL IS SUMMONED, NOT PERMANENT.
 *
 * docs/display-chrome-budget.md: "An element earns PERMANENCE only if the participant needs it
 * WITHOUT KNOWING THEY NEED IT." The reply channel is on that short list, so it cannot be deleted —
 * but that argues for DISCOVERABILITY, not for a text box. What stays is a 20×85 edge tab; the
 * input is behind it.
 *
 *   C1  the tab is always present; the panel is NOT, and "not present" means not laid out
 *   C2  the tab opens it, and the tab is still reachable once it is open (it covered itself once)
 *   C3  ESC closes it, so the panel is never something you are stuck inside
 *   C4  the disabled state says WHY, in words naming a cause and an action (P4.2)
 *   C5  ⛓ the always-present element COUNT, asserted — the budget doc's rule is that this number
 *       must never drift silently, and a doc nobody re-measures is a doc that is already wrong
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer } from '../../app/server.mjs';
import { launch, until } from '../../harness/multi.mjs';
import { WebSocket } from 'ws';

/* The inventory, as code. Same method as the doc's table: everything laid out in the FIXED chrome
 * layer, excluding the stage — minus the two containers (`ap-seat`, `ap-chat`) the table lists only
 * by their children, so this returns the doc's number and not a second, incompatible one. */
const INVENTORY = () => {
  const out = [];
  const stage = document.getElementById('stage');
  document.querySelectorAll('body *').forEach((el) => {
    if (stage && (el === stage || stage.contains(el))) return;
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    let n = el, fixed = false;
    while (n && n !== document.body) { if (getComputedStyle(n).position === 'fixed') { fixed = true; break; } n = n.parentElement; }
    if (!fixed) return;
    if (el.id === 'ap-seat' || el.id === 'ap-chat') return;   // containers; the doc counts their children
    out.push(el.id || el.tagName.toLowerCase());
  });
  return out;
};

test('0537 P4 — the message panel is summoned, the tab stays reachable, and the chrome count holds at 7', async () => {
  const server = await createServer({ port: 0 });
  const browser = await launch();
  try {
    const p = await browser.newPage();
    await p.setViewport({ width: 1280, height: 800 });
    await p.goto(`${server.url()}/?userId=u1&name=U1&role=participant`, { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => window.__apChatPanel && typeof window.__apChatPanel.set === 'function');

    // ---- C1 + C5: the closed floor ----
    const closed = await p.evaluate(INVENTORY);
    expect(closed.includes('ap-chat-tab'), 'the tab is always present', JSON.stringify(closed));
    expect(!closed.includes('ap-chat-input') && !closed.includes('ap-chat-send'),
      'the INPUT is not — it is summoned', JSON.stringify(closed));
    // ⛓ C5. If this number changes, the change was deliberate and docs/display-chrome-budget.md
    // must change with it. ⛔ Do not "fix" this by editing the 7 — re-measure, then argue the case.
    expect(closed.length === 7,
      'SEVEN always-present elements on a bare deployment (docs/display-chrome-budget.md)',
      `${closed.length}: ${JSON.stringify(closed)}`);
    // The bottom bar is gone: nothing full-width remains at the floor except the 6px echo strip.
    const floor = await p.evaluate(() => {
      const r = document.getElementById('ap-chat').getBoundingClientRect();
      return { chatVisible: getComputedStyle(document.getElementById('ap-chat')).visibility, chatBottom: r.bottom };
    });
    expect(floor.chatVisible === 'hidden', 'the collapsed panel is visibility:hidden — not merely parked off-screen', floor.chatVisible);

    // ---- C4: the disabled state names a cause and an action (no listener attached yet) ----
    const why = await p.evaluate(() => document.getElementById('ap-chat-why').textContent);
    expect(/nobody is listening/i.test(why), 'the disabled state names the CAUSE', why);
    expect(/nothing is broken|nothing to switch on/i.test(why),
      'and answers the question the old copy provoked ("is this built yet?")', why);
    expect(!/disabled until a listener is attached/i.test(why), 'the old code-shaped wording is gone', why);

    // ---- C2: the tab opens it, and is STILL clickable once open ----
    await p.click('#ap-chat-tab');
    await until(async () => (await p.evaluate(() => window.__apChatPanel.open())) === true, { label: 'panel open', timeout: 5000 });
    const open = await p.evaluate(() => {
      const t = document.getElementById('ap-chat-tab').getBoundingClientRect();
      const hit = document.elementFromPoint(Math.round(t.left + t.width / 2), Math.round(t.top + t.height / 2));
      return { onTop: !!(hit && (hit.id === 'ap-chat-tab' || hit.closest('#ap-chat-tab'))),
               label: document.getElementById('ap-chat-tab').textContent,
               inputShown: document.getElementById('ap-chat-input').getBoundingClientRect().width > 0 };
    });
    expect(open.inputShown, 'the input is on screen once summoned');
    // ⛓ The panel is at right:0 and outranks the tab; it DID cover it, and ESC was the only way
    // out. Found in a screenshot. This is the assertion that keeps it found.
    expect(open.onTop, 'the tab is still the top element at its own centre — the panel must not cover its own control');
    expect(open.label === 'CLOSE', 'and it says what it will now do', open.label);
    // Clicking it again closes — the tab is a real toggle, not a one-way door.
    await p.click('#ap-chat-tab');
    await until(async () => (await p.evaluate(() => window.__apChatPanel.open())) === false, { label: 'panel closed by tab', timeout: 5000 });

    // ---- C3: ESC closes ----
    await p.evaluate(() => window.__apChatPanel.set(true));
    await p.keyboard.press('Escape');
    await until(async () => (await p.evaluate(() => window.__apChatPanel.open())) === false, { label: 'panel closed by ESC', timeout: 5000 });

    // ---- and the enabled state clears the warning ----
    const listener = new WebSocket(server.url().replace('http', 'ws'));
    await new Promise((r) => listener.on('open', () => { listener.send(JSON.stringify({ t: 'hello', userId: 'gm', role: 'presenter' })); r(); }));
    await until(async () => (await p.evaluate(() => window.__apChat.enabled())) === true, { label: 'input enabled', timeout: 5000 });
    const cleared = await p.evaluate(() => document.getElementById('ap-chat-why').textContent);
    expect(cleared === '', 'the warning clears by itself when a listener joins — exactly as it promised', cleared);
    listener.close();
  } finally { await browser.close(); await server.close(); }
});
