import { redirect } from "next/navigation";

/** The library supersedes this view — everyone ever touched, not only current leads. */
export default async function Leads({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/products/${id}/library`);
}
