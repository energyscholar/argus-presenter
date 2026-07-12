/*
 * Plugin ai-train-the-trainer — scene templates. A PURE-CONTENT plugin: no new
 * components, just domain scenes composed from core components. Shows the plugin
 * spectrum (from "adds components" like the example plugin to "adds only content").
 */
export function exerciseCheckpoint({ userId, userName, exercise = 'CLAUDE.md config' } = {}) {
  return {
    layout: 'stack', title: 'Exercise Checkpoint', userId, userName,
    items: [
      { component: 'narration', opts: { speaker: 'Coach', text: 'You built a ' + exercise + '. Let’s verify it actually pays off.', promptId: 'ex-nar' } },
      { component: 'choice', opts: { prompt: 'Did your config measurably reduce token cost?', options: [{ label: 'Yes — I measured it', value: 'yes', style: 'ok' }, { label: 'Not sure', value: 'unsure', style: 'danger' }], promptId: 'ex-check' } },
      { component: 'card', opts: { title: 'Stuck?', reveal: { label: 'Show hint', body: 'Run the same task with and without the config; compare the token counts in the status line.' }, promptId: 'ex-hint' } }
    ]
  };
}

export const plugin = { name: 'ai-train-the-trainer', components: [], scenes: { checkpoint: exerciseCheckpoint } };
