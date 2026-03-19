export type ChatConversationType = "direct" | "group";

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

export type ChatMessageSender = {
  id: number;
  username: string;
  name: string | null;
  surname: string | null;
};

export type ChatMessage = {
  id: string;
  conversation_id: string;
  sender_user_id: number;
  sender: ChatMessageSender | null;
  message_type: ChatMessageType;
  content: string;
  created_at: string;
};

export type ChatGroup = {
  name: string;
  participant_count: number;
  created_by: number | null;
};

export type ChatConversationBase = {
  id: string;
  type: ChatConversationType;
  last_message: ChatMessage | null;
  unread_count: number;
  last_read_at: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
};

export type ChatDirectConversation = ChatConversationBase & {
  type: "direct";
  other_user: ChatUser;
};

export type ChatGroupConversation = ChatConversationBase & {
  type: "group";
  group: ChatGroup;
};

export type ChatConversation = ChatDirectConversation | ChatGroupConversation;
