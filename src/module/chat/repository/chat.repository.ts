import type { PoolClient } from "pg";
import pool from "../../../config/database";

import type { ChatConversation, ChatMessage, ChatUser } from "../types/chat.types";

type DbQueryer = Pick<PoolClient, "query">;

type ChatUserRow = {
  id: number;
  username: string;
  name: string | null;
  surname: string | null;
  email: string | null;
  role: string | null;
  status: string | null;
};

function mapUser(row: ChatUserRow): ChatUser {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    surname: row.surname,
    email: row.email,
    role: row.role,
    status: row.status,
  };
}

export async function repoGetChatUserById(userId: number): Promise<ChatUser | null> {
  const res = await pool.query<ChatUserRow>(
    `
      SELECT
        id::int AS id,
        username,
        name,
        surname,
        email,
        role,
        status
      FROM public.users
      WHERE id = $1::int
      LIMIT 1
    `,
    [userId]
  );
  const row = res.rows[0] ?? null;
  return row ? mapUser(row) : null;
}

export async function repoListChatUsers(params: { me_user_id: number; q?: string; limit?: number }): Promise<ChatUser[]> {
  const q = typeof params.q === "string" ? params.q.trim() : "";
  const limit = Math.max(1, Math.min(200, Math.trunc(params.limit ?? 50)));

  const res = await pool.query<ChatUserRow>(
    `
      SELECT
        u.id::int AS id,
        u.username,
        u.name,
        u.surname,
        u.email,
        u.role,
        u.status
      FROM public.users u
      WHERE u.id <> $1::int
        AND COALESCE(NULLIF(lower(trim(u.status)), ''), 'active') NOT IN ('inactive', 'blocked', 'suspended')
        AND (
          $2::text = ''
          OR lower(u.username) LIKE ('%' || lower($2::text) || '%')
          OR lower(COALESCE(u.email, '')) LIKE ('%' || lower($2::text) || '%')
          OR lower(COALESCE(u.name, '')) LIKE ('%' || lower($2::text) || '%')
          OR lower(COALESCE(u.surname, '')) LIKE ('%' || lower($2::text) || '%')
        )
      ORDER BY u.username ASC, u.id ASC
      LIMIT $3::int
    `,
    [params.me_user_id, q, limit]
  );

  return res.rows.map(mapUser);
}

type ConversationRow = {
  conversation_id: string;
  type: string;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  last_read_at: string | null;
  other_user_id: number;
  other_username: string;
  other_name: string | null;
  other_surname: string | null;
  other_email: string | null;
  other_role: string | null;
  other_status: string | null;
  last_message_id: string | null;
  last_message_sender_user_id: number | null;
  last_message_type: string | null;
  last_message_content: string | null;
  last_message_created_at: string | null;
  unread_count: number;
};

function mapConversation(row: ConversationRow): ChatConversation {
  const lastMessage: ChatMessage | null = row.last_message_id
    ? {
        id: row.last_message_id,
        conversation_id: row.conversation_id,
        sender_user_id: row.last_message_sender_user_id ?? 0,
        message_type: (row.last_message_type ?? "text") === "text" ? "text" : "text",
        content: row.last_message_content ?? "",
        created_at: row.last_message_created_at ?? "",
      }
    : null;

  return {
    id: row.conversation_id,
    type: row.type === "direct" ? "direct" : "direct",
    other_user: {
      id: row.other_user_id,
      username: row.other_username,
      name: row.other_name,
      surname: row.other_surname,
      email: row.other_email,
      role: row.other_role,
      status: row.other_status,
    },
    last_message: lastMessage,
    unread_count: Number.isFinite(row.unread_count) ? row.unread_count : 0,
    last_read_at: row.last_read_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_message_at: row.last_message_at,
  };
}

async function repoListConversationsForUser(q: DbQueryer, params: { user_id: number; conversation_id?: string | null }) {
  const convFilter = typeof params.conversation_id === "string" && params.conversation_id.trim() ? params.conversation_id.trim() : null;

  const res = await q.query<ConversationRow>(
    `
      SELECT
        c.id::text AS conversation_id,
        c.type,
        c.created_at::text AS created_at,
        c.updated_at::text AS updated_at,
        c.last_message_at::text AS last_message_at,
        p.last_read_at::text AS last_read_at,

        ou.id::int AS other_user_id,
        ou.username AS other_username,
        ou.name AS other_name,
        ou.surname AS other_surname,
        ou.email AS other_email,
        ou.role AS other_role,
        ou.status AS other_status,

        lm.id::text AS last_message_id,
        lm.sender_user_id::int AS last_message_sender_user_id,
        lm.message_type AS last_message_type,
        lm.content AS last_message_content,
        lm.created_at::text AS last_message_created_at,

        (
          SELECT COUNT(*)::int
          FROM public.chat_messages m
          WHERE m.conversation_id = c.id
            AND m.deleted_at IS NULL
            AND m.sender_user_id <> $1::int
            AND m.created_at > COALESCE(p.last_read_at, 'epoch'::timestamptz)
        ) AS unread_count
      FROM public.chat_conversations c
      JOIN public.chat_conversation_participants p
        ON p.conversation_id = c.id
       AND p.user_id = $1::int
      JOIN public.chat_conversation_participants op
        ON op.conversation_id = c.id
       AND op.user_id <> $1::int
      JOIN public.users ou
        ON ou.id = op.user_id
      LEFT JOIN LATERAL (
        SELECT
          m.id,
          m.sender_user_id,
          m.message_type,
          m.content,
          m.created_at
        FROM public.chat_messages m
        WHERE m.conversation_id = c.id
          AND m.deleted_at IS NULL
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1
      ) lm ON true
      WHERE c.type = 'direct'
        AND ($2::uuid IS NULL OR c.id = $2::uuid)
      ORDER BY COALESCE(c.last_message_at, c.updated_at, c.created_at) DESC, c.id DESC
      LIMIT 200
    `,
    [params.user_id, convFilter]
  );

  return res.rows.map(mapConversation);
}

export async function repoListChatConversations(params: { user_id: number }): Promise<ChatConversation[]> {
  return repoListConversationsForUser(pool, { user_id: params.user_id });
}

export async function repoGetChatConversation(params: { user_id: number; conversation_id: string }): Promise<ChatConversation | null> {
  const items = await repoListConversationsForUser(pool, { user_id: params.user_id, conversation_id: params.conversation_id });
  return items[0] ?? null;
}

export async function repoGetOrCreateDirectConversation(params: { user_id: number; other_user_id: number }): Promise<string> {
  const low = Math.min(params.user_id, params.other_user_id);
  const high = Math.max(params.user_id, params.other_user_id);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const convRes = await client.query<{ id: string }>(
      `
        INSERT INTO public.chat_conversations (
          type,
          direct_user_low_id,
          direct_user_high_id,
          created_at,
          updated_at
        )
        VALUES ('direct', $1::int, $2::int, now(), now())
        ON CONFLICT (type, direct_user_low_id, direct_user_high_id) DO UPDATE
          SET updated_at = public.chat_conversations.updated_at
        RETURNING id::text AS id
      `,
      [low, high]
    );

    const conversationId = convRes.rows[0]?.id;
    if (!conversationId) throw new Error("Failed to create conversation");

    await client.query(
      `
        INSERT INTO public.chat_conversation_participants (conversation_id, user_id, joined_at)
        VALUES
          ($1::uuid, $2::int, now()),
          ($1::uuid, $3::int, now())
        ON CONFLICT (conversation_id, user_id) DO NOTHING
      `,
      [conversationId, params.user_id, params.other_user_id]
    );

    await client.query("COMMIT");
    return conversationId;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore
    }
    throw err;
  } finally {
    client.release();
  }
}

type ChatMessageRow = {
  id: string;
  conversation_id: string;
  sender_user_id: number;
  message_type: "text";
  content: string;
  created_at: string;
};

function mapMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    sender_user_id: row.sender_user_id,
    message_type: "text",
    content: row.content,
    created_at: row.created_at,
  };
}

export async function repoListChatMessages(params: {
  user_id: number;
  conversation_id: string;
  before?: string | null;
  limit?: number;
}): Promise<{ items: ChatMessage[]; has_more: boolean; next_before: string | null } | null> {
  const before = typeof params.before === "string" && params.before.trim() ? params.before.trim() : null;
  const limit = Math.max(1, Math.min(100, Math.trunc(params.limit ?? 50)));
  const pageSize = limit + 1;

  const res = await pool.query<ChatMessageRow>(
    `
      SELECT
        m.id::text AS id,
        m.conversation_id::text AS conversation_id,
        m.sender_user_id::int AS sender_user_id,
        m.message_type::text AS message_type,
        m.content,
        m.created_at::text AS created_at
      FROM public.chat_messages m
      JOIN public.chat_conversation_participants p
        ON p.conversation_id = m.conversation_id
       AND p.user_id = $2::int
      WHERE m.conversation_id = $1::uuid
        AND m.deleted_at IS NULL
        AND ($3::timestamptz IS NULL OR m.created_at < $3::timestamptz)
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $4::int
    `,
    [params.conversation_id, params.user_id, before, pageSize]
  );

  // If the user is not a participant, the JOIN returns 0 rows even if messages exist.
  // Confirm membership to decide between "empty conversation" and "not found".
  const membership = await pool.query<{ ok: number }>(
    `
      SELECT 1 AS ok
      FROM public.chat_conversation_participants
      WHERE conversation_id = $1::uuid
        AND user_id = $2::int
      LIMIT 1
    `,
    [params.conversation_id, params.user_id]
  );

  if (!membership.rows[0]?.ok) return null;

  const rows = res.rows;
  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, limit) : rows;
  const items = sliced.map(mapMessage).reverse();
  const nextBefore = items.length ? items[0]!.created_at : null;

  return {
    items,
    has_more: hasMore,
    next_before: nextBefore,
  };
}

export async function repoSendChatMessage(params: {
  conversation_id: string;
  sender_user_id: number;
  content: string;
}): Promise<
  | {
      message: ChatMessage;
      participant_user_ids: number[];
      sender: ChatUser;
    }
  | null
> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const memberRes = await client.query<{ ok: number }>(
      `
        SELECT 1 AS ok
        FROM public.chat_conversation_participants
        WHERE conversation_id = $1::uuid
          AND user_id = $2::int
        LIMIT 1
      `,
      [params.conversation_id, params.sender_user_id]
    );

    if (!memberRes.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return null;
    }

    const msgRes = await client.query<ChatMessageRow>(
      `
        INSERT INTO public.chat_messages (
          conversation_id,
          sender_user_id,
          message_type,
          content,
          created_at,
          updated_at
        )
        VALUES ($1::uuid, $2::int, 'text', $3::text, now(), now())
        RETURNING
          id::text AS id,
          conversation_id::text AS conversation_id,
          sender_user_id::int AS sender_user_id,
          message_type::text AS message_type,
          content,
          created_at::text AS created_at
      `,
      [params.conversation_id, params.sender_user_id, params.content]
    );

    const msgRow = msgRes.rows[0];
    if (!msgRow) throw new Error("Failed to insert message");

    await client.query(
      `
        UPDATE public.chat_conversations
        SET
          last_message_at = $2::timestamptz,
          updated_at = now()
        WHERE id = $1::uuid
      `,
      [params.conversation_id, msgRow.created_at]
    );

    const partsRes = await client.query<{ user_id: number }>(
      `
        SELECT user_id::int AS user_id
        FROM public.chat_conversation_participants
        WHERE conversation_id = $1::uuid
        ORDER BY user_id ASC
      `,
      [params.conversation_id]
    );

    const senderRes = await client.query<ChatUserRow>(
      `
        SELECT
          id::int AS id,
          username,
          name,
          surname,
          email,
          role,
          status
        FROM public.users
        WHERE id = $1::int
        LIMIT 1
      `,
      [params.sender_user_id]
    );

    const senderRow = senderRes.rows[0];
    if (!senderRow) throw new Error("Sender not found");

    await client.query("COMMIT");

    return {
      message: mapMessage(msgRow),
      participant_user_ids: partsRes.rows.map((r) => r.user_id),
      sender: mapUser(senderRow),
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function repoMarkConversationRead(params: {
  user_id: number;
  conversation_id: string;
}): Promise<{ read_at: string } | null> {
  const res = await pool.query<{ read_at: string }>(
    `
      UPDATE public.chat_conversation_participants
      SET last_read_at = now()
      WHERE conversation_id = $1::uuid
        AND user_id = $2::int
      RETURNING last_read_at::text AS read_at
    `,
    [params.conversation_id, params.user_id]
  );

  const row = res.rows[0] ?? null;
  return row ? { read_at: row.read_at } : null;
}

export async function repoGetUnreadCount(params: { user_id: number }): Promise<number> {
  const res = await pool.query<{ total_unread: number }>(
    `
      SELECT COUNT(*)::int AS total_unread
      FROM public.chat_messages m
      JOIN public.chat_conversation_participants p
        ON p.conversation_id = m.conversation_id
      WHERE p.user_id = $1::int
        AND m.deleted_at IS NULL
        AND m.sender_user_id <> $1::int
        AND m.created_at > COALESCE(p.last_read_at, 'epoch'::timestamptz)
    `,
    [params.user_id]
  );

  return res.rows[0]?.total_unread ?? 0;
}
