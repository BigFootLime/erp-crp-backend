export class AppError extends Error {
    public readonly statusCode: number;
    public readonly isOperational: boolean;
  
    constructor(message: string, statusCode = 500, isOperational = true) {
      super(message);
      this.statusCode = statusCode;
      this.isOperational = isOperational;
      Error.captureStackTrace(this, this.constructor);
    }
  }
  
  export class NotFoundError extends AppError {
    constructor(message = 'Ressource introuvable') {
      super(message, 404);
    }
  }
  
  export class ConflictError extends AppError {
    constructor(message = 'Conflit : ressource déjà existante') {
      super(message, 409);
    }
  }
  
  export class UnauthorizedError extends AppError {
    constructor(message = 'Non autorisé') {
      super(message, 401);
    }
  }
  
  export class ValidationError extends AppError {
    constructor(message = 'Données invalides') {
      super(message, 400);
    }
  }
  
  export class AuthenticationError extends AppError {
    constructor(message = 'Authentification requise') {
      super(message, 401);
    }
  }
  
  export class ForbiddenError extends AppError {
    constructor(message = 'Accès interdit') {
      super(message, 403);
    }
  }
  