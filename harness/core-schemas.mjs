/*
 * core-schemas.mjs — the published INPUT SCHEMA for every core component
 * (the "content contract", phase3-decision 1). Each entry: fields[] with
 * { name, type, default?, required? }. This is the machine-readable source the
 * manifest generator (A5) attaches to the registry catalog, and the schema the
 * validator/assembler checks authored content against. Domain-neutral.
 *
 * ⚠ EVERY components/ DIRECTORY NEEDS AN ENTRY HERE. `generateManifest()` filters for the ones
 * that have none and THROWS, so a component added without a schema does not fail quietly — it
 * fails everywhere the manifest is built, in tests about other things. `t80`
 * (test/unit/0525-p5-core-schema-coverage.test.mjs) is the test that names the missing one.
 */

/*
 * The `map` field list is named because ONE OTHER COMPONENT RENDERS THROUGH IT. components/navmap/
 * navmap.js does not reimplement the map: it looks the `map` factory up in the client registry and
 * calls it with the SAME opts object, then appends one draggable token on top —
 *   "opts = <map opts> + { tokenLabel?, tokenPx?, tokenPy?, tokenId? }"
 * — so every field below is equally a navmap field, and sharing the list rather than copying it is
 * what stops the two parting company the day a map field is added.
 */
const mapFields = [
  { name: 'controllable', type: 'boolean', default: false },
  { name: 'image', type: 'string' },
  { name: 'svg', type: 'string' },
  { name: 'preset', type: 'string' },
  { name: 'label', type: 'string' },
  { name: 'laser', type: 'boolean', default: true },
  { name: 'x', type: 'number', default: 0 },
  { name: 'y', type: 'number', default: 0 },
  { name: 'scale', type: 'number', default: 1 },
];

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
  // Plan 0493 §8 — the standard markdown text-response card. `html` is SERVER-SANITISED markdown output
  // (app/markdown.mjs), never author-supplied raw HTML; present_text is the only intended writer.
  prose: { fields: [
    { name: 'html', type: 'string', default: '' },
    { name: 'title', type: 'string' },
    { name: 'chrome', type: 'boolean', default: true },
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
  map: { fields: mapFields },
  // navmap — the map, plus ONE token any seat may drag. It delegates rendering to `map` with the
  // same opts (above) and adds four of its own, read straight out of components/navmap/navmap.js:
  //   tokenLabel  the caption under the token          opts.tokenLabel || 'AD'
  //   tokenPx/Py  where it starts, as a FRACTION of the untransformed content box, matching the
  //               map's own marker anchoring — not pixels, so it survives pan and zoom
  //               typeof opts.tokenPx === 'number' ? opts.tokenPx : 0.654  (py: 0.345)
  //   tokenId     the marker id it writes to `map/markers`; re-adding the same id overwrites, which
  //               is what makes the token SHARED rather than one per dragger    opts.tokenId || 'ship-ad'
  // The defaults are the component's own, recorded rather than tidied: an author who fills nothing
  // in gets exactly these, and a schema that hid them would be describing a component that does
  // not exist.
  navmap: { fields: [
    ...mapFields,
    { name: 'tokenLabel', type: 'string', default: 'AD' },
    { name: 'tokenPx', type: 'number', default: 0.654 },
    { name: 'tokenPy', type: 'number', default: 0.345 },
    { name: 'tokenId', type: 'string', default: 'ship-ad' },
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
