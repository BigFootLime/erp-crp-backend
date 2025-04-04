"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppError = void 0;
exports.parseId = parseId;
// src/utils/parseId.ts
class AppError extends Error {
    constructor(message, statusCode = 400) {
        super(message);
        this.statusCode = statusCode;
        Object.setPrototypeOf(this, AppError.prototype);
    }
}
exports.AppError = AppError;
function parseId(value, label = "ID") {
    const parsed = parseInt(value);
    if (isNaN(parsed)) {
        throw new AppError(`${label} invalide`, 400);
    }
    return parsed;
}
