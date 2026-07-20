/*
 * X5 — RAF metrics via presenter_raf. A scripted PEER-REACTIVE session (mostly
 * participant, peer-visible, cross-user responses) yields peer-catalysis >
 * teacher-dependency and non-zero interaction density.
 */
import { test, expect } from '../../harness/test.mjs';
import { toolMap, _server } from '../../mcp/tools.mjs';

const part = (id) => ({ userId: id, role: 'participant' });
const gm = { userId: 'gm', role: 'presenter' };

test('X5 — peer-reactive session: peer-catalysis > teacher-dependency; density > 0', async () => {
  const T = toolMap();
  await T.presenter_start.handler({ port: 0 });
  const s = _server();
  try {
    // One teacher (GM) action; four peer (participant) actions, cross-user responsive.
    s.store.apply({ path: 'map/view', verb: 'set', value: { x: 0 } }, gm);                         // teacher
    s.store.apply({ path: 'polls/p/votes/u1', verb: 'set', value: 'yes' }, part('u1'));            // peer
    s.store.apply({ path: 'polls/p/votes/u2', verb: 'set', value: 'no' }, part('u2'));             // peer responds
    s.store.apply({ path: 'map/markers', verb: 'add', value: { id: 'm1' } }, part('u1'));          // peer responds
    s.store.apply({ path: 'map/markers', verb: 'add', value: { id: 'm2' } }, part('u2'));          // peer responds

    const raf = await T.presenter_raf.handler({ windowMs: 5000 });
    expect(raf.totalOps === 5, 'five ops logged', String(raf.totalOps));
    expect(raf.peerCatalysisRatio > raf.teacherDependencyRatio, 'peer-catalysis > teacher-dependency',
      JSON.stringify({ peer: raf.peerCatalysisRatio, teacher: raf.teacherDependencyRatio }));
    // Plan 0471 C3: private votes are NO LONGER peer-visible (ballot secrecy), so only the 2
    // shared map/markers count as peer-catalysis: 2/5 = 0.4 (was 0.8 under default-open read).
    expect(Math.abs(raf.peerCatalysisRatio - 0.4) < 1e-6, 'peer-catalysis = 2/5 (markers; votes now private)', String(raf.peerCatalysisRatio));
    expect(Math.abs(raf.teacherDependencyRatio - 0.2) < 1e-6, 'teacher-dependency = 1/5', String(raf.teacherDependencyRatio));
    expect(raf.peerResponseEdges === 3 && raf.interactionDensity > 0, 'peer->peer response edges counted',
      JSON.stringify({ edges: raf.peerResponseEdges, density: raf.interactionDensity }));
  } finally { await T.presenter_stop.handler({}); }
});
