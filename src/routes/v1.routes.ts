// src/routes/v1.routes.ts
import { Router } from "express"
import authRoutes from "../module/auth/routes/auth.routes"
import outilRoutes from "../module/outils/routes/outil.routes"
import bankingInfoRoutes from "../module/banking-info/routes/banking-info.routes"
import commandeClientRoutes from "../module/commande-client/routes/commande-client.routes"


const router = Router()

router.use("/auth", authRoutes)
router.use("/outil", outilRoutes)
router.use("/banking-info", bankingInfoRoutes)  
router.use("/commandes", commandeClientRoutes) // ✅                                    

export default router
