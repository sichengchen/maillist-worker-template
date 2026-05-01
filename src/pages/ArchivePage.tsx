import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

interface EmailEntry {
  key: string;
  size: number;
  uploaded: string;
  from: string;
  to: string;
  subject: string;
  date: string;
}

export default function ArchivePage() {
  const [emails, setEmails] = useState<EmailEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const fetchEmails = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/emails");
      const data = await res.json();
      setEmails(data.emails ?? []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEmails();
  }, []);

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="max-w-5xl mx-auto">
      <h1 className="text-2xl font-semibold mb-4">Email Archive</h1>

      {emails.length === 0 && !loading ? (
        <p className="text-muted-foreground">No archived emails yet.</p>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left p-3 font-medium">Archived</th>
                <th className="text-left p-3 font-medium">From</th>
                <th className="text-left p-3 font-medium">Subject</th>
                <th className="text-right p-3 font-medium">Size</th>
              </tr>
            </thead>
            <tbody>
              {emails.map((email) => (
                <tr
                  key={email.key}
                  className="border-b hover:bg-muted/30 cursor-pointer transition-colors"
                  onClick={() => navigate(`/archive/${encodeURIComponent(email.key)}`)}
                >
                  <td className="p-3 whitespace-nowrap">
                    {email.uploaded ? new Date(email.uploaded).toLocaleString() : "—"}
                  </td>
                  <td className="p-3">{email.from}</td>
                  <td className="p-3">{email.subject || "(no subject)"}</td>
                  <td className="p-3 text-right whitespace-nowrap">{formatSize(email.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {loading && <p className="text-muted-foreground mt-4">Loading...</p>}
    </div>
  );
}
