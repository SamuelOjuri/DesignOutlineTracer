import type { PageSession } from "@/types/roi";

export function PenetrationSummary({ pages }: { pages: PageSession[] }) {
  return <section aria-label="Penetration annotation summary" className="mb-6 border-b border-border pb-4 min-w-0 break-words">
    <h2 className="text-lg font-semibold">Penetration Annotations</h2>
    {!pages.some((page) => page.annotations.some((annotation) => annotation.kind === "penetration"))
      && <p className="text-sm text-muted-foreground mt-2">No penetration annotations.</p>}
    {pages.map((page) => {
      const children = page.annotations.filter((annotation) => annotation.kind === "penetration");
      if (!children.length) return null;
      const parentIds = [...new Set(children.map((annotation) => annotation.roi_id))];
      return <div key={page.source.page_id} className="mt-4" data-page-id={page.source.page_id}>
        <h3 className="text-sm font-semibold break-all">{page.source.file_name} / Page {page.source.page_index + 1}</h3>
        {parentIds.map((parentId) => {
          const parent = page.annotations.find((annotation) => annotation.kind === "roof_roi" && annotation.id === parentId);
          const validParent = parent?.review_status === "accepted" && parent.validity === "current";
          return <div key={parentId ?? "unassigned"} className="mt-2" data-roi-id={parentId ?? ""}>
            <h4 className="text-sm font-medium">{parent?.label ?? "Unassigned roof area"}{!validParent && " / Needs review"}</h4>
            <ul className="divide-y divide-border">
              {children.filter((annotation) => annotation.roi_id === parentId).map((annotation) => <li key={annotation.id}
                className="py-2 text-sm" data-annotation-id={annotation.id}>
                <span className="block">{annotation.label}</span>
                <span className="block text-xs text-muted-foreground capitalize">{annotation.subtype?.replace(/_/g, " ")} / {annotation.review_status}
                  {annotation.validity === "needs_review" || !validParent ? " / Needs review" : " / Current"}</span>
              </li>)}
            </ul>
          </div>;
        })}
      </div>;
    })}
  </section>;
}