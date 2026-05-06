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
import CustomersPage from "./pages/customers";
import CustomerDetailPage from "./pages/customer-detail";
import TasksPage from "./pages/tasks";
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
import SeasonsPage from "./pages/seasons";
import { customersSearchSchema } from "./lib/search-schemas/customers";
import { returnsSearchSchema } from "./lib/search-schemas/returns";
import { tasksSearchSchema } from "./lib/search-schemas/tasks";
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
});

const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks",
  component: TasksPage,
  validateSearch: tasksSearchSchema,
  beforeLoad: restoreSearchOnEmpty("/tasks"),
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
});

const statementsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/statements",
  component: StatementsPage,
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

const seasonsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/seasons",
  component: SeasonsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  invoicingTodayRoute,
  customersRoute,
  customerDetailRoute,
  tasksRoute,
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
  seasonsRoute,
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
