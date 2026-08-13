/*
 * Plugin example — scene templates (Node side; used by MCP/server to build domain
 * content). Composes core + plugin components into ready-to-push scenes.
 */
export function forecastScene({ userId, userName } = {}) {
  return {
    layout: 'grid', title: 'Weather Station', userId, userName,
    items: [
      { component: 'weather', opts: { title: 'Downtown Station', metrics: [{ key: 'temp', label: 'Temp', value: 64 }, { key: 'humidity', label: 'Humidity', value: 40 }, { key: 'wind', label: 'Wind', value: 20 }] } },
      { component: 'narration', opts: { speaker: 'Forecaster', text: 'A cold front is moving in; humidity is climbing fast.', promptId: 'wx-nar' } },
      { component: 'choice', opts: { prompt: 'What do we recommend to viewers?', options: [{ label: 'Bring an umbrella', value: 'umbrella', style: 'ok' }, { label: 'Clear skies', value: 'clear' }, { label: 'Stay indoors', value: 'stayin' }], promptId: 'wx-choice' } }
    ]
  };
}

export const plugin = { name: 'example', components: ['weather'], scenes: { forecast: forecastScene } };
