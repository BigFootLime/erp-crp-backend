import { Router } from "express";

import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import {
  getUnreadCount,
  listChatUsers,
  listConversations,
  listMessages,
  listParticipants,
  markConversationRead,
  openDirectConversation,
  createGroupConversation,
  renameGroupConversation,
  addGroupMembers,
  removeGroupMember,
  leaveGroupConversation,
  deleteGroupConversation,
  sendMessage,
  archiveConversation,
} from "../controllers/chat.controller";

const router = Router();
router.use(authenticateToken);

router.get("/users", listChatUsers);
router.get("/conversations", listConversations);
router.post("/conversations/direct", openDirectConversation);
router.post("/conversations/group", createGroupConversation);
router.patch("/conversations/:id/group", renameGroupConversation);
router.post("/conversations/:id/group/members", addGroupMembers);
router.delete("/conversations/:id/group/members/:userId", removeGroupMember);
router.post("/conversations/:id/group/leave", leaveGroupConversation);
router.delete("/conversations/:id/group", deleteGroupConversation);
router.get("/conversations/:id/messages", listMessages);
router.get("/conversations/:id/participants", listParticipants);
router.post("/conversations/:id/messages", sendMessage);
router.post("/conversations/:id/read", markConversationRead);
router.post("/conversations/:id/archive", archiveConversation);
router.get("/unread-count", getUnreadCount);

export default router;
