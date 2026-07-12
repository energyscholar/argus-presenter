/*
 * core-schemas.mjs — the published INPUT SCHEMA for every core component
 * (the "content contract", phase3-decision 1). Each entry: fields[] with
 * { name, type, default?, required? }. This is the machine-readable source the
 * manifest generator (A5) attaches to the registry catalog, and the schema the
 * validator/assembler checks authored content against. Domain-neutral.
 */
export const coreSchemas = {
  choice: { fields: [
    { name: 'prompt', type: 'string', default: 'Choose:' },
    { name: 'options', type: 'array', default: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }] },
    { name: 'promptId', type: 'string' },
  ] },
  'text-input': { fields: [
    { name: 'prompt', type: 'string', default: 'Your answer:' },
    { name: 'placeholder', type: 'string' },
    { name: 'validate', type: 'string' },
    { name: 'submitLabel', type: 'string', default: 'Submit' },
    { name: 'promptId', type: 'string' },
  ] },
  slider: { fields: [
    { name: 'prompt', type: 'string', default: 'Select a value:' },
    { name: 'min', type: 'number', default: 0 },
    { name: 'max', type: 'number', default: 100 },
    { name: 'step', type: 'number', default: 1 },
    { name: 'value', type: 'number', default: 0 },
    { name: 'unit', type: 'string' },
    { name: 'promptId', type: 'string' },
  ] },
  dice: { fields: [
    { name: 'label', type: 'string' },
    { name: 'dice', type: 'string', default: '2d6' },
    { name: 'target', type: 'number' },
    { name: 'promptId', type: 'string' },
  ] },
  form: { fields: [
    { name: 'title', type: 'string' },
    { name: 'fields', type: 'array', default: [] },
    { name: 'promptId', type: 'string' },
  ] },
  'poll-results': { fields: [
    { name: 'prompt', type: 'string' },
    { name: 'options', type: 'array', default: [] },
    { name: 'tally', type: 'object', default: {} },
    { name: 'count', type: 'number', default: 0 },
    { name: 'promptId', type: 'string' },
  ] },
  narration: { fields: [
    { name: 'speaker', type: 'string' },
    { name: 'text', type: 'string', default: '' },
    { name: 'cta', type: 'string' },
    { name: 'promptId', type: 'string' },
  ] },
  card: { fields: [
    { name: 'title', type: 'string' },
    { name: 'subtitle', type: 'string' },
    { name: 'image', type: 'string' },
    { name: 'imageAlt', type: 'string' },
    { name: 'body', type: 'string' },
    { name: 'badges', type: 'array' },
    { name: 'footer', type: 'string' },
    { name: 'reveal', type: 'object' },
    { name: 'promptId', type: 'string' },
  ] },
  image: { fields: [
    { name: 'src', type: 'string' },
    { name: 'caption', type: 'string' },
    { name: 'alt', type: 'string' },
    { name: 'frame', type: 'boolean', default: false },
    { name: 'fit', type: 'string' },
  ] },
  map: { fields: [
    { name: 'controllable', type: 'boolean', default: false },
    { name: 'image', type: 'string' },
    { name: 'svg', type: 'string' },
    { name: 'preset', type: 'string' },
    { name: 'label', type: 'string' },
    { name: 'laser', type: 'boolean', default: true },
    { name: 'x', type: 'number', default: 0 },
    { name: 'y', type: 'number', default: 0 },
    { name: 'scale', type: 'number', default: 1 },
  ] },
  'svg-reactive': { fields: [
    { name: 'label', type: 'string' },
    { name: 'watch', type: 'string' },
    { name: 'min', type: 'number', default: 0 },
    { name: 'max', type: 'number', default: 100 },
    { name: 'value', type: 'number', default: 0 },
  ] },
  stepper: { fields: [
    { name: 'showProgress', type: 'boolean', default: false },
    { name: 'steps', type: 'array', default: [] },
    { name: 'promptId', type: 'string' },
  ] },
  scene: { fields: [
    { name: 'title', type: 'string' },
    { name: 'layout', type: 'string', default: 'stack' },
    { name: 'gap', type: 'string' },
    { name: 'columns', type: 'string' },
    { name: 'areas', type: 'string' },
    { name: 'items', type: 'array', default: [] },
  ] },
  crud: { fields: [
    { name: 'id', type: 'string', default: 'list' },
    { name: 'title', type: 'string' },
    { name: 'fields', type: 'array', default: [{ name: 'text', label: 'Item' }] },
    { name: 'items', type: 'object', default: {} },
    { name: 'config', type: 'string' },
    { name: 'allowAdd', type: 'boolean', default: true },
  ] },
};
