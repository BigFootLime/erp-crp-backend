"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ForbiddenError = exports.AuthenticationError = exports.ValidationError = exports.UnauthorizedError = exports.ConflictError = exports.NotFoundError = exports.AppError = void 0;
class AppError extends Error {
    constructor(message, statusCode = 500, isOperational = true) {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = isOperational;
        Error.captureStackTrace(this, this.constructor);
    }
}
exports.AppError = AppError;
class NotFoundError extends AppError {
    constructor(message = 'Ressource introuvable') {
        super(message, 404);
    }
}
exports.NotFoundError = NotFoundError;
class ConflictError extends AppError {
    constructor(message = 'Conflit : ressource déjà existante') {
        super(message, 409);
    }
}
exports.ConflictError = ConflictError;
class UnauthorizedError extends AppError {
    constructor(message = 'Non autorisé') {
        super(message, 401);
    }
}
exports.UnauthorizedError = UnauthorizedError;
class ValidationError extends AppError {
    constructor(message = 'Données invalides') {
        super(message, 400);
    }
}
exports.ValidationError = ValidationError;
class AuthenticationError extends AppError {
    constructor(message = 'Authentification requise') {
        super(message, 401);
    }
}
exports.AuthenticationError = AuthenticationError;
class ForbiddenError extends AppError {
    constructor(message = 'Accès interdit') {
        super(message, 403);
    }
}
exports.ForbiddenError = ForbiddenError;
