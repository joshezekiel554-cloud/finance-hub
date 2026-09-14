// Home dashboard (operator spec 2026-09-14, mockup finance-dashboard-rev1):
// no tasks board here — "+ New task" opens the shared create dialog with the
// board (assignee) picker; then the Money section by book, and four action
// cards: invoices not sent yet today, orders to review, returns awaiting
// arrival, customers on hold / payment upfront. Each card owns its fetch.
// The hub's Home reads the same Money object via /api/ext/hub-summary.

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Plus } from "lucide-react";
import { Card, CardBody } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { NewTaskDialog } from "../components/tasks/new-task-dialog";
import { MoneyWidget } from "../components/dashboard/money-widget";
import { InvoicesNotSentWidget } from "../components/dashboard/invoices-not-sent-widget";
import { OrdersToReviewWidget } from "../components/dashboard/orders-to-review-widget";
import { RmasWidget } from "../components/dashboard/rmas-widget";
import { HoldsWidget } from "../components/dashboard/holds-widget";
import { TimeClockCard } from "../components/dashboard/time-clock-card";

export default function HomePage() {
  const [newTaskOpen, setNewTaskOpen] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-secondary">
            What needs your attention right now.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/shared-tasks">
            <Button variant="secondary" size="sm">
              Open tasks board <ArrowRight className="size-3.5" />
            </Button>
          </Link>
          {/* The dialog's assignee picker IS the board picker: tasks live on
              per-member boards, so "Shaya" = Shaya's board. */}
          <Button size="sm" onClick={() => setNewTaskOpen(true)}>
            <Plus className="size-3.5" /> New task
          </Button>
        </div>
      </div>

      <NewTaskDialog open={newTaskOpen} onOpenChange={setNewTaskOpen} />

      {/* Time clock — self-hides unless the viewer is on the clock allow-list. */}
      <TimeClockCard />

      <MoneyWidget />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <InvoicesNotSentWidget />
        <OrdersToReviewWidget />
        <RmasWidget />
        <HoldsWidget />
      </div>

      {/* Quick links — most-used pages, one click away. */}
      <Card>
        <CardBody>
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 text-sm font-medium">Jump to</span>
            <Link to="/invoicing">
              <Button variant="secondary" size="sm">Today's invoicing</Button>
            </Link>
            <Link to="/chase">
              <Button variant="secondary" size="sm">Chase list</Button>
            </Link>
            <Link to="/customers">
              <Button variant="secondary" size="sm">Customers</Button>
            </Link>
            <Link to="/statements">
              <Button variant="secondary" size="sm">Statements log</Button>
            </Link>
            <Link to="/shared-tasks">
              <Button variant="secondary" size="sm">Tasks</Button>
            </Link>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
