// src/routes/v1.routes.ts
import { Router } from "express"
import authRoutes from "../module/auth/routes/auth.routes"
import outilRoutes from "../module/outils/routes/outil.routes"
import bankingInfoRoutes from "../module/banking-info/routes/banking-info.routes"
import commandeClientRoutes from "../module/commande-client/routes/commande-client.routes"
import clientRoutes from "../module/client/routes/client.routes";
import paymentModeRoutes from "../module/payment-mode/routes/payment-modes.routes";
import billerRoutes from "../module/biller/routes/biller.routes";

const router = Router()

router.use("/auth", authRoutes)
router.use("/outil", outilRoutes)
router.use("/banking-info", bankingInfoRoutes)  
router.use("/commandes", commandeClientRoutes) // ✅  
router.use("/clients", clientRoutes);
router.use("/payment-modes", paymentModeRoutes);  
router.use("/billers", billerRoutes);                                

export default router
