import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { Nav } from "@/components/nav";
import { currentProject } from "@/lib/server/auth";

/** Signed-in shell: redirects to sign-in when there is no session cookie. */
export default async function DashLayout({ children }: { children: ReactNode }) {
  const project = await currentProject();
  if (!project) redirect("/signin");
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <Link href="/agents" className="brand">
            <span className="brand-mark" aria-hidden="true" />
            Managed Agents
          </Link>
          <Nav />
          <div className="account">
            <span className="who">
              {project.name} · <span className="badge">{project.role}</span>
            </span>
            <form action="/api/auth/signout" method="post">
              <button type="submit" className="btn btn-sm">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        {children}
      </main>
    </>
  );
}
