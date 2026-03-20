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
  repoListChatConversationParticipants,
  repoListChatMessages,
  repoListChatUsers,
  repoMarkConversationRead,
  repoCreateGroupConversation,
  repoArchiveChatConversation,
  repoAddGroupConversationMembers,
  repoDeleteGroupConversation,
  repoListChatConversationParticipantUserIds,
  repoRemoveGroupConversationMember,
  repoUpdateGroupConversationName,
  repoSendChatMessage,
} from "../repository/chat.repository";

export async function svcListChatUsers(params: { me_user_id: number; q?: string; limit?: number }): Promise<ChatUser[]> {
  return repoListChatUsers(params);
}

export async function svcListChatConversations(params: { user_id: number }): Promise<ChatConversation[]> {
  return repoListChatConversations(params);
}

export async function svcListChatConversationParticipants(params: { user_id: number; conversation_id: string }): Promise<ChatUser[]> {
  const out = await repoListChatConversationParticipants(params);
  if (!out) throw new HttpError(404, "CONVERSATION_NOT_FOUND", "Conversation not found");
  return out;
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

export async function svcArchiveChatConversation(params: {
  user_id: number;
  conversation_id: string;
}): Promise<{ archived_at: string }> {
  const out = await repoArchiveChatConversation(params);
  if (!out) throw new HttpError(404, "CONVERSATION_NOT_FOUND", "Conversation not found");
  return out;
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

export async function svcRenameGroupConversation(params: {
  user_id: number;
  conversation_id: string;
  name: string;
}): Promise<ChatConversation> {
  const name = typeof params.name === "string" ? params.name.trim() : "";
  if (!name) throw new HttpError(400, "INVALID_NAME", "Group name is required");

  const conv = await repoGetChatConversation({ user_id: params.user_id, conversation_id: params.conversation_id });
  if (!conv) throw new HttpError(404, "CONVERSATION_NOT_FOUND", "Conversation not found");
  if (conv.type !== "group") throw new HttpError(400, "INVALID_CONVERSATION", "Not a group conversation");

  if (conv.group.created_by !== params.user_id) {
    throw new HttpError(403, "FORBIDDEN", "Only the group owner can rename the group");
  }

  const ok = await repoUpdateGroupConversationName({ conversation_id: params.conversation_id, name });
  if (!ok) throw new HttpError(404, "CONVERSATION_NOT_FOUND", "Conversation not found");

  const userIds = await repoListChatConversationParticipantUserIds({ conversation_id: params.conversation_id });
  for (const userId of userIds) {
    emitChatConversationUpsert(userId, { conversation_id: params.conversation_id, type: "group", group_name: name });
  }

  const updated = await repoGetChatConversation({ user_id: params.user_id, conversation_id: params.conversation_id });
  if (!updated) throw new Error("Group renamed but not readable");
  return updated;
}

export async function svcAddGroupMembers(params: {
  user_id: number;
  conversation_id: string;
  user_ids: number[];
}): Promise<ChatConversation> {
  const seen = new Set<number>();
  const ids = params.user_ids
    .map((n) => (Number.isFinite(n) ? Math.trunc(n) : 0))
    .filter((n) => n > 0)
    .filter((n) => {
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    })
    .filter((n) => n !== params.user_id);

  if (!ids.length) throw new HttpError(400, "INVALID_PARTICIPANTS", "Select at least one other user");

  const conv = await repoGetChatConversation({ user_id: params.user_id, conversation_id: params.conversation_id });
  if (!conv) throw new HttpError(404, "CONVERSATION_NOT_FOUND", "Conversation not found");
  if (conv.type !== "group") throw new HttpError(400, "INVALID_CONVERSATION", "Not a group conversation");
  if (conv.group.created_by !== params.user_id) {
    throw new HttpError(403, "FORBIDDEN", "Only the group owner can add members");
  }

  const activeUsers = await repoListChatUsersByIds(ids);
  if (activeUsers.length !== ids.length) {
    throw new HttpError(404, "USER_NOT_FOUND", "User not found");
  }

  await repoAddGroupConversationMembers({ conversation_id: params.conversation_id, user_ids: ids });

  const userIds = await repoListChatConversationParticipantUserIds({ conversation_id: params.conversation_id });
  for (const userId of userIds) {
    emitChatConversationUpsert(userId, {
      conversation_id: params.conversation_id,
      type: "group",
      group_name: conv.group.name,
    });
  }

  const updated = await repoGetChatConversation({ user_id: params.user_id, conversation_id: params.conversation_id });
  if (!updated) throw new Error("Members added but conversation not readable");
  return updated;
}

export async function svcRemoveGroupMember(params: {
  user_id: number;
  conversation_id: string;
  remove_user_id: number;
}): Promise<{ ok: true }> {
  if (params.remove_user_id === params.user_id) {
    throw new HttpError(400, "INVALID_TARGET", "Use leave-group to remove yourself");
  }

  const conv = await repoGetChatConversation({ user_id: params.user_id, conversation_id: params.conversation_id });
  if (!conv) throw new HttpError(404, "CONVERSATION_NOT_FOUND", "Conversation not found");
  if (conv.type !== "group") throw new HttpError(400, "INVALID_CONVERSATION", "Not a group conversation");
  if (conv.group.created_by !== params.user_id) {
    throw new HttpError(403, "FORBIDDEN", "Only the group owner can remove members");
  }

  const ok = await repoRemoveGroupConversationMember({ conversation_id: params.conversation_id, user_id: params.remove_user_id });
  if (!ok) throw new HttpError(404, "USER_NOT_FOUND", "User not found in this conversation");

  // Notify remaining participants + removed user (forces list refresh).
  const remaining = await repoListChatConversationParticipantUserIds({ conversation_id: params.conversation_id });
  const targetIds = new Set<number>([...remaining, params.remove_user_id]);
  for (const userId of targetIds) {
    emitChatConversationUpsert(userId, {
      conversation_id: params.conversation_id,
      type: "group",
      group_name: conv.group.name,
    });
  }

  return { ok: true };
}

export async function svcLeaveGroupConversation(params: {
  user_id: number;
  conversation_id: string;
}): Promise<{ ok: true }> {
  const conv = await repoGetChatConversation({ user_id: params.user_id, conversation_id: params.conversation_id });
  if (!conv) throw new HttpError(404, "CONVERSATION_NOT_FOUND", "Conversation not found");
  if (conv.type !== "group") throw new HttpError(400, "INVALID_CONVERSATION", "Not a group conversation");

  if (conv.group.created_by === params.user_id) {
    throw new HttpError(400, "OWNER_CANNOT_LEAVE", "Group owner cannot leave. Delete the group instead.");
  }

  const ok = await repoRemoveGroupConversationMember({ conversation_id: params.conversation_id, user_id: params.user_id });
  if (!ok) throw new HttpError(404, "CONVERSATION_NOT_FOUND", "Conversation not found");

  const remaining = await repoListChatConversationParticipantUserIds({ conversation_id: params.conversation_id });
  const targetIds = new Set<number>([...remaining, params.user_id]);
  for (const userId of targetIds) {
    emitChatConversationUpsert(userId, {
      conversation_id: params.conversation_id,
      type: "group",
      group_name: conv.group.name,
    });
  }

  return { ok: true };
}

export async function svcDeleteGroupConversation(params: {
  user_id: number;
  conversation_id: string;
}): Promise<{ ok: true }> {
  const conv = await repoGetChatConversation({ user_id: params.user_id, conversation_id: params.conversation_id });
  if (!conv) throw new HttpError(404, "CONVERSATION_NOT_FOUND", "Conversation not found");
  if (conv.type !== "group") throw new HttpError(400, "INVALID_CONVERSATION", "Not a group conversation");
  if (conv.group.created_by !== params.user_id) {
    throw new HttpError(403, "FORBIDDEN", "Only the group owner can delete the group");
  }

  const userIds = await repoListChatConversationParticipantUserIds({ conversation_id: params.conversation_id });
  const ok = await repoDeleteGroupConversation({ conversation_id: params.conversation_id });
  if (!ok) throw new HttpError(404, "CONVERSATION_NOT_FOUND", "Conversation not found");

  for (const userId of userIds) {
    emitChatConversationUpsert(userId, {
      conversation_id: params.conversation_id,
      type: "group",
      group_name: conv.group.name,
    });
  }

  return { ok: true };
}
