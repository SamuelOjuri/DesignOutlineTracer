import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FileText, Trash2 } from "lucide-react";
import { formatFileSize, validateSpecDocument } from "@/utils/specDocument";

interface SpecDocumentUploadProps {
  file: File | null;
  onChange: (file: File | null) => void;
}

/** The specification is kept as an opaque attachment; nothing is read from it into the form. */
export const SpecDocumentUpload = ({ file, onChange }: SpecDocumentUploadProps) => {
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const selection = useRef(0);

  useEffect(() => {
    if (!file || typeof URL.createObjectURL !== "function") {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const handleSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0];
    event.target.value = "";
    if (!selected) return;
    const current = ++selection.current;
    setChecking(true);
    setError(null);
    try {
      const problem = await validateSpecDocument(selected);
      if (current !== selection.current) return;
      if (problem) setError(problem);
      else onChange(selected);
    } catch {
      if (current === selection.current) setError("The selected PDF could not be read.");
    } finally {
      if (current === selection.current) setChecking(false);
    }
  };

  return (
    <Card className="p-4 mb-4">
      <h3 className="text-base font-semibold mb-1">Performance Specification</h3>
      <p className="text-xs text-muted-foreground mb-3">
        Optional. Upload the specification PDF from the CRM. It is added to the download package exactly as
        provided and is not copied into the form below.
      </p>
      {file ? (
        <div className="p-3 bg-muted rounded-lg space-y-2">
          <div className="flex items-start gap-2">
            <FileText className="w-4 h-4 mt-0.5 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="text-sm font-medium break-all" data-testid="spec-document-name">{file.name}</p>
              <p className="text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
            </div>
          </div>
          <div className="flex gap-2">
            {previewUrl && (
              <Button asChild variant="outline" size="sm" className="flex-1">
                <a href={previewUrl} target="_blank" rel="noopener noreferrer">Preview</a>
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" className="flex-1" onClick={() => { setError(null); onChange(null); }}>
              <Trash2 className="w-3.5 h-3.5 mr-1" />
              Remove
            </Button>
          </div>
        </div>
      ) : null}
      <div className={file ? "mt-3" : undefined}>
        <Label htmlFor="spec-document" className="text-xs">{file ? "Replace PDF" : "Specification PDF"}</Label>
        <Input id="spec-document" type="file" accept="application/pdf,.pdf" aria-label="Performance specification PDF"
          onChange={handleSelect} disabled={checking} className="mt-1" />
      </div>
      {error && <p role="alert" className="text-xs text-destructive mt-2">{error}</p>}
    </Card>
  );
};
