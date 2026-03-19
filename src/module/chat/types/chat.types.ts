export type ChatConversationType = "direct";

export type ChatUser = {
  id: number;
  username: string;
  name: string | null;
  surname: string | null;
  email: string | null;
  role: string | null;
  status: string | null;
};

export type ChatMessageType = "text";

export type ChatMessage = {
  id: string;
  conversation_id: string;
  sender_user_id: number;
  message_type: ChatMessageType;
  content: string;
  created_at: string;
};

export type ChatConversation = {
  id: string;
  type: ChatConversationType;
  other_user: ChatUser;
  last_message: ChatMessage | null;
  unread_count: number;
  last_read_at: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
};
