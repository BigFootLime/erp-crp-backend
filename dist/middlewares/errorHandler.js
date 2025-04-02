"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandler = errorHandler;
const errors_1 = require("../utils/errors");
const logger_1 = __importDefault(require("../utils/logger"));
function errorHandler(err, req, res, next) {
    logger_1.default.error('Error caught by middleware:', {
        message: err.message,
        stack: err.stack,
        method: req.method,
        path: req.path,
        ip: req.ip,
    });
    if (err instanceof errors_1.AppError) {
        res.status(err.statusCode).json({ error: err.message });
    }
    else {
        res.status(500).json({ error: 'Internal Server Error' });
    }
}
