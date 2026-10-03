import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const replicateConnections = sqliteTable("replicate_connections", {
  userId: text("user_id").primaryKey(),
  username: text("username").notNull(),
  name: text("name"),
  encryptedToken: text("encrypted_token").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
