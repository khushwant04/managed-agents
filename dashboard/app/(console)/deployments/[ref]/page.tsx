import type { Metadata } from "next"
import { DeploymentDetail } from "./deployment-detail"

type Props = { params: Promise<{ ref: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return { title: decodeURIComponent((await params).ref) }
}

export default async function DeploymentPage({ params }: Props) {
  const { ref } = await params
  return <DeploymentDetail deploymentRef={decodeURIComponent(ref)} />
}
