import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route, Switch, Router as WouterRouter } from "wouter";
import { ThemeProvider } from "@/components/theme-provider";
import { Layout } from "@/components/layout";

import RecorderPage from "@/pages/recorder";
import LibraryPage from "@/pages/library";
import AllVideosPage from "@/pages/all-videos";
import PlayerPage from "@/pages/player";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
    },
  },
});

function NotFound() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
      <h1 className="text-6xl font-bold text-primary mb-4">404</h1>
      <h2 className="text-2xl font-semibold mb-2">Page Not Found</h2>
      <p className="text-muted-foreground mb-8">
        The page you're looking for doesn't exist.
      </p>
      <a
        href="/"
        className="bg-primary text-primary-foreground px-6 py-2 rounded-lg font-medium hover:bg-primary/90 transition-colors"
      >
        Return Home
      </a>
    </div>
  );
}

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={RecorderPage} />
        <Route path="/library" component={LibraryPage} />
        <Route path="/all" component={AllVideosPage} />
        <Route path="/watch/:id" component={PlayerPage} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light" storageKey="screencast-theme">
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
