// pulselog — probe what you run, stay silent when green, alert when not.
// Programmatic surface (the CLI in bin/ is the usual entry).
export { run } from './run.js';
export { CHECKS } from './checks.js';
export { createSink } from './sink.js';
export { assembleEmail, sendEmail } from './email.js';
