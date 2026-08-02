/*
 * Plan 0525 PHASE 4 — the seat link's discarded `?userId=` is DECLARED, not silent.
 *
 * WHAT THE 0524 SESSION SAW. A participant opened a seat link carrying `?userId=`, and landed on
 * the roster under a DIFFERENT id than the URL asked for. That looked like a bug and is not one:
 * app/server.mjs says it in as many words — "identity is DERIVED from the link and nothing else:
 * userId = <stationCode>-<slug(userName)>". The derivation is load-bearing. It is what makes a
 * RELOAD return the same seat instead of minting a fresh anonymous id, which is the churn that
 * 0508 D3 hit and 0522 P3 ("one person, one roster row") was written to remove.
 *
 * SO THIS PHASE CHANGES NOTHING. The only real residual is that the discard was undocumented and
 * unpinned — one refactor away from becoming per-reload churn again with nobody noticing. t79 is
 * the pin; RUN.md §1 is the declaration a person constructing a link can read.
 *
 * ⛔ The tempting "fix" — honour the caller's `userId` on a seat link — is exactly the regression
 * this test exists to catch. Do not make it. If it is ever made, claim (b) below is the assertion
 * that names the damage.
 *
 * The registry here is the neutral 0514 fixture (alpha/beta), not the installed deployment: core
 * carries no deployment's vocabulary, per docs/naming-canon.md. It also keeps the test off the
 * gitignored plugin tree, so it runs in a clean clone.
 */
import { test, expect } from '../../harness/test.mjs';
import { createServer, slugForSeat } from '../../app/server.mjs';
import { WebSocket } from 'ws';
import { makePluginsDir, withPlugins, stationManifest, connect, last } from './_0514-fixtures.mjs';

// What app/presenter.html actually puts on the wire, from its own reading of the query string:
//   seatLinked = q.get('stationUID') != null || q.get('station') != null
//   stationUID = seatLinked ? <int|null> : undefined     ← the key is ABSENT off a seat link
//   userId     = q.get('userId') || q.get('u') || 'anon-<random>'   ← ALWAYS sent, seat link or not
const SEAT_LINK_UID = 1;            // ?stationUID=1  → stationCode 'alpha' in the fixture registry
const LINK_NAME = 'Participant A';       // ?n=Von%20Sydo
const ASKED_ID = 'participant-a';         // ?userId=participant-a — what the caller asks to be called

test('0525 t79 — a seat link DERIVES its userId and discards the one asked for; a reload derives the SAME one; a non-seat link still honours it', async () => {
  const dir = makePluginsDir({ fixture: { 'plugin.json': stationManifest() } });
  await withPlugins(dir, async () => {
    const server = await createServer({ port: 0 });
    const url = server.url().replace('http', 'ws');
    const conns = [];
    try {
      const DERIVED = 'alpha-' + slugForSeat(LINK_NAME);   // the rule, spelled out: <stationCode>-<slug(userName)>

      // ── (a) THE DISCARD. A seat link carrying ?userId= is seated under the DERIVED id. ────────
      const seat = await connect(WebSocket, url, { stationUID: SEAT_LINK_UID, userId: ASKED_ID, userName: LINK_NAME });
      conns.push(seat);
      const wa = last(seat, 'welcome');
      expect(wa && wa.userId === DERIVED, 'a seat link derives <stationCode>-<slug(name)>', wa && wa.userId);
      expect(wa && wa.userId !== ASKED_ID, 'and the ?userId= the link asked for is DISCARDED, not honoured', wa && wa.userId);
      expect(server.presence().some((p) => p.userId === DERIVED), 'the roster row is the derived id', JSON.stringify(server.presence().map((p) => p.userId)));
      expect(!server.presence().some((p) => p.userId === ASKED_ID), 'and no roster row carries the asked-for id');

      // The `?station=`-only form is a seat link too — presenter.html sends stationUID:null for it,
      // which resolves to the deployment default. Same rule, no branch.
      const cosmetic = await connect(WebSocket, url, { stationUID: null, userId: ASKED_ID, userName: LINK_NAME });
      conns.push(cosmetic);
      const wc = last(cosmetic, 'welcome');
      expect(wc && wc.userId === 'beta-' + slugForSeat(LINK_NAME), 'a ?station=-only link derives from the DEFAULT station', wc && wc.userId);
      expect(wc && wc.userId !== ASKED_ID, 'and it discards ?userId= as well', wc && wc.userId);

      // ── (b) WHY IT EXISTS. The same link opened again yields the SAME id. ─────────────────────
      // This is the property the derivation is FOR, and the one honouring the caller's id would
      // destroy — a browser reload sends whatever ?userId= the URL bears, or a fresh anon-<random>
      // when it bears none, and either way a per-reload id orphans the seat (0508 D3).
      const reload = await connect(WebSocket, url, { stationUID: SEAT_LINK_UID, userId: ASKED_ID, userName: LINK_NAME });
      conns.push(reload);
      expect(last(reload, 'welcome').userId === DERIVED, 'a RELOAD of the same seat link derives the SAME id', last(reload, 'welcome').userId);

      // Same link, a DIFFERENT asked-for id: still the same seat. The derived id depends on the
      // link's station and name, and on NOTHING the caller supplies alongside them.
      const churn = await connect(WebSocket, url, { stationUID: SEAT_LINK_UID, userId: 'anon-9f3xk1', userName: LINK_NAME });
      conns.push(churn);
      expect(last(churn, 'welcome').userId === DERIVED, 'and a fresh anon id on the same link lands on the SAME seat, not a new one', last(churn, 'welcome').userId);
      const rows = server.presence().map((p) => p.userId).filter((id) => id === DERIVED);
      expect(rows.length === 1, 'so four connections on two seat links leave ONE roster row for that seat', String(rows.length));

      // ── (c) THE SCOPE. Off a seat link, ?userId= is honoured exactly as given. ────────────────
      // presenter.html omits the stationUID key entirely when the URL carries neither selector,
      // so the server falls through to the anonymous identity path — where the caller's id stands.
      const plain = await connect(WebSocket, url, { userId: ASKED_ID, userName: LINK_NAME });
      conns.push(plain);
      const wp = last(plain, 'welcome');
      expect(wp && wp.userId === ASKED_ID, 'a NON-seat link is seated under the ?userId= it asked for', wp && wp.userId);
      expect(wp && wp.userName === LINK_NAME, 'and keeps its name', wp && wp.userName);
      expect(server.presence().some((p) => p.userId === ASKED_ID), 'the roster carries the asked-for id on that path', JSON.stringify(server.presence().map((p) => p.userId)));
    } finally {
      for (const c of conns) { try { c.ws.close(); } catch (e) {} }
      await server.close();
    }
  });
});
