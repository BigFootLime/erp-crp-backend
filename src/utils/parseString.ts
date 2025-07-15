export function parseString(value: any, fieldName = "Valeur"): string {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`${fieldName} invalide ou manquant`);
    }
    return value.trim();
}
