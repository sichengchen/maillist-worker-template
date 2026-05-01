import { Routes, Route, Navigate, Link, useNavigate, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import LoginPage from "./pages/LoginPage";
import ArchivePage from "./pages/ArchivePage";
import EmailViewPage from "./pages/EmailViewPage";
import SettingsPage from "./pages/SettingsPage";

function AuthGuard({ children }: { children: React.ReactNode }) {
  const [checking, setChecking] = useState(true);
  const [authed, setAuthed] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    fetch("/api/auth/check")
      .then((r) => r.json())
      .then((d: { authenticated: boolean }) => {
        setAuthed(d.authenticated);
        if (!d.authenticated) navigate("/login", { replace: true });
      })
      .catch(() => navigate("/login", { replace: true }))
      .finally(() => setChecking(false));
  }, [navigate]);

  if (checking) return <div className="flex items-center justify-center h-screen">Loading...</div>;
  if (!authed) return null;
  return <>{children}</>;
}

function NavBar() {
  const navigate = useNavigate();
  const location = useLocation();

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    navigate("/login", { replace: true });
  };

  const linkClass = (path: string) =>
    `text-sm font-medium transition-colors hover:text-foreground ${
      location.pathname.startsWith(path) ? "text-foreground" : "text-muted-foreground"
    }`;

  return (
    <nav className="border-b">
      <div className="flex h-14 items-center px-6 gap-6">
        <span className="font-semibold">Mail Admin</span>
        <Link to="/archive" className={linkClass("/archive")}>Archive</Link>
        <Link to="/settings" className={linkClass("/settings")}>Settings</Link>
        <div className="ml-auto">
          <Button variant="ghost" size="sm" onClick={logout}>
            Logout
          </Button>
        </div>
      </div>
    </nav>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/*"
        element={
          <AuthGuard>
            <div className="min-h-screen">
              <NavBar />
              <main className="p-6">
                <Routes>
                  <Route path="/archive" element={<ArchivePage />} />
                  <Route path="/archive/:key" element={<EmailViewPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="*" element={<Navigate to="/archive" replace />} />
                </Routes>
              </main>
            </div>
          </AuthGuard>
        }
      />
    </Routes>
  );
}
