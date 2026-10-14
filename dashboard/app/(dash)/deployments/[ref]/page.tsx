import type { Metadata } from "next";
import { DeploymentDetail } from "./deployment-detail";

export async function generateMetadata({ params }: { params: Promise<{ ref: string }> }): Promise<Metadata> {
  return { title: `Deployment ${decodeURIComponent((await params).ref)}` };
}

export default async function DeploymentPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  return <DeploymentDetail deploymentRef={decodeURIComponent(ref)} />;
}
