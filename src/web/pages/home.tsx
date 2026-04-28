import { ArrowRight, FileText, Users, CheckSquare } from "lucide-react";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";

export default function HomePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-secondary">
          Finance hub scaffold — UI primitives wired, schema and modules land in subsequent phases.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-secondary">Open invoices</span>
              <FileText className="size-4 text-muted" />
            </div>
          </CardHeader>
          <CardBody>
            <div className="text-2xl font-semibold">--</div>
            <Badge tone="info" className="mt-2">
              awaiting sync
            </Badge>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-secondary">Active customers</span>
              <Users className="size-4 text-muted" />
            </div>
          </CardHeader>
          <CardBody>
            <div className="text-2xl font-semibold">--</div>
            <Badge tone="neutral" className="mt-2">
              awaiting sync
            </Badge>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-secondary">Tasks due today</span>
              <CheckSquare className="size-4 text-muted" />
            </div>
          </CardHeader>
          <CardBody>
            <div className="text-2xl font-semibold">--</div>
            <Badge tone="neutral" className="mt-2">
              not configured
            </Badge>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Next steps</h2>
        </CardHeader>
        <CardBody>
          <ul className="space-y-2 text-sm text-secondary">
            <li>1. Drizzle schema + migrations land via the schema task</li>
            <li>2. Auth (sessions + Arctic OAuth) lands via the auth task</li>
            <li>3. Pino logging + readiness probe via the observability task</li>
            <li>4. Module routes mount under /api as feature agents complete their work</li>
          </ul>
          <div className="mt-4">
            <Button variant="primary" size="sm">
              Read the docs <ArrowRight className="size-3.5" />
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
