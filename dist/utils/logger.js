"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const log = (...args) => console.log('[LOG]', ...args);
const info = (...args) => console.info('[INFO]', ...args);
const error = (...args) => console.error('[ERROR]', ...args);
const warn = (...args) => console.warn('[WARN]', ...args);
exports.default = { log, info, error, warn };
