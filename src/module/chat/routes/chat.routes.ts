import { Router } from "express";

import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import {
  getUnreadCount,
  listChatUsers,
  listConversations,
  listMessages,
  markConversationRead,
  openDirectConversation,
  createGroupConversation,
  sendMessage,
} from "../controllers/chat.controller";

const router = Router();
router.use(authenticateToken);

router.get("/users", listChatUsers);
router.get("/conversations", listConversations);
router.post("/conversations/direct", openDirectConversation);
router.post("/conversations/group", createGroupConversation);
router.get("/conversations/:id/messages", listMessages);
router.post("/conversations/:id/messages", sendMessage);
router.post("/conversations/:id/read", markConversationRead);
router.get("/unread-count", getUnreadCount);

export default router;
