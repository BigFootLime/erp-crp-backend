import { HttpError } from "../../../utils/httpError";
import { emitChatConversationRead, emitChatMessageCreated } from "../../../shared/realtime/realtime.service";
import type { ChatConversation, ChatMessage, ChatUser } from "../types/chat.types";
import {
  repoGetChatConversation,
  repoGetChatUserById,
  repoGetOrCreateDirectConversation,
  repoGetUnreadCount,
  repoListChatConversations,
  repoListChatMessages,
  repoListChatUsers,
  repoMarkConversationRead,
  repoSendChatMessage,
} from "../repository/chat.repository";

export async function svcListChatUsers(params: { me_user_id: number; q?: string; limit?: number }): Promise<ChatUser[]> {
  return repoListChatUsers(params);
}

export async function svcListChatConversations(params: { user_id: number }): Promise<ChatConversation[]> {
  return repoListChatConversations(params);
}

export async function svcOpenDirectConversation(params: { user_id: number; other_user_id: number }): Promise<ChatConversation> {
  if (params.other_user_id === params.user_id) {
    throw new HttpError(400, "INVALID_TARGET", "You cannot chat with yourself");
  }

  const other = await repoGetChatUserById(params.other_user_id);
  if (!other) throw new HttpError(404, "USER_NOT_FOUND", "User not found");

  const conversationId = await repoGetOrCreateDirectConversation(params);
  const conv = await repoGetChatConversation({ user_id: params.user_id, conversation_id: conversationId });
  if (!conv) throw new Error("Conversation created but not readable");
  return conv;
}

export async function svcListChatMessages(params: {
  user_id: number;
  conversation_id: string;
  before?: string | null;
  limit?: number;
}) {
  const out = await repoListChatMessages(params);
  if (!out) throw new HttpError(404, "CONVERSATION_NOT_FOUND", "Conversation not found");
  return out;
}

export async function svcSendChatMessage(params: {
  user_id: number;
  conversation_id: string;
  content: string;
}): Promise<{ message: ChatMessage }> {
  const r = await repoSendChatMessage({
    conversation_id: params.conversation_id,
    sender_user_id: params.user_id,
    content: params.content,
  });

  if (!r) throw new HttpError(404, "CONVERSATION_NOT_FOUND", "Conversation not found");

  for (const userId of r.participant_user_ids) {
    emitChatMessageCreated(userId, {
      conversation_id: r.message.conversation_id,
      message: r.message,
      sender: r.sender,
    });
  }

  return { message: r.message };
}

export async function svcMarkConversationRead(params: { user_id: number; conversation_id: string }): Promise<{ read_at: string }> {
  const out = await repoMarkConversationRead(params);
  if (!out) throw new HttpError(404, "CONVERSATION_NOT_FOUND", "Conversation not found");
  emitChatConversationRead(params.user_id, { conversation_id: params.conversation_id, read_at: out.read_at });
  return out;
}

export async function svcGetUnreadCount(params: { user_id: number }): Promise<{ total_unread: number }> {
  const total = await repoGetUnreadCount(params);
  return { total_unread: total };
}
