import {
  boolean,
  index,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./auth";

export const userSignatures = mysqlTable(
  "user_signatures",
  {
    id: varchar("id", { length: 24 }).primaryKey(),
    userId: varchar("user_id", { length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 64 }).notNull(),
    html: text("html").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .onUpdateNow(),
  },
  (t) => ({
    userIdx: index("idx_user_signatures_user").on(t.userId),
    defaultIdx: index("idx_user_signatures_default").on(t.userId, t.isDefault),
  }),
);

export type UserSignature = typeof userSignatures.$inferSelect;
export type NewUserSignature = typeof userSignatures.$inferInsert;
