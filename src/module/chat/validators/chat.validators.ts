import { z } from "zod";

export const listChatUsersQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export type ListChatUsersQueryDTO = z.infer<typeof listChatUsersQuerySchema>;

export const listChatMessagesQuerySchema = z.object({
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type ListChatMessagesQueryDTO = z.infer<typeof listChatMessagesQuerySchema>;

export const chatConversationIdParamSchema = z.object({
  id: z.string().uuid(),
});

export type ChatConversationIdParamDTO = z.infer<typeof chatConversationIdParamSchema>;

export const openDirectConversationBodySchema = z.object({
  user_id: z.coerce.number().int().min(1),
});

export type OpenDirectConversationBodyDTO = z.infer<typeof openDirectConversationBodySchema>;

export const sendChatMessageBodySchema = z.object({
  content: z.string().trim().min(1).max(2000),
});

export type SendChatMessageBodyDTO = z.infer<typeof sendChatMessageBodySchema>;

export const createGroupConversationBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  participant_user_ids: z.array(z.coerce.number().int().min(1)).min(1).max(50),
});

export type CreateGroupConversationBodyDTO = z.infer<typeof createGroupConversationBodySchema>;
