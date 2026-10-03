import { integer, sqliteTable, text, primaryKey, uniqueIndex } from "drizzle-orm/sqlite-core";

export const replicateConnections = sqliteTable("replicate_connections", {
  userId: text("user_id").primaryKey(),
  username: text("username").notNull(),
  name: text("name"),
  encryptedToken: text("encrypted_token").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const musicRecords = sqliteTable("music_records", {
  userId: text("user_id").notNull(),
  id: text("id").notNull(),
  kind: text("kind").notNull(),
  requestKey: text("request_key"),
  payload: text("payload").notNull(),
  revision: integer("revision").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
}, table => [
  primaryKey({ columns: [table.userId, table.id] }),
  uniqueIndex("music_records_user_request_key").on(table.userId, table.requestKey),
]);
