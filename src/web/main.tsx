import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRouter,
  RouterProvider,
  createRootRoute,
  createRoute,
  Outlet,
  ScrollRestoration,
} from "@tanstack/react-router";
import App from "./App";
import HomePage from "./pages/home";
import InvoicingTodayPage from "./pages/invoicing-today";
import InvoicingTodayDetailPage from "./pages/invoicing-today-detail";
import CustomersPage from "./pages/customers";
import CustomerDetailPage from "./pages/customer-detail";
import SharedTasksPage from "./pages/shared-tasks";
import SettingsPage from "./pages/settings";
import ChasePage from "./pages/chase";
import StatementsPage from "./pages/statements";
import MondayTermsImportPage from "./pages/monday-terms-import";
import ShopifyB2bAuditPage from "./pages/shopify-b2b-audit";
import ShopifyLinkPage from "./pages/shopify-link";
import RosterTagImportPage from "./pages/roster-tag-import";
import ReturnsListPage from "./pages/returns";
import ReturnNewPage from "./pages/return-new";
import ReturnDetailPage from "./pages/return-detail";
import CreditMemoCreatePage from "./pages/credit-memo-create";
import SeasonsPage from "./pages/seasons";
import AutopilotPage from "./pages/autopilot";
import AiTrainingPage from "./pages/ai-training";
import OriginReviewPage from "./pages/origin-review";
import AgentPage from "./pages/agent";
import { customersSearchSchema } from "./lib/search-schemas/customers";
import { returnsSearchSchema } from "./lib/search-schemas/returns";
import { invoicingTodaySearchSchema } from "./lib/search-schemas/invoicing-today";
import { chaseSearchSchema } from "./lib/search-schemas/chase";
import { statementsSearchSchema } from "./lib/search-schemas/statements";
import { customerDetailSearchSchema } from "./lib/search-schemas/customer-detail";
import { creditMemoCreateSearchSchema } from "./lib/search-schemas/credit-memo-create";
import { restoreSearchOnEmpty } from "./lib/restore-search-on-empty";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

// Expose so restoreSearchOnEmpty (which runs in beforeLoad, outside React)
// can read the cached current user without re-querying.
(window as unknown as { __FH_QUERY_CLIENT__: typeof queryClient }).__FH_QUERY_CLIENT__ = queryClient;

const rootRoute = createRootRoute({
  component: () => (
    <App>
      <ScrollRestoration />
      <Outlet />
    </App>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});

const invoicingTodayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invoicing",
  component: InvoicingTodayPage,
  validateSearch: invoicingTodaySearchSchema,
  beforeLoad: restoreSearchOnEmpty("/invoicing"),
});

const invoicingTodayDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invoicing/$gmailId",
  component: InvoicingTodayDetailPage,
});

const customersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/customers",
  component: CustomersPage,
  validateSearch: customersSearchSchema,
  beforeLoad: restoreSearchOnEmpty("/customers"),
});

const customerDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/customers/$customerId",
  component: CustomerDetailPage,
  validateSearch: customerDetailSearchSchema,
  beforeLoad: restoreSearchOnEmpty("/customers/$customerId"),
});

const sharedTasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/shared-tasks",
  component: SharedTasksPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

const chaseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chase",
  component: ChasePage,
  validateSearch: chaseSearchSchema,
  beforeLoad: restoreSearchOnEmpty("/chase"),
});

const statementsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/statements",
  component: StatementsPage,
  validateSearch: statementsSearchSchema,
  beforeLoad: restoreSearchOnEmpty("/statements"),
});

const mondayTermsImportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/import/monday-terms",
  component: MondayTermsImportPage,
});

const shopifyB2bAuditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/import/shopify-b2b-audit",
  component: ShopifyB2bAuditPage,
});

const shopifyLinkRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/import/shopify-link",
  component: ShopifyLinkPage,
});

const rosterTagImportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/import/roster-tag",
  component: RosterTagImportPage,
});

const returnsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/returns",
  component: ReturnsListPage,
  validateSearch: returnsSearchSchema,
  beforeLoad: restoreSearchOnEmpty("/returns"),
});

const returnNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/returns/new",
  component: ReturnNewPage,
});

const returnDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/returns/$rmaId",
  component: ReturnDetailPage,
});

const creditMemoCreateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/returns/$rmaId/credit-memo",
  component: CreditMemoCreatePage,
  validateSearch: creditMemoCreateSearchSchema,
});

const seasonsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/seasons",
  component: SeasonsPage,
});

const autopilotRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/autopilot",
  component: AutopilotPage,
});

const aiTrainingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ai-training",
  component: AiTrainingPage,
});

const originReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/origin-review",
  component: OriginReviewPage,
});

const agentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agent",
  component: AgentPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  invoicingTodayRoute,
  invoicingTodayDetailRoute,
  customersRoute,
  customerDetailRoute,
  sharedTasksRoute,
  settingsRoute,
  chaseRoute,
  statementsRoute,
  mondayTermsImportRoute,
  shopifyB2bAuditRoute,
  shopifyLinkRoute,
  rosterTagImportRoute,
  returnsRoute,
  returnNewRoute,
  returnDetailRoute,
  creditMemoCreateRoute,
  seasonsRoute,
  autopilotRoute,
  aiTrainingRoute,
  originReviewRoute,
  agentRoute,
]);

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root element");

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
