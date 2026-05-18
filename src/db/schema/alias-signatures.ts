import {
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./auth";

export const aliasSignatures = mysqlTable("alias_signatures", {
  aliasEmail: varchar("alias_email", { length: 254 }).primaryKey(),
  html: text("html").notNull(),
  updatedByUserId: varchar("updated_by_user_id", { length: 255 }).references(
    () => users.id,
    { onDelete: "set null" },
  ),
  updatedAt: timestamp("updated_at").defaultNow().notNull().onUpdateNow(),
});

export type AliasSignature = typeof aliasSignatures.$inferSelect;
export type NewAliasSignature = typeof aliasSignatures.$inferInsert;
