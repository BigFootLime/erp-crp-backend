const log = (...args: any[]) => console.log('[LOG]', ...args);
const info = (...args: any[]) => console.info('[INFO]', ...args);
const error = (...args: any[]) => console.error('[ERROR]', ...args);
const warn = (...args: any[]) => console.warn('[WARN]', ...args);

export default { log, info, error, warn };
