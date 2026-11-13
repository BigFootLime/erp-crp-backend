/** Project the form's serialized operational block into customer-facing notes.
 * Call only when creating a new document snapshot. Archived renderers must use
 * their already frozen public_comment unchanged.
 */
export function customerCommandeComment(commentaire: string | null | undefined): string | null {
  if (!commentaire?.trim()) return null;
  const constraints = new Set<string>();
  const publicText = commentaire.replace(
    /\[Commande operations\]([\s\S]*?)(?:\[\/Commande operations\]|$)/gi,
    (_match, block: string) => {
      // An incomplete block is excluded entirely: its contents have not been
      // delimited as public text and must not leak into a customer document.
      if (!/\[\/Commande operations\]$/i.test(_match)) return "";
      const customerConstraints = block.match(/Contraintes client:\s*([\s\S]*)/i)?.[1]?.trim();
      if (customerConstraints) constraints.add(customerConstraints);
      return "";
    },
  ).replace(/\[\/Commande operations\]/gi, "").trim();
  const parts = [publicText, ...[...constraints].map(text => `Exigences client :\n${text}`)].filter(Boolean);
  return parts.length ? parts.join("\n\n") : null;
}
