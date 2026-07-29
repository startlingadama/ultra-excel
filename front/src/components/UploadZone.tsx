import { useCallback, useRef, useState } from "react";
import { Text } from "@radix-ui/themes";
import { FileIcon, UploadIcon } from "@radix-ui/react-icons";
import { ACCEPTED_EXTENSIONS } from "../api";

interface UploadZoneProps {
  selectedFileName: string | null;
  /** true once the summary has come back, triggers the grid-fill animation */
  filled: boolean;
  disabled: boolean;
  onFileSelected: (file: File) => void;
}

const GRID_COLUMNS = 8;
const GRID_ROWS = 5;

/**
 * The drop zone doubles as ultra excel's signature element: a faint
 * spreadsheet grid sits behind the copy, and once a file finishes
 * processing, its columns fill in left-to-right - echoing a workbook
 * being read column by column.
 */
export function UploadZone({
  selectedFileName,
  filled,
  disabled,
  onFileSelected,
}: UploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      onFileSelected(files[0]);
    },
    [onFileSelected],
  );

  return (
    <div
      className="ue-dropzone"
      data-active={isDragOver}
      role="button"
      tabIndex={0}
      aria-disabled={disabled}
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragOver(false);
        if (!disabled) handleFiles(e.dataTransfer.files);
      }}
    >
      <div className="ue-dropzone__grid" aria-hidden="true">
        {Array.from({ length: GRID_COLUMNS - 1 }).map((_, i) => (
          <div
            key={`col-${i}`}
            className="ue-col"
            data-filled={filled}
            style={{
              left: `${((i + 1) * 100) / GRID_COLUMNS}%`,
              animationDelay: filled ? `${i * 45}ms` : undefined,
            }}
          />
        ))}
        {Array.from({ length: GRID_ROWS - 1 }).map((_, i) => (
          <div
            key={`row-${i}`}
            className="ue-row"
            style={{ top: `${((i + 1) * 100) / GRID_ROWS}%` }}
          />
        ))}
      </div>

      <div className="ue-dropzone__content">
        {selectedFileName ? <FileIcon width={22} height={22} /> : <UploadIcon width={22} height={22} />}

        <div className="ue-dropzone__title">
          {selectedFileName ? "Fichier prêt" : "Dépose un classeur Excel"}
        </div>
        <Text as="p" className="ue-dropzone__hint">
          {selectedFileName
            ? "Clique pour en choisir un autre"
            : "ou clique pour parcourir - .xlsx, .xls, .xlsm, .xlsb… 200 Mo max"}
        </Text>

        {selectedFileName && (
          <div className="ue-dropzone__filename">{selectedFileName}</div>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_EXTENSIONS.join(",")}
        hidden
        onChange={(e) => handleFiles(e.target.files)}
      />
    </div>
  );
}
