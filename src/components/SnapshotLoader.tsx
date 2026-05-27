import { FileArchive, Loader2 } from "lucide-react";
import type { ChangeEvent } from "react";

interface SnapshotLoaderProps {
  loading: boolean;
  onFileSelected: (file: File) => void;
}

export function SnapshotLoader({ loading, onFileSelected }: SnapshotLoaderProps) {
  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    if (file) {
      onFileSelected(file);
    }
  }

  return (
    <label className="file-input">
      {loading ? <Loader2 className="spin" size={18} /> : <FileArchive size={18} />}
      <span>导入快照 zip</span>
      <input accept=".zip,application/zip" type="file" onChange={handleChange} />
    </label>
  );
}
