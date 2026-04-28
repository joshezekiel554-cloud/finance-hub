import { relations } from "drizzle-orm";
import {
  users,
  accounts,
  sessions,
  authenticators,
} from "./schema/auth";
import { customers, customerContacts } from "./schema/customers";
import { products, orders } from "./schema/catalog";
import { invoices, invoiceLines, shipments } from "./schema/invoices";
import {
  activities,
  tasks,
  emailLog,
  statementSends,
} from "./schema/crm";
import { notifications, pushSubscriptions } from "./schema/notifications";
import {
  auditLog,
  aiInteractions,
  syncRuns,
  aiDigests,
  chaseLog,
} from "./schema/audit";

export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(accounts),
  sessions: many(sessions),
  authenticators: many(authenticators),
  activities: many(activities),
  assignedTasks: many(tasks, { relationName: "task_assignee" }),
  createdTasks: many(tasks, { relationName: "task_creator" }),
  emailLog: many(emailLog),
  statementSends: many(statementSends),
  notifications: many(notifications),
  pushSubscriptions: many(pushSubscriptions),
  auditLog: many(auditLog),
  aiInteractions: many(aiInteractions),
  chaseLog: many(chaseLog),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const authenticatorsRelations = relations(authenticators, ({ one }) => ({
  user: one(users, { fields: [authenticators.userId], references: [users.id] }),
}));

export const customersRelations = relations(customers, ({ many }) => ({
  contacts: many(customerContacts),
  orders: many(orders),
  invoices: many(invoices),
  shipments: many(shipments),
  activities: many(activities),
  tasks: many(tasks),
  emailLog: many(emailLog),
  statementSends: many(statementSends),
  notifications: many(notifications),
  chaseLog: many(chaseLog),
}));

export const customerContactsRelations = relations(customerContacts, ({ one }) => ({
  customer: one(customers, {
    fields: [customerContacts.customerId],
    references: [customers.id],
  }),
}));

export const ordersRelations = relations(orders, ({ one }) => ({
  customer: one(customers, {
    fields: [orders.customerId],
    references: [customers.id],
  }),
}));

export const productsRelations = relations(products, () => ({}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  customer: one(customers, {
    fields: [invoices.customerId],
    references: [customers.id],
  }),
  lines: many(invoiceLines),
}));

export const invoiceLinesRelations = relations(invoiceLines, ({ one }) => ({
  invoice: one(invoices, {
    fields: [invoiceLines.invoiceId],
    references: [invoices.id],
  }),
  matchedOrder: one(orders, {
    fields: [invoiceLines.matchedOrderId],
    references: [orders.id],
  }),
}));

export const shipmentsRelations = relations(shipments, ({ one }) => ({
  customer: one(customers, {
    fields: [shipments.customerMatchId],
    references: [customers.id],
  }),
}));

export const activitiesRelations = relations(activities, ({ one, many }) => ({
  customer: one(customers, {
    fields: [activities.customerId],
    references: [customers.id],
  }),
  user: one(users, { fields: [activities.userId], references: [users.id] }),
  tasks: many(tasks),
}));

export const tasksRelations = relations(tasks, ({ one }) => ({
  customer: one(customers, {
    fields: [tasks.customerId],
    references: [customers.id],
  }),
  assignee: one(users, {
    fields: [tasks.assigneeUserId],
    references: [users.id],
    relationName: "task_assignee",
  }),
  createdBy: one(users, {
    fields: [tasks.createdByUserId],
    references: [users.id],
    relationName: "task_creator",
  }),
  completedBy: one(users, {
    fields: [tasks.completedByUserId],
    references: [users.id],
    relationName: "task_completer",
  }),
  relatedActivity: one(activities, {
    fields: [tasks.relatedActivityId],
    references: [activities.id],
  }),
}));

export const emailLogRelations = relations(emailLog, ({ one }) => ({
  customer: one(customers, {
    fields: [emailLog.customerId],
    references: [customers.id],
  }),
  user: one(users, { fields: [emailLog.userId], references: [users.id] }),
}));

export const statementSendsRelations = relations(statementSends, ({ one }) => ({
  customer: one(customers, {
    fields: [statementSends.customerId],
    references: [customers.id],
  }),
  sentBy: one(users, {
    fields: [statementSends.sentByUserId],
    references: [users.id],
  }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
  customer: one(customers, {
    fields: [notifications.customerId],
    references: [customers.id],
  }),
}));

export const pushSubscriptionsRelations = relations(pushSubscriptions, ({ one }) => ({
  user: one(users, {
    fields: [pushSubscriptions.userId],
    references: [users.id],
  }),
}));

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  user: one(users, { fields: [auditLog.userId], references: [users.id] }),
}));

export const aiInteractionsRelations = relations(aiInteractions, ({ one }) => ({
  user: one(users, { fields: [aiInteractions.userId], references: [users.id] }),
}));

export const syncRunsRelations = relations(syncRuns, () => ({}));

export const aiDigestsRelations = relations(aiDigests, ({ many }) => ({
  chaseLog: many(chaseLog),
}));

export const chaseLogRelations = relations(chaseLog, ({ one }) => ({
  customer: one(customers, {
    fields: [chaseLog.customerId],
    references: [customers.id],
  }),
  user: one(users, { fields: [chaseLog.userId], references: [users.id] }),
  aiDigest: one(aiDigests, {
    fields: [chaseLog.aiDigestId],
    references: [aiDigests.id],
  }),
}));
