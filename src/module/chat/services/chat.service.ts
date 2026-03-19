import { HttpError } from "../../../utils/httpError";
import { emitChatConversationRead, emitChatConversationUpsert, emitChatMessageCreated } from "../../../shared/realtime/realtime.service";
import type { ChatConversation, ChatMessage, ChatUser } from "../types/chat.types";
import {
  repoGetChatConversation,
  repoGetChatUserById,
  repoGetOrCreateDirectConversation,
  repoGetUnreadCount,
  repoListChatUsersByIds,
  repoListChatConversations,
  repoListChatMessages,
  repoListChatUsers,
  repoMarkConversationRead,
  repoCreateGroupConversation,
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

export async function svcCreateGroupConversation(params: {
  user_id: number;
  name: string;
  participant_user_ids: number[];
}): Promise<ChatConversation> {
  const name = typeof params.name === "string" ? params.name.trim() : "";
  if (!name) throw new HttpError(400, "INVALID_NAME", "Group name is required");

  const seen = new Set<number>();
  const others = params.participant_user_ids
    .map((n) => (Number.isFinite(n) ? Math.trunc(n) : 0))
    .filter((n) => n > 0)
    .filter((n) => n !== params.user_id)
    .filter((n) => {
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    });

  if (!others.length) {
    throw new HttpError(400, "INVALID_PARTICIPANTS", "Select at least one other user");
  }

  const activeUsers = await repoListChatUsersByIds(others);
  if (activeUsers.length !== others.length) {
    throw new HttpError(404, "USER_NOT_FOUND", "User not found");
  }

  const participants = [params.user_id, ...others];
  const created = await repoCreateGroupConversation({
    created_by: params.user_id,
    group_name: name,
    participant_user_ids: participants,
  });

  for (const userId of created.participant_user_ids) {
    emitChatConversationUpsert(userId, {
      conversation_id: created.conversation_id,
      type: "group",
      group_name: name,
    });
  }

  const conv = await repoGetChatConversation({ user_id: params.user_id, conversation_id: created.conversation_id });
  if (!conv) throw new Error("Group conversation created but not readable");
  return conv;
}
