import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface ParsedEmail {
  from: { name?: string; address?: string } | null;
  to: { name?: string; address?: string }[] | null;
  subject: string;
  date: string;
  text: string | null;
  html: string | null;
  attachments: { filename: string; mimeType: string; size: number }[];
}

export default function EmailViewPage() {
  const { key } = useParams();
  const [email, setEmail] = useState<ParsedEmail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    if (!key) return;
    fetch(`/api/emails/${encodeURIComponent(key)}/parsed`)
      .then((r) => {
        if (!r.ok) throw new Error("Not found");
        return r.json();
      })
      .then((d) => setEmail(d))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [key]);

  if (loading) return <p className="text-muted-foreground">Loading...</p>;
  if (error) return <p className="text-destructive">{error}</p>;
  if (!email) return null;

  const formatAddr = (a: { name?: string; address?: string } | null) => {
    if (!a) return "—";
    return a.name ? `${a.name} <${a.address}>` : a.address ?? "—";
  };

  const downloadUrl = `/api/emails/${encodeURIComponent(key!)}/raw`;

  return (
    <div className="max-w-4xl mx-auto">
      <Button variant="ghost" size="sm" onClick={() => navigate("/archive")} className="mb-4">
        &larr; Back to Archive
      </Button>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-lg">{email.subject || "(no subject)"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p><span className="font-medium">From:</span> {formatAddr(email.from)}</p>
          <p><span className="font-medium">To:</span> {email.to?.map(formatAddr).join(", ") ?? "—"}</p>
          <p><span className="font-medium">Date:</span> {email.date ? new Date(email.date).toLocaleString() : "—"}</p>
          <div className="pt-2">
            <a href={downloadUrl} download>
              <Button variant="outline" size="sm">Download EML</Button>
            </a>
          </div>
        </CardContent>
      </Card>

      {email.attachments.length > 0 && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">Attachments</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {email.attachments.map((att, i) => (
              <Badge key={i} variant="secondary">
                {att.filename || "unnamed"} ({(att.size / 1024).toFixed(1)} KB)
              </Badge>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {email.html ? (
            <iframe
              srcDoc={email.html}
              sandbox="allow-same-origin"
              className="w-full min-h-[500px] border-0"
              title="Email body"
            />
          ) : (
            <pre className="p-6 whitespace-pre-wrap text-sm">{email.text ?? ""}</pre>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
