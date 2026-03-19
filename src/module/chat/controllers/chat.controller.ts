import type { Request } from "express";
import type { RequestHandler } from "express";

import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import {
  chatConversationIdParamSchema,
  createGroupConversationBodySchema,
  listChatMessagesQuerySchema,
  listChatUsersQuerySchema,
  openDirectConversationBodySchema,
  sendChatMessageBodySchema,
} from "../validators/chat.validators";
import {
  svcCreateGroupConversation,
  svcGetUnreadCount,
  svcListChatConversations,
  svcListChatConversationParticipants,
  svcListChatMessages,
  svcListChatUsers,
  svcMarkConversationRead,
  svcOpenDirectConversation,
  svcSendChatMessage,
} from "../services/chat.service";

function requireUserId(req: Request): number {
  const userId = typeof req.user?.id === "number" ? req.user.id : null;
  if (!userId) throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
  return userId;
}

export const listChatUsers: RequestHandler = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const query = listChatUsersQuerySchema.parse(req.query);
  const items = await svcListChatUsers({ me_user_id: userId, q: query.q, limit: query.limit });
  res.json({ items });
});

export const listConversations: RequestHandler = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const items = await svcListChatConversations({ user_id: userId });
  res.json({ items });
});

export const openDirectConversation: RequestHandler = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const body = openDirectConversationBodySchema.parse(req.body);
  const conversation = await svcOpenDirectConversation({ user_id: userId, other_user_id: body.user_id });
  res.status(201).json({ conversation });
});

export const createGroupConversation: RequestHandler = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const body = createGroupConversationBodySchema.parse(req.body);
  const conversation = await svcCreateGroupConversation({
    user_id: userId,
    name: body.name,
    participant_user_ids: body.participant_user_ids,
  });
  res.status(201).json({ conversation });
});

export const listMessages: RequestHandler = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const { id } = chatConversationIdParamSchema.parse({ id: req.params.id });
  const query = listChatMessagesQuerySchema.parse(req.query);
  const out = await svcListChatMessages({ user_id: userId, conversation_id: id, before: query.before ?? null, limit: query.limit });
  res.json(out);
});

export const listParticipants: RequestHandler = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const { id } = chatConversationIdParamSchema.parse({ id: req.params.id });
  const items = await svcListChatConversationParticipants({ user_id: userId, conversation_id: id });
  res.json({ items });
});

export const sendMessage: RequestHandler = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const { id } = chatConversationIdParamSchema.parse({ id: req.params.id });
  const body = sendChatMessageBodySchema.parse(req.body);
  const out = await svcSendChatMessage({ user_id: userId, conversation_id: id, content: body.content });
  res.status(201).json(out);
});

export const markConversationRead: RequestHandler = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const { id } = chatConversationIdParamSchema.parse({ id: req.params.id });
  const out = await svcMarkConversationRead({ user_id: userId, conversation_id: id });
  res.json(out);
});

export const getUnreadCount: RequestHandler = asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const out = await svcGetUnreadCount({ user_id: userId });
  res.json(out);
});
