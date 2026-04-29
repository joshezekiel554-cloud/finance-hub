import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRouter,
  RouterProvider,
  createRootRoute,
  createRoute,
  Outlet,
} from "@tanstack/react-router";
import App from "./App";
import HomePage from "./pages/home";
import InvoicingTodayPage from "./pages/invoicing-today";
import CustomersPage from "./pages/customers";
import CustomerDetailPage from "./pages/customer-detail";
import TasksPage from "./pages/tasks";
import SettingsPage from "./pages/settings";
import ChasePage from "./pages/chase";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

const rootRoute = createRootRoute({
  component: () => (
    <App>
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

const routeTree = rootRoute.addChildren([
  indexRoute,
  invoicingTodayRoute,
  customersRoute,
  customerDetailRoute,
  tasksRoute,
  settingsRoute,
  chaseRoute,
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
