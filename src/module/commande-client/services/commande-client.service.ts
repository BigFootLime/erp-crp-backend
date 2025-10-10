import type { CreateCommandeInput } from "../types/commande-client.types"
import { repoCreateCommande, repoDeleteCommande, repoGetCommande, repoListCommandes } from "../repository/commande-client.repository"

export const createCommandeSVC = (input: CreateCommandeInput, documents: any[]) =>
  repoCreateCommande(input, documents)

export const listCommandesSVC = () => repoListCommandes()

export const getCommandeSVC = (id: string) => repoGetCommande(id)

export const deleteCommandeSVC = (id: string) => repoDeleteCommande(id)

// Stub "générer affaires"
export async function generateAffairesFromOrderSVC(_id: string) {
  // TODO: ta logique
  return { ok: true }
}
