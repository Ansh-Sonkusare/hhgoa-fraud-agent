// Thin server page: Next 15 passes `params` as a Promise, and the case
// detail screen itself is client-side (SSE + interactive approvals), so
// this page only unwraps the case id and hands it to the client view.
import { CaseDetailView } from "../../../components/CaseDetailView";

export default async function CaseDetailPage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const { caseId } = await params;
  return <CaseDetailView caseId={caseId} />;
}