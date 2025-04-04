// src/utils/parseId.ts
export class AppError extends Error {
    statusCode: number;

    constructor(message: string, statusCode = 400) {
        super(message);
        this.statusCode = statusCode;
        Object.setPrototypeOf(this, AppError.prototype);
    }
}

export function parseId(value: any, label = "ID"): number {
    const parsed = parseInt(value);
    if (isNaN(parsed)) {
        throw new AppError(`${label} invalide`, 400);
    }
    return parsed;
}
