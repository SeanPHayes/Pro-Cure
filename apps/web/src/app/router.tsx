import { createBrowserRouter, isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { Login } from './Login';
import { ClientShell, InternalShell, RequireActor, RootRedirect, VendorShell } from './Shells';

/**
 * Route modules are lazy-loaded; each exports `Component`. Three surfaces:
 *   /app     internal workspace (procurement firm staff)
 *   /vendor  vendor portal
 *   /portal  hotel owner / client portal
 */
const page = (load: () => Promise<{ Component: React.ComponentType }>) => ({ lazy: load });

function RouteError() {
  const err = useRouteError();
  const notFound = isRouteErrorResponse(err) && err.status === 404;
  return (
    <div className="mx-auto max-w-[560px] px-6 py-24">
      <h1 className="text-[22px] font-[640]">
        {notFound ? 'This page doesn’t exist' : 'This page failed to load'}
      </h1>
      <p className="mt-2 text-ink-2">
        {notFound
          ? 'Check the address, or go back to where you were.'
          : err instanceof Error
            ? err.message
            : 'Reload the page to try again. If it keeps happening, tell your administrator.'}
      </p>
      <Link to="/" className="mt-6 inline-block font-[560] text-lacquer hover:underline">
        Go to your home page
      </Link>
    </div>
  );
}

export const router = createBrowserRouter([
  { path: '/', element: <RootRedirect />, errorElement: <RouteError /> },
  { path: '/login', element: <Login /> },
  {
    path: '/app',
    element: (
      <RequireActor actor="internal">
        <InternalShell />
      </RequireActor>
    ),
    errorElement: <RouteError />,
    children: [
      { index: true, ...page(() => import('@/features/home/Dashboard')) },
      { path: 'tasks', ...page(() => import('@/features/projects/TasksPage')) },
      { path: 'inbox', ...page(() => import('@/features/comms/InboxPage')) },
      { path: 'approvals', ...page(() => import('@/features/quoting/ApprovalsPage')) },
      { path: 'projects', ...page(() => import('@/features/projects/ProjectsPage')) },
      { path: 'projects/:id', ...page(() => import('@/features/projects/ProjectPage')) },
      { path: 'quotes', ...page(() => import('@/features/quoting/QuotesPage')) },
      { path: 'quotes/:id', ...page(() => import('@/features/quoting/QuoteBuilder')) },
      { path: 'specs', ...page(() => import('@/features/quoting/SpecsPage')) },
      { path: 'specs/:id', ...page(() => import('@/features/quoting/SpecPage')) },
      { path: 'cost-requests', ...page(() => import('@/features/quoting/CostRequestsPage')) },
      { path: 'cost-requests/:id', ...page(() => import('@/features/quoting/CostRequestPage')) },
      { path: 'orders', ...page(() => import('@/features/orders/OrdersPage')) },
      { path: 'orders/:id', ...page(() => import('@/features/orders/OrderPage')) },
      { path: 'shipments', ...page(() => import('@/features/orders/ShipmentsPage')) },
      { path: 'storage', ...page(() => import('@/features/orders/StoragePage')) },
      { path: 'claims', ...page(() => import('@/features/orders/ClaimsPage')) },
      { path: 'claims/:id', ...page(() => import('@/features/orders/ClaimPage')) },
      { path: 'finance', ...page(() => import('@/features/finance/FinancePage')) },
      { path: 'invoices/:id', ...page(() => import('@/features/finance/InvoicePage')) },
      { path: 'catalog/standards', ...page(() => import('@/features/catalog/StandardsPage')) },
      { path: 'catalog/standards/:id', ...page(() => import('@/features/catalog/StandardPage')) },
      { path: 'catalog/vendors', ...page(() => import('@/features/catalog/VendorsPage')) },
      { path: 'catalog/vendors/:id', ...page(() => import('@/features/catalog/VendorPage')) },
      { path: 'catalog/products', ...page(() => import('@/features/catalog/ProductsPage')) },
      { path: 'ai', ...page(() => import('@/features/ai/AiPage')) },
      { path: 'ai/jobs/:id', ...page(() => import('@/features/ai/AiJobPage')) },
      { path: 'settings', ...page(() => import('@/features/settings/SettingsPage')) },
      { path: 'settings/:tab', ...page(() => import('@/features/settings/SettingsPage')) },
    ],
  },
  {
    path: '/vendor',
    element: (
      <RequireActor actor="vendor">
        <VendorShell />
      </RequireActor>
    ),
    errorElement: <RouteError />,
    children: [
      { index: true, ...page(() => import('@/portals/vendor/VendorHome')) },
      { path: 'cost-requests', ...page(() => import('@/portals/vendor/VendorCostRequests')) },
      { path: 'cost-requests/:id', ...page(() => import('@/portals/vendor/VendorCostRequest')) },
      { path: 'orders', ...page(() => import('@/portals/vendor/VendorOrders')) },
      { path: 'orders/:id', ...page(() => import('@/portals/vendor/VendorOrder')) },
      { path: 'claims', ...page(() => import('@/portals/vendor/VendorClaims')) },
      { path: 'profile', ...page(() => import('@/portals/vendor/VendorProfile')) },
    ],
  },
  {
    path: '/portal',
    element: (
      <RequireActor actor="client">
        <ClientShell />
      </RequireActor>
    ),
    errorElement: <RouteError />,
    children: [
      { index: true, ...page(() => import('@/portals/client/ClientHome')) },
      { path: 'projects/:id', ...page(() => import('@/portals/client/ClientProject')) },
      { path: 'quotes/:id', ...page(() => import('@/portals/client/ClientQuote')) },
      { path: 'approvals', ...page(() => import('@/portals/client/ClientApprovals')) },
      { path: 'claims', ...page(() => import('@/portals/client/ClientClaims')) },
      { path: 'claims/:id', ...page(() => import('@/portals/client/ClientClaim')) },
      { path: 'invoices', ...page(() => import('@/portals/client/ClientInvoices')) },
      { path: 'invoices/:id', ...page(() => import('@/portals/client/ClientInvoice')) },
    ],
  },
  { path: '*', element: <RouteError /> },
]);
