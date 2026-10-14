import { redirect } from "next/navigation";
import { currentProject } from "@/lib/server/auth";

export default async function Home() {
  redirect((await currentProject()) ? "/agents" : "/signin");
}
