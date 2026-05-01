import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { toast } from "sonner";
import { X } from "lucide-react";

export default function SettingsPage() {
  const [mailingList, setMailingList] = useState<string[]>([]);
  const [archiveSenders, setArchiveSenders] = useState<string[]>([]);
  const [archiveAll, setArchiveAll] = useState(false);
  const [newMailAddr, setNewMailAddr] = useState("");
  const [newArchiveAddr, setNewArchiveAddr] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        setMailingList(d.mailingList ?? []);
        setArchiveSenders(d.archiveSenders ?? []);
        setArchiveAll(d.archiveAll ?? false);
      })
      .catch(() => toast.error("Failed to load settings"))
      .finally(() => setLoading(false));
  }, []);

  const addToList = (
    list: string[],
    setList: (l: string[]) => void,
    value: string,
    clear: () => void
  ) => {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return;
    if (list.includes(trimmed)) {
      toast.error("Address already in list");
      return;
    }
    setList([...list, trimmed]);
    clear();
  };

  const removeFromList = (list: string[], setList: (l: string[]) => void, index: number) => {
    setList(list.filter((_, i) => i !== index));
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mailingList, archiveSenders, archiveAll }),
      });
      if (res.ok) {
        toast.success("Settings saved");
      } else {
        toast.error("Failed to save settings");
      }
    } catch {
      toast.error("Network error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="text-muted-foreground">Loading...</p>;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Mailing List Recipients</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {mailingList.map((addr, i) => (
              <Badge key={i} variant="secondary" className="gap-1">
                {addr}
                <button
                  onClick={() => removeFromList(mailingList, setMailingList, i)}
                  className="ml-1 hover:text-destructive"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
            {mailingList.length === 0 && (
              <p className="text-sm text-muted-foreground">No recipients configured.</p>
            )}
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              addToList(mailingList, setMailingList, newMailAddr, () => setNewMailAddr(""));
            }}
          >
            <Input
              type="email"
              placeholder="Add email address"
              value={newMailAddr}
              onChange={(e) => setNewMailAddr(e.target.value)}
            />
            <Button type="submit" variant="outline" size="sm">
              Add
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Archive All Emails</CardTitle>
        </CardHeader>
        <CardContent>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={archiveAll}
              onChange={(e) => setArchiveAll(e.target.checked)}
              className="h-4 w-4 rounded border-input"
            />
            <span className="text-sm">
              Archive every incoming email regardless of sender
            </span>
          </label>
          {archiveAll && (
            <p className="text-sm text-muted-foreground mt-2">
              The sender list below is ignored when this is enabled.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Archive Senders</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {archiveSenders.map((addr, i) => (
              <Badge key={i} variant="secondary" className="gap-1">
                {addr}
                <button
                  onClick={() => removeFromList(archiveSenders, setArchiveSenders, i)}
                  className="ml-1 hover:text-destructive"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
            {archiveSenders.length === 0 && (
              <p className="text-sm text-muted-foreground">No archive senders configured.</p>
            )}
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              addToList(archiveSenders, setArchiveSenders, newArchiveAddr, () =>
                setNewArchiveAddr("")
              );
            }}
          >
            <Input
              type="email"
              placeholder="Add sender address"
              value={newArchiveAddr}
              onChange={(e) => setNewArchiveAddr(e.target.value)}
            />
            <Button type="submit" variant="outline" size="sm">
              Add
            </Button>
          </form>
        </CardContent>
      </Card>

      <Button onClick={save} disabled={saving}>
        {saving ? "Saving..." : "Save Settings"}
      </Button>
    </div>
  );
}
